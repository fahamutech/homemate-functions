import {test, describe, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {start} from 'bfast-function';
import {smsPort} from '../../src/services/customer-access/container.mjs';
import {createMoneyService} from '../../src/services/admin-console/money.mjs';

/**
 * T05 over real HTTP: a customer enquires, the broker accepts from the app,
 * the customer pays and finance verifies, the broker's tracker follows, and
 * the landlord moves the tenant in and later ends the tenancy.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BROKER = '+255714000001';
const LANDLORD = '+255714000002';
const CUSTOMER = '+255714000003';
const PIN = '4820';

describe('journey: broker answers, landlord hosts (e2e)', () => {
    /** @type {import('node:http').Server} */
    let server;
    let baseUrl;
    let db;
    let pool;
    let money;
    let propertyId;

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
        pool = new pg.Pool({connectionString: process.env.DATABASE_URL});
        money = createMoneyService({pool});
    });

    after(async () => {
        await db.end();
        await pool.end();
        await new Promise((resolve) => server.close(resolve));
        setImmediate(() => process.exit(0));
    });

    beforeEach(async () => {
        await db.query(`truncate table otp_request_log, auth_otp_challenges, external_notification_events, notifications,
                                       payment_instructions, ledger_entries, payment_splits, external_payment_events, payouts,
                                       payments, lease_agreements, property_holds, bookings, property_inquiries,
                                       property_parties, property_media, properties, users, organizations
                        restart identity cascade`);
        smsPort.sentMessages.length = 0;
        await db.query(
            `update settings set value = '50'::jsonb where key = 'commission.tenant_fee_percentage';
             update settings set value = '10'::jsonb where key = 'commission.platform_percentage';`
        );
    });

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

    async function partner(phone, role) {
        const token = await register(phone);
        await db.query(`insert into user_roles (user_id, role, status) values ($1, $2, 'active')`, [userIdOf(token), role]);
        const switched = await api('/app/me/active-role', {method: 'POST', token, body: {role}});
        assert.equal(switched.status, 200, JSON.stringify(switched.body));
        return switched.body.token;
    }

    async function brokeredHome(brokerId, landlordId) {
        const {rows: dict} = await db.query(`select code, id from dictionary_items where code in ('apartment', 'dar_es_salaam')`);
        const ids = Object.fromEntries(dict.map((r) => [r.code, r.id]));
        const {rows} = await db.query(
            `insert into properties (title, owner_id, price, property_type_id, region_id, deposit_months, min_lease_months,
                                     location, status)
             values ('Oyster Bay 2BR', $1, 1000000, $2, $3, 1, 12, st_setsrid(st_makepoint(39.28, -6.77), 4326)::geography, 'draft')
             returning id`,
            [landlordId, ids.apartment, ids.dar_es_salaam]
        );
        const id = rows[0].id;
        await db.query(
            `insert into property_parties (property_id, user_id, role, is_primary) values ($1, $2, 'landlord', true), ($1, $3, 'broker', true)`,
            [id, landlordId, brokerId]
        );
        await db.query(`update properties set status = 'pending_review' where id = $1`, [id]);
        await db.query(`update properties set status = 'approved' where id = $1`, [id]);
        return id;
    }

    test('enquire → broker accepts → pay → verified → landlord moves the tenant in and ends it', async () => {
        const broker = await partner(BROKER, 'broker');
        const landlord = await partner(LANDLORD, 'landlord');
        const customer = await register(CUSTOMER);
        propertyId = await brokeredHome(userIdOf(broker), userIdOf(landlord));

        const enquiry = await api('/app/inquiries', {method: 'POST', token: customer, body: {propertyId, message: 'Still free?', occupants: 2}});
        assert.equal(enquiry.status, 201, JSON.stringify(enquiry.body));
        const inquiryId = enquiry.body.id;

        const inbox = await api('/app/partner/inquiries?status=new', {token: broker});
        assert.equal(inbox.status, 200, JSON.stringify(inbox.body));
        assert.equal(inbox.body.items[0].customer.phone, CUSTOMER);

        const landlordCannot = await api(`/app/partner/inquiries/${inquiryId}/respond`, {
            method: 'POST',
            token: landlord,
            body: {status: 'accepted', response: 'Yes'},
        });
        assert.equal(landlordCannot.status, 403);

        const noReason = await api(`/app/partner/inquiries/${inquiryId}/respond`, {method: 'POST', token: broker, body: {status: 'rejected'}});
        assert.equal(noReason.status, 400);

        const accepted = await api(`/app/partner/inquiries/${inquiryId}/respond`, {
            method: 'POST',
            token: broker,
            body: {status: 'accepted', response: 'Welcome'},
        });
        assert.equal(accepted.status, 200, JSON.stringify(accepted.body));

        const checkout = await api(`/app/properties/${propertyId}/checkout`, {method: 'POST', token: customer, body: {leaseMonths: 12}});
        assert.equal(checkout.status, 201, JSON.stringify(checkout.body));
        await money.reconcilePayment(checkout.body.paymentId, {note: 'Seen on the statement'}, 'finance@homemate.co.tz');

        const tracker = await api(`/app/partner/inquiries/${inquiryId}/journey`, {token: broker});
        assert.equal(tracker.status, 200);
        assert.equal(tracker.body.steps.find((s) => s.key === 'payment_verified').state, 'done');
        assert.equal(tracker.body.earning.yourShare, 450000);

        const moving = await api('/app/landlord/tenancies?status=moving_in', {token: landlord});
        assert.equal(moving.status, 200, JSON.stringify(moving.body));
        const tenancyId = moving.body.items[0].id;

        const today = new Date().toISOString().slice(0, 10);
        const strangerMove = await api(`/app/landlord/tenancies/${tenancyId}/move-in`, {method: 'POST', token: broker, body: {date: today}});
        assert.equal(strangerMove.status, 404);

        const moved = await api(`/app/landlord/tenancies/${tenancyId}/move-in`, {method: 'POST', token: landlord, body: {date: today}});
        assert.equal(moved.status, 200, JSON.stringify(moved.body));
        assert.equal(moved.body.stage, 'current');

        const lease = await api(`/app/landlord/tenancies/${tenancyId}/lease`, {token: landlord});
        assert.equal(lease.status, 200);

        const ended = await api(`/app/landlord/tenancies/${tenancyId}/end`, {method: 'POST', token: landlord, body: {date: today}});
        assert.equal(ended.status, 200, JSON.stringify(ended.body));
        assert.equal(ended.body.stage, 'past');
    });

    test('the partner inbox needs a partner role', async () => {
        const customer = await register(CUSTOMER);
        assert.equal((await api('/app/partner/inquiries', {token: customer})).status, 403);
        assert.equal((await api('/app/partner/inquiries')).status, 401);
        assert.deepEqual((await api('/app/landlord/tenancies', {token: customer})).body, {items: []});
    });
});
