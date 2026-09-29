import {test, describe, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {start} from 'bfast-function';
import {smsPort} from '../../src/services/customer-access/container.mjs';

/**
 * T04 over real HTTP: a broker lists a home from the app, the landlord
 * confirms it from theirs, the moderator approves it, and a customer finds
 * it. Also the partner workspace guard: an applicant names their role with
 * X-Partner-Role, a plain customer is refused.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BROKER = '+255713800001';
const LANDLORD = '+255713800002';
const CUSTOMER = '+255713800003';
const PIN = '4820';
const photo = {base64: Buffer.from('RIFF----WEBPVP8 photo').toString('base64'), contentType: 'image/webp', name: 'front.webp'};

describe('journey: broker listing with landlord confirmation (e2e)', () => {
    /** @type {import('node:http').Server} */
    let server;
    let baseUrl;
    let db;
    let adminToken;
    let dictionaryIds;

    async function api(path, {method = 'GET', body, token, headers = {}} = {}) {
        const response = await fetch(`${baseUrl}${path}`, {
            method,
            headers: {
                ...(body ? {'content-type': 'application/json'} : {}),
                ...(token ? {authorization: `Bearer ${token}`} : {}),
                ...headers,
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
        const {rows} = await db.query(`select code, id from dictionary_items where code in ('apartment', 'dar_es_salaam')`);
        dictionaryIds = Object.fromEntries(rows.map((r) => [r.code, r.id]));
    });

    after(async () => {
        await db.end();
        await new Promise((resolve) => server.close(resolve));
        setImmediate(() => process.exit(0));
    });

    beforeEach(async () => {
        await db.query(`truncate table otp_request_log, auth_otp_challenges, external_notification_events, notifications,
                                       property_media, property_charges, property_amenities, property_parties, properties,
                                       users, organizations
                        restart identity cascade`);
        smsPort.sentMessages.length = 0;
    });

    /** Registers the phone the way the app does and returns a session token. */
    async function register(phoneNumber) {
        const requested = await api('/customer/auth/otp/request', {method: 'POST', body: {phoneNumber}});
        const verified = await api('/customer/auth/otp/verify', {
            method: 'POST',
            body: {challengeId: requested.body.challengeId, code: smsPort.lastMessageTo(phoneNumber)?.params?.code},
        });
        const session = await api('/customer/auth/pin', {
            method: 'POST',
            body: {verificationToken: verified.body.verificationToken, pin: PIN, confirmPin: PIN},
        });
        assert.equal(session.status, 200, JSON.stringify(session.body));
        return session.body.token;
    }

    const userIdOf = (token) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString()).userId;

    async function grant(token, role, status = 'active') {
        await db.query('insert into user_roles (user_id, role, status) values ($1, $2, $3)', [userIdOf(token), role, status]);
    }

    async function actAs(token, role) {
        const switched = await api('/app/me/active-role', {method: 'POST', token, body: {role}});
        assert.equal(switched.status, 200, JSON.stringify(switched.body));
        return switched.body.token;
    }

    test('broker lists → landlord confirms → broker submits → approved → customers find it', async () => {
        const broker = await actAs(await register(BROKER).then(async (t) => (await grant(t, 'broker'), t)), 'broker');

        const created = await api('/app/partner/listings', {
            method: 'POST',
            token: broker,
            body: {
                title: 'Mikocheni 3BR House',
                propertyTypeId: dictionaryIds.apartment,
                regionId: dictionaryIds.dar_es_salaam,
                price: 1200000,
                latitude: -6.76,
                longitude: 39.25,
            },
        });
        assert.equal(created.status, 201, JSON.stringify(created.body));
        const id = created.body.id;

        const photoAdded = await api(`/app/partner/listings/${id}/photos`, {method: 'POST', token: broker, body: {image: photo}});
        assert.equal(photoAdded.status, 201, JSON.stringify(photoAdded.body));
        const cover = await fetch(`${baseUrl}${photoAdded.body.photos[0].url}`, {headers: {authorization: `Bearer ${broker}`}});
        assert.equal(cover.status, 200);

        // The landlord has never used HomeMate: look up, then invite.
        const lookup = await api(`/app/partner/landlords/lookup?phone=${encodeURIComponent(LANDLORD)}`, {token: broker});
        assert.deepEqual(lookup.body, {found: false});
        const invited = await api('/app/partner/landlords/invite', {method: 'POST', token: broker, body: {fullName: 'Amina Mwinyi', phone: LANDLORD}});
        assert.equal(invited.status, 201, JSON.stringify(invited.body));

        const attached = await api(`/app/partner/listings/${id}`, {
            method: 'PUT',
            token: broker,
            body: {landlordUserId: invited.body.landlord.userId},
        });
        assert.equal(attached.status, 200, JSON.stringify(attached.body));
        assert.equal(attached.body.landlord.confirmationStatus, 'pending');
        assert.equal(smsPort.lastMessageTo(LANDLORD).template, 'landlord-confirm-listing');

        const blocked = await api(`/app/partner/listings/${id}/submit`, {method: 'POST', token: broker});
        assert.equal(blocked.status, 422);
        assert.deepEqual(blocked.body.details.reasons.map((r) => r.code), ['landlord_pending']);

        // The invited landlord signs in with the same phone and confirms.
        const landlord = await register(LANDLORD);
        const waiting = await api('/app/landlord/confirmations', {token: landlord});
        assert.equal(waiting.status, 200);
        assert.equal(waiting.body.items[0].propertyId, id);
        const confirmed = await api(`/app/landlord/listings/${id}/confirm`, {method: 'POST', token: landlord});
        assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));

        const submitted = await api(`/app/partner/listings/${id}/submit`, {method: 'POST', token: broker});
        assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
        assert.equal(submitted.body.status, 'pending_review');

        const approved = await api(`/admin/properties/${id}/status`, {method: 'POST', token: adminToken, body: {status: 'approved'}});
        assert.equal(approved.status, 200, JSON.stringify(approved.body));

        const customer = await register(CUSTOMER);
        const search = await api('/app/properties', {token: customer});
        assert.equal(search.status, 200);
        assert.ok(search.body.items.some((item) => item.id === id));
    });

    test('an applicant drafts with X-Partner-Role; a plain customer is refused', async () => {
        const applicant = await register(BROKER);
        await grant(applicant, 'landlord', 'pending_review');

        const refused = await api('/app/partner/listings', {token: applicant});
        assert.equal(refused.status, 403);
        assert.equal(refused.body.error, 'ROLE_NOT_ACTIVE');

        const headers = {'x-partner-role': 'landlord'};
        const draft = await api('/app/partner/listings', {method: 'POST', token: applicant, headers, body: {title: 'My flat'}});
        assert.equal(draft.status, 201, JSON.stringify(draft.body));
        assert.equal(draft.body.landlord.confirmationStatus, 'not_required');

        const mine = await api('/app/partner/listings', {token: applicant, headers});
        assert.equal(mine.body.items.length, 1);

        // Landlord lookup is a broker tool.
        const lookup = await api(`/app/partner/landlords/lookup?phone=${LANDLORD}`, {token: applicant, headers});
        assert.equal(lookup.status, 403);

        const customer = await register(CUSTOMER);
        assert.equal((await api('/app/partner/listings', {token: customer, headers: {'x-partner-role': 'broker'}})).status, 403);
        assert.equal((await api('/app/partner/listings')).status, 401);
    });
});
