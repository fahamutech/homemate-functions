import {withActor, query, toPage, pageParams, nullIfBlank, updateById} from '../../shared/db.mjs';
import {notFound, invalid} from '../../shared/errors.mjs';
import {PLATFORM_ROLES, STAFF_ROLES, readRolesForUsers} from '../../shared/roles.mjs';
import {publicRole} from '../../shared/active-role.mjs';
import {hashPassword, generateInitialPassword} from '../../shared/passwords.mjs';

export {PLATFORM_ROLES, STAFF_ROLES};
const ALL_ROLES = [...PLATFORM_ROLES, ...STAFF_ROLES];

const UPDATABLE_FIELDS = [
    'full_name', 'email', 'phone_number', 'job_title', 'role', 'organization_id', 'allowed_routes',
];

/** Backoffice route keys (navConfig.ts) an invited staff account may open; 'admin' ignores this. */
function normalizeAllowedRoutes(value) {
    if (!Array.isArray(value)) return null;
    const keys = value.filter((key) => typeof key === 'string' && key.trim().length > 0);
    return keys.length > 0 ? keys : [];
}

/** A boolean filter has three meanings: on, off, and "don't filter". */
function triState(value) {
    if (value === undefined || value === null || value === '') return null;
    return value === true || value === 'true';
}

/**
 * Adds `roles` (the account's user_roles rows, migration 027) to each user
 * row, in one query for the whole page. Staff have none.
 */
async function withRoles(db, userRows) {
    const byUser = await readRolesForUsers(db, userRows.map((row) => row.id));
    return userRows.map((row) => ({...row, roles: (byUser.get(row.id) ?? []).map(publicRole)}));
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
        const page = toPage(rows, {limit, offset});
        return {...page, items: await withRoles(pool, page.items)};
    }

    async function getById(id) {
        const {rows} = await query(pool, 'select * from v_users where id = $1', [id]);
        if (rows.length === 0) throw notFound('User');
        const [user] = await withRoles(pool, rows);
        return user;
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

        const isStaff = STAFF_ROLES.includes(role);
        // Staff authenticate with a password (platform users use phone OTP),
        // and it starts as a one-time secret only the creator ever sees in
        // plaintext — see the `initial_password` field on the return value.
        const initialPassword = isStaff ? generateInitialPassword() : null;
        const passwordHash = initialPassword ? await hashPassword(initialPassword) : null;
        // 'admin' always has full access and never needs a route list.
        const allowedRoutes = isStaff && role !== 'admin' ? normalizeAllowedRoutes(input.allowedRoutes) : null;

        return withActor(pool, actor, async (client) => {
            const {rows} = await client.query(
                `insert into users
                    (phone_number, email, full_name, role, organization_id, job_title, status,
                     password_hash, allowed_routes)
                 values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
                 returning id`,
                [
                    // phone is NOT NULL on the table; staff invited by email get a placeholder
                    phoneNumber ?? `pending:${email}`,
                    email,
                    nullIfBlank(input.fullName),
                    role,
                    nullIfBlank(input.organizationId),
                    nullIfBlank(input.jobTitle),
                    nullIfBlank(input.status) ?? (isStaff ? 'pending' : 'active'),
                    passwordHash,
                    allowedRoutes ? JSON.stringify(allowedRoutes) : null,
                ]
            );
            const {rows: created} = await client.query('select * from v_users where id = $1', [rows[0].id]);
            const [user] = await withRoles(client, created);
            return initialPassword ? {...user, initial_password: initialPassword} : user;
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
                    allowed_routes:
                        patch.allowedRoutes === undefined
                            ? undefined
                            : JSON.stringify(normalizeAllowedRoutes(patch.allowedRoutes) ?? []),
                },
            });
            if (!updated) throw notFound('User');
            const {rows} = await client.query('select * from v_users where id = $1', [id]);
            const [user] = await withRoles(client, rows);
            return user;
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
            const [user] = await withRoles(client, updated);
            return user;
        });
    }

    return {search, getById, create, update, changeStatus};
}
