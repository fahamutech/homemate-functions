/**
 * admin-access has no external port of its own — it authenticates against
 * credentials predefined in the environment (ADMIN_EMAIL/ADMIN_PASSWORD),
 * not a database or a third-party identity provider. This file exists so
 * its error contract lives in the same place every other module's does.
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
});
