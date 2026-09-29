/** A partner may change a listing only while it is back in their hands. */
export const EDITABLE_STATUSES = ['draft', 'changes_requested'];

/** Columns of v_properties the partner app never sees: storage keys, the reviewer, the owner's phone. */
const HIDDEN = new Set(['cover_url', 'cover_thumbnail_url', 'reviewed_by', 'owner_phone']);

const camel = (snake) => snake.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());

/** Listing photos are streamed by GET /app/media/:id/raw — never a storage URL. */
export function mediaUrl(mediaId, {thumbnail = false} = {}) {
    if (!mediaId) return null;
    return `/app/media/${mediaId}/raw${thumbnail ? '?thumbnail=1' : ''}`;
}

/**
 * One v_properties row as the partner app sees it: camelCase, without
 * internal columns, plus the status history BRK-021 shows and whether this
 * user may still edit it.
 */
export function toPartnerListing(row, {userId, createdBy}) {
    const view = {};
    for (const [key, value] of Object.entries(row)) {
        if (!HIDDEN.has(key)) view[camel(key)] = value;
    }
    view.statusHistory = {
        createdAt: row.created_at ?? null,
        submittedAt: row.submitted_at ?? null,
        reviewedAt: row.reviewed_at ?? null,
        rejectionReason: row.rejection_reason ?? null,
    };
    view.editable = createdBy === userId && EDITABLE_STATUSES.includes(row.status);
    return view;
}

/**
 * BRK-030c's "What the tenant pays to move in" and "You earn", from the
 * checkout formula in shared/fees.mjs — the app shows these, it never works
 * them out.
 */
export function moneyPreview(payment, earning) {
    return {
        rent: payment.rent,
        deposit: payment.deposit,
        advance: payment.advance,
        firstRent: payment.firstRent,
        tenantFee: payment.fee.amount,
        tenantFeePercentage: payment.fee.percentage,
        saving: payment.fee.saving,
        total: payment.total,
        youEarn: earning,
    };
}
