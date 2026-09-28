import {query} from './db.mjs';

/**
 * The `user_role` enum (migrations/002_core_domain.sql), split into the two
 * groups every service that discriminates on role needs — kept here once so
 * admin-console, admin-access and the guards agree on the same lists.
 */
export const PLATFORM_ROLES = ['customer', 'landlord', 'agency', 'broker'];
export const STAFF_ROLES = ['moderator', 'manager', 'finance_auditor', 'admin'];

/**
 * The roles a phone-and-PIN account can hold in `user_roles` (migration 027),
 * in the order the app lists them. Agency stays on `users.role` and is out of
 * scope for partner roles.
 */
export const PARTNER_ROLES = ['broker', 'landlord'];
export const ACCOUNT_ROLES = ['customer', ...PARTNER_ROLES];

/** customer → broker → landlord, the same order as ACCOUNT_ROLES (the enum's own order differs). */
const ROLE_ORDER = `array_position(array['customer', 'broker', 'landlord']::user_role[], role)`;

const USER_ROLE_COLUMNS = `user_id, role, status, applied_at, submitted_at, activated_at, reviewed_at,
       reviewed_by, rejection_reason, agreement_version, agreement_accepted_at, created_at, updated_at`;

/** Every `user_roles` row for one account, customer first. */
export async function readUserRoles(db, userId) {
    const {rows} = await query(
        db,
        `select ${USER_ROLE_COLUMNS} from user_roles where user_id = $1 order by ${ROLE_ORDER}`,
        [userId]
    );
    return rows;
}

/** The same, for a page of accounts: a Map of user id → rows (absent ids get []). */
export async function readRolesForUsers(db, userIds) {
    const byUser = new Map(userIds.map((id) => [id, []]));
    if (userIds.length === 0) return byUser;
    const {rows} = await query(
        db,
        `select ${USER_ROLE_COLUMNS} from user_roles where user_id = any($1::uuid[]) order by user_id, ${ROLE_ORDER}`,
        [userIds]
    );
    for (const row of rows) byUser.get(row.user_id)?.push(row);
    return byUser;
}

/** One role's status, or null when the account never had it. */
export async function readRoleStatus(db, userId, role) {
    const {rows} = await query(db, 'select status from user_roles where user_id = $1 and role = $2', [
        userId,
        role,
    ]);
    return rows[0]?.status ?? null;
}
