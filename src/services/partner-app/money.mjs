import {query, pageParams} from '../../shared/db.mjs';
import {notFound} from '../../shared/errors.mjs';
import {PARTNER_ROLES} from '../../shared/roles.mjs';
import {mediaUrl} from './listing-view.mjs';
import {toPublicPayout} from './payout.mjs';
import {EARNING_STATES, earningState, maskAccount, feeArithmetic, earningTimeline} from './earning-view.mjs';

/**
 * A partner's money (T06, BRK-050–052, LND-040/041) and the two home
 * screens' summaries (BRK-010, LND-010). Read-only: payouts are created and
 * released by finance in the backoffice, never from the app.
 *
 * Rows come from v_partner_earnings (031); the state a partner sees is
 * earningState() — one mapping, applied here to rows and to totals alike.
 */
export function createPartnerMoneyService({pool}) {
    async function earnings(userId, role, filters = {}) {
        const type = beneficiaryType(role);
        const {limit, offset} = pageParams(filters);

        const [{rows}, {rows: groups}, {rows: year}] = await Promise.all([
            query(
                pool,
                `select e.*, count(*) over () as total_count
                   from v_partner_earnings e
                  where e.beneficiary_user_id = $1 and e.beneficiary_type = $2::beneficiary_type
                    and e.payment_status <> 'failed'
                  order by coalesce(e.payment_confirmed_at, e.customer_declared_paid_at, e.payment_created_at) desc
                  limit $3 offset $4`,
                [userId, type, limit, offset]
            ),
            query(
                pool,
                `select payment_status, payout_status, sum(amount) as amount
                   from v_partner_earnings
                  where beneficiary_user_id = $1 and beneficiary_type = $2::beneficiary_type
                  group by payment_status, payout_status`,
                [userId, type]
            ),
            query(
                pool,
                `select coalesce(sum(amount), 0) as amount
                   from v_partner_earnings
                  where beneficiary_user_id = $1 and beneficiary_type = $2::beneficiary_type
                    and payment_status = 'successful' and payout_status = 'paid'
                    and payout_paid_at >= date_trunc('year', now())`,
                [userId, type]
            ),
        ]);

        const totals = Object.fromEntries(EARNING_STATES.map((state) => [state, 0]));
        for (const group of groups) {
            const {state} = earningState({paymentStatus: group.payment_status, payoutStatus: group.payout_status});
            if (state in totals) totals[state] = round2(totals[state] + Number(group.amount));
        }

        const total = rows.length > 0 ? Number(rows[0].total_count) : 0;
        return {
            totals,
            paidThisYear: Number(year[0].amount),
            items: rows.map(toEarning),
            pagination: {total, limit, offset, hasMore: offset + rows.length < total},
        };
    }

    /** One earning: the whole split of its payment, the fee from the booking snapshot, and the timeline. */
    async function earning(userId, id) {
        const {rows} = await query(
            pool,
            `select * from v_partner_earnings where id = $1 and beneficiary_user_id = $2`,
            [id, userId]
        );
        if (rows.length === 0) throw notFound('Earning');
        const row = rows[0];

        const [{rows: split}, {rows: booking}, {rows: broker}] = await Promise.all([
            query(
                pool,
                `select id, beneficiary_type, beneficiary_user_id, amount, component
                   from payment_splits where payment_id = $1
                  order by array_position(array['landlord', 'broker', 'agency', 'platform']::beneficiary_type[], beneficiary_type)`,
                [row.payment_id]
            ),
            query(
                pool,
                `select monthly_rent, service_fee, service_fee_percentage, platform_fee_percentage
                   from bookings where id = $1`,
                [row.booking_id]
            ),
            query(
                pool,
                `select 1 from property_parties where property_id = $1 and role = 'broker' and is_primary`,
                [row.property_id]
            ),
        ]);

        return {
            ...toEarning(row),
            split: split.map((s) => ({
                beneficiary: s.beneficiary_type === 'platform' ? 'homemate' : s.beneficiary_type,
                purpose: s.component,
                amount: s.amount,
                you: s.id === row.id,
            })),
            fee: feeArithmetic(booking[0] ?? null, {role: row.beneficiary_type, hasBroker: broker.length > 0}),
            timeline: earningTimeline(row),
        };
    }

    async function payouts(userId, role) {
        const type = beneficiaryType(role);
        const [{rows}, {rows: user}] = await Promise.all([
            query(
                pool,
                `select id, reference, amount, currency, status, hold_reason, failure_reason, provider_reference,
                        destination, scheduled_for, paid_at, created_at
                   from payouts
                  where beneficiary_user_id = $1 and beneficiary_type = $2::beneficiary_type
                  order by created_at desc`,
                [userId, type]
            ),
            query(pool, 'select * from users where id = $1', [userId]),
        ]);
        const account = user[0] ? toPublicPayout(user[0]) : null;
        return {
            account: account && {...account, accountNumber: maskAccount(account.accountNumber)},
            items: rows.map((p) => ({
                id: p.id,
                reference: p.reference,
                amount: p.amount,
                currency: p.currency,
                status: p.status,
                holdReason: p.hold_reason,
                failureReason: p.failure_reason,
                providerReference: p.provider_reference,
                destination: maskAccount(p.destination),
                scheduledFor: p.scheduled_for,
                paidAt: p.paid_at,
                createdAt: p.created_at,
            })),
        };
    }

    async function brokerSummary(userId) {
        const {rows} = await query(pool, 'select broker_summary($1) as summary', [userId]);
        return withNumbers(rows[0].summary);
    }

    async function landlordSummary(userId) {
        const {rows} = await query(pool, 'select landlord_summary($1) as summary', [userId]);
        return withNumbers(rows[0].summary);
    }

    return {earnings, earning, payouts, brokerSummary, landlordSummary};
}

function beneficiaryType(role) {
    if (!PARTNER_ROLES.includes(role)) throw notFound('Earnings');
    return role;
}

const round2 = (value) => Math.round(value * 100) / 100;

function toEarning(row) {
    const {state, holdReason} = earningState({
        paymentStatus: row.payment_status,
        payoutStatus: row.payout_status,
        holdReason: row.hold_reason,
        failureReason: row.payout_failure_reason,
    });
    return {
        id: row.id,
        role: row.beneficiary_type,
        amount: row.amount,
        currency: row.currency,
        purpose: row.component,
        state,
        holdReason,
        paymentReference: row.payment_reference,
        paymentConfirmedAt: row.payment_confirmed_at,
        propertyId: row.property_id,
        propertyTitle: row.property_title,
        coverPhotoUrl: mediaUrl(row.cover_media_id),
        tenantName: row.tenant_name,
        payoutReference: row.payout_reference,
        payoutPaidAt: row.payout_paid_at,
    };
}

/** jsonb numbers arrive as numbers already; counts from count(*) do too. */
function withNumbers(summary) {
    return {
        counts: Object.fromEntries(Object.entries(summary.counts).map(([key, value]) => [key, Number(value)])),
        needsYou: summary.needsYou ?? [],
    };
}
