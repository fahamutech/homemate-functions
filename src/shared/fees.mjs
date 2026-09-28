/**
 * The tenant fee: what a customer pays for being matched with a home, and who
 * it belongs to afterwards.
 *
 * In this market an agent customarily takes one full month's rent for finding
 * a tenant. HomeMate charges a configured share of that month instead
 * (`commission.tenant_fee_percentage`), shows the customer the difference as
 * a saving, and keeps a configured share *of the fee* for itself
 * (`commission.platform_percentage`). The rest of the fee goes to whoever
 * brought the listing — the broker, else the agency, else the landlord who
 * listed it directly.
 *
 * Rent, deposit and advance are never commissioned: they belong to the
 * landlord whole. HomeMate's revenue comes from the fee and nothing else.
 *
 * Everything here is arithmetic on numbers already read from the database, so
 * checkout, the property screen and the finance portal agree by construction.
 */

export const FEE_SETTING_KEYS = {
    tenantFeePercentage: 'commission.tenant_fee_percentage',
    platformPercentage: 'commission.platform_percentage',
};

export const DEFAULT_FEE_SETTINGS = {tenantFeePercentage: 50, platformPercentage: 10};

/** The customary agent fee the saving is measured against: one month's rent. */
export const BENCHMARK_MONTHS = 1;

export function round2(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function percentage(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return fallback;
    return parsed;
}

/** Reads both percentages in one round trip, falling back to the defaults. */
export async function loadFeeSettings(client) {
    const {rows} = await client.query('select key, value from settings where key = any($1)', [
        Object.values(FEE_SETTING_KEYS),
    ]);
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    return {
        tenantFeePercentage: percentage(
            byKey[FEE_SETTING_KEYS.tenantFeePercentage],
            DEFAULT_FEE_SETTINGS.tenantFeePercentage
        ),
        platformPercentage: percentage(
            byKey[FEE_SETTING_KEYS.platformPercentage],
            DEFAULT_FEE_SETTINGS.platformPercentage
        ),
    };
}

/**
 * What the customer pays as the fee on a given monthly rent, what the usual
 * one-month agent fee would have been, and the difference they keep.
 */
export function tenantFee(monthlyRent, {tenantFeePercentage, platformPercentage}) {
    const rent = Number(monthlyRent);
    const safeRent = Number.isFinite(rent) && rent > 0 ? rent : 0;
    const amount = round2((safeRent * tenantFeePercentage) / 100);
    const benchmark = round2(safeRent * BENCHMARK_MONTHS);
    const platformAmount = round2((amount * platformPercentage) / 100);
    return {
        percentage: tenantFeePercentage,
        amount,
        benchmarkAmount: benchmark,
        saving: round2(Math.max(benchmark - amount, 0)),
        platformPercentage,
        platformAmount,
        agentAmount: round2(amount - platformAmount),
    };
}

/**
 * How one checkout payment is divided.
 *
 * `fee` is the part of `amount` that is the tenant fee; everything else is the
 * landlord's. HomeMate takes `platformPercentage` of the fee, and the rest of
 * the fee goes to `agent` — or to the landlord when nobody else listed it, in
 * which case the two landlord shares are one row.
 *
 * The last row always takes the remainder, so the rows add up to `amount`
 * exactly and `assert_splits_balance` never sees rounding dust.
 */
export function checkoutSplits({amount, fee, platformPercentage, agent, landlordUserId}) {
    const total = round2(amount);
    const feeAmount = round2(Math.min(Math.max(Number(fee) || 0, 0), total));
    const platformAmount = round2((feeAmount * platformPercentage) / 100);
    const agentAmount = round2(feeAmount - platformAmount);

    const shares = [];
    if (platformAmount > 0) {
        shares.push({beneficiaryType: 'platform', amount: platformAmount, percentage: platformPercentage});
    }
    if (agentAmount > 0 && agent?.userId) {
        shares.push({
            beneficiaryType: agent.type,
            beneficiaryUserId: agent.userId,
            amount: agentAmount,
            percentage: round2(100 - platformPercentage),
        });
    }

    const assigned = round2(shares.reduce((sum, share) => sum + share.amount, 0));
    shares.push({beneficiaryType: 'landlord', beneficiaryUserId: landlordUserId, amount: round2(total - assigned)});
    return shares;
}

/**
 * Who brought the listing, from its primary parties: the broker, else the
 * agency, else nobody (the landlord listed it themselves).
 */
export function listingAgent(parties) {
    for (const role of ['broker', 'agency']) {
        const party = parties.find((p) => p.role === role && p.user_id);
        if (party) return {type: role, userId: party.user_id};
    }
    return null;
}

/** The primary parties and owner of a property, for `checkoutSplits`. */
export async function loadListingParties(client, propertyId) {
    const {rows: parties} = await client.query(
        `select role, user_id from property_parties
          where property_id = $1 and is_primary
          order by role`,
        [propertyId]
    );
    const landlord = parties.find((p) => p.role === 'landlord' && p.user_id);
    let landlordUserId = landlord?.user_id ?? null;
    if (!landlordUserId) {
        const {rows} = await client.query('select owner_id from properties where id = $1', [propertyId]);
        landlordUserId = rows[0]?.owner_id ?? null;
    }
    return {agent: listingAgent(parties), landlordUserId};
}
