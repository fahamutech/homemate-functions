/**
 * admin-access has no external port of its own — it authenticates against
 * a single env-predefined superuser (ADMIN_EMAIL/ADMIN_PASSWORD) or, for
 * invited staff, a hashed password on their `users` row (see
 * shared/passwords.mjs). This file exists so its error contract lives in
 * the same place every other module's does.
 */
export class AdminAccessError extends Error {
    /**
     * @param {string} code
     * @param {string} message
     */
    constructor(code, message) {
        super(message);
        this.name = 'AdminAccessError';
        this.code = code;
    }
}

export const AdminAccessErrorCodes = Object.freeze({
    INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
    NOT_CONFIGURED: 'NOT_CONFIGURED',
    // A staff account exists and the password matched, but sign-in is
    // blocked pending activation or the minimum identity check the portal
    // requires — distinct from INVALID_CREDENTIALS so the person knows to
    // wait rather than retype their password.
    ACCOUNT_INACTIVE: 'ACCOUNT_INACTIVE',
    KYC_REQUIRED: 'KYC_REQUIRED',
});
