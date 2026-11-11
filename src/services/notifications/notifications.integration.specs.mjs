import {test, describe, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createCustomerAppService} from '../customer-app/service.mjs';
import {createCustomerJourneyService} from '../customer-app/journey.mjs';
import {createMoneyService} from '../admin-console/money.mjs';
import {createKycService} from '../admin-console/kyc.mjs';
import {createSandboxPaymentAdapter} from '../payments/adapters/sandbox-payment.adapter.mjs';
import {createSandboxNotificationAdapter} from '../identity-access/adapters/sandbox-notification.adapter.mjs';
import {createSmsOutbox} from './sms-outbox.mjs';

/**
 * Event notifications (migrations 033–034): every important event reaches the
 * right person's inbox for the role it concerns, and money reaching someone
 * also queues an SMS that the outbox sends after commit.
 */

const FINANCE = 'finance@homemate.co.tz';

describe('event notifications (Postgres integration)', () => {
    /** @type {pg.Pool} */
    let pool;
    let app;
    let journey;
    let money;
    let kyc;
    let smsPort;
    let outbox;
    let dictionaryIds;
    let broker;
    let landlord;
    let customer;

    before(async () => {
        pool = new pg.Pool({connectionString: process.env.DATABASE_URL});
        app = createCustomerAppService({pool});
        money = createMoneyService({pool});
        kyc = createKycService({pool, storagePort: null});
        journey = createCustomerJourneyService({
            pool,
            paymentPorts: {sandbox: createSandboxPaymentAdapter(), manual: createSandboxPaymentAdapter()},
        });
        const {rows} = await pool.query(`select code, id from dictionary_items where code in ('apartment', 'dar_es_salaam')`);
        dictionaryIds = Object.fromEntries(rows.map((r) => [r.code, r.id]));
    });

    after(async () => {
        await pool.end();
    });

    beforeEach(async () => {
        await pool.query(`truncate table
            sms_outbox, notifications, payment_instructions, ledger_entries, payment_splits, external_payment_events,
            payouts, payments, lease_agreements, property_holds, bookings, property_viewings, property_inquiries,
            kyc_remediations, property_parties, property_media, properties, users, organizations
            restart identity cascade`);
        await pool.query(
            `update settings set value = '50'::jsonb where key = 'commission.tenant_fee_percentage';
             update settings set value = '10'::jsonb where key = 'commission.platform_percentage';`
        );
        broker = await makeUser('+255714200001', 'Juma Broker', 'broker');
        landlord = await makeUser('+255714200002', 'Amina Landlord', 'landlord');
        customer = await makeUser('+255714200003', 'Neema Customer', 'customer');
        await pool.query(
            `update users set payout_method = 'mobile_money', mobile_money_provider = 'mpesa',
                              mobile_money_account_name = full_name, mobile_money_number = phone_number
              where id = any($1::uuid[])`,
            [[broker, landlord]]
        );
        smsPort = createSandboxNotificationAdapter();
        outbox = createSmsOutbox({pool, smsPort});
    });

    async function makeUser(phone, name, role) {
        const {rows} = await pool.query(
            `insert into users (phone_number, full_name, role, status) values ($1, $2, $3, 'active') returning id`,
            [phone, name, role]
        );
        return rows[0].id;
    }

    /** A home on the market; `until: 'pending_review'` stops short of approval. */
    async function makeHome({brokerId = broker, until = 'approved'} = {}) {
        const {rows} = await pool.query(
            `insert into properties (title, owner_id, price, property_type_id, region_id, deposit_months, advance_rent_months,
                                     min_lease_months, location, status)
             values ('Sea view flat', $1, 1000000, $2, $3, 1, 0, 12,
                     st_setsrid(st_makepoint(39.27, -6.75), 4326)::geography, 'draft')
             returning id`,
            [landlord, dictionaryIds.apartment, dictionaryIds.dar_es_salaam]
        );
        const id = rows[0].id;
        await pool.query(`insert into property_parties (property_id, user_id, role, is_primary) values ($1, $2, 'landlord', true)`, [id, landlord]);
        if (brokerId) {
            await pool.query(`insert into property_parties (property_id, user_id, role, is_primary) values ($1, $2, 'broker', true)`, [id, brokerId]);
        }
        await pool.query(`update properties set status = 'pending_review' where id = $1`, [id]);
        if (until === 'approved') await pool.query(`update properties set status = 'approved' where id = $1`, [id]);
        return id;
    }

    async function methodId() {
        const {rows} = await pool.query(`update payment_methods set is_active = true where code = 'mpesa' returning id`);
        if (rows.length > 0) return rows[0].id;
        const {rows: made} = await pool.query(
            `insert into payment_methods (code, name, kind, provider, is_active)
             values ('mpesa', 'M-Pesa', 'mobile_money', 'sandbox', true) returning id`
        );
        return made[0].id;
    }

    async function checkout(propertyId) {
        const inquiry = await app.createInquiry(customer, {propertyId, message: 'Still free?'});
        await pool.query(`update property_inquiries set status = 'accepted', response = 'Yes' where id = $1`, [inquiry.id]);
        const started = await journey.startCheckout(customer, propertyId, {leaseMonths: 12});
        await journey.payNow(customer, started.paymentId, {paymentMethodId: await methodId()});
        return {...started, inquiryId: inquiry.id};
    }

    async function inbox(userId) {
        const {rows} = await pool.query(
            `select kind::text, title, body, subject_table, subject_id, audience
               from notifications where user_id = $1 order by created_at, title`,
            [userId]
        );
        return rows;
    }

    test('a new enquiry reaches the broker who answers it and the landlord, each in their own inbox', async () => {
        const home = await makeHome();
        const inquiry = await app.createInquiry(customer, {propertyId: home, message: 'Is it free in May?'});

        const [toBroker] = (await inbox(broker)).filter((n) => n.kind === 'enquiry_received');
        assert.equal(toBroker.audience, 'broker');
        assert.equal(toBroker.subject_table, 'property_inquiries');
        assert.equal(toBroker.subject_id, inquiry.id);
        assert.match(toBroker.body, /Neema Customer asked about Sea view flat/);

        const [toLandlord] = (await inbox(landlord)).filter((n) => n.kind === 'enquiry_received');
        assert.equal(toLandlord.audience, 'landlord');
        assert.match(toLandlord.body, /The broker who listed it will reply/);

        assert.equal((await inbox(customer)).filter((n) => n.kind === 'enquiry_received').length, 0);
    });

    test('a verified payment tells the customer once, each partner their share, and texts the customer a receipt', async () => {
        const home = await makeHome();
        const {paymentId} = await checkout(home);
        await money.reconcilePayment(paymentId, {note: 'On the statement'}, FINANCE);

        // The reservation it confirmed already says so; no second "Payment received" beside it.
        const customerMoney = (await inbox(customer)).filter((n) => ['booking_update', 'payment_received'].includes(n.kind));
        assert.deepEqual(customerMoney.map((n) => n.title), ['Payment verified — the home is yours']);
        assert.equal(customerMoney[0].audience, 'customer');

        const [brokerShare] = (await inbox(broker)).filter((n) => n.kind === 'payment_received');
        assert.equal(brokerShare.audience, 'broker');
        assert.equal(brokerShare.subject_table, 'payment_splits');
        assert.match(brokerShare.body, /Neema Customer paid for Sea view flat\. Your share is TZS [\d,]+/);
        const [landlordShare] = (await inbox(landlord)).filter((n) => n.kind === 'payment_received');
        assert.equal(landlordShare.audience, 'landlord');

        const {rows: queued} = await pool.query('select template, phone_number, status, params from sms_outbox');
        assert.equal(queued.length, 1);
        assert.equal(queued[0].template, 'payment-received');
        assert.equal(queued[0].phone_number, '+255714200003');
        assert.equal(queued[0].params.property, 'Sea view flat');

        assert.deepEqual(await outbox.drain(), {sent: 1, failed: 0});
        assert.equal(smsPort.sentMessages[0].to, '+255714200003');
        const {rows: sent} = await pool.query('select status, provider, sent_at from sms_outbox');
        assert.equal(sent[0].status, 'sent');
        assert.equal(sent[0].provider, 'sandbox');
        assert.ok(sent[0].sent_at);
        assert.deepEqual(await outbox.drain(), {sent: 0, failed: 0}, 'a sent receipt is not sent again');
    });

    test('a payment finance could not verify tells the customer why', async () => {
        const {paymentId} = await checkout(await makeHome());
        await money.failPayment(paymentId, {reason: 'No such transaction on the statement.'}, FINANCE);

        const [failed] = (await inbox(customer)).filter((n) => n.subject_table === 'payments' && n.kind === 'payment_due'
            && n.title === 'We could not verify your payment');
        assert.match(failed.body, /No such transaction on the statement\. If you have paid, contact us and quote HM-/);
        assert.equal((await pool.query('select 1 from sms_outbox')).rowCount, 0, 'only money arriving is texted');
    });

    test('a payout sent reaches the partner in the app and by SMS; a hold only in the app', async () => {
        const {paymentId} = await checkout(await makeHome());
        await money.reconcilePayment(paymentId, {}, FINANCE);
        await pool.query(`update users set kyc_status = 'verified' where id = $1`, [broker]);

        const payout = await money.createPayout({beneficiaryType: 'broker', beneficiaryUserId: broker}, FINANCE);
        await money.changePayoutStatus(payout.id, {status: 'on_hold', reason: 'Checking the number'}, FINANCE);
        await money.changePayoutStatus(payout.id, {status: 'scheduled'}, FINANCE);
        await money.changePayoutStatus(payout.id, {status: 'processing'}, FINANCE);
        await money.changePayoutStatus(payout.id, {status: 'paid', providerReference: 'MP-1'}, FINANCE);

        const payouts = (await inbox(broker)).filter((n) => n.kind === 'payout_update');
        assert.deepEqual(payouts.map((n) => n.title).sort(), ['Payout sent', 'Your payout is on hold']);
        assert.ok(payouts.every((n) => n.audience === 'broker' && n.subject_table === 'payouts'));

        const {rows} = await pool.query(`select template, user_id from sms_outbox order by created_at`);
        assert.deepEqual(rows.map((r) => r.template), ['payment-received', 'payout-sent']);
        assert.equal(rows[1].user_id, broker);
    });

    test('a listing decision reaches the partner who made it', async () => {
        const home = await makeHome({until: 'pending_review'});
        await pool.query('update properties set created_by_user_id = $1 where id = $2', [broker, home]);
        await pool.query(`update properties set status = 'approved' where id = $1`, [home]);

        const [live] = (await inbox(broker)).filter((n) => n.kind === 'listing_update');
        assert.equal(live.title, 'Your listing is live');
        assert.equal(live.audience, 'broker');
        assert.equal(live.subject_id, home);
    });

    test('an identity decision and a request for a new document reach the person, in every inbox', async () => {
        await kyc.openRemediation(customer, {issue: 'Blurred', requestedAction: 'Upload a sharper photo of your ID'}, FINANCE);
        await kyc.reviewUser(customer, {status: 'verified'}, FINANCE);

        const identity = (await inbox(customer)).filter((n) => n.kind === 'kyc_update');
        assert.deepEqual(identity.map((n) => n.title), ['Action needed on your ID', 'Your identity is verified']);
        assert.ok(identity.every((n) => n.audience === null && n.subject_table === 'users'));
    });

    test('each role reads its own inbox, and the account-wide notices in all of them', async () => {
        const home = await makeHome();
        // The broker also rents: one account, two inboxes.
        await app.createInquiry(broker, {propertyId: await makeHome({brokerId: null}), message: 'Free?'});
        await app.createInquiry(customer, {propertyId: home, message: 'Free?'});
        await pool.query(
            `insert into notifications (user_id, kind, title) values ($1, 'system', 'Welcome to HomeMate')`,
            [broker]
        );

        const titles = async (audience) =>
            (await app.listNotifications(broker, {audience})).items.map((n) => n.title).sort();
        assert.deepEqual(await titles('broker'), ['New enquiry', 'Welcome to HomeMate']);
        assert.deepEqual(await titles('customer'), ['Welcome to HomeMate']);
        assert.equal((await app.listNotifications(broker, {})).items.length, 2, 'no audience: everything');

        assert.deepEqual(await app.unreadNotificationCount(broker, {audience: 'broker'}), {unread: 2});
        await app.markAllNotificationsRead(broker, {audience: 'landlord'});
        assert.deepEqual(await app.unreadNotificationCount(broker, {audience: 'broker'}), {unread: 1},
            'marking the landlord inbox read clears only what the landlord inbox shows');

        await assert.rejects(app.listNotifications(broker, {audience: 'admin'}), /audience must be one of/);
    });

    test('an SMS the provider refuses is retried later, then given up', async () => {
        const {paymentId} = await checkout(await makeHome());
        await money.reconcilePayment(paymentId, {}, FINANCE);

        const refusing = createSmsOutbox({
            pool,
            smsPort: {send: async () => { throw new Error('Out of credit'); }},
            maxAttempts: 2,
        });
        assert.deepEqual(await refusing.drain(), {sent: 0, failed: 1});
        let {rows} = await pool.query('select status, attempts, last_error, next_attempt_at > now() as later from sms_outbox');
        assert.deepEqual(rows[0], {status: 'queued', attempts: 1, last_error: 'Out of credit', later: true});

        assert.deepEqual(await refusing.drain(), {sent: 0, failed: 0}, 'not before its retry time');
        await pool.query('update sms_outbox set next_attempt_at = now()');
        await refusing.drain();
        ({rows} = await pool.query('select status, attempts from sms_outbox'));
        assert.deepEqual(rows[0], {status: 'failed', attempts: 2});
    });
});
