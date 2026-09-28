import {query} from '../../shared/db.mjs';
import {DomainError, ErrorCodes, invalid, notFound} from '../../shared/errors.mjs';
import {PARTNER_ROLES} from '../../shared/roles.mjs';
import {loadFeeSettings} from '../../shared/fees.mjs';
import {readInquiryFilter, toPartnerInquiry, earningPreview} from './enquiry-view.mjs';

/**
 * Enquiries on a partner's listings (T05, BRK-040–042).
 *
 * Which enquiries a partner sees follows the role they act in: a broker sees
 * the homes where they are the primary broker, a landlord the homes where
 * they are the primary landlord. Who may *answer* is narrower
 * (partner_can_answer_inquiry, 030): the broker on a brokered home, the
 * landlord only on a home nobody brokered. Answering reuses the backoffice's
 * respondToInquiry, so the rules and the customer notification are the same.
 */
export function createPartnerEnquiriesService({pool, customerOps}) {
    async function list(userId, role, {status} = {}) {
        readRole(role);
        const statuses = readInquiryFilter(status);
        const {rows} = await query(
            pool,
            `select v.*, partner_can_answer_inquiry($1, v.property_id) as can_answer
               from v_partner_inquiries v
              where (case when $2 = 'broker' then v.broker_user_id else v.landlord_user_id end) = $1
                and ($3::inquiry_status[] is null or v.status = any ($3::inquiry_status[]))
              order by v.created_at desc`,
            [userId, role, statuses]
        );
        return {items: rows.map((row) => toPartnerInquiry(row, {canAnswer: row.can_answer}))};
    }

    async function get(userId, role, id) {
        const row = await load(userId, role, id);
        return toPartnerInquiry(row, {canAnswer: row.can_answer});
    }

    async function respond(userId, role, id, {status, response, rejectionReason} = {}) {
        const row = await load(userId, role, id);
        if (!row.can_answer) {
            throw new DomainError(
                ErrorCodes.FORBIDDEN,
                'The broker who listed this home answers its enquiries',
                403
            );
        }
        await customerOps.respondToInquiry(id, {status, response, rejectionReason, actorUserId: userId}, userId);
        return get(userId, role, id);
    }

    /** BRK-042: the steps and dates, and what this partner stands to earn. */
    async function journey(userId, role, id) {
        const row = await load(userId, role, id);
        const [{rows: steps}, {rows: booking}, settings] = await Promise.all([
            query(pool, 'select partner_inquiry_journey($1) as steps', [id]),
            query(
                pool,
                `select monthly_rent, service_fee, platform_fee_percentage from bookings
                  where inquiry_id = $1 and status not in ('cancelled', 'expired')
                  order by created_at desc limit 1`,
                [id]
            ),
            loadFeeSettings(pool),
        ]);
        return {
            inquiry: toPartnerInquiry(row, {canAnswer: row.can_answer}),
            steps: steps[0].steps,
            earning: earningPreview({
                role,
                rent: row.property_price,
                settings,
                hasBroker: Boolean(row.broker_user_id),
                booking: booking[0] ?? null,
            }),
        };
    }

    /** The enquiry, if it is on one of this partner's listings in this role — else "not found". */
    async function load(userId, role, id) {
        readRole(role);
        const {rows} = await query(
            pool,
            `select v.*, partner_can_answer_inquiry($1, v.property_id) as can_answer
               from v_partner_inquiries v
              where v.id = $3
                and (case when $2 = 'broker' then v.broker_user_id else v.landlord_user_id end) = $1`,
            [userId, role, id]
        );
        if (rows.length === 0) throw notFound('Enquiry');
        return rows[0];
    }

    return {list, get, respond, journey};
}

function readRole(role) {
    if (!PARTNER_ROLES.includes(role)) throw invalid(`role must be one of: ${PARTNER_ROLES.join(', ')}`);
}
