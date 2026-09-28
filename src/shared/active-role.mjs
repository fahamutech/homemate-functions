import {ACCOUNT_ROLES} from './roles.mjs';

/**
 * Pure rules for "which roles is this person acting in" (T01). The rows are
 * `user_roles` rows as the database returns them; nothing here queries.
 */

/** Only `active` roles can be acted in, listed customer → broker → landlord. */
export function activeRolesOf(rows = []) {
    const active = new Set((rows ?? []).filter((row) => row.status === 'active').map((row) => row.role));
    return ACCOUNT_ROLES.filter((role) => active.has(role));
}

/** The role the app opens in: the last one used if still active, else customer. */
export function pickActiveRole({lastActiveRole, activeRoles}) {
    return lastActiveRole && activeRoles.includes(lastActiveRole) ? lastActiveRole : 'customer';
}

/**
 * What a phone-and-PIN session token carries. `role: 'customer'` stays for
 * the app versions that predate roles, and for the `/app` guard.
 */
export function customerSessionClaims(user, roleRows) {
    const roles = activeRolesOf(roleRows);
    return {
        userId: user.id,
        phoneNumber: user.phone_number,
        role: 'customer',
        roles,
        activeRole: pickActiveRole({lastActiveRole: user.last_active_role ?? null, activeRoles: roles}),
    };
}

/** A role as the app and the backoffice see it. The reviewer's identity stays internal. */
export function publicRole(row) {
    return {
        role: row.role,
        status: row.status,
        appliedAt: row.applied_at ?? null,
        submittedAt: row.submitted_at ?? null,
        activatedAt: row.activated_at ?? null,
        reviewedAt: row.reviewed_at ?? null,
        rejectionReason: row.rejection_reason ?? null,
    };
}
