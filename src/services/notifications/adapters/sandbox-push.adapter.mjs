/**
 * Sandbox PushPort: never reaches a phone. It keeps every message in memory so
 * tests and local dev can see exactly what would have been pushed.
 *
 * A token starting `invalid-` is answered the way FCM answers an uninstalled
 * app, and one starting `flaky-` the way it answers an outage, so both paths
 * can be exercised without a vendor.
 */
export function createSandboxPushAdapter({log = true} = {}) {
    /** @type {import('../ports.mjs').PushMessage[]} */
    const sentMessages = [];

    return {
        provider: 'sandbox',

        /** @type {import('../ports.mjs').PushPort['send']} */
        async send(message) {
            if (message.token.startsWith('invalid-')) {
                return {ok: false, provider: 'sandbox', invalidToken: true, error: 'UNREGISTERED'};
            }
            if (message.token.startsWith('flaky-')) {
                return {ok: false, provider: 'sandbox', retryable: true, error: 'UNAVAILABLE'};
            }
            sentMessages.push(message);
            if (log) console.log(`[sandbox-push] ${message.platform} "${message.title}"`, message.data);
            return {ok: true, provider: 'sandbox', messageId: `sandbox-${sentMessages.length}`};
        },

        /** Test/dev-only inspection API — never used by domain code. */
        sentMessages,
    };
}
