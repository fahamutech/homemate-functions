import {test, describe, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {start} from 'bfast-function';
import {smsPort} from '../../src/services/customer-access/container.mjs';
import {pushPort, smsOutbox} from '../../src/services/notifications/container.mjs';
import {createMoneyService} from '../../src/services/admin-console/money.mjs';

/**
 * Notifications over real HTTP, with the server's own push listener running:
 * the phones register their FCM tokens, the journey's events happen through
 * the API, and each one reaches the right person's inbox and phone — the
 * payment receipt by SMS as well. Pushes go through the sandbox PushPort, the
 * same seam the FCM adapter plugs into.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BROKER = '+255714400001';
const LANDLORD = '+255714400002';
const CUSTOMER = '+255714400003';
const PIN = '4820';

describe('notifications: inbox, push and SMS (e2e)', () => {
    /** @type {import('node:http').Server} */
    let server;
    let baseUrl;
    let db;
    let pool;
    let money;

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
        await db.query(`truncate table otp_request_log, auth_otp_challenges, external_notification_events,
                                       push_deliveries, push_devices, sms_outbox, notifications,
                                       payment_instructions, ledger_entries, payment_splits, external_payment_events, payouts,
                                       payments, lease_agreements, property_holds, bookings, property_inquiries,
                                       property_parties, property_media, properties, users, organizations
                        restart identity cascade`);
        smsPort.sentMessages.length = 0;
        pushPort.sentMessages.length = 0;
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

    /** The server pushes on its own, from the commit; wait for it rather than for a fixed time. */
    async function pushed(token, title, timeoutMs = 5_000) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const found = pushPort.sentMessages.find((m) => m.token === token && m.title === title);
            if (found) return found;
            if (Date.now() > deadline) {
                assert.fail(`no push "${title}" to ${token}; pushed: ${JSON.stringify(pushPort.sentMessages.map((m) => [m.token, m.title]))}`);
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }

    test('enquire → accept → pay → verified: every step reaches the right inbox and phone', async () => {
        const broker = await partner(BROKER, 'broker');
        const landlord = await partner(LANDLORD, 'landlord');
        const customer = await register(CUSTOMER);
        const propertyId = await brokeredHome(userIdOf(broker), userIdOf(landlord));

        const brokerPhone = 'fcm-broker-android-0000000001';
        const customerBrowser = 'fcm-customer-web-00000000001';
        for (const [token, fcm, platform] of [[broker, brokerPhone, 'android'], [customer, customerBrowser, 'web']]) {
            const registered = await api('/app/devices', {method: 'POST', token, body: {token: fcm, platform, appVersion: '1.4.0+5'}});
            assert.equal(registered.status, 200, JSON.stringify(registered.body));
        }

        // 1. The customer enquires: the broker's phone buzzes, in the broker inbox.
        const enquiry = await api('/app/inquiries', {method: 'POST', token: customer, body: {propertyId, message: 'Still free?'}});
        assert.equal(enquiry.status, 201, JSON.stringify(enquiry.body));
        const newEnquiry = await pushed(brokerPhone, 'New enquiry');
        assert.deepEqual(
            [newEnquiry.platform, newEnquiry.data.audience, newEnquiry.data.subjectTable, newEnquiry.data.subjectId],
            ['android', 'broker', 'property_inquiries', enquiry.body.id]
        );

        // 2. The broker accepts: the customer's browser gets a link straight to the enquiry.
        const accepted = await api(`/app/partner/inquiries/${enquiry.body.id}/respond`, {
            method: 'POST', token: broker, body: {status: 'accepted', response: 'Welcome, it is yours to take'},
        });
        assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
        const reply = await pushed(customerBrowser, 'You have a reply');
        assert.equal(reply.body, 'Welcome, it is yours to take');
        assert.match(reply.link, /\/#\/open-notification\?notificationId=[0-9a-f-]+&kind=inquiry_response&audience=customer/);

        // 3. Pay, and finance verifies: the home is the customer's, the broker's share is on its way,
        //    and the customer's receipt is texted.
        const checkout = await api(`/app/properties/${propertyId}/checkout`, {method: 'POST', token: customer, body: {leaseMonths: 12}});
        assert.equal(checkout.status, 201, JSON.stringify(checkout.body));
        await money.reconcilePayment(checkout.body.paymentId, {note: 'Seen on the statement'}, 'finance@homemate.co.tz');
        await pushed(customerBrowser, 'Payment verified — the home is yours');
        const share = await pushed(brokerPhone, 'Payment received');
        assert.equal(share.data.subjectTable, 'payment_splits');

        await smsOutbox.drain();
        const receipt = smsPort.sentMessages.find((m) => m.template === 'payment-received');
        assert.equal(receipt.to, CUSTOMER);
        assert.equal(receipt.params.property, 'Oyster Bay 2BR');

        // The inboxes agree with the phones, one per role.
        const brokerInbox = await api('/app/notifications?audience=broker', {token: broker});
        assert.deepEqual(brokerInbox.body.items.map((n) => n.title).sort(), ['New enquiry', 'Payment received']);
        const unread = await api('/app/notifications/unread-count?audience=customer', {token: customer});
        assert.deepEqual(unread.body, {unread: 2});
        const summary = await api('/app/summary', {token: customer});
        assert.equal(summary.body.unreadNotifications, 2);

        // The landlord registered no phone: inbox only.
        const landlordInbox = await api('/app/notifications?audience=landlord', {token: landlord});
        assert.ok(landlordInbox.body.items.some((n) => n.title === 'New enquiry'));
        assert.equal(pushPort.sentMessages.filter((m) => m.data.audience === 'landlord').length, 0);

        const {rows} = await db.query(
            `select push_status, count(*)::int as n from notifications group by push_status order by push_status`
        );
        assert.deepEqual(rows, [{push_status: 'sent', n: 4}, {push_status: 'skipped', n: 2}],
            'broker and customer phones got theirs; the landlord has no phone');
    });

    test('a signed-out phone stops getting pushes; device registration is checked', async () => {
        const customer = await register(CUSTOMER);
        const phone = 'fcm-customer-android-000000002';
        assert.equal((await api('/app/devices', {method: 'POST', token: customer, body: {token: phone, platform: 'android'}})).status, 200);

        const removed = await api('/app/devices/remove', {method: 'POST', token: customer, body: {token: phone}});
        assert.deepEqual(removed.body, {removed: 1});
        await db.query(`insert into notifications (user_id, kind, title) values ($1, 'system', 'After sign-out')`, [userIdOf(customer)]);
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.equal(pushPort.sentMessages.length, 0);

        assert.equal((await api('/app/devices', {method: 'POST', body: {token: phone, platform: 'android'}})).status, 401);
        const badPlatform = await api('/app/devices', {method: 'POST', token: customer, body: {token: phone, platform: 'fax'}});
        assert.equal(badPlatform.status, 400);
        assert.match(badPlatform.body.message ?? JSON.stringify(badPlatform.body), /platform must be one of/);
    });
});
