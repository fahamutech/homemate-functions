import {test, describe, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createCustomerAppService} from './service.mjs';
import {createCustomerJourneyService} from './journey.mjs';
import {createMoneyService} from '../admin-console/money.mjs';
import {createSandboxPaymentAdapter} from '../payments/adapters/sandbox-payment.adapter.mjs';
import {ErrorCodes} from '../../shared/errors.mjs';

/**
 * The half of the journey that is about exclusivity and time, against the real
 * database — because that is where the rules are. A hold is exclusive because
 * of a partial unique index; a nudge has a cooldown because a function says
 * so; a property cannot be paid for twice because the second payer is turned
 * away. None of that can be tested against a fake.
 */

function expectDomainError(code) {
    return (error) => {
        assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
        return true;
    };
}

describe('customer journey (Postgres integration)', () => {
    /** @type {pg.Pool} */
    let pool;
    let app;
    let journey;
    let money;
    let dictionaryIds;
    let landlord;
    let customer;
    let other;
    let propertyId;

    before(async () => {
        pool = new pg.Pool({connectionString: process.env.DATABASE_URL});
        app = createCustomerAppService({pool});
        money = createMoneyService({pool});
        journey = createCustomerJourneyService({
            pool,
            paymentPorts: {sandbox: createSandboxPaymentAdapter(), manual: createSandboxPaymentAdapter()},
        });
        const {rows} = await pool.query(
            `select code, id from dictionary_items where code in ('apartment', 'dar_es_salaam', 'kinondoni', 'masaki')`
        );
        dictionaryIds = Object.fromEntries(rows.map((r) => [r.code, r.id]));
    });

    after(async () => {
        await pool.end();
    });

    beforeEach(async () => {
        await pool.query(`truncate table
            notifications, customer_preferences, saved_properties, payment_instructions,
            ledger_entries, payment_splits, external_payment_events, payouts, payments,
            lease_agreements, property_holds,
            bookings, property_viewings, property_inquiries,
            kyc_remediations, kyc_documents, property_parties, property_media, properties,
            users, organizations
            restart identity cascade`);
        await pool.query('truncate table audit_log restart identity');

        landlord = await makeUser('+255700002001', 'Baraka Landlord', 'landlord');
        customer = await makeUser('+255700002002', 'Neema Customer', 'customer');
        other = await makeUser('+255700002003', 'Juma Other', 'customer');
        propertyId = await makeProperty();
    });

    async function makeUser(phone, name, role) {
        const {rows} = await pool.query(
            `insert into users (phone_number, full_name, role, status) values ($1, $2, $3, 'active') returning id`,
            [phone, name, role]
        );
        return rows[0].id;
    }

    async function makeProperty({approve = true, price = 800000} = {}) {
        const {rows} = await pool.query(
            `insert into properties
                 (title, description, owner_id, price, property_type_id, region_id, district_id, ward_id,
                  bedrooms, deposit_months, advance_rent_months, min_lease_months, notice_period_days,
                  location, status)
             values ('Masaki 2BR Apartment', 'Bright and airy', $1, $2, $3, $4, $5, $6,
                     2, 2, 0, 12, 90, st_setsrid(st_makepoint(39.2768, -6.7576), 4326)::geography, 'draft')
             returning id`,
            [
                landlord,
                price,
                dictionaryIds.apartment,
                dictionaryIds.dar_es_salaam,
                dictionaryIds.kinondoni,
                dictionaryIds.masaki,
            ]
        );
        const id = rows[0].id;
        await pool.query(
            `insert into property_parties (property_id, user_id, role, is_primary) values ($1, $2, 'landlord', true)`,
            [id, landlord]
        );
        if (approve) {
            await pool.query("update properties set status = 'pending_review' where id = $1", [id]);
            await pool.query("update properties set status = 'approved' where id = $1", [id]);
        }
        return id;
    }

    /** Pretends the ten minutes have passed, without waiting ten minutes. */
    async function lapseHolds() {
        await pool.query(
            `update property_holds
                set created_at = now() - interval '20 minutes',
                    expires_at = now() - interval '10 minutes'
              where released_at is null`
        );
    }

    async function activeMethodId(code = 'mpesa') {
        const {rows} = await pool.query(
            `update payment_methods set is_active = true where code = $1 returning id`,
            [code]
        );
        if (rows.length > 0) return rows[0].id;
        const {rows: made} = await pool.query(
            `insert into payment_methods (code, name, kind, provider, is_active)
             values ($1, 'M-Pesa', 'mobile_money', 'sandbox', true) returning id`,
            [code]
        );
        return made[0].id;
    }

    // --- holds ---------------------------------------------------------------

    describe('holding a property while you pay', () => {
        test('gives the first customer ten minutes and turns the second away', async () => {
            const hold = await journey.hold(customer, propertyId);

            assert.equal(hold.customer_id, customer);
            assert.ok(hold.is_live);
            assert.ok(
                hold.seconds_remaining > 570 && hold.seconds_remaining <= 600,
                `expected about ten minutes, got ${hold.seconds_remaining}s`
            );

            await assert.rejects(
                () => journey.hold(other, propertyId),
                expectDomainError(ErrorCodes.CONFLICT)
            );
        });

        test('tells the second customer how long they must wait', async () => {
            await journey.hold(customer, propertyId);

            await assert.rejects(
                () => journey.hold(other, propertyId),
                (error) => {
                    assert.match(error.message, /paying for this property right now/i);
                    assert.match(error.message, /minute/i, 'the wait must be stated, not implied');
                    return true;
                }
            );
        });

        test('re-entering extends the holder’s own window rather than refusing them', async () => {
            const first = await journey.hold(customer, propertyId);
            const second = await journey.hold(customer, propertyId);

            assert.equal(second.id, first.id, 'a second hold row would mean two reservations');
            const {rows} = await pool.query(
                'select count(*)::int as live from property_holds where released_at is null'
            );
            assert.equal(rows[0].live, 1);
        });

        test('a lapsed hold frees the property for the next person', async () => {
            await journey.hold(customer, propertyId);
            await lapseHolds();

            const theirs = await journey.hold(other, propertyId);
            assert.equal(theirs.customer_id, other);

            const {rows} = await pool.query(
                `select count(*)::int as swept from property_holds where release_reason = 'expired'`
            );
            assert.equal(rows[0].swept, 1);
        });

        test('releasing early hands it straight back', async () => {
            const hold = await journey.hold(customer, propertyId);
            await journey.releaseHold(customer, hold.id, 'left the screen');

            const theirs = await journey.hold(other, propertyId);
            assert.equal(theirs.customer_id, other);
        });

        test('a hold belongs to its owner: nobody else can release it', async () => {
            const hold = await journey.hold(customer, propertyId);

            await assert.rejects(
                () => journey.releaseHold(other, hold.id),
                expectDomainError(ErrorCodes.NOT_FOUND)
            );
        });

        test('a property still in moderation cannot be held at all', async () => {
            const draft = await makeProperty({approve: false});

            await assert.rejects(
                () => journey.hold(customer, draft),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
        });
    });

    // --- the three routes into payment ---------------------------------------

    describe('who may pay, and by which route', () => {
        test('someone who has never asked may still pay outright', async () => {
            const eligibility = await journey.checkoutEligibility(customer, propertyId);

            assert.equal(eligibility.canPay, true);
            assert.equal(eligibility.route, 'direct');
        });

        test('an accepted enquiry is recognised as the route in', async () => {
            const inquiry = await app.createInquiry(customer, {
                propertyId,
                message: 'Is this still free?',
            });
            await pool.query("update property_inquiries set status = 'accepted' where id = $1", [
                inquiry.id,
            ]);

            const eligibility = await journey.checkoutEligibility(customer, propertyId);
            assert.equal(eligibility.route, 'inquiry_accepted');
            assert.equal(eligibility.inquiryId, inquiry.id);
            assert.equal(eligibility.canPay, true);
        });

        test('a completed viewing is a route in even with no enquiry behind it', async () => {
            const viewing = await app.requestViewing(customer, {
                propertyId,
                scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
            });
            await pool.query("update property_viewings set status = 'confirmed' where id = $1", [
                viewing.id,
            ]);
            await pool.query("update property_viewings set status = 'completed' where id = $1", [
                viewing.id,
            ]);

            const eligibility = await journey.checkoutEligibility(customer, propertyId);
            assert.equal(eligibility.route, 'viewing_completed');
            assert.equal(eligibility.viewingId, viewing.id);
        });

        test('a declined enquiry closes the door', async () => {
            const inquiry = await app.createInquiry(customer, {propertyId, message: 'Please?'});
            await pool.query(
                `update property_inquiries set status = 'rejected', rejection_reason = 'Already taken' where id = $1`,
                [inquiry.id]
            );

            const eligibility = await journey.checkoutEligibility(customer, propertyId);
            assert.equal(eligibility.canPay, false);
            assert.equal(eligibility.route, 'blocked');

            await assert.rejects(
                () => journey.startCheckout(customer, propertyId),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
        });

        test('the eligibility answer names who is holding it and for how long', async () => {
            await journey.hold(other, propertyId);

            const eligibility = await journey.checkoutEligibility(customer, propertyId);
            assert.equal(eligibility.heldByOther, true);
            assert.equal(eligibility.heldByMe, false);
            assert.ok(eligibility.holdSecondsRemaining > 0);
        });
    });

    // --- checkout ------------------------------------------------------------

    describe('starting a checkout', () => {
        test('creates the booking, the payment and the hold together', async () => {
            const checkout = await journey.startCheckout(customer, propertyId, {leaseMonths: 12});

            assert.ok(checkout.bookingId);
            assert.ok(checkout.paymentId);
            assert.equal(checkout.hold.property_id, propertyId);
            assert.ok(checkout.hold.is_live);

            // deposit is 2 months at 800,000, plus the first month's rent
            assert.equal(checkout.summary.totalDue, 2_400_000);
            assert.equal(checkout.summary.amountOutstanding, 2_400_000);

            const {rows} = await pool.query('select status from bookings where id = $1', [
                checkout.bookingId,
            ]);
            assert.equal(rows[0].status, 'awaiting_payment');
        });

        test('the hold it takes blocks a second customer from starting one', async () => {
            await journey.startCheckout(customer, propertyId);

            await assert.rejects(
                () => journey.startCheckout(other, propertyId),
                expectDomainError(ErrorCodes.CONFLICT)
            );
        });

        test('re-entering reuses the booking rather than stacking a second one', async () => {
            const first = await journey.startCheckout(customer, propertyId);
            const again = await journey.startCheckout(customer, propertyId);

            assert.equal(again.bookingId, first.bookingId);
            assert.equal(again.paymentId, first.paymentId);

            const {rows} = await pool.query(
                'select count(*)::int as bookings from bookings where property_id = $1',
                [propertyId]
            );
            assert.equal(rows[0].bookings, 1);
        });

        test('records which door the customer came through', async () => {
            const inquiry = await app.createInquiry(customer, {propertyId, message: 'Interested'});
            await pool.query("update property_inquiries set status = 'accepted' where id = $1", [
                inquiry.id,
            ]);

            const checkout = await journey.startCheckout(customer, propertyId);
            const {rows} = await pool.query('select inquiry_id from bookings where id = $1', [
                checkout.bookingId,
            ]);
            assert.equal(rows[0].inquiry_id, inquiry.id);
        });

        test('the breakdown accounts for every shilling of the total', async () => {
            const checkout = await journey.startCheckout(customer, propertyId);

            const summed = checkout.summary.breakdown.reduce((total, line) => total + line.amount, 0);
            assert.equal(summed, checkout.summary.totalDue);
            assert.ok(checkout.summary.breakdown.some((line) => line.key === 'deposit'));
            assert.ok(
                checkout.summary.breakdown.some((line) => line.waived),
                'waived charges must still be listed, because "TZS 0" is information'
            );
        });
    });

    // --- paying --------------------------------------------------------------

    describe('paying', () => {
        test('opens a charge, returns instructions, and settles nothing', async () => {
            const checkout = await journey.startCheckout(customer, propertyId);
            const methodId = await activeMethodId();

            const result = await journey.payNow(customer, checkout.paymentId, {
                paymentMethodId: methodId,
                payerPhone: '+255712345678',
            });

            assert.equal(
                result.payment.status,
                'pending',
                'BR-005: a provider callback settles a payment, never the app'
            );
            assert.equal(result.payment.customer_state, 'awaiting_payment');
            assert.ok(result.payment.pay_reference, 'the customer must be told what to quote');
            assert.ok(result.hold?.is_live, 'the clock restarts when they actually start paying');
        });

        test('keeps the provider’s reply verbatim as an external entity', async () => {
            const checkout = await journey.startCheckout(customer, propertyId);
            await journey.payNow(customer, checkout.paymentId, {
                paymentMethodId: await activeMethodId(),
            });

            const {rows} = await pool.query(
                'select provider, status, raw_payload from external_payment_events where payment_id = $1',
                [checkout.paymentId]
            );
            assert.equal(rows.length, 1);
            assert.equal(rows[0].provider, 'sandbox');
            assert.equal(rows[0].status, 'pending');
        });

        test('refuses a method nobody has registered an adapter for', async () => {
            const checkout = await journey.startCheckout(customer, propertyId);
            // payment_methods is reference data and survives the truncate, so
            // this has to be idempotent across runs.
            const {rows} = await pool.query(
                `insert into payment_methods (code, name, kind, provider, is_active)
                 values ('ghost', 'Ghost Pay', 'mobile_money', 'nobody', true)
                 on conflict (code) do update
                     set provider = 'nobody', is_active = true
                 returning id`
            );

            await assert.rejects(
                () => journey.payNow(customer, checkout.paymentId, {paymentMethodId: rows[0].id}),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
        });

        test('a payment belongs to its payer', async () => {
            const checkout = await journey.startCheckout(customer, propertyId);
            const methodId = await activeMethodId();

            await assert.rejects(
                () => journey.payNow(other, checkout.paymentId, {paymentMethodId: methodId}),
                expectDomainError(ErrorCodes.NOT_FOUND)
            );
        });
    });

    // --- nudging -------------------------------------------------------------

    describe('nudging a quiet landlord', () => {
        test('reaches the landlord and is counted', async () => {
            const inquiry = await app.createInquiry(customer, {propertyId, message: 'Hello?'});

            const nudged = await journey.nudgeInquiry(customer, inquiry.id);
            assert.equal(nudged.nudge_count, 1);
            assert.ok(nudged.last_nudged_at);

            const {rows} = await pool.query(
                'select count(*)::int as sent from notifications where user_id = $1',
                [landlord]
            );
            assert.equal(rows[0].sent, 1);
        });

        test('will not let the same landlord be poked twice in a day', async () => {
            const inquiry = await app.createInquiry(customer, {propertyId, message: 'Hello?'});
            await journey.nudgeInquiry(customer, inquiry.id);

            await assert.rejects(
                () => journey.nudgeInquiry(customer, inquiry.id),
                (error) => {
                    assert.match(error.message, /already sent a reminder/i);
                    assert.match(error.message, /hour/i, 'say when they may try again');
                    return true;
                }
            );
        });

        test('there is nothing to nudge once the landlord has answered', async () => {
            const inquiry = await app.createInquiry(customer, {propertyId, message: 'Hello?'});
            await pool.query("update property_inquiries set status = 'accepted' where id = $1", [
                inquiry.id,
            ]);

            await assert.rejects(
                () => journey.nudgeInquiry(customer, inquiry.id),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
        });

        test('an enquiry belongs to the person who sent it', async () => {
            const inquiry = await app.createInquiry(customer, {propertyId, message: 'Hello?'});

            await assert.rejects(
                () => journey.nudgeInquiry(other, inquiry.id),
                expectDomainError(ErrorCodes.NOT_FOUND)
            );
        });
    });

    // --- the timeline and the Favourites screen -------------------------------

    describe('the journey timeline', () => {
        test('reads back as the steps the customer has actually been through', async () => {
            const inquiry = await app.createInquiry(customer, {propertyId, message: 'Interested'});
            await pool.query("update property_inquiries set status = 'accepted' where id = $1", [
                inquiry.id,
            ]);

            const {items} = await journey.propertyJourney(customer, propertyId);
            const keys = items.map((event) => event.key);

            assert.ok(keys.includes('inquiry_submitted'));
            assert.ok(keys.includes('landlord_decision'));
            assert.ok(
                keys.includes('awaiting_payment'),
                'an accepted enquiry must point at the next thing to do'
            );
            assert.equal(
                items.find((event) => event.key === 'landlord_decision').title,
                'Landlord Approved'
            );
        });

        test('says plainly when an application was declined', async () => {
            const inquiry = await app.createInquiry(customer, {propertyId, message: 'Interested'});
            await pool.query(
                `update property_inquiries set status = 'rejected', rejection_reason = 'Already let' where id = $1`,
                [inquiry.id]
            );

            const {items} = await journey.inquiryJourney(customer, inquiry.id);
            const decision = items.find((event) => event.key === 'landlord_decision');

            assert.equal(decision.state, 'blocked');
            assert.equal(decision.detail, 'Already let');
        });
    });

    describe('the Favourites screen payload', () => {
        test('carries all four sections with their own totals', async () => {
            await app.saveProperty(customer, propertyId);
            await app.createInquiry(customer, {propertyId, message: 'Interested'});
            const second = await makeProperty();
            await app.requestViewing(customer, {
                propertyId: second,
                scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
            });

            const overview = await journey.savedOverview(customer);

            assert.equal(overview.favoriteCount, 1);
            assert.equal(overview.favorites.length, 1);
            assert.equal(overview.inquiryCount, 1);
            assert.equal(overview.recentInquiries.length, 1);
            assert.equal(overview.upcomingBookingCount, 1);
            assert.equal(overview.upcomingBookings.length, 1);
            assert.deepEqual(overview.activeRentals, []);
        });

        test('shows an accepted enquiry as awaiting payment, which is what the chip says', async () => {
            const inquiry = await app.createInquiry(customer, {propertyId, message: 'Interested'});
            await pool.query("update property_inquiries set status = 'accepted' where id = $1", [
                inquiry.id,
            ]);

            const overview = await journey.savedOverview(customer);
            assert.equal(overview.recentInquiries[0].display_status, 'awaiting_payment');
        });

        test('sees only its own customer’s records', async () => {
            await app.saveProperty(other, propertyId);

            const overview = await journey.savedOverview(customer);
            assert.equal(overview.favoriteCount, 0);
        });
    });

    // --- tenancies -----------------------------------------------------------

    describe('active rentals', () => {
        /**
         * Walks a booking all the way to a live tenancy the way money actually
         * does. The payment is settled through the finance service rather than
         * with an UPDATE, because the database refuses to let anything else
         * mark a payment successful — which is BR-005 working, not an obstacle
         * to route around.
         */
        async function makeTenancy() {
            const checkout = await journey.startCheckout(customer, propertyId, {leaseMonths: 12});
            await journey.payNow(customer, checkout.paymentId, {
                paymentMethodId: await activeMethodId(),
            });
            await money.reconcilePayment(
                checkout.paymentId,
                {note: 'Seen on the statement'},
                'finance@homemate.co.tz'
            );
            await pool.query(
                `update bookings
                    set status = 'confirmed',
                        lease_start_date = current_date - interval '2 months',
                        lease_end_date = current_date + interval '10 months'
                  where id = $1`,
                [checkout.bookingId]
            );
            return checkout.bookingId;
        }

        test('lists a confirmed booking as a tenancy, with the next rent date worked out', async () => {
            const bookingId = await makeTenancy();

            const rentals = await journey.listRentals(customer);
            assert.equal(rentals.items.length, 1);

            const rental = rentals.items[0];
            assert.equal(rental.id, bookingId);
            assert.ok(rental.next_payment_date, 'a tenant needs to know when rent is next due');
            assert.ok(rental.months_remaining >= 9);
            assert.ok(rental.exit_window_opens_on, '90 days notice has to resolve to a date');
        });

        test('the detail carries the money, the history and what the place comes with', async () => {
            const bookingId = await makeTenancy();

            const detail = await journey.getRental(customer, bookingId);
            assert.equal(detail.rental.id, bookingId);
            assert.equal(detail.payments.length, 1);
            assert.equal(detail.payments[0].status, 'successful');
            assert.ok(Array.isArray(detail.amenities));
            assert.ok(detail.timeline.some((event) => event.key === 'lease_started'));
        });

        test('a tenancy belongs to its tenant', async () => {
            const bookingId = await makeTenancy();

            await assert.rejects(
                () => journey.getRental(other, bookingId),
                expectDomainError(ErrorCodes.NOT_FOUND)
            );
        });

        test('appears in the Favourites screen’s Active Rents section', async () => {
            await makeTenancy();

            const overview = await journey.savedOverview(customer);
            assert.equal(overview.activeRentalCount, 1);
            assert.equal(overview.activeRentals.length, 1);
            assert.ok(overview.activeRentals[0].next_payment_date);
        });

        test('once someone has the tenancy, nobody else may start paying for it', async () => {
            await makeTenancy();
            await pool.query('update property_holds set released_at = now() where released_at is null');

            await assert.rejects(
                () => journey.startCheckout(other, propertyId),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
        });
    });
});
