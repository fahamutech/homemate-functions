/**
 * NotificationPort — the only way identity-access is allowed to reach an
 * SMS/email vendor. Domain code (service.mjs) depends on this contract only,
 * never on a specific adapter. See IMPLEMENTATION_PLAN.md Section 2.1.
 *
 * @typedef {object} NotificationPort
 * @property {(message: {to: string, template: string, params: object}) =>
 *   Promise<{provider: string, externalId: string|null, status: string, raw: object}>} send
 */

/**
 * Thrown by service.mjs for every expected business-rule failure, so the
 * HTTP layer (functions/rest) can map `code` to the right status code
 * without the service knowing anything about HTTP.
 */
export class IdentityAccessError extends Error {
    /**
     * @param {string} code
     * @param {string} message
     */
    constructor(code, message) {
        super(message);
        this.name = 'IdentityAccessError';
        this.code = code;
    }
}

export const IdentityAccessErrorCodes = Object.freeze({
    INVALID_PHONE_NUMBER: 'INVALID_PHONE_NUMBER',
    CHALLENGE_NOT_FOUND: 'CHALLENGE_NOT_FOUND',
    CHALLENGE_ALREADY_USED: 'CHALLENGE_ALREADY_USED',
    CHALLENGE_EXPIRED: 'CHALLENGE_EXPIRED',
    CHALLENGE_LOCKED: 'CHALLENGE_LOCKED',
    INVALID_CODE: 'INVALID_CODE',
    USER_NOT_FOUND: 'USER_NOT_FOUND',
});
