import {query, withActor, pageParams, toPage, nullIfBlank} from '../../shared/db.mjs';
import {DomainError, ErrorCodes, invalid, notFound} from '../../shared/errors.mjs';
import {toApplicationView} from './application-view.mjs';
import {readDecision} from './decision.mjs';
import {readPartnerRole} from './onboarding.mjs';

const STATUSES = ['invited', 'applied', 'pending_review', 'active', 'action_needed', 'rejected', 'suspended'];

const DECISION_MESSAGES = {
    approve: (role) => ({
        title: `You are now a HomeMate ${role}`,
        body: `Your ${role} application was approved. Switch to your ${role} role to get started.`,
    }),
    action_needed: (role, reason, remediation) => ({
        title: `Your ${role} application needs a change`,
        body: `${remediation.issue} — ${remediation.requestedAction}`,
    }),
    reject: (role, reason) => ({
        title: `Your ${role} application was not approved`,
        body: reason,
    }),
};

/**
 * The backoffice side of partner onboarding (T03): the queue of applications
 * and a moderator's decision. Nothing is ever approved automatically; every
 * decision runs as the moderator (withActor), so the user_roles audit trail
 * and the reviewed_by stamp (028) name them.
 */
export function createPartnerReviewService({pool, notificationPort}) {
    async function queue(filters = {}) {
        const role = nullIfBlank(filters.role);
        if (role) readPartnerRole(role);
        const status = nullIfBlank(filters.status);
        if (status && !STATUSES.includes(status)) throw invalid(`status must be one of: ${STATUSES.join(', ')}`);
        const {limit, offset} = pageParams(filters);

        const {rows} = await query(
            pool,
            `select ur.user_id, ur.role, ur.status,
                    u.full_name, u.phone_number, u.email, u.kyc_status, u.date_of_birth,
                    u.national_id_number, u.tin_number, u.physical_address, u.payout_method,
                    partner_application_state(ur.user_id, ur.role) as state,
                    count(*) over () as total_count
               from user_roles ur
               join users u on u.id = ur.user_id
              where ur.role in ('broker', 'landlord')
                and ($1::user_role is null or ur.role = $1)
                and ($2::partner_role_status is null or ur.status = $2)
                and ($3::text is null
                     or u.full_name ilike '%' || $3 || '%'
                     or u.phone_number ilike '%' || $3 || '%'
                     or u.national_id_number ilike '%' || $3 || '%')
              order by (ur.status = 'pending_review') desc,
                       coalesce(ur.submitted_at, ur.applied_at, ur.created_at)
              limit $4 offset $5`,
            [role, status, nullIfBlank(filters.q), limit, offset]
        );
        const page = toPage(rows, {limit, offset});
        return {...page, items: await withEvidence(pool, page.items)};
    }

    async function get(userId, role) {
        readPartnerRole(role);
        return getWith(pool, userId, role);
    }

    async function decide(userId, role, input, actor) {
        readPartnerRole(role);
        const decision = readDecision(input);

        const {item, phoneNumber, message} = await withActor(pool, actor, async (client) => {
            const {rows} = await client.query(
                `select ur.status, u.phone_number from user_roles ur join users u on u.id = ur.user_id
                  where ur.user_id = $1 and ur.role = $2 for update of ur`,
                [userId, role]
            );
            if (rows.length === 0) throw notFound(`A ${role} application`);
            if (rows[0].status !== 'pending_review') {
                throw new DomainError(
                    ErrorCodes.CONFLICT,
                    `Only an application waiting for review can be decided (this one is ${rows[0].status})`,
                    409
                );
            }

            await client.query(
                `update user_roles set status = $3::partner_role_status, rejection_reason = $4
                  where user_id = $1 and role = $2`,
                [userId, role, decision.status, decision.status === 'rejected' ? decision.reason : null]
            );

            if (decision.remediation) {
                await client.query(
                    `insert into kyc_remediations (user_id, kyc_document_id, issue, requested_action, raised_by)
                     values ($1, $2, $3, $4, $5)`,
                    [userId, decision.remediation.documentId, decision.remediation.issue,
                        decision.remediation.requestedAction, actor ?? null]
                );
            }

            const text = DECISION_MESSAGES[decision.decision](role, decision.reason, decision.remediation);
            await client.query(
                `insert into notifications (user_id, kind, title, body, subject_table, subject_id)
                 values ($1, 'kyc_update', $2, $3, 'user_roles', $1)`,
                [userId, text.title, text.body]
            );

            return {item: await getWith(client, userId, role), phoneNumber: rows[0].phone_number, message: text};
        });

        // After commit: a provider outage must not undo a decision already made.
        try {
            await notificationPort.send({
                to: phoneNumber,
                template: 'partner-application-decision',
                params: {decision: decision.decision, role, reason: decision.reason, text: message.body},
            });
        } catch (error) {
            console.error('partner decision SMS failed', error);
        }
        return item;
    }

    return {queue, get, decide};
}

async function getWith(db, userId, role) {
    const {rows} = await query(
        db,
        `select ur.user_id, ur.role, ur.status,
                u.full_name, u.phone_number, u.email, u.kyc_status, u.date_of_birth,
                u.national_id_number, u.tin_number, u.physical_address, u.payout_method,
                partner_application_state(ur.user_id, ur.role) as state
           from user_roles ur join users u on u.id = ur.user_id
          where ur.user_id = $1 and ur.role = $2`,
        [userId, role]
    );
    if (rows.length === 0) throw notFound(`A ${role} application`);
    const [item] = await withEvidence(db, rows);
    return item;
}

/** Adds each applicant's documents and open remediations, one query each for the page. */
async function withEvidence(db, rows) {
    const ids = [...new Set(rows.map((row) => row.user_id))];
    if (ids.length === 0) return [];
    const [{rows: documents}, {rows: remediations}] = await Promise.all([
        query(
            db,
            `select id, user_id, document_type, status, rejection_reason, created_at, reviewed_at,
                    thumbnail_key is not null as has_thumbnail
               from kyc_documents where user_id = any($1::uuid[]) order by created_at desc`,
            [ids]
        ),
        query(
            db,
            `select id, user_id, kyc_document_id, issue, requested_action, raised_by, created_at
               from kyc_remediations where user_id = any($1::uuid[]) and not resolved order by created_at desc`,
            [ids]
        ),
    ]);
    const byUser = (list, userId) => list.filter((row) => row.user_id === userId).map(({user_id, ...rest}) => rest);

    return rows.map((row) => ({
        userId: row.user_id,
        role: row.role,
        status: row.status,
        person: {
            fullName: row.full_name,
            phoneNumber: row.phone_number,
            email: row.email,
            kycStatus: row.kyc_status,
            dateOfBirth: row.date_of_birth,
            nationalIdNumber: row.national_id_number,
            tinNumber: row.tin_number,
            physicalAddress: row.physical_address,
            payoutMethod: row.payout_method,
        },
        documents: byUser(documents, row.user_id),
        remediations: byUser(remediations, row.user_id),
        application: toApplicationView(row.state),
    }));
}
