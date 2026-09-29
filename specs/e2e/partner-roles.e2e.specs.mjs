import {test, describe, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {start} from 'bfast-function';
import {smsPort} from '../../src/services/customer-access/container.mjs';

/**
 * ROL-001 / ROL-002 over real HTTP: a person with one phone and one PIN signs
 * in, sees every role they hold, switches to an active one without signing in
 * again, and is refused a role that is not active. The old app keeps working:
 * the token still says `role: 'customer'`, so `/app/*` stays open to it.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PHONE = '+255713400001';
const PIN = '4820';

function decode(token) {
    return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
}

describe('journey: multi-role sign-in and role switching (e2e)', () => {
    /** @type {import('node:http').Server} */
    let server;
    let baseUrl;
    let db;
    let adminToken;

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
    });

    after(async () => {
        await db.end();
        await new Promise((resolve) => server.close(resolve));
        setImmediate(() => process.exit(0));
    });

    beforeEach(async () => {
        await db.query(`truncate table otp_request_log, auth_otp_challenges, external_notification_events,
                                       users, organizations restart identity cascade`);
        smsPort.sentMessages.length = 0;
    });

    /** Registers the way the app does and returns the account id. */
    async function register() {
        const requested = await api('/customer/auth/otp/request', {method: 'POST', body: {phoneNumber: PHONE}});
        assert.equal(requested.status, 200, JSON.stringify(requested.body));
        const verified = await api('/customer/auth/otp/verify', {
            method: 'POST',
            body: {challengeId: requested.body.challengeId, code: smsPort.lastMessageTo(PHONE)?.params?.code},
        });
        assert.equal(verified.status, 200, JSON.stringify(verified.body));
        const session = await api('/customer/auth/pin', {
            method: 'POST',
            body: {verificationToken: verified.body.verificationToken, pin: PIN, confirmPin: PIN},
        });
        assert.equal(session.status, 200, JSON.stringify(session.body));
        return decode(session.body.token).userId;
    }

    async function signIn() {
        const session = await api('/customer/auth/login', {method: 'POST', body: {phoneNumber: PHONE, pin: PIN}});
        assert.equal(session.status, 200, JSON.stringify(session.body));
        return session.body;
    }

    async function grant(userId, role, status) {
        await db.query(`insert into user_roles (user_id, role, status) values ($1, $2, $3)`, [userId, role, status]);
    }

    test('a new customer signs in with one active role and a backward-compatible token', async () => {
        await register();
        const session = await signIn();
        const claims = decode(session.token);

        assert.equal(claims.role, 'customer');
        assert.deepEqual(claims.roles, ['customer']);
        assert.equal(claims.activeRole, 'customer');
        assert.equal(session.activeRole, 'customer');

        const me = await api('/app/me', {token: session.token});
        assert.equal(me.status, 200);
        assert.deepEqual(me.body.roles.map((r) => [r.role, r.status]), [['customer', 'active']]);
        assert.equal(me.body.lastActiveRole, null);
    });

    test('a broker switches role, keeps using the app, and opens as broker next time', async () => {
        const userId = await register();
        await grant(userId, 'broker', 'active');
        await grant(userId, 'landlord', 'pending_review');

        const {token} = await signIn();
        const me = await api('/app/me', {token});
        assert.deepEqual(
            me.body.roles.map((r) => [r.role, r.status]),
            [['customer', 'active'], ['broker', 'active'], ['landlord', 'pending_review']]
        );

        const switched = await api('/app/me/active-role', {method: 'POST', token, body: {role: 'broker'}});
        assert.equal(switched.status, 200, JSON.stringify(switched.body));
        assert.equal(switched.body.activeRole, 'broker');
        assert.equal(decode(switched.body.token).activeRole, 'broker');

        // The re-signed token still opens the customer app.
        const stillCustomer = await api('/app/me', {token: switched.body.token});
        assert.equal(stillCustomer.status, 200);
        assert.equal(stillCustomer.body.lastActiveRole, 'broker');

        const next = await signIn();
        assert.equal(decode(next.token).activeRole, 'broker');
    });

    test('switching to a role that is not active is a 403 ROLE_NOT_ACTIVE', async () => {
        const userId = await register();
        await grant(userId, 'landlord', 'pending_review');
        const {token} = await signIn();

        for (const role of ['landlord', 'broker']) {
            const refused = await api('/app/me/active-role', {method: 'POST', token, body: {role}});
            assert.equal(refused.status, 403);
            assert.equal(refused.body.error, 'ROLE_NOT_ACTIVE');
        }

        const invalid = await api('/app/me/active-role', {method: 'POST', token, body: {role: 'admin'}});
        assert.equal(invalid.status, 400);
    });

    test('switching needs a session', async () => {
        const refused = await api('/app/me/active-role', {method: 'POST', body: {role: 'customer'}});
        assert.equal(refused.status, 401);
    });

    test('the backoffice sees the roles on the user', async () => {
        const userId = await register();
        await grant(userId, 'broker', 'active');

        const fetched = await api(`/admin/users/${userId}`, {token: adminToken});
        assert.equal(fetched.status, 200);
        assert.deepEqual(fetched.body.roles.map((r) => r.role), ['customer', 'broker']);

        const list = await api('/admin/users', {token: adminToken});
        assert.deepEqual(list.body.items.find((u) => u.id === userId).roles.map((r) => r.role), ['customer', 'broker']);
    });
});
