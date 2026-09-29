import {test, describe, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createPartnerEnquiriesService} from './enquiries.mjs';
import {createLandlordTenanciesService} from './tenancies.mjs';
import {createCustomerOpsService} from '../admin-console/customer-ops.mjs';
import {createCustomerAppService} from '../customer-app/service.mjs';
import {createCustomerJourneyService} from '../customer-app/journey.mjs';
import {createMoneyService} from '../admin-console/money.mjs';
import {createSandboxPaymentAdapter} from '../payments/adapters/sandbox-payment.adapter.mjs';
import {ErrorCodes} from '../../shared/errors.mjs';

/**
 * Partner enquiries and landlord tenancies (T05, migration 030): a broker
 * answers the enquiries on homes they listed, a landlord answers on homes they
 * listed themselves and only reads the rest, and a landlord moves tenants in
 * and ends tenancies on their own homes — under the same date rules the
 * backoffice now obeys.
 */

function expectDomainError(code, pattern) {
    return (error) => {
        assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
        if (pattern) assert.match(error.message, pattern);
        return true;
    };
}

describe('partner enquiries and landlord tenancies (Postgres integration)', () => {
    /** @type {pg.Pool} */
    let pool;
    let enquiries;
    let tenancies;
    let customerOps;
    let app;
    let journey;
    let money;
    let dictionaryIds;
    let broker;
    let otherBroker;
    let landlord;
    let selfLandlord;
    let customer;
    let brokeredHome;
    let selfListedHome;

    before(async () => {
        pool = new pg.Pool({connectionString: process.env.DATABASE_URL});
        customerOps = createCustomerOpsService({pool});
        enquiries = createPartnerEnquiriesService({pool, customerOps});
        tenancies = createLandlordTenanciesService({pool, customerOps});
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
        await pool.query('truncate table audit_log restart identity');
        await pool.query(
            `update settings set value = '50'::jsonb where key = 'commission.tenant_fee_percentage';
             update settings set value = '10'::jsonb where key = 'commission.platform_percentage';`
        );

        broker = await makeUser('+255713900001', 'Juma Broker', 'broker');
        otherBroker = await makeUser('+255713900002', 'Other Broker', 'broker');
        landlord = await makeUser('+255713900003', 'Amina Landlord', 'landlord');
        selfLandlord = await makeUser('+255713900004', 'Baraka Landlord', 'landlord');
        customer = await makeUser('+255713900005', 'Neema Customer', 'customer');

        brokeredHome = await makeProperty({landlordId: landlord, brokerId: broker, price: 1000000});
        selfListedHome = await makeProperty({landlordId: selfLandlord, price: 800000});
    });

    async function makeUser(phone, name, role) {
        const {rows} = await pool.query(
            `insert into users (phone_number, full_name, role, status) values ($1, $2, $3, 'active') returning id`,
            [phone, name, role]
        );
        return rows[0].id;
    }

    async function makeProperty({landlordId, brokerId = null, price}) {
        const {rows} = await pool.query(
            `insert into properties (title, owner_id, price, property_type_id, region_id, deposit_months,
                                     min_lease_months, notice_period_days, location, status)
             values ('Home ' || $2::text, $1, $2::numeric, $3, $4, 1, 12, 90,
                     st_setsrid(st_makepoint(39.27, -6.75), 4326)::geography, 'draft')
             returning id`,
            [landlordId, price, dictionaryIds.apartment, dictionaryIds.dar_es_salaam]
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

    const enquire = (propertyId, extra = {}) =>
        app.createInquiry(customer, {
            propertyId,
            message: 'Is it still free?',
            moveInDate: '2026-11-01',
            occupants: 2,
            budgetAmount: 1000000,
            contactPreference: 'whatsapp',
            preferredContactTime: 'evenings',
            ...extra,
        });

    async function activeMethodId() {
        const {rows} = await pool.query(`update payment_methods set is_active = true where code = 'mpesa' returning id`);
        if (rows.length > 0) return rows[0].id;
        const {rows: made} = await pool.query(
            `insert into payment_methods (code, name, kind, provider, is_active)
             values ('mpesa', 'M-Pesa', 'mobile_money', 'sandbox', true) returning id`
        );
        return made[0].id;
    }

    /** Enquire → accepted by the answering partner → pay → verified; returns the confirmed booking. */
    async function confirmedTenancy(propertyId, answerer, role, {leaseStart = null} = {}) {
        const inquiry = await enquire(propertyId);
        await enquiries.respond(answerer, role, inquiry.id, {status: 'accepted', response: 'Welcome'});
        const checkout = await journey.startCheckout(customer, propertyId, {leaseMonths: 12});
        await journey.payNow(customer, checkout.paymentId, {paymentMethodId: await activeMethodId()});
        await money.reconcilePayment(checkout.paymentId, {note: 'Seen on the statement'}, 'finance@homemate.co.tz');
        if (leaseStart) {
            await pool.query(`update bookings set lease_start_date = $2, lease_end_date = $2::date + 365 where id = $1`, [
                checkout.bookingId,
                leaseStart,
            ]);
        }
        return {inquiry, bookingId: checkout.bookingId};
    }

    const today = () => new Date().toISOString().slice(0, 10);
    const daysFromNow = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

    describe('enquiries', () => {
        test('a broker sees the enquiry with everything the customer said, and the phone', async () => {
            const inquiry = await enquire(brokeredHome);

            const list = await enquiries.list(broker, 'broker', {status: 'new'});
            assert.equal(list.items.length, 1);
            const item = list.items[0];
            assert.equal(item.id, inquiry.id);
            assert.equal(item.moveInDate, '2026-11-01');
            assert.equal(item.occupants, 2);
            assert.equal(Number(item.budgetAmount), 1000000);
            assert.equal(item.contactPreference, 'whatsapp');
            assert.equal(item.preferredContactTime, 'evenings');
            assert.equal(item.customer.name, 'Neema Customer');
            assert.equal(item.customer.phone, '+255713900005');
            assert.equal(item.customer.idVerified, false);
            assert.equal(item.canAnswer, true);

            assert.equal((await enquiries.list(broker, 'broker', {status: 'accepted'})).items.length, 0);
            await assert.rejects(enquiries.list(broker, 'broker', {status: 'bogus'}), expectDomainError(ErrorCodes.VALIDATION_FAILED));
        });

        test('broker accepts → the customer can check out, and is told', async () => {
            const inquiry = await enquire(brokeredHome);
            const before = await journey.checkoutEligibility(customer, brokeredHome);
            assert.equal(before.canPay, false);

            const answered = await enquiries.respond(broker, 'broker', inquiry.id, {status: 'accepted', response: 'You can move in'});
            assert.equal(answered.status, 'accepted');

            const {rows} = await pool.query('select responded_by from property_inquiries where id = $1', [inquiry.id]);
            assert.equal(rows[0].responded_by, broker);
            const after = await journey.checkoutEligibility(customer, brokeredHome);
            assert.equal(after.canPay, true);
            const {rows: notes} = await pool.query(`select kind::text from notifications where user_id = $1`, [customer]);
            assert.ok(notes.some((n) => n.kind === 'inquiry_response'));
            assert.equal((await enquiries.list(broker, 'broker', {status: 'accepted'})).items.length, 1);
        });

        test('declining without a reason is refused; with one it is sent', async () => {
            const inquiry = await enquire(brokeredHome);
            await assert.rejects(
                enquiries.respond(broker, 'broker', inquiry.id, {status: 'rejected'}),
                expectDomainError(ErrorCodes.VALIDATION_FAILED, /why/)
            );
            const declined = await enquiries.respond(broker, 'broker', inquiry.id, {status: 'rejected', rejectionReason: 'Already let'});
            assert.equal(declined.status, 'rejected');
            assert.equal(declined.rejectionReason, 'Already let');
            assert.equal((await enquiries.list(broker, 'broker', {status: 'closed'})).items.length, 1);
        });

        test('closing without replying is allowed and tells the customer nothing new (BRK-041)', async () => {
            const inquiry = await enquire(brokeredHome);
            await assert.rejects(
                enquiries.respond(broker, 'broker', inquiry.id, {status: 'responded'}),
                expectDomainError(ErrorCodes.VALIDATION_FAILED, /reply/)
            );
            const closed = await enquiries.respond(broker, 'broker', inquiry.id, {status: 'closed'});
            assert.equal(closed.status, 'closed');
            const {rows} = await pool.query(
                `select title from notifications where subject_id = $1 and kind = 'inquiry_response'`, [inquiry.id]
            );
            assert.deepEqual(rows.map((r) => r.title), ['Your enquiry was closed']);
        });

        test('a landlord answers on a home they listed themselves', async () => {
            const inquiry = await enquire(selfListedHome);
            const answered = await enquiries.respond(selfLandlord, 'landlord', inquiry.id, {status: 'responded', response: 'Come and see it'});
            assert.equal(answered.status, 'responded');
            assert.equal(answered.customer.phone, '+255713900005');
        });

        test('a landlord only reads enquiries on a broker-listed home — no phone, no answering', async () => {
            const inquiry = await enquire(brokeredHome);
            const seen = await enquiries.get(landlord, 'landlord', inquiry.id);
            assert.equal(seen.canAnswer, false);
            assert.equal(seen.customer.phone, null);
            assert.equal((await enquiries.list(landlord, 'landlord', {})).items.length, 1);

            await assert.rejects(
                enquiries.respond(landlord, 'landlord', inquiry.id, {status: 'accepted', response: 'Yes'}),
                expectDomainError(ErrorCodes.FORBIDDEN)
            );
            const {rows} = await pool.query('select status::text from property_inquiries where id = $1', [inquiry.id]);
            assert.equal(rows[0].status, 'pending');
        });

        test('two brokers never see each other’s enquiries', async () => {
            const inquiry = await enquire(brokeredHome);
            assert.equal((await enquiries.list(otherBroker, 'broker', {})).items.length, 0);
            for (const attempt of [
                () => enquiries.get(otherBroker, 'broker', inquiry.id),
                () => enquiries.respond(otherBroker, 'broker', inquiry.id, {status: 'accepted', response: 'Mine'}),
                () => enquiries.journey(otherBroker, 'broker', inquiry.id),
            ]) {
                await assert.rejects(attempt(), expectDomainError(ErrorCodes.NOT_FOUND));
            }
            // Acting as a landlord does not open a broker's listing either.
            await assert.rejects(enquiries.get(broker, 'landlord', inquiry.id), expectDomainError(ErrorCodes.NOT_FOUND));
        });

        test('the journey follows the money, and previews the broker’s earning', async () => {
            const inquiry = await enquire(brokeredHome);
            let tracker = await enquiries.journey(broker, 'broker', inquiry.id);
            const state = (key) => tracker.steps.find((s) => s.key === key).state;
            assert.deepEqual(tracker.steps.map((s) => s.key), [
                'enquiry_received', 'decision', 'awaiting_payment', 'payment_verified', 'moved_in', 'ended',
            ]);
            assert.equal(state('decision'), 'current');
            assert.deepEqual(tracker.earning, {
                basis: 'listing_price',
                monthlyRent: 1000000,
                tenantFee: 500000,
                platformAmount: 50000,
                yourShare: 450000,
                rentGoesTo: 'landlord',
            });
            // BRK-042 "What the customer pays", the checkout formula on the listing.
            assert.deepEqual(tracker.payment, {
                basis: 'listing_price',
                firstRent: 1000000,
                deposit: 1000000,
                advance: 0,
                tenantFee: 500000,
                tenantFeePercentage: 50,
                total: 2500000,
            });

            await enquiries.respond(broker, 'broker', inquiry.id, {status: 'accepted', response: 'Welcome'});
            tracker = await enquiries.journey(broker, 'broker', inquiry.id);
            assert.equal(state('decision'), 'done');
            assert.equal(state('awaiting_payment'), 'current');

            const checkout = await journey.startCheckout(customer, brokeredHome, {leaseMonths: 12});
            await journey.payNow(customer, checkout.paymentId, {paymentMethodId: await activeMethodId()});
            await money.reconcilePayment(checkout.paymentId, {note: 'Seen'}, 'finance@homemate.co.tz');

            tracker = await enquiries.journey(broker, 'broker', inquiry.id);
            assert.equal(state('awaiting_payment'), 'done');
            assert.equal(state('payment_verified'), 'done', 'verifying the payment confirmed the booking (021)');
            assert.equal(state('moved_in'), 'current');
            assert.equal(tracker.earning.basis, 'booking');
            assert.equal(tracker.earning.yourShare, 450000);
            assert.equal(tracker.payment.basis, 'booking');
            assert.equal(tracker.payment.total, 2500000, 'what was actually charged');

            const landlordView = await enquiries.journey(landlord, 'landlord', inquiry.id);
            assert.equal(landlordView.earning.yourShare, 0, 'the broker earns the fee on a brokered home');
        });
    });

    describe('tenancies', () => {
        test('a landlord sees a paid tenancy as moving in, with tenant, dates and payments', async () => {
            const {bookingId} = await confirmedTenancy(selfListedHome, selfLandlord, 'landlord');

            const list = await tenancies.list(selfLandlord, {status: 'moving_in'});
            assert.equal(list.items.length, 1);
            const item = list.items[0];
            assert.equal(item.id, bookingId);
            assert.equal(item.tenant.name, 'Neema Customer');
            assert.equal(item.tenant.phone, '+255713900005');
            assert.ok(item.nextPaymentDate);
            assert.ok(item.monthsRemaining >= 11);
            assert.ok(item.exitWindowOpensOn);
            assert.equal((await tenancies.list(selfLandlord, {status: 'current'})).items.length, 0);

            const detail = await tenancies.get(selfLandlord, bookingId);
            assert.equal(detail.payments.length, 1);
            assert.equal(detail.payments[0].status, 'successful');

            const lease = await tenancies.lease(selfLandlord, bookingId);
            assert.equal(lease.bookingReference, detail.reference);
        });

        test('the landlord of a broker-listed home still owns its tenancies', async () => {
            const {bookingId} = await confirmedTenancy(brokeredHome, broker, 'broker');
            assert.equal((await tenancies.list(landlord, {})).items[0].id, bookingId);
            assert.equal((await tenancies.list(broker, {})).items.length, 0, 'the broker does not');
        });

        test('move in, then end — both notify the tenant and are audited', async () => {
            const {bookingId} = await confirmedTenancy(selfListedHome, selfLandlord, 'landlord', {leaseStart: today()});

            const moved = await tenancies.moveIn(selfLandlord, bookingId, {date: today()});
            assert.equal(moved.status, 'active');
            assert.equal(moved.stage, 'current');
            assert.equal(moved.moveInDate, today());

            await assert.rejects(tenancies.end(selfLandlord, bookingId, {}), expectDomainError(ErrorCodes.VALIDATION_FAILED, /date/));
            const ended = await tenancies.end(selfLandlord, bookingId, {date: today(), reason: 'Tenant relocated'});
            assert.equal(ended.status, 'completed');
            assert.equal(ended.stage, 'past');
            assert.equal(ended.endedOn, today());
            assert.equal(ended.endReason, 'Tenant relocated');
            assert.equal(ended.nextPaymentDate, null);

            const {rows: notes} = await pool.query(
                `select title from notifications where user_id = $1 and kind = 'booking_update' order by created_at`,
                [customer]
            );
            assert.ok(notes.some((n) => /started/.test(n.title)));
            assert.ok(notes.some((n) => /ended/.test(n.title)));
            const {rows: audit} = await pool.query(
                `select actor from audit_log where table_name = 'bookings' and operation = 'UPDATE' and actor = $1`,
                [selfLandlord]
            );
            assert.ok(audit.length >= 2);
        });

        test('moving in more than a week before the lease starts is refused — for the backoffice too', async () => {
            const {bookingId} = await confirmedTenancy(selfListedHome, selfLandlord, 'landlord', {leaseStart: daysFromNow(30)});

            await assert.rejects(
                tenancies.moveIn(selfLandlord, bookingId, {date: today()}),
                expectDomainError(ErrorCodes.VALIDATION_FAILED, /7 days/)
            );
            await assert.rejects(
                customerOps.changeBookingStatus(bookingId, {status: 'active', date: today()}, 'ops@homemate.co.tz'),
                expectDomainError(ErrorCodes.VALIDATION_FAILED, /7 days/)
            );
            const moved = await tenancies.moveIn(selfLandlord, bookingId, {date: daysFromNow(24)});
            assert.equal(moved.status, 'active');
        });

        test('a move-in date is required and must be a day', async () => {
            const {bookingId} = await confirmedTenancy(selfListedHome, selfLandlord, 'landlord');
            await assert.rejects(tenancies.moveIn(selfLandlord, bookingId, {}), expectDomainError(ErrorCodes.VALIDATION_FAILED));
            await assert.rejects(tenancies.moveIn(selfLandlord, bookingId, {date: 'tomorrow'}), expectDomainError(ErrorCodes.VALIDATION_FAILED));
        });

        test('a landlord cannot touch someone else’s tenancy', async () => {
            const {bookingId} = await confirmedTenancy(selfListedHome, selfLandlord, 'landlord', {leaseStart: today()});
            for (const attempt of [
                () => tenancies.get(landlord, bookingId),
                () => tenancies.lease(landlord, bookingId),
                () => tenancies.moveIn(landlord, bookingId, {date: today()}),
                () => tenancies.end(landlord, bookingId, {date: today()}),
                () => tenancies.moveIn(broker, bookingId, {date: today()}),
            ]) {
                await assert.rejects(attempt(), expectDomainError(ErrorCodes.NOT_FOUND));
            }
            const {rows} = await pool.query('select status::text from bookings where id = $1', [bookingId]);
            assert.equal(rows[0].status, 'confirmed');
        });

        test('the backoffice start/end keeps working, defaulting the day to today', async () => {
            const {bookingId} = await confirmedTenancy(selfListedHome, selfLandlord, 'landlord', {leaseStart: today()});
            const started = await customerOps.changeBookingStatus(bookingId, {status: 'active'}, 'ops@homemate.co.tz');
            assert.equal(started.status, 'active');
            const ended = await customerOps.changeBookingStatus(bookingId, {status: 'completed'}, 'ops@homemate.co.tz');
            assert.equal(ended.status, 'completed');
            const {rows} = await pool.query('select move_in_date::text, ended_on::text from bookings where id = $1', [bookingId]);
            assert.equal(rows[0].ended_on, today());
            assert.ok(rows[0].move_in_date);
        });

        test('an unknown stage is refused', async () => {
            await assert.rejects(tenancies.list(selfLandlord, {status: 'active'}), expectDomainError(ErrorCodes.VALIDATION_FAILED));
        });
    });
});
