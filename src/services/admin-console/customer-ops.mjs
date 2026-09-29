import {withActor, query, toPage, pageParams, nullIfBlank} from '../../shared/db.mjs';
import {notFound, invalid} from '../../shared/errors.mjs';

/**
 * The operator's side of everything the app does: answering enquiries,
 * looking after the tenancies they turn into, and — the part that carries real
 * money — publishing where a customer should pay and then verifying that they
 * did.
 *
 * There is no booking workflow for an operator to drive any more. A customer
 * enquires, the enquiry is accepted here, the customer pays, and verifying the
 * payment confirms the reservation by itself (021). What is left for a person
 * is the tenancy afterwards: starting it and ending it.
 *
 * The verification itself is not here. It is `money.reconcilePayment`, because
 * a customer payment settles by exactly the same authorised path as any other
 * (BR-005). This module's job is to put the right thing in front of a person.
 */
/** confirmed → active, active → completed; the database enforces the order. */
const TENANCY_MOVES = ['active', 'completed'];

export function createCustomerOpsService({pool}) {
    // --- inquiries -----------------------------------------------------------

    async function listInquiries(filters = {}) {
        const {limit, offset} = pageParams(filters);
        const {rows} = await query(pool, 'select * from search_inquiries($1, $2, $3, $4, $5, $6)', [
            nullIfBlank(filters.query),
            nullIfBlank(filters.status),
            nullIfBlank(filters.customerId),
            nullIfBlank(filters.propertyId),
            limit,
            offset,
        ]);
        return toPage(rows, {limit, offset});
    }

    async function getInquiry(id) {
        const {rows} = await query(pool, 'select * from v_inquiries where id = $1', [id]);
        if (rows.length === 0) throw notFound('Inquiry');
        return rows[0];
    }

    /**
     * Answering an enquiry. A rejection carries a reason because the customer
     * is shown it — "rejected" with no explanation is the worst screen in any
     * rental app.
     */
    async function respondToInquiry(id, {status, response, rejectionReason, actorUserId}, actor) {
        const next = nullIfBlank(status) ?? 'responded';
        if (!['responded', 'accepted', 'rejected', 'closed'].includes(next)) {
            throw invalid('status must be responded, accepted, rejected or closed');
        }
        if (next === 'rejected' && !nullIfBlank(rejectionReason)) {
            throw invalid('Tell the customer why their enquiry was turned down');
        }
        if (next !== 'rejected' && !nullIfBlank(response)) {
            throw invalid('Write a reply to send to the customer');
        }

        return withActor(pool, actor, async (client) => {
            const {rows} = await client.query(
                `update property_inquiries
                    set status = $2::inquiry_status,
                        response = coalesce($3, response),
                        rejection_reason = case when $2 = 'rejected' then $4 else null end,
                        responded_by = coalesce($5, responded_by)
                  where id = $1
                  returning id, customer_id, property_id, reference`,
                [id, next, nullIfBlank(response), nullIfBlank(rejectionReason), nullIfBlank(actorUserId)]
            );
            if (rows.length === 0) throw notFound('Inquiry');

            await notify(client, rows[0].customer_id, {
                kind: 'inquiry_response',
                title: next === 'rejected' ? 'Your enquiry was declined' : 'You have a reply',
                body: next === 'rejected' ? rejectionReason : response,
                subjectTable: 'property_inquiries',
                subjectId: id,
            });
            return id;
        }).then(() => getInquiry(id));
    }

    // --- rentals -------------------------------------------------------------
    //
    // Still stored as `bookings`: the reservation a payment settles against and
    // the tenancy it becomes are one row.

    async function listBookings(filters = {}) {
        const {limit, offset} = pageParams(filters);
        const {rows} = await query(pool, 'select * from search_bookings($1, $2, $3, $4, $5, $6)', [
            nullIfBlank(filters.query),
            nullIfBlank(filters.status),
            nullIfBlank(filters.customerId),
            nullIfBlank(filters.propertyId),
            limit,
            offset,
        ]);
        return toPage(rows, {limit, offset});
    }

    async function getBooking(id) {
        const {rows} = await query(pool, 'select * from v_bookings where id = $1', [id]);
        if (rows.length === 0) throw notFound('Booking');
        const {rows: payments} = await query(
            pool,
            'select * from v_customer_payments where booking_id = $1 order by created_at',
            [id]
        );
        return {...rows[0], payments};
    }

    /**
     * Starting or ending a tenancy — the only moves left to a person.
     * Confirming happens when the payment is verified, and an unpaid
     * reservation lapses on its own, so neither is offered here.
     *
     * `date` is the move-in day (active) or the last day (completed). The
     * backoffice may leave it out: moving in then keeps the day the customer
     * named, else today; ending is today. The database (030) holds both paths
     * to the same rule — no move-in more than 7 days before the lease starts.
     * The landlord app (partner-app/tenancies.mjs) always sends it.
     */
    async function changeBookingStatus(id, {status, date, reason}, actor) {
        const next = nullIfBlank(status);
        if (!next) throw invalid('status is required');
        if (!TENANCY_MOVES.includes(next)) {
            throw invalid(
                'Only starting or ending a tenancy is done by hand. A reservation is confirmed when its payment is verified.'
            );
        }
        const day = nullIfBlank(date);

        return withActor(pool, actor, async (client) => {
            const {rows} = await client.query(
                `update bookings
                    set status = $2::booking_status,
                        move_in_date = case when $2 = 'active'
                                            then coalesce($3::date, move_in_date, current_date)
                                            else move_in_date end,
                        ended_on = case when $2 = 'completed' then coalesce($3::date, current_date) else ended_on end,
                        end_reason = case when $2 = 'completed' then $4 else end_reason end
                  where id = $1
                  returning id, customer_id, reference`,
                [id, next, day, nullIfBlank(reason)]
            );
            if (rows.length === 0) throw notFound('Booking');

            await notify(client, rows[0].customer_id, {
                kind: 'booking_update',
                title: next === 'active' ? 'Your tenancy has started' : 'Your tenancy has ended',
                body: null,
                subjectTable: 'bookings',
                subjectId: id,
            });
            return id;
        }).then(() => getBooking(id));
    }

    // --- payment instructions and the verification queue ---------------------

    /**
     * Where the customer should send the money. The app shows these words
     * exactly as typed, so this is the one place they are authored — and one
     * payment may only ever have one set, because two sets of numbers is how
     * money goes astray.
     */
    async function setPaymentInstructions(paymentId, input, actor) {
        const accountNumber = nullIfBlank(input.accountNumber);
        const paymentReference = nullIfBlank(input.paymentReference);
        const displayName = nullIfBlank(input.displayName);
        if (!accountNumber) throw invalid('An account or till number is required');
        if (!paymentReference) throw invalid('A reference for the customer to quote is required');
        if (!displayName) throw invalid('A payee name to display is required');

        return withActor(pool, actor, async (client) => {
            const {rows: payment} = await client.query(
                'select id, amount, currency, status from payments where id = $1',
                [paymentId]
            );
            if (payment.length === 0) throw notFound('Payment');
            if (payment[0].status !== 'pending') {
                throw invalid(`A payment that is ${payment[0].status} no longer needs instructions`);
            }

            const {rows} = await client.query(
                `insert into payment_instructions
                     (payment_id, payment_method_id, display_name, account_name, account_number,
                      payment_reference, instructions, amount, currency, expires_at, issued_by)
                 values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::numeric, $9::numeric), $10, $11::timestamptz, $12)
                 on conflict (payment_id) do update set
                     payment_method_id = excluded.payment_method_id,
                     display_name = excluded.display_name,
                     account_name = excluded.account_name,
                     account_number = excluded.account_number,
                     payment_reference = excluded.payment_reference,
                     instructions = excluded.instructions,
                     amount = excluded.amount,
                     expires_at = excluded.expires_at,
                     issued_by = excluded.issued_by
                 returning *`,
                [
                    paymentId,
                    nullIfBlank(input.paymentMethodId),
                    displayName,
                    nullIfBlank(input.accountName),
                    accountNumber,
                    paymentReference,
                    nullIfBlank(input.instructions),
                    input.amount === undefined || input.amount === '' ? null : Number(input.amount),
                    payment[0].amount,
                    payment[0].currency,
                    nullIfBlank(input.expiresAt),
                    actor ?? null,
                ]
            );

            const {rows: payer} = await client.query('select payer_user_id from payments where id = $1', [
                paymentId,
            ]);
            if (payer[0]?.payer_user_id) {
                await notify(client, payer[0].payer_user_id, {
                    kind: 'payment_due',
                    title: 'Payment details are ready',
                    body: `Pay ${payment[0].currency} ${payment[0].amount} to ${displayName}, reference ${paymentReference}.`,
                    subjectTable: 'payments',
                    subjectId: paymentId,
                });
            }
            return rows[0];
        });
    }

    async function getPaymentInstructions(paymentId) {
        const {rows} = await query(pool, 'select * from payment_instructions where payment_id = $1', [
            paymentId,
        ]);
        return rows[0] ?? null;
    }

    /** Payments a customer says they have made, waiting for a human to check. */
    async function listDeclaredPayments(filters = {}) {
        const {limit, offset} = pageParams(filters);
        const {rows} = await query(
            pool,
            `select p.id, p.reference, p.amount, p.currency, p.status, p.created_at,
                    p.customer_declared_paid_at, p.customer_declared_reference, p.customer_declared_note,
                    p.booking_id, b.reference as booking_reference,
                    p.payer_user_id, u.full_name as payer_name, u.phone_number as payer_phone,
                    prop.reference_code as property_reference, prop.title as property_title,
                    i.account_number, i.payment_reference, i.display_name,
                    count(*) over () as total_count
               from payments p
               left join bookings b on b.id = p.booking_id
               left join users u on u.id = p.payer_user_id
               left join properties prop on prop.id = p.property_id
               left join payment_instructions i on i.payment_id = p.id
              where p.status = 'pending'
                and p.customer_declared_paid_at is not null
                and ($1::text is null or p.reference ilike '%' || $1 || '%'
                     or coalesce(p.customer_declared_reference, '') ilike '%' || $1 || '%'
                     or coalesce(u.full_name, '') ilike '%' || $1 || '%')
              order by p.customer_declared_paid_at
              limit $2 offset $3`,
            [nullIfBlank(filters.query), limit, offset]
        );
        return toPage(rows, {limit, offset});
    }

    /** Payments that have no instructions yet, so the customer cannot pay. */
    async function listPaymentsNeedingInstructions(filters = {}) {
        const {limit, offset} = pageParams(filters);
        const {rows} = await query(
            pool,
            `select p.id, p.reference, p.amount, p.currency, p.created_at,
                    p.booking_id, b.reference as booking_reference,
                    u.full_name as payer_name, u.phone_number as payer_phone,
                    prop.reference_code as property_reference, prop.title as property_title,
                    count(*) over () as total_count
               from payments p
               left join bookings b on b.id = p.booking_id
               left join users u on u.id = p.payer_user_id
               left join properties prop on prop.id = p.property_id
              where p.status = 'pending'
                and p.booking_id is not null
                and not exists (select 1 from payment_instructions i where i.payment_id = p.id)
              order by p.created_at
              limit $1 offset $2`,
            [limit, offset]
        );
        return toPage(rows, {limit, offset});
    }

    // --- internals -----------------------------------------------------------

    /** Tells the customer something happened. In-app only for now. */
    async function notify(client, userId, {kind, title, body, subjectTable, subjectId}) {
        await client.query(
            `insert into notifications (user_id, kind, title, body, subject_table, subject_id)
             values ($1, $2::notification_kind, $3, $4, $5, $6)`,
            [userId, kind, title, nullIfBlank(body), subjectTable, subjectId]
        );
    }

    return {
        listInquiries,
        getInquiry,
        respondToInquiry,
        listBookings,
        getBooking,
        changeBookingStatus,
        setPaymentInstructions,
        getPaymentInstructions,
        listDeclaredPayments,
        listPaymentsNeedingInstructions,
    };
}
