/**
 * PushPort — the only way the backend reaches a push vendor. The push outbox
 * (push-outbox.mjs) depends on this contract, never on FCM itself, so tests
 * and local dev run against the sandbox adapter.
 *
 * `send` never throws for a refusal it understands: it reports it, so one dead
 * phone cannot stop the others from being reached.
 *
 * @typedef {object} PushMessage
 * @property {string} token     the device's registration token
 * @property {'android'|'ios'|'web'} platform
 * @property {string} title
 * @property {string|null} body
 * @property {Record<string, string>} data   what the app needs to open the right screen
 * @property {string|null} link  where a click on the web notification goes
 *
 * @typedef {object} PushResult
 * @property {boolean} ok
 * @property {string} provider
 * @property {string|null} [messageId]
 * @property {boolean} [invalidToken]  the token will never work again; stop using it
 * @property {boolean} [retryable]     worth trying again later (rate limit, outage)
 * @property {string} [error]
 *
 * @typedef {object} PushPort
 * @property {string} provider
 * @property {(message: PushMessage) => Promise<PushResult>} send
 */

export {};
