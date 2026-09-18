import {withActor, query, toPage, pageParams, nullIfBlank, updateById} from '../../shared/db.mjs';
import {notFound, invalid} from '../../shared/errors.mjs';

export const PLATFORM_ROLES = ['customer', 'landlord', 'agency', 'broker'];
export const STAFF_ROLES = ['moderator', 'manager', 'finance_auditor', 'admin'];
const ALL_ROLES = [...PLATFORM_ROLES, ...STAFF_ROLES];

const UPDATABLE_FIELDS = ['full_name', 'email', 'phone_number', 'job_title', 'role', 'organization_id'];

/** A boolean filter has three meanings: on, off, and "don't filter". */
function triState(value) {
    if (value === undefined || value === null || value === '') return null;
    return value === true || value === 'true';
}

/**
 * Users = every human on the platform: customers, landlords, agencies and
 * brokers, plus backoffice staff (moderator / manager / finance auditor /
 * admin). One table, one service — the `role` column is the discriminator and
 * the database (003_triggers.sql) enforces which roles may be org-scoped and
 * which status transitions are legal, so this layer does not re-check them.
 */
export function createUsersService({pool}) {
    async function search(filters = {}) {
        const {limit, offset} = pageParams(filters);
        const {rows} = await query(
            pool,
            'select * from search_users($1, $2, $3, $4, $5, $6, $7, $8, $9)',
            [
                nullIfBlank(filters.query),
                nullIfBlank(filters.role),
                nullIfBlank(filters.status),
                nullIfBlank(filters.organizationId),
                triState(filters.staffOnly),
                nullIfBlank(filters.kycStatus),
                triState(filters.needsAttention),
                limit,
                offset,
            ]
        );
        return toPage(rows, {limit, offset});
    }

    async function getById(id) {
        const {rows} = await query(pool, 'select * from v_users where id = $1', [id]);
        if (rows.length === 0) throw notFound('User');
        return rows[0];
    }

    async function create(input, actor) {
        const role = nullIfBlank(input.role) ?? 'customer';
        if (!ALL_ROLES.includes(role)) {
            throw invalid(`role must be one of: ${ALL_ROLES.join(', ')}`);
        }
        const phoneNumber = nullIfBlank(input.phoneNumber);
        const email = nullIfBlank(input.email);
        if (!phoneNumber && !email) {
            throw invalid('Either phoneNumber or email is required');
        }

        return withActor(pool, actor, async (client) => {
            const {rows} = await client.query(
                `insert into users (phone_number, email, full_name, role, organization_id, job_title, status)
                 values ($1, $2, $3, $4, $5, $6, $7)
                 returning id`,
                [
                    // phone is NOT NULL on the table; staff invited by email get a placeholder
                    phoneNumber ?? `pending:${email}`,
                    email,
                    nullIfBlank(input.fullName),
                    role,
                    nullIfBlank(input.organizationId),
                    nullIfBlank(input.jobTitle),
                    nullIfBlank(input.status) ?? (STAFF_ROLES.includes(role) ? 'pending' : 'active'),
                ]
            );
            const {rows: created} = await client.query('select * from v_users where id = $1', [rows[0].id]);
            return created[0];
        });
    }

    async function update(id, patch, actor) {
        return withActor(pool, actor, async (client) => {
            const updated = await updateById(client, {
                table: 'users',
                id,
                allowed: UPDATABLE_FIELDS,
                returning: 'id',
                patch: {
                    full_name: nullIfBlank(patch.fullName) ?? undefined,
                    email: patch.email === undefined ? undefined : nullIfBlank(patch.email),
                    phone_number: nullIfBlank(patch.phoneNumber) ?? undefined,
                    job_title: patch.jobTitle === undefined ? undefined : nullIfBlank(patch.jobTitle),
                    role: nullIfBlank(patch.role) ?? undefined,
                    organization_id:
                        patch.organizationId === undefined ? undefined : nullIfBlank(patch.organizationId),
                },
            });
            if (!updated) throw notFound('User');
            const {rows} = await client.query('select * from v_users where id = $1', [id]);
            return rows[0];
        });
    }

    /**
     * Status changes go through their own entry point rather than `update`
     * because a suspension carries a reason and the database refuses illegal
     * moves (e.g. deactivated -> suspended).
     */
    async function changeStatus(id, {status, reason}, actor) {
        const nextStatus = nullIfBlank(status);
        if (!nextStatus) throw invalid('status is required');
        if (nextStatus === 'suspended' && !nullIfBlank(reason)) {
            throw invalid('A suspension reason is required');
        }

        return withActor(pool, actor, async (client) => {
            const {rows} = await client.query(
                `update users
                    set status = $2::user_status,
                        suspension_reason = case when $2 = 'suspended' then $3 else null end
                  where id = $1
                  returning id`,
                [id, nextStatus, nullIfBlank(reason)]
            );
            if (rows.length === 0) throw notFound('User');
            const {rows: updated} = await client.query('select * from v_users where id = $1', [id]);
            return updated[0];
        });
    }

    return {search, getById, create, update, changeStatus};
}
