import {PARTNER_ROLES} from './roles.mjs';

const created = new Date().toISOString();

/**
 * A guard for a broker or landlord workspace (T01). Two checks, in order:
 *
 *   1. the token says the session is *acting* as `role` — cheap, no database;
 *   2. `user_roles` still says that role is `active` — so a suspension bites
 *      on the next request instead of when the week-long token expires.
 *
 * Dependencies are injected so the decision is unit-testable; the real
 * wiring (shared token signer, pool) is `requirePartnerRole` in
 * functions/guards/auth.mjs.
 *
 * @param {{role: 'broker'|'landlord', path?: string,
 *          verify: (token: string) => Record<string, unknown>|null,
 *          roleStatusOf: (userId: string, role: string) => Promise<string|null>}} options
 */
export function createPartnerRoleGuard({role, path = `/app/${role}`, verify, roleStatusOf}) {
    if (!PARTNER_ROLES.includes(role)) {
        throw new Error(`requirePartnerRole needs one of: ${PARTNER_ROLES.join(', ')} (got ${role})`);
    }

    const notActive = (response) =>
        response.status(403).json({error: 'ROLE_NOT_ACTIVE', message: `Switch to your ${role} role to continue`});

    return {
        created,
        path,
        description: `Requires a customer session acting as an active ${role}`,
        onGuard: async (request, response, next) => {
            const [scheme, token] = (request.headers?.authorization ?? '').split(' ');
            if (scheme !== 'Bearer' || !token) {
                response.status(401).json({error: 'UNAUTHORIZED', message: 'Missing bearer session token'});
                return;
            }

            const payload = verify(token);
            if (!payload) {
                response.status(401).json({error: 'UNAUTHORIZED', message: 'Invalid or expired session token'});
                return;
            }

            if (payload.activeRole !== role) {
                notActive(response);
                return;
            }

            let status;
            try {
                status = await roleStatusOf(payload.userId, role);
            } catch (error) {
                console.error(`partner guard (${role}) failed`, error);
                response.status(500).json({error: 'INTERNAL_ERROR', message: 'Unexpected server error'});
                return;
            }
            if (status !== 'active') {
                notActive(response);
                return;
            }

            request.auth = payload;
            next();
        },
    };
}
