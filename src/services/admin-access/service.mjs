import {timingSafeEqual} from 'node:crypto';
import {AdminAccessError, AdminAccessErrorCodes} from './ports.mjs';

function timingSafeStringEqual(a, b) {
    const bufferA = Buffer.from(a);
    const bufferB = Buffer.from(b);
    if (bufferA.length !== bufferB.length) {
        // still run a comparison of equal-length buffers so a length
        // mismatch doesn't short-circuit faster than a real compare would.
        timingSafeEqual(bufferA, bufferA);
        return false;
    }
    return timingSafeEqual(bufferA, bufferB);
}

/**
 * The admin-access domain service: a single, env-predefined administrator
 * account (no database row, no OTP) so the backoffice admin portal has a
 * simple, always-available way in. Broker/agency/customer identity stays
 * on identity-access's phone-OTP flow — this is deliberately a separate,
 * simpler module rather than another branch inside identity-access, since
 * the two have almost nothing in common besides issuing a session token.
 *
 * @param {object} deps
 * @param {string} deps.adminEmail
 * @param {string} deps.adminPassword
 * @param {ReturnType<typeof import('../../shared/session-tokens.mjs').createSessionTokenService>} deps.sessionTokens
 */
export function createAdminAccessService({adminEmail, adminPassword, sessionTokens}) {
    if (!adminEmail || !adminPassword) {
        throw new AdminAccessError(
            AdminAccessErrorCodes.NOT_CONFIGURED,
            'ADMIN_EMAIL and ADMIN_PASSWORD must both be set'
        );
    }
    const normalizedAdminEmail = adminEmail.toLowerCase();

    async function login({email, password}) {
        const normalizedEmail = typeof email === 'string' ? email.toLowerCase() : '';
        const emailMatches = normalizedEmail === normalizedAdminEmail;
        const passwordMatches = typeof password === 'string' && timingSafeStringEqual(password, adminPassword);

        if (!emailMatches || !passwordMatches) {
            throw new AdminAccessError(AdminAccessErrorCodes.INVALID_CREDENTIALS, 'Incorrect email or password');
        }

        const admin = {email: normalizedAdminEmail, role: 'admin'};
        const token = sessionTokens.sign(admin);
        return {token, admin};
    }

    return {login};
}
