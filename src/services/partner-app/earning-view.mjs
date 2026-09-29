import {invalid} from '../../shared/errors.mjs';
import {tenantFee} from '../../shared/fees.mjs';
import {PARTNER_ROLES} from '../../shared/roles.mjs';

/** The states a partner's earnings are totalled in (BRK-050, LND-040). */
export const EARNING_STATES = ['being_checked', 'ready', 'in_payout', 'paid', 'on_hold', 'reversed'];

/**
 * Where a partner's share of a payment stands, from the payment and the
 * payout that claimed it. The one place this mapping lives.
 *
 * A failed payout goes back to finance to reschedule or cancel, so the
 * partner sees it as held, with the failure as the reason. A failed payment
 * never brought money in: it is `failed`, and not counted in any total.
 */
export function earningState({paymentStatus, payoutStatus = null, holdReason = null, failureReason = null}) {
    if (['reversed', 'refunded', 'partially_refunded'].includes(paymentStatus)) return {state: 'reversed', holdReason: null};
    if (paymentStatus === 'failed') return {state: 'failed', holdReason: null};
    if (paymentStatus !== 'successful') return {state: 'being_checked', holdReason: null};
    switch (payoutStatus) {
        case 'scheduled':
        case 'processing':
            return {state: 'in_payout', holdReason: null};
        case 'paid':
            return {state: 'paid', holdReason: null};
        case 'on_hold':
            return {state: 'on_hold', holdReason};
        case 'failed':
            return {state: 'on_hold', holdReason: failureReason};
        default:
            return {state: 'ready', holdReason: null};
    }
}

/** "•••• 5678" — a payout account or number, recognisable but not usable. */
export function maskAccount(value) {
    if (!value) return null;
    const digits = `${value}`.replace(/\D/g, '');
    return `•••• ${digits.slice(-4)}`;
}

/**
 * The fee on one booking, from its own snapshot (bookings.service_fee_*, 024)
 * through fees.mjs — never from today's settings. The fee share goes to the
 * listing broker, or to the landlord when nobody brokered the home.
 */
export function feeArithmetic(booking, {role, hasBroker}) {
    if (!booking) return null;
    const fee = tenantFee(booking.monthly_rent, {
        tenantFeePercentage: Number(booking.service_fee_percentage),
        platformPercentage: Number(booking.platform_fee_percentage),
    });
    const earnsFee = role === 'broker' ? hasBroker : !hasBroker;
    return {
        monthlyRent: Number(booking.monthly_rent),
        feePercentage: fee.percentage,
        feeAmount: fee.amount,
        platformPercentage: fee.platformPercentage,
        platformAmount: fee.platformAmount,
        yourShare: earnsFee ? fee.agentAmount : 0,
    };
}

/** Paid → verified → put in a payout → paid out. */
export function earningTimeline(row) {
    return [
        {key: 'paid', at: row.customer_declared_paid_at ?? row.payment_created_at ?? null},
        {key: 'verified', at: row.payment_confirmed_at ?? null},
        {key: 'payout_created', at: row.payout_created_at ?? null},
        {key: 'paid_out', at: row.payout_paid_at ?? null},
    ].map((step) => ({...step, done: step.at !== null}));
}

/** Which beneficiary role to report: the query's, else the active role. */
export function readEarningRole(queryRole, activeRole) {
    const role = `${queryRole ?? ''}`.trim() || activeRole;
    if (!PARTNER_ROLES.includes(role)) throw invalid(`role must be one of: ${PARTNER_ROLES.join(', ')}`);
    return role;
}
