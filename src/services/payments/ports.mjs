/**
 * PaymentPort — the contract every payment provider adapter implements.
 *
 * Per BR-005, a payment is only ever "successful" because a trusted provider
 * said so: `createCharge` opens an attempt, and confirmation arrives through
 * `handleCallback` (a provider webhook) or `reconcile` (an authorised
 * lookup). No adapter may mark a charge paid on its own say-so, and nothing
 * in the UI can either.
 *
 * @typedef {object} ChargeRequest
 * @property {string} reference        HomeMate's own reference
 * @property {number} amount
 * @property {string} currency
 * @property {string} methodCode       payment_methods.code
 * @property {string} [payerPhone]
 * @property {object} [metadata]
 *
 * @typedef {object} ChargeResult
 * @property {'pending'|'failed'} status  never 'successful' — see above
 * @property {string} providerReference
 * @property {string} provider
 * @property {object} raw                verbatim provider payload, stored as an external entity
 * @property {string} [instructions]     what the payer must do next
 *
 * @typedef {object} PaymentPort
 * @property {string} provider
 * @property {(request: ChargeRequest) => Promise<ChargeResult>} createCharge
 * @property {(payload: object) => Promise<{reference: string, status: string, providerReference: string, raw: object}>} handleCallback
 * @property {(reference: string) => Promise<{status: string, raw: object}>} reconcile
 */

export class PaymentError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.name = 'PaymentError';
        this.code = code;
        this.status = status;
    }
}
