import {withActor, query, toPage, pageParams, nullIfBlank} from '../../shared/db.mjs';
import {notFound, invalid, DomainError, ErrorCodes} from '../../shared/errors.mjs';
import {resolveLeaseMonths} from './lease-terms.mjs';
import {checkoutSplits, loadFeeSettings, loadListingParties, round2, tenantFee} from '../../shared/fees.mjs';

/**
 * The part of the customer's journey that runs from "the landlord said yes" to
 * "I am a tenant": reserving the property while you pay, paying, and then
 * living with the lease you signed.
 *
 * It is a separate service from `service.mjs` for one reason: everything here
 * is about *exclusivity and time* — a ten-minute hold, a nudge cooldown, a
 * lease that ends — and that is a different kind of care from browsing and
 * saving. The rules themselves live in `020_customer_journey.sql`; this module
 * calls them and translates their errors into something an app can render.
 */

/** The bus-ticket window. Long enough to read an M-Pesa SMS, short enough that
 *  an abandoned checkout does not park a property for the afternoon. */
const HOLD_MINUTES = 10;

/**
 * Postgres speaks in SQLSTATEs; the app speaks in sentences. This is the one
 * place the two meet, so a screen never has to know what `55P03` is.
 */
function translateJourneyError(error, what = 'Record') {
    // `lock_not_available` and `no_data_found` are raised deliberately by the
    // functions in 020 and fall through `translatePostgresError`'s default
    // branch, so they arrive here as raw driver errors.
    if (error?.code === '55P03') {
        // Somebody else is inside the payment flow.
        return new DomainError(
            ErrorCodes.CONFLICT,
            error.hint ? `${error.message} ${error.hint}` : error.message,
            409
        );
    }
    if (error?.code === 'P0002') return notFound(what);
    return error;
}

export function createCustomerJourneyService({pool, paymentPorts = {}}) {
    // --- holds ---------------------------------------------------------------

    /**
     * Reserve the property for ten minutes so nobody else can start paying.
     *
     * Re-entrant on purpose: a customer who switches to their SMS app and
     * comes back must find their own hold extended, not a refusal.
     */
    async function hold(customerId, propertyId, {bookingId, paymentId, minutes} = {}) {
        if (!nullIfBlank(propertyId)) throw invalid('propertyId is required');

        const holdId = await withActor(pool, customerId, async (client) => {
            const {rows} = await client.query(
                'select id from acquire_property_hold($1, $2, $3, $4, $5)',
                [
                    propertyId,
                    customerId,
                    Number.isFinite(Number(minutes)) ? Number(minutes) : HOLD_MINUTES,
                    nullIfBlank(bookingId),
                    nullIfBlank(paymentId),
                ]
            );
            return rows[0].id;
        }).catch((error) => {
            throw translateJourneyError(error, 'Property');
        });

        // Read back through the view rather than returning the insert: the
        // countdown the app shows is the server's arithmetic, never the
        // phone's idea of what time it is.
        return getHold(customerId, holdId);
    }

    async function getHold(customerId, holdId) {
        const {rows} = await query(
            pool,
            'select * from v_property_holds where id = $1 and customer_id = $2',
            [holdId, customerId]
        );
        if (rows.length === 0) throw notFound('Hold');
        return rows[0];
    }

    /** Whatever this customer currently holds — usually nothing, at most one. */
    async function myHolds(customerId) {
        const {rows} = await query(
            pool,
            'select * from v_property_holds where customer_id = $1 and is_live order by expires_at',
            [customerId]
        );
        return {items: rows};
    }

    /**
     * Give it back early. Leaving the checkout screen should free the property
     * for the next person rather than making them wait out the full ten
     * minutes for nothing.
     */
    async function releaseHold(customerId, holdId, reason = 'released') {
        const released = await withActor(pool, customerId, async (client) => {
            const {rows} = await client.query('select release_property_hold($1, $2, $3) as released', [
                holdId,
                customerId,
                nullIfBlank(reason) ?? 'released',
            ]);
            return rows[0].released;
        });
        if (!released) throw notFound('Hold');
        return {released: true};
    }

    // --- eligibility and the timeline ---------------------------------------

    /**
     * "Can I pay for this, and why?" — the single answer behind every Pay
     * button, so the three routes into payment cannot disagree.
     */
    async function checkoutEligibility(customerId, propertyId) {
        const {rows} = await query(pool, 'select customer_checkout_eligibility($1, $2) as result', [
            customerId,
            propertyId,
        ]);
        return rows[0].result;
    }

    /** Everything that has happened on one property, oldest state to newest. */
    async function propertyJourney(customerId, propertyId) {
        const {rows} = await query(pool, 'select customer_property_journey($1, $2) as events', [
            customerId,
            propertyId,
        ]);
        return {items: rows[0].events ?? []};
    }

    /** The same timeline, reached from an enquiry rather than from a listing. */
    async function inquiryJourney(customerId, inquiryId) {
        const {rows} = await query(
            pool,
            'select property_id from property_inquiries where id = $1 and customer_id = $2',
            [inquiryId, customerId]
        );
        if (rows.length === 0) throw notFound('Inquiry');
        return propertyJourney(customerId, rows[0].property_id);
    }

    // --- nudging a quiet landlord -------------------------------------------

    /**
     * CUS-007e. The cooldown lives in the database, not here — this endpoint is
     * not the only thing that can reach that function, and a landlord poked
     * eleven times stops reading any of them.
     */
    async function nudgeInquiry(customerId, inquiryId) {
        return withActor(pool, customerId, async (client) => {
            // `select * from fn(...)` rather than `(fn(...)).*`: the latter
            // spelling re-evaluates the function once per output column, which
            // would nudge the landlord a dozen times in one call.
            const {rows} = await client.query('select * from nudge_inquiry($1, $2)', [
                inquiryId,
                customerId,
            ]);
            return rows[0];
        }).catch((error) => {
            throw translateJourneyError(error, 'Enquiry');
        });
    }

    // --- starting a checkout -------------------------------------------------

    /**
     * Turn "the landlord said yes" into something payable.
     *
     * There is one road in: an **accepted enquiry**. The journey is enquire →
     * accepted → pay → verified, and `customer_checkout_eligibility` (024)
     * refuses everything else. The property must also be unlet and not being
     * paid for by somebody else — and the ten-minute hold is taken in the same
     * transaction as the booking, so the reservation and the exclusivity
     * cannot come apart.
     *
     * The first payment is rent, deposit and the tenant fee together. The fee
     * is snapshotted onto the booking and the payment is split the moment it
     * is created, so what finance later settles is exactly what the customer
     * was shown.
     */
    async function startCheckout(customerId, propertyId, input = {}) {
        if (!nullIfBlank(propertyId)) throw invalid('propertyId is required');

        const eligibility = await checkoutEligibility(customerId, propertyId);
        if (!eligibility.available) {
            throw invalid('This property is no longer available');
        }
        if (!eligibility.canPay) {
            throw invalid(
                eligibility.route === 'blocked'
                    ? 'The landlord declined this application, so it cannot be paid for'
                    : 'Send an enquiry first — you can pay once the landlord accepts it'
            );
        }
        if (eligibility.heldByOther) {
            throw new DomainError(
                ErrorCodes.CONFLICT,
                'Someone is paying for this property right now. Try again in a few minutes.',
                409
            );
        }

        const result = await withActor(pool, customerId, async (client) => {
            // Take the hold first. If another customer beat us to it by a
            // millisecond the transaction stops here, before a booking exists.
            const {rows: holdRows} = await client.query(
                'select id from acquire_property_hold($1, $2, $3)',
                [propertyId, customerId, HOLD_MINUTES]
            );
            const holdId = holdRows[0].id;

            let bookingId = eligibility.bookingId;
            let paymentId = null;

            if (bookingId) {
                // Re-entering a checkout that already exists: reuse the open
                // payment rather than stacking a second one on the booking.
                const {rows: open} = await client.query(
                    `select id from payments
                      where booking_id = $1 and status = 'pending'
                      order by created_at limit 1`,
                    [bookingId]
                );
                paymentId = open[0]?.id ?? null;
            } else {
                const {rows: property} = await client.query(
                    `select id, price, currency, deposit_months, advance_rent_months,
                            payment_frequency, min_lease_months
                       from v_properties where id = $1 and status = 'approved'`,
                    [propertyId]
                );
                if (property.length === 0) throw notFound('Property');

                const p = property[0];
                const rent = Number(p.price);
                if (!Number.isFinite(rent) || rent <= 0) {
                    throw invalid('This property has no price set, so it cannot be booked yet');
                }

                const depositMonths = Number(p.deposit_months ?? 0);
                const advanceMonths = Number(p.advance_rent_months ?? 0);
                const leaseMonths = resolveLeaseMonths(input.leaseMonths, p.min_lease_months);

                const deposit = round2(rent * depositMonths);
                const advance = round2(rent * advanceMonths);
                const feeSettings = await loadFeeSettings(client);
                const fee = tenantFee(rent, feeSettings);
                const totalDue = round2(deposit + (advance > 0 ? advance : rent) + fee.amount);

                const {rows: booking} = await client.query(
                    `insert into bookings
                         (property_id, customer_id, inquiry_id, monthly_rent, currency,
                          deposit_amount, advance_months, payment_frequency, lease_months,
                          move_in_date, total_due, notes, expires_at,
                          service_fee, service_fee_percentage, platform_fee_percentage)
                     values ($1, $2, $3, $4, $5, $6, $7, $8::rent_payment_frequency, $9,
                             $10::date, $11, $12, now() + interval '48 hours', $13, $14, $15)
                     returning id`,
                    [
                        propertyId,
                        customerId,
                        // The enquiry the landlord accepted — the only door in.
                        eligibility.inquiryId,
                        rent,
                        p.currency ?? 'TZS',
                        deposit,
                        advanceMonths,
                        p.payment_frequency ?? 'monthly',
                        leaseMonths,
                        nullIfBlank(input.moveInDate),
                        totalDue,
                        nullIfBlank(input.notes),
                        fee.amount,
                        fee.percentage,
                        fee.platformPercentage,
                    ]
                );
                bookingId = booking[0].id;

                const {rows: payment} = await client.query(
                    `insert into payments (booking_id, property_id, payer_user_id, purpose, amount, currency, created_by)
                     values ($1, $2, $3, 'deposit', $4, $5, $6)
                     returning id`,
                    [bookingId, propertyId, customerId, totalDue, p.currency ?? 'TZS', customerId]
                );
                paymentId = payment[0].id;

                // Split now, not at settlement: the ledger posts whatever rows
                // exist when the payment turns successful, and the fee's owners
                // are known today.
                const parties = await loadListingParties(client, propertyId);
                if (!parties.landlordUserId) {
                    throw invalid('This property has no landlord on file, so it cannot be paid for yet');
                }
                for (const split of checkoutSplits({
                    amount: totalDue,
                    fee: fee.amount,
                    platformPercentage: fee.platformPercentage,
                    agent: parties.agent,
                    landlordUserId: parties.landlordUserId,
                })) {
                    await client.query(
                        `insert into payment_splits (payment_id, beneficiary_type, beneficiary_user_id, amount, percentage)
                         values ($1, $2::beneficiary_type, $3, $4, $5)`,
                        [paymentId, split.beneficiaryType, split.beneficiaryUserId ?? null, split.amount, split.percentage ?? null]
                    );
                }

                await client.query("update bookings set status = 'awaiting_payment' where id = $1", [
                    bookingId,
                ]);
            }

            await client.query(
                'update property_holds set booking_id = $2, payment_id = $3 where id = $1',
                [holdId, bookingId, paymentId]
            );

            return {holdId, bookingId, paymentId};
        }).catch((error) => {
            throw translateJourneyError(error);
        });

        return {
            hold: await getHold(customerId, result.holdId),
            bookingId: result.bookingId,
            paymentId: result.paymentId,
            summary: await checkoutSummary(customerId, result.bookingId),
        };
    }

    /**
     * CUS-011. What the customer is about to pay and what each part of it is
     * for, read back from the booking rather than recomputed — the number on
     * this screen must be the number the payment row holds.
     */
    async function checkoutSummary(customerId, bookingId) {
        const {rows} = await query(
            pool,
            'select * from v_bookings where id = $1 and customer_id = $2',
            [bookingId, customerId]
        );
        if (rows.length === 0) throw notFound('Booking');
        const booking = rows[0];

        const {rows: payments} = await query(
            pool,
            'select * from v_customer_payments where booking_id = $1 order by created_at',
            [bookingId]
        );

        const rent = Number(booking.monthly_rent);
        const deposit = Number(booking.deposit_amount);
        const advanceMonths = Number(booking.advance_months ?? 0);
        const firstPeriod = advanceMonths > 0 ? round2(rent * advanceMonths) : rent;
        const fee = tenantFee(rent, {
            tenantFeePercentage: Number(booking.service_fee_percentage ?? 0),
            platformPercentage: Number(booking.platform_fee_percentage ?? 0),
        });
        // The snapshot is the truth; the percentage only explains it.
        const feeAmount = Number(booking.service_fee ?? 0);

        return {
            booking,
            payments,
            // The breakdown the design lists line by line. Charges that are
            // waived still appear, because "TZS 0 (Waived)" is information and
            // a missing row is not.
            breakdown: [
                {
                    key: 'first_period',
                    label: advanceMonths > 1 ? `Rent (${advanceMonths} months up front)` : 'First month rent',
                    amount: firstPeriod,
                },
                {
                    key: 'deposit',
                    label:
                        Number(booking.deposit_amount) > 0 && rent > 0
                            ? `Security deposit (${round2(deposit / rent)}x)`
                            : 'Security deposit',
                    amount: deposit,
                },
                {
                    key: 'service_fee',
                    label:
                        feeAmount > 0
                            ? `HomeMate fee (${fee.percentage}% of one month's rent)`
                            : 'HomeMate fee',
                    amount: feeAmount,
                    waived: feeAmount === 0,
                    highlight: true,
                },
            ],
            // What the customer keeps by not paying the usual agent: one full
            // month's rent, less the fee they are actually charged. The app
            // highlights this under the breakdown.
            serviceFee: {
                amount: feeAmount,
                percentage: Number(booking.service_fee_percentage ?? 0),
                benchmarkAmount: fee.benchmarkAmount,
                benchmarkLabel: "Usual agent fee (one month's rent)",
                saving: round2(Math.max(fee.benchmarkAmount - feeAmount, 0)),
            },
            totalDue: Number(booking.total_due),
            amountPaid: Number(booking.amount_paid),
            amountOutstanding: Number(booking.amount_outstanding),
            currency: booking.currency,
        };
    }

    /** The methods this property actually accepts, for CUS-014's picker. */
    async function paymentMethodsFor(propertyId) {
        const {rows} = await query(
            pool,
            `select m.id, m.code, m.name, m.kind, m.provider, m.instructions
               from payment_methods m
              where m.is_active
                and (
                    not exists (select 1 from property_payment_methods ppm where ppm.property_id = $1)
                    or exists (select 1 from property_payment_methods ppm
                                where ppm.property_id = $1 and ppm.payment_method_id = m.id)
                )
              order by m.sort_order, m.name`,
            [propertyId]
        );
        return {items: rows};
    }

    /**
     * CUS-014. The customer has picked a method and pressed pay.
     *
     * This opens a charge with the provider and writes down what it said. It
     * deliberately cannot settle anything: `createCharge` may only return
     * `pending` or `failed` (BR-005), and the payment becomes successful when
     * a provider callback or a finance officer says so. What the customer gets
     * back is the instruction — the till number, the reference, or "check your
     * phone" — and the hold is extended so they have the full ten minutes from
     * the moment they actually started paying.
     */
    async function payNow(customerId, paymentId, input = {}) {
        const methodId = nullIfBlank(input.paymentMethodId);
        if (!methodId) throw invalid('Please choose how you want to pay');

        const {rows: existing} = await query(
            pool,
            'select * from v_customer_payments where id = $1 and payer_user_id = $2',
            [paymentId, customerId]
        );
        if (existing.length === 0) throw notFound('Payment');
        const payment = existing[0];

        if (payment.status === 'successful') throw invalid('This payment has already been confirmed');
        if (payment.status !== 'pending') {
            throw invalid(`A payment that is ${payment.status} cannot be paid again`);
        }

        const {rows: methods} = await query(
            pool,
            'select * from payment_methods where id = $1 and is_active',
            [methodId]
        );
        if (methods.length === 0) throw invalid('That payment method is not available');
        const method = methods[0];

        const port = paymentPorts[method.provider];
        if (!port) {
            // A method pointing at an adapter nobody registered is a
            // configuration mistake, and saying so plainly beats a 500.
            throw invalid(
                `Payments through ${method.name} are not available right now. Please choose another method.`
            );
        }

        const charge = await port.createCharge({
            reference: payment.reference,
            amount: Number(payment.amount),
            currency: payment.currency,
            methodCode: method.code,
            payerPhone: nullIfBlank(input.payerPhone),
            metadata: {bookingId: payment.booking_id, propertyId: payment.property_id},
        });

        if (charge.status === 'failed') {
            throw invalid('That payment could not be started. Please try again or use another method.');
        }

        return withActor(pool, customerId, async (client) => {
            await client.query(
                `update payments
                    set payment_method_id = $2, provider = $3, provider_reference = $4
                  where id = $1`,
                [paymentId, methodId, charge.provider, charge.providerReference]
            );

            // The provider's verbatim reply, kept as an external entity and
            // never read back as domain logic.
            await client.query(
                `insert into external_payment_events
                     (payment_id, reference, provider, provider_reference, status, raw_payload)
                 values ($1, $2, $3, $4, $5, $6::jsonb)`,
                [
                    paymentId,
                    payment.reference,
                    charge.provider,
                    charge.providerReference,
                    charge.status,
                    JSON.stringify(charge.raw ?? {}),
                ]
            );

            /*
             * How to pay, in the customer's hands. An operator may already have
             * configured this from the portal — in which case theirs wins,
             * because those are the account details a human checked. Otherwise
             * the adapter's own instruction stands in, so the screen is never
             * blank while somebody waits for finance to fill a form.
             */
            await client.query(
                `insert into payment_instructions
                     (payment_id, payment_method_id, display_name, account_name, account_number,
                      payment_reference, instructions, amount, currency, expires_at, issued_by)
                 values ($1, $2, $3, null, $4, $5, $6, $7, $8, now() + interval '48 hours', 'provider')
                 on conflict (payment_id) do nothing`,
                [
                    paymentId,
                    methodId,
                    method.name,
                    charge.providerReference,
                    payment.reference,
                    charge.instructions ?? method.instructions,
                    Number(payment.amount),
                    payment.currency,
                ]
            );

            // They are actively paying now, so the clock restarts here rather
            // than from whenever they opened the screen.
            if (payment.property_id) {
                await client.query('select acquire_property_hold($1, $2, $3, $4, $5)', [
                    payment.property_id,
                    customerId,
                    HOLD_MINUTES,
                    payment.booking_id,
                    paymentId,
                ]);
            }

            return true;
        })
            .catch((error) => {
                throw translateJourneyError(error);
            })
            .then(async () => ({
                payment: (
                    await query(pool, 'select * from v_customer_payments where id = $1', [paymentId])
                ).rows[0],
                hold: payment.property_id
                    ? (
                          await query(
                              pool,
                              'select * from v_property_holds where property_id = $1 and customer_id = $2 and is_live',
                              [payment.property_id, customerId]
                          )
                      ).rows[0] ?? null
                    : null,
            }));
    }

    // --- tenancies -----------------------------------------------------------

    /** CUS-012a. Every lease the customer is currently living under. */
    async function listRentals(customerId, filters = {}) {
        const {limit, offset} = pageParams(filters);
        const {rows} = await query(pool, 'select * from search_active_rentals($1, $2, $3)', [
            customerId,
            limit,
            offset,
        ]);
        return toPage(rows, {limit, offset});
    }

    /**
     * CUS-012b. One tenancy in full: the money, the paperwork, what has been
     * paid, and what the property comes with.
     */
    async function getRental(customerId, bookingId) {
        const {rows} = await query(
            pool,
            'select * from v_active_rentals where id = $1 and customer_id = $2',
            [bookingId, customerId]
        );
        if (rows.length === 0) throw notFound('Rental');
        const rental = rows[0];

        const [history, amenities, journey] = await Promise.all([
            query(pool, 'select rental_payment_history($1, $2) as items', [bookingId, customerId]),
            query(
                pool,
                `select d.id, d.name, d.code
                   from property_amenities pa
                   join dictionary_items d on d.id = pa.amenity_id
                  where pa.property_id = $1
                  order by d.sort_order, d.name`,
                [rental.property_id]
            ),
            query(pool, 'select customer_property_journey($1, $2) as events', [
                customerId,
                rental.property_id,
            ]),
        ]);

        return {
            rental,
            payments: history.rows[0].items ?? [],
            amenities: amenities.rows,
            timeline: journey.rows[0].events ?? [],
        };
    }

    /** CUS-012c. The lease itself, if one has been drawn up. */
    async function getLease(customerId, bookingId) {
        const {rows} = await query(
            pool,
            `select la.*, b.reference as booking_reference, b.lease_start_date, b.lease_end_date,
                    b.monthly_rent, b.currency, b.deposit_amount, b.lease_months,
                    b.property_title, b.property_address, b.landlord_name, b.landlord_phone,
                    b.customer_name
               from v_bookings b
               left join lease_agreements la on la.booking_id = b.id
              where b.id = $1 and b.customer_id = $2`,
            [bookingId, customerId]
        );
        if (rows.length === 0) throw notFound('Rental');
        return rows[0];
    }

    // --- the Favourites screen ----------------------------------------------

    /** CUS-013a, in one round trip. */
    async function savedOverview(customerId, {sectionLimit} = {}) {
        const limit = Number.parseInt(sectionLimit ?? '6', 10);
        const {rows} = await query(pool, 'select customer_saved_overview($1, $2) as overview', [
            customerId,
            Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 20) : 6,
        ]);
        return rows[0].overview;
    }

    return {
        hold,
        getHold,
        myHolds,
        releaseHold,
        checkoutEligibility,
        propertyJourney,
        inquiryJourney,
        nudgeInquiry,
        startCheckout,
        checkoutSummary,
        paymentMethodsFor,
        payNow,
        listRentals,
        getRental,
        getLease,
        savedOverview,
    };
}
