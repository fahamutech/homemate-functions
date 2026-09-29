import {test, describe, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createPartnerMoneyService} from './money.mjs';
import {createCustomerAppService} from '../customer-app/service.mjs';
import {createCustomerJourneyService} from '../customer-app/journey.mjs';
import {createMoneyService} from '../admin-console/money.mjs';
import {createSandboxPaymentAdapter} from '../payments/adapters/sandbox-payment.adapter.mjs';
import {ErrorCodes} from '../../shared/errors.mjs';

/**
 * Partner money (T06, migration 031): real checkouts write the splits the
 * way fees.mjs builds them, finance verifies and pays out in the backoffice,
 * and the broker and the landlord each see their own share move through
 * being_checked → ready → in_payout → paid (or on_hold, or reversed).
 */

const FINANCE = 'finance@homemate.co.tz';

function expectDomainError(code) {
    return (error) => {
        assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
        return true;
    };
}

describe('partner money (Postgres integration)', () => {
    /** @type {pg.Pool} */
    let pool;
    let partnerMoney;
    let app;
    let journey;
    let money;
    let dictionaryIds;
    let broker;
    let otherBroker;
    let landlord;
    let selfLandlord;
    let customer;

    before(async () => {
        pool = new pg.Pool({connectionString: process.env.DATABASE_URL});
        partnerMoney = createPartnerMoneyService({pool});
        app = createCustomerAppService({pool});
        money = createMoneyService({pool});
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
            notifications, payment_instructions, ledger_entries, payment_splits, external_payment_events, payouts,
            payments, lease_agreements, property_holds, bookings, property_viewings, property_inquiries,
            property_parties, property_media, properties, users, organizations
            restart identity cascade`);
        await pool.query(
            `update settings set value = '50'::jsonb where key = 'commission.tenant_fee_percentage';
             update settings set value = '10'::jsonb where key = 'commission.platform_percentage';`
        );
        broker = await makeUser('+255714100001', 'Juma Broker', 'broker');
        otherBroker = await makeUser('+255714100002', 'Other Broker', 'broker');
        landlord = await makeUser('+255714100003', 'Amina Landlord', 'landlord');
        selfLandlord = await makeUser('+255714100004', 'Baraka Landlord', 'landlord');
        customer = await makeUser('+255714100005', 'Neema Customer', 'customer');
        // Payouts to a verified person with an account on file are scheduled, not held.
        await pool.query(
            `update users set kyc_status = 'verified', payout_method = 'mobile_money', mobile_money_provider = 'mpesa',
                              mobile_money_account_name = full_name, mobile_money_number = phone_number
              where id = any($1::uuid[])`,
            [[broker, landlord, selfLandlord]]
        );
    });

    async function makeUser(phone, name, role) {
        const {rows} = await pool.query(
            `insert into users (phone_number, full_name, role, status) values ($1, $2, $3, 'active') returning id`,
            [phone, name, role]
        );
        return rows[0].id;
    }

    async function makeHome({landlordId, brokerId = null, price = 1000000}) {
        const {rows} = await pool.query(
            `insert into properties (title, owner_id, price, property_type_id, region_id, deposit_months, advance_rent_months,
                                     min_lease_months, location, status)
             values ($5, $1, $2::numeric, $3, $4, 1, 0, 12, st_setsrid(st_makepoint(39.27, -6.75), 4326)::geography, 'draft')
             returning id`,
            [landlordId, price, dictionaryIds.apartment, dictionaryIds.dar_es_salaam, brokerId ? 'Brokered home' : 'Own home']
        );
        const id = rows[0].id;
        await pool.query(`insert into property_parties (property_id, user_id, role, is_primary) values ($1, $2, 'landlord', true)`, [id, landlordId]);
        if (brokerId) {
            await pool.query(`insert into property_parties (property_id, user_id, role, is_primary) values ($1, $2, 'broker', true)`, [id, brokerId]);
        }
        await pool.query(`update properties set status = 'pending_review' where id = $1`, [id]);
        await pool.query(`update properties set status = 'approved' where id = $1`, [id]);
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

    /** Enquire → accepted → checkout (splits written by fees.mjs); the payment is pending. */
    async function checkout(propertyId) {
        const inquiry = await app.createInquiry(customer, {propertyId, message: 'Still free?'});
        await pool.query(`update property_inquiries set status = 'accepted', response = 'Yes' where id = $1`, [inquiry.id]);
        const started = await journey.startCheckout(customer, propertyId, {leaseMonths: 12});
        await journey.payNow(customer, started.paymentId, {paymentMethodId: await methodId()});
        // The tenant says they have paid: what puts a payment in front of finance.
        await pool.query('update payments set customer_declared_paid_at = now() where id = $1', [started.paymentId]);
        return started;
    }

    const verify = (paymentId) => money.reconcilePayment(paymentId, {note: 'Seen on the statement'}, FINANCE);
    const byState = (earnings) => Object.fromEntries(earnings.items.map((e) => [e.state, e]));

    test('a checkout on a brokered home splits into landlord, broker and HomeMate, each with its purpose', async () => {
        const home = await makeHome({landlordId: landlord, brokerId: broker});
        const {paymentId} = await checkout(home);

        const {rows} = await pool.query(
            `select beneficiary_type::text, component, amount from payment_splits where payment_id = $1
              order by array_position(array['landlord', 'broker', 'platform']::beneficiary_type[], beneficiary_type)`,
            [paymentId]
        );
        // rent 1,000,000 + deposit 1,000,000 + fee 500,000; HomeMate 10% of the fee.
        assert.deepEqual(rows.map((r) => [r.beneficiary_type, r.component, Number(r.amount)]), [
            ['landlord', 'rent_and_deposit', 2000000],
            ['broker', 'fee_share', 450000],
            ['platform', 'fee_share', 50000],
        ]);
    });

    test('every state, for the broker and for the landlord', async () => {
        const home = await makeHome({landlordId: landlord, brokerId: broker});
        const {paymentId} = await checkout(home);

        let brokerView = await partnerMoney.earnings(broker, 'broker', {});
        assert.equal(brokerView.items.length, 1);
        const item = brokerView.items[0];
        assert.equal(item.state, 'being_checked');
        assert.equal(Number(item.amount), 450000);
        assert.equal(item.purpose, 'fee_share');
        assert.equal(item.propertyTitle, 'Brokered home');
        assert.equal(item.tenantName, 'Neema Customer');
        assert.ok(item.paymentReference);
        assert.equal(brokerView.totals.being_checked, 450000);

        await verify(paymentId);
        brokerView = await partnerMoney.earnings(broker, 'broker', {});
        assert.equal(brokerView.items[0].state, 'ready');
        assert.equal(brokerView.totals.ready, 450000);
        const landlordView = await partnerMoney.earnings(landlord, 'landlord', {});
        assert.equal(landlordView.items[0].state, 'ready');
        assert.equal(landlordView.items[0].purpose, 'rent_and_deposit');
        assert.equal(landlordView.totals.ready, 2000000);

        const payout = await money.createPayout({beneficiaryType: 'broker', beneficiaryUserId: broker}, FINANCE);
        assert.equal(byState(await partnerMoney.earnings(broker, 'broker', {})).in_payout.payoutReference, payout.reference);

        await money.changePayoutStatus(payout.id, {status: 'on_hold', reason: 'Checking the number'}, FINANCE);
        const held = (await partnerMoney.earnings(broker, 'broker', {})).items[0];
        assert.equal(held.state, 'on_hold');
        assert.equal(held.holdReason, 'Checking the number');

        await money.changePayoutStatus(payout.id, {status: 'scheduled'}, FINANCE);
        await money.changePayoutStatus(payout.id, {status: 'processing'}, FINANCE);
        assert.equal((await partnerMoney.earnings(broker, 'broker', {})).items[0].state, 'in_payout');
        await money.changePayoutStatus(payout.id, {status: 'paid', providerReference: 'MP-123'}, FINANCE);

        brokerView = await partnerMoney.earnings(broker, 'broker', {});
        assert.equal(brokerView.items[0].state, 'paid');
        assert.equal(brokerView.totals.paid, 450000);
        assert.equal(brokerView.paidThisYear, 450000);
        // The landlord's share is theirs to be paid separately; it is still ready.
        assert.equal((await partnerMoney.earnings(landlord, 'landlord', {})).items[0].state, 'ready');

        await pool.query(`update payments set status = 'reversed', failure_reason = 'Chargeback' where id = $1`, [paymentId]);
        assert.equal((await partnerMoney.earnings(landlord, 'landlord', {})).items[0].state, 'reversed');
        assert.equal((await partnerMoney.earnings(broker, 'broker', {})).totals.reversed, 450000);
    });

    test('the detail shows the whole split, the fee arithmetic from the booking, and the timeline', async () => {
        const home = await makeHome({landlordId: landlord, brokerId: broker});
        const {paymentId} = await checkout(home);
        await verify(paymentId);
        const id = (await partnerMoney.earnings(broker, 'broker', {})).items[0].id;

        // Settings change after the booking — the detail must not follow them.
        await pool.query(`update settings set value = '30'::jsonb where key = 'commission.tenant_fee_percentage'`);

        const detail = await partnerMoney.earning(broker, id);
        assert.deepEqual(
            detail.split.map((s) => [s.beneficiary, s.purpose, Number(s.amount), s.you]),
            [
                ['landlord', 'rent_and_deposit', 2000000, false],
                ['broker', 'fee_share', 450000, true],
                ['homemate', 'fee_share', 50000, false],
            ]
        );
        assert.deepEqual(detail.fee, {
            monthlyRent: 1000000,
            feePercentage: 50,
            feeAmount: 500000,
            platformPercentage: 10,
            platformAmount: 50000,
            yourShare: 450000,
        });
        assert.deepEqual(detail.timeline.map((s) => [s.key, s.done]), [
            ['paid', true], ['verified', true], ['payout_created', false], ['paid_out', false],
        ]);
    });

    test('a landlord who listed the home themselves gets the fee share', async () => {
        const home = await makeHome({landlordId: selfLandlord});
        const {paymentId} = await checkout(home);
        await verify(paymentId);

        const {items} = await partnerMoney.earnings(selfLandlord, 'landlord', {});
        assert.equal(items.length, 1);
        // rent + deposit + (fee − HomeMate's 10%) in one row, as checkoutSplits writes it.
        assert.equal(Number(items[0].amount), 2450000);
        const detail = await partnerMoney.earning(selfLandlord, items[0].id);
        assert.equal(detail.fee.yourShare, 450000);
        assert.deepEqual(detail.split.map((s) => s.beneficiary), ['landlord', 'homemate']);
    });

    test('a broker sees only their own splits', async () => {
        const home = await makeHome({landlordId: landlord, brokerId: broker});
        const {paymentId} = await checkout(home);
        await verify(paymentId);

        assert.equal((await partnerMoney.earnings(otherBroker, 'broker', {})).items.length, 0);
        assert.equal((await partnerMoney.earnings(broker, 'landlord', {})).items.length, 0, 'not the landlord’s either');
        const theirs = (await partnerMoney.earnings(broker, 'broker', {})).items[0].id;
        await assert.rejects(partnerMoney.earning(otherBroker, theirs), expectDomainError(ErrorCodes.NOT_FOUND));
        const landlordSplit = (await partnerMoney.earnings(landlord, 'landlord', {})).items[0].id;
        await assert.rejects(partnerMoney.earning(broker, landlordSplit), expectDomainError(ErrorCodes.NOT_FOUND));
    });

    test('earnings are paginated, with totals over everything', async () => {
        for (let i = 0; i < 3; i += 1) {
            const home = await makeHome({landlordId: landlord, brokerId: broker, price: 1000000 + i});
            const {paymentId} = await checkout(home);
            await verify(paymentId);
        }
        const page = await partnerMoney.earnings(broker, 'broker', {limit: 2});
        assert.equal(page.items.length, 2);
        assert.equal(page.pagination.total, 3);
        assert.equal(page.pagination.hasMore, true);
        assert.ok(page.totals.ready > 1350000 - 1);
    });

    test('payouts show reference, status, hold reason and a masked destination', async () => {
        const home = await makeHome({landlordId: landlord, brokerId: broker});
        const {paymentId} = await checkout(home);
        await verify(paymentId);
        const payout = await money.createPayout({beneficiaryType: 'broker', beneficiaryUserId: broker}, FINANCE);
        await money.changePayoutStatus(payout.id, {status: 'on_hold', reason: 'Checking the number'}, FINANCE);

        const {items, account} = await partnerMoney.payouts(broker, 'broker');
        assert.equal(items.length, 1);
        assert.equal(items[0].reference, payout.reference);
        assert.equal(Number(items[0].amount), 450000);
        assert.equal(items[0].status, 'on_hold');
        assert.equal(items[0].holdReason, 'Checking the number');
        assert.equal(items[0].destination, '•••• 0001');
        assert.deepEqual(account, {method: 'mobile_money', provider: 'mpesa', accountName: 'Juma Broker', accountNumber: '•••• 0001'});
        assert.equal((await partnerMoney.payouts(broker, 'landlord')).items.length, 0);
    });

    describe('home summaries', () => {
        test('the broker: live listings, open enquiries, earned this month, and what needs them', async () => {
            const home = await makeHome({landlordId: landlord, brokerId: broker});
            const {paymentId} = await checkout(home);
            await app.createInquiry(await makeUser('+255714100006', 'Second Customer', 'customer'), {propertyId: home, message: 'Hi'});
            const changes = await makeHome({landlordId: landlord, brokerId: broker});
            await pool.query(`update properties set status = 'suspended' where id = $1`, [changes]);

            let summary = await partnerMoney.brokerSummary(broker);
            assert.equal(summary.counts.liveListings, 1);
            assert.equal(summary.counts.openEnquiries, 1);
            assert.equal(Number(summary.counts.earnedThisMonth), 0);
            assert.deepEqual(summary.needsYou.map((n) => n.kind).sort(), ['enquiry', 'payment_checking']);

            await verify(paymentId);
            summary = await partnerMoney.brokerSummary(broker);
            assert.equal(Number(summary.counts.earnedThisMonth), 450000);
            assert.ok(summary.needsYou.some((n) => n.kind === 'payment_verified'));
            for (const item of summary.needsYou) {
                assert.ok(item.title && item.subtitle && item.targetId, JSON.stringify(item));
            }

            assert.deepEqual((await partnerMoney.brokerSummary(otherBroker)).counts, {liveListings: 0, openEnquiries: 0, earnedThisMonth: 0});
        });

        test('the landlord: homes, let, paid this month, confirmations and move-ins', async () => {
            const own = await makeHome({landlordId: selfLandlord});
            const {paymentId} = await checkout(own);
            await verify(paymentId);
            await makeHome({landlordId: selfLandlord});

            const summary = await partnerMoney.landlordSummary(selfLandlord);
            assert.equal(summary.counts.homes, 2);
            assert.equal(summary.counts.let, 1);
            assert.equal(Number(summary.counts.paidThisMonth), 2450000);
            const kinds = summary.needsYou.map((n) => n.kind);
            assert.ok(kinds.includes('move_in'), 'the lease starts today, so moving in is due');
            assert.ok(kinds.includes('payment_verified'));
        });

        test('a landlord is asked to confirm a broker’s listing, and never to answer its enquiries', async () => {
            const {rows} = await pool.query(
                `insert into properties (title, owner_id, created_by_user_id, status) values ('Pending home', $1, $2, 'draft') returning id`,
                [landlord, broker]
            );
            await pool.query(`insert into property_parties (property_id, user_id, role, is_primary) values ($1, $2, 'broker', true)`, [rows[0].id, broker]);
            await pool.query(`insert into property_parties (property_id, user_id, role, is_primary) values ($1, $2, 'landlord', true)`, [rows[0].id, landlord]);
            const brokered = await makeHome({landlordId: landlord, brokerId: broker});
            await app.createInquiry(customer, {propertyId: brokered, message: 'Hi'});

            const kinds = (await partnerMoney.landlordSummary(landlord)).needsYou.map((n) => n.kind);
            assert.deepEqual(kinds, ['confirm_listing']);
        });
    });
});
