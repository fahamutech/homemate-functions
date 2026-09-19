import {invalid} from '../../shared/errors.mjs';

// Mirrors bookings_lease_sane in 013_customer_domain.sql.
const LEASE_MIN_MONTHS = 1;
const LEASE_MAX_MONTHS = 120;

const DEFAULT_LEASE_MONTHS = 12;

const clamp = (months) => Math.min(Math.max(months, LEASE_MIN_MONTHS), LEASE_MAX_MONTHS);

/**
 * A lease length the bookings table will accept.
 *
 * Callers may leave the term unset, and the mobile client spells that as an
 * explicit JSON `null` rather than an absent key — so `null` has to count as
 * "not chosen" here, otherwise it coerces to 0 and trips bookings_lease_sane.
 */
export function resolveLeaseMonths(requested, minLeaseMonths) {
    if (requested === undefined || requested === null || requested === '') {
        const fallback = Number(minLeaseMonths);
        return Number.isFinite(fallback) && fallback > 0 ? clamp(Math.trunc(fallback)) : DEFAULT_LEASE_MONTHS;
    }

    const months = Number(requested);
    if (!Number.isInteger(months) || months < LEASE_MIN_MONTHS || months > LEASE_MAX_MONTHS) {
        throw invalid(
            `leaseMonths must be a whole number of months between ${LEASE_MIN_MONTHS} and ${LEASE_MAX_MONTHS}`
        );
    }
    return months;
}
