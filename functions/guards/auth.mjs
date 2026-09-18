import {getSharedSessionTokens} from '../../src/shared/session-tokens.mjs';

const created = new Date().toISOString();

/**
 * Builds a guard descriptor that requires a valid Bearer session token at
 * exactly `path`, optionally constrained to a specific `requiredRole`.
 * Both identity-access sessions ({userId, phoneNumber}) and admin-access
 * sessions ({role: 'admin', email}) are signed by the same shared
 * session-tokens.mjs, so a validly-signed token alone is NOT enough to
 * authorize an admin route — a customer/broker token would pass signature
 * verification too. `requiredRole` closes that gap.
 *
 * bfast-function mounts a guard's `onGuard` as Express middleware scoped to
 * its `path` prefix, so e.g. the '/auth/me' guard never runs for
 * '/auth/otp/request' or '/auth/admin/login'.
 */
function createSessionGuard(path, description, {requiredRole} = {}) {
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

            if (requiredRole && payload.role !== requiredRole) {
                response.status(403).json({error: 'FORBIDDEN', message: `This route requires a ${requiredRole} session`});
                return;
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
    'Requires a valid Bearer admin session token issued by /auth/admin/login',
    {requiredRole: 'admin'}
);

// One guard covers the whole admin API surface, so a new /admin/* route is
// protected the moment it exists — there is no per-route step to forget.
export const requireAdminForConsole = createSessionGuard(
    '/admin',
    'Requires an admin session for every backoffice API route',
    {requiredRole: 'admin'}
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
