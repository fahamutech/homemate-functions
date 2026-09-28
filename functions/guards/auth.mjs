import {getSharedSessionTokens} from '../../src/shared/session-tokens.mjs';
import {STAFF_ROLES, readRoleStatus} from '../../src/shared/roles.mjs';
import {resourceKeysForPath} from '../../src/shared/admin-acl.mjs';
import {createPartnerRoleGuard} from '../../src/shared/partner-role-guard.mjs';
import {getPool} from '../../src/db/pool.mjs';

const created = new Date().toISOString();

/**
 * Builds a guard descriptor that requires a valid Bearer session token at
 * exactly `path`, optionally constrained to `requiredRole` (a role, or an
 * array of roles any of which is accepted). Both identity-access sessions
 * ({userId, phoneNumber}) and admin-access sessions ({role, email, ...})
 * are signed by the same shared session-tokens.mjs, so a validly-signed
 * token alone is NOT enough to authorize an admin route — a customer/broker
 * token would pass signature verification too. `requiredRole` closes that
 * gap; `enforceAcl` additionally checks a non-admin staff session's
 * `allowedRoutes` against the request path (see shared/admin-acl.mjs).
 *
 * bfast-function mounts a guard's `onGuard` as Express middleware scoped to
 * its `path` prefix, so e.g. the '/auth/me' guard never runs for
 * '/auth/otp/request' or '/auth/admin/login'.
 */
function createSessionGuard(path, description, {requiredRole, enforceAcl = false} = {}) {
    const allowedRoles = requiredRole == null ? null : [].concat(requiredRole);

    return {
        created,
        path,
        description,
        onGuard: (request, response, next) => {
            const header = request.headers.authorization ?? '';
            const [scheme, token] = header.split(' ');
            if (scheme !== 'Bearer' || !token) {
                response.status(401).json({error: 'UNAUTHORIZED', message: 'Missing bearer session token'});
                return;
            }

            const payload = getSharedSessionTokens().verify(token);
            if (!payload) {
                response.status(401).json({error: 'UNAUTHORIZED', message: 'Invalid or expired session token'});
                return;
            }

            if (allowedRoles && !allowedRoles.includes(payload.role)) {
                response
                    .status(403)
                    .json({error: 'FORBIDDEN', message: `This route requires one of these roles: ${allowedRoles.join(', ')}`});
                return;
            }

            // The single admin role always has full access. A restricted
            // staff role (moderator/manager/finance_auditor) is further
            // scoped to whichever sidebar sections it was granted.
            if (enforceAcl && payload.role !== 'admin') {
                const requestPath = (request.originalUrl ?? request.url ?? '').split('?')[0];
                const requiredKeys = resourceKeysForPath(requestPath);
                const grantedKeys = Array.isArray(payload.allowedRoutes) ? payload.allowedRoutes : [];
                const permitted = requiredKeys !== null
                    && (requiredKeys.length === 0 || requiredKeys.some((key) => grantedKeys.includes(key)));
                if (!permitted) {
                    response
                        .status(403)
                        .json({error: 'FORBIDDEN', message: 'Your account does not have access to this section'});
                    return;
                }
            }

            request.auth = payload;
            next();
        },
    };
}

export const requireCustomerSession = createSessionGuard(
    '/auth/me',
    'Requires a valid Bearer session token issued by /auth/otp/verify'
);

export const requireAdminSession = createSessionGuard(
    '/auth/admin/me',
    'Requires a valid Bearer staff session token issued by /auth/admin/login',
    {requiredRole: STAFF_ROLES}
);

// One guard covers the whole admin API surface, so a new /admin/* route is
// protected the moment it exists — there is no per-route step to forget.
// Every backoffice role may pass the session check; resourceKeysForPath
// then scopes non-admin roles to their granted sidebar sections.
export const requireAdminForConsole = createSessionGuard(
    '/admin',
    'Requires a staff session for every backoffice API route, ACL-scoped for non-admin roles',
    {requiredRole: STAFF_ROLES, enforceAcl: true}
);

/**
 * The same arrangement for the mobile app: every `/app/*` route needs a
 * customer session, so adding a screen's endpoint cannot accidentally ship it
 * unauthenticated. The unauthenticated parts of the journey — asking for a
 * code, verifying it, choosing a PIN, signing in — live under `/customer/auth`
 * and are deliberately outside this prefix.
 */
export const requireCustomerForApp = createSessionGuard(
    '/app',
    'Requires a customer session for every mobile app API route',
    {requiredRole: 'customer'}
);

/**
 * Builds the guard for a broker or landlord workspace (T01): the session must
 * be acting as `role`, and `user_roles` must still say that role is active —
 * a suspension takes effect on the next request. Exported as a factory, so
 * bfast mounts nothing until a route file (T03–T06) exports
 * `requirePartnerRole('broker', {path: '/app/broker'})`.
 *
 * @param {'broker'|'landlord'} role
 * @param {{path?: string}} [options] the prefix to guard; defaults to `/app/<role>`
 */
export function requirePartnerRole(role, {path} = {}) {
    return createPartnerRoleGuard({
        role,
        path,
        verify: (token) => getSharedSessionTokens().verify(token),
        roleStatusOf: (userId, askedRole) => readRoleStatus(getPool(), userId, askedRole),
    });
}
