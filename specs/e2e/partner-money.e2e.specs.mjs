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
 * T06 over real HTTP: a customer pays for a brokered home, finance verifies
 * and pays the broker out, and the broker's earnings, payouts and home
 * summary follow — while the summaries stay closed to anyone not acting in
 * the role.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BROKER = '+255714200001';
const LANDLORD = '+255714200002';
const CUSTOMER = '+255714200003';
const PIN = '4820';
const FINANCE = 'finance@homemate.co.tz';

describe('journey: broker earnings (e2e)', () => {
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
        await db.query(
            `update users set kyc_status = 'verified', payout_method = 'mobile_money', mobile_money_provider = 'mpesa',
                              mobile_money_account_name = 'Juma', mobile_money_number = phone_number where id = $1`,
            [userIdOf(token)]
        );
        const switched = await api('/app/me/active-role', {method: 'POST', token, body: {role}});
        assert.equal(switched.status, 200, JSON.stringify(switched.body));
        return switched.body.token;
    }

    test('pay → verify → payout → paid shows up in the broker’s earnings, payouts and summary', async () => {
        const broker = await partner(BROKER, 'broker');
        const landlord = await partner(LANDLORD, 'landlord');
        const customer = await register(CUSTOMER);

        const {rows: dict} = await db.query(`select code, id from dictionary_items where code in ('apartment', 'dar_es_salaam')`);
        const ids = Object.fromEntries(dict.map((r) => [r.code, r.id]));
        const {rows} = await db.query(
            `insert into properties (title, owner_id, price, property_type_id, region_id, deposit_months, min_lease_months,
                                     location, status)
             values ('Msasani 2BR', $1, 1000000, $2, $3, 1, 12, st_setsrid(st_makepoint(39.27, -6.75), 4326)::geography, 'draft')
             returning id`,
            [userIdOf(landlord), ids.apartment, ids.dar_es_salaam]
        );
        const propertyId = rows[0].id;
        await db.query(
            `insert into property_parties (property_id, user_id, role, is_primary) values ($1, $2, 'landlord', true), ($1, $3, 'broker', true)`,
            [propertyId, userIdOf(landlord), userIdOf(broker)]
        );
        await db.query(`update properties set status = 'pending_review' where id = $1`, [propertyId]);
        await db.query(`update properties set status = 'approved' where id = $1`, [propertyId]);

        const enquiry = await api('/app/inquiries', {method: 'POST', token: customer, body: {propertyId, message: 'Still free?'}});
        await api(`/app/partner/inquiries/${enquiry.body.id}/respond`, {method: 'POST', token: broker, body: {status: 'accepted', response: 'Yes'}});
        const checkout = await api(`/app/properties/${propertyId}/checkout`, {method: 'POST', token: customer, body: {leaseMonths: 12}});
        assert.equal(checkout.status, 201, JSON.stringify(checkout.body));

        let earnings = await api('/app/partner/earnings', {token: broker});
        assert.equal(earnings.status, 200, JSON.stringify(earnings.body));
        assert.equal(earnings.body.items[0].state, 'being_checked');

        await money.reconcilePayment(checkout.body.paymentId, {note: 'Seen'}, FINANCE);
        const payout = await money.createPayout({beneficiaryType: 'broker', beneficiaryUserId: userIdOf(broker)}, FINANCE);
        await money.changePayoutStatus(payout.id, {status: 'processing'}, FINANCE);
        await money.changePayoutStatus(payout.id, {status: 'paid', providerReference: 'MP-9'}, FINANCE);

        earnings = await api('/app/partner/earnings?role=broker', {token: broker});
        assert.equal(earnings.body.items[0].state, 'paid');
        assert.equal(earnings.body.totals.paid, 450000);
        assert.equal(earnings.body.paidThisYear, 450000);

        const detail = await api(`/app/partner/earnings/${earnings.body.items[0].id}`, {token: broker});
        assert.equal(detail.status, 200);
        assert.equal(detail.body.fee.yourShare, 450000);
        assert.ok(detail.body.timeline.every((step) => step.done));

        const payouts = await api('/app/partner/payouts', {token: broker});
        assert.equal(payouts.body.items[0].providerReference, 'MP-9');
        assert.equal(payouts.body.items[0].destination, '•••• 0001');

        const summary = await api('/app/broker/summary', {token: broker});
        assert.equal(summary.status, 200, JSON.stringify(summary.body));
        assert.equal(summary.body.counts.earnedThisMonth, 450000);

        const landlordEarnings = await api('/app/partner/earnings?role=landlord', {token: landlord});
        assert.equal(landlordEarnings.body.totals.ready, 2000000);
        assert.equal((await api('/app/landlord/summary', {token: landlord})).status, 200);

        // The broker's session is not acting as landlord, and a customer is neither.
        assert.equal((await api('/app/landlord/summary', {token: broker})).status, 403);
        assert.equal((await api('/app/broker/summary', {token: customer})).status, 403);
        assert.equal((await api('/app/partner/earnings', {token: customer})).status, 400);
        assert.equal((await api(`/app/partner/earnings/${earnings.body.items[0].id}`, {token: landlord})).status, 404);
    });
});
