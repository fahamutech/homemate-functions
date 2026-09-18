import {timingSafeEqual} from 'node:crypto';
import {AdminAccessError, AdminAccessErrorCodes} from './ports.mjs';
import {verifyPassword} from '../../shared/passwords.mjs';
import {STAFF_ROLES} from '../../shared/roles.mjs';

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
 * The admin-access domain service: a single, env-predefined superuser
 * (checked first, no database row, no OTP) plus, for invited staff, a
 * lookup against their `users` row's hashed password. Broker/agency/customer
 * identity stays on identity-access's phone-OTP flow — this is deliberately
 * a separate, simpler module rather than another branch inside
 * identity-access, since the two have almost nothing in common besides
 * issuing a session token.
 *
 * @param {object} deps
 * @param {string} deps.adminEmail
 * @param {string} deps.adminPassword
 * @param {ReturnType<typeof import('../../shared/session-tokens.mjs').createSessionTokenService>} deps.sessionTokens
 * @param {import('pg').Pool} [deps.pool] staff accounts live in the database; omitted in unit tests that only
 *   exercise the env-credential path.
 */
export function createAdminAccessService({adminEmail, adminPassword, sessionTokens, pool}) {
    if (!adminEmail || !adminPassword) {
        throw new AdminAccessError(
            AdminAccessErrorCodes.NOT_CONFIGURED,
            'ADMIN_EMAIL and ADMIN_PASSWORD must both be set'
        );
    }
    const normalizedAdminEmail = adminEmail.toLowerCase();

    async function findStaffByEmail(email) {
        if (!email || !pool) return null;
        const {rows} = await pool.query(
            `select id, email, role, status, kyc_status, password_hash, allowed_routes
               from users
              where lower(email) = $1 and role = any($2::user_role[])`,
            [email, STAFF_ROLES]
        );
        return rows[0] ?? null;
    }

    async function login({email, password}) {
        const normalizedEmail = typeof email === 'string' ? email.toLowerCase() : '';
        const passwordString = typeof password === 'string' ? password : '';

        if (normalizedEmail === normalizedAdminEmail && timingSafeStringEqual(passwordString, adminPassword)) {
            const admin = {email: normalizedAdminEmail, role: 'admin'};
            return {token: sessionTokens.sign(admin), admin};
        }

        const staff = await findStaffByEmail(normalizedEmail);
        if (staff && (await verifyPassword(passwordString, staff.password_hash))) {
            if (staff.status !== 'active') {
                throw new AdminAccessError(
                    AdminAccessErrorCodes.ACCOUNT_INACTIVE,
                    'This staff account has not been activated yet'
                );
            }
            if (staff.kyc_status !== 'verified') {
                throw new AdminAccessError(
                    AdminAccessErrorCodes.KYC_REQUIRED,
                    'Identity verification is required before you can sign in'
                );
            }
            const admin = {
                email: staff.email,
                role: staff.role,
                userId: staff.id,
                allowedRoutes: staff.role === 'admin' ? null : (staff.allowed_routes ?? []),
            };
            return {token: sessionTokens.sign(admin), admin};
        }

        throw new AdminAccessError(AdminAccessErrorCodes.INVALID_CREDENTIALS, 'Incorrect email or password');
    }

    return {login};
}
