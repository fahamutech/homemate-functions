import {test, describe, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {start} from 'bfast-function';
import {smsPort} from '../../src/services/customer-access/container.mjs';
import {createSessionTokenService} from '../../src/shared/session-tokens.mjs';

/**
 * T03 over real HTTP: a customer applies to be a broker from the app, a
 * moderator with the `partners` section approves it from the backoffice, and
 * the customer switches into the broker role. Staff without that section, and
 * customers, are refused the admin routes.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PHONE = '+255713600001';
const PIN = '4820';
const image = {base64: Buffer.from('photo-bytes').toString('base64'), contentType: 'image/jpeg'};

describe('journey: broker onboarding and review (e2e)', () => {
    /** @type {import('node:http').Server} */
    let server;
    let baseUrl;
    let db;
    let adminToken;
    let staffTokens;

    async function api(path, {method = 'GET', body, token} = {}) {
        const response = await fetch(`${baseUrl}${path}`, {
            method,
            headers: {
                ...(body ? {'content-type': 'application/json'} : {}),
                ...(token ? {authorization: `Bearer ${token}`} : {}),
            },
            ...(body ? {body: JSON.stringify(body)} : {}),
        });
        return {status: response.status, body: await response.json().catch(() => null)};
    }

    before(async () => {
        server = await start({
            port: process.env.PORT ?? '0',
            functionsConfig: {
                functionsDirPath: join(repoRoot, 'functions'),
                bfastJsonPath: join(repoRoot, 'bfast.json'),
            },
        });
        if (!server.listening) await once(server, 'listening');
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        db = new pg.Client({connectionString: process.env.DATABASE_URL});
        await db.connect();

        const login = await api('/auth/admin/login', {
            method: 'POST',
            body: {email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD},
        });
        adminToken = login.body.token;
        // Staff sessions as /auth/admin/login signs them for a restricted role.
        const signer = createSessionTokenService(process.env.SESSION_TOKEN_SECRET);
        staffTokens = {
            partners: signer.sign({role: 'moderator', email: 'p@homemate.co.tz', allowedRoutes: ['partners']}),
            properties: signer.sign({role: 'moderator', email: 'o@homemate.co.tz', allowedRoutes: ['properties']}),
        };
    });

    after(async () => {
        await db.end();
        await new Promise((resolve) => server.close(resolve));
        setImmediate(() => process.exit(0));
    });

    beforeEach(async () => {
        await db.query(`truncate table otp_request_log, auth_otp_challenges, external_notification_events,
                                       notifications, kyc_remediations, kyc_documents, users, organizations
                        restart identity cascade`);
        smsPort.sentMessages.length = 0;
    });

    async function register() {
        const requested = await api('/customer/auth/otp/request', {method: 'POST', body: {phoneNumber: PHONE}});
        const verified = await api('/customer/auth/otp/verify', {
            method: 'POST',
            body: {challengeId: requested.body.challengeId, code: smsPort.lastMessageTo(PHONE)?.params?.code},
        });
        const session = await api('/customer/auth/pin', {
            method: 'POST',
            body: {verificationToken: verified.body.verificationToken, pin: PIN, confirmPin: PIN},
        });
        assert.equal(session.status, 200, JSON.stringify(session.body));
        return session.body.token;
    }

    test('apply → submit → approve → switch to broker', async () => {
        const token = await register();

        const start = await api('/app/partner/applications', {token});
        assert.equal(start.status, 200);
        assert.deepEqual(start.body.applications.map((a) => a.status), ['not_started', 'not_started']);

        const details = await api('/app/partner/applications/broker', {
            method: 'PUT',
            token,
            body: {
                fullName: 'Neema Kileo',
                dateOfBirth: '1990-04-12',
                nationalIdNumber: '19900412-12345-00001-23',
                physicalAddress: 'Mikocheni, Dar es Salaam',
            },
        });
        assert.equal(details.status, 200, JSON.stringify(details.body));
        assert.equal(details.body.status, 'applied');

        const early = await api('/app/partner/applications/broker/submit', {method: 'POST', token});
        assert.equal(early.status, 422);
        assert.deepEqual(early.body.details.missingSteps, ['identity', 'payout', 'agreement']);

        for (const documentType of ['national_id', 'selfie']) {
            const uploaded = await api('/app/me/kyc/documents', {method: 'POST', token, body: {documentType, file: image}});
            assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
        }
        const payout = await api('/app/me/payout', {
            method: 'PUT',
            token,
            body: {method: 'mobile_money', provider: 'mpesa', accountName: 'Neema Kileo', accountNumber: '0712345678'},
        });
        assert.equal(payout.status, 200, JSON.stringify(payout.body));
        assert.equal(payout.body.payout.accountNumber, '+255712345678');

        const agreement = await api('/app/partner/applications/broker/agreement', {method: 'POST', token, body: {version: 'v1.0'}});
        assert.equal(agreement.status, 200, JSON.stringify(agreement.body));

        const submitted = await api('/app/partner/applications/broker/submit', {method: 'POST', token});
        assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
        assert.equal(submitted.body.status, 'pending_review');

        const refusedSwitch = await api('/app/me/active-role', {method: 'POST', token, body: {role: 'broker'}});
        assert.equal(refusedSwitch.status, 403, 'not active until approved');

        const userId = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString()).userId;
        const queue = await api('/admin/partner-applications?status=pending_review&role=broker', {token: staffTokens.partners});
        assert.equal(queue.status, 200, JSON.stringify(queue.body));
        assert.equal(queue.body.items.length, 1);
        assert.equal(queue.body.items[0].userId, userId);

        const one = await api(`/admin/partner-applications/${userId}/broker`, {token: staffTokens.partners});
        assert.equal(one.status, 200);
        assert.equal(one.body.person.phoneNumber, PHONE);

        const approved = await api(`/admin/partner-applications/${userId}/broker/decision`, {
            method: 'POST',
            token: staffTokens.partners,
            body: {decision: 'approve'},
        });
        assert.equal(approved.status, 200, JSON.stringify(approved.body));
        assert.equal(approved.body.status, 'active');
        assert.equal(smsPort.lastMessageTo(PHONE).template, 'partner-application-decision');

        const switched = await api('/app/me/active-role', {method: 'POST', token, body: {role: 'broker'}});
        assert.equal(switched.status, 200, JSON.stringify(switched.body));
        assert.equal(switched.body.activeRole, 'broker');

        const attention = await api('/admin/attention', {token: adminToken});
        assert.equal(attention.body.badges.partners, 0);
    });

    test('a rejection without a reason is a 400', async () => {
        const token = await register();
        const userId = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString()).userId;
        await db.query(`insert into user_roles (user_id, role, status) values ($1, 'broker', 'pending_review')`, [userId]);

        const refused = await api(`/admin/partner-applications/${userId}/broker/decision`, {
            method: 'POST',
            token: adminToken,
            body: {decision: 'reject'},
        });
        assert.equal(refused.status, 400);

        const attention = await api('/admin/attention', {token: adminToken});
        assert.equal(attention.body.badges.partners, 1);
    });

    test('customers and staff without the partners section are refused the admin routes', async () => {
        const token = await register();
        const userId = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString()).userId;

        for (const caller of [token, staffTokens.properties]) {
            const list = await api('/admin/partner-applications', {token: caller});
            assert.equal(list.status, 403);
            const decide = await api(`/admin/partner-applications/${userId}/broker/decision`, {
                method: 'POST',
                token: caller,
                body: {decision: 'approve'},
            });
            assert.equal(decide.status, 403);
        }
        assert.equal((await api('/admin/partner-applications')).status, 401);
        assert.equal((await api('/admin/partner-applications', {token: adminToken})).status, 200);
    });

    test('the partner routes need a customer session', async () => {
        assert.equal((await api('/app/partner/applications')).status, 401);
        assert.equal((await api('/app/me/payout', {method: 'PUT', body: {}})).status, 401);
    });
});
