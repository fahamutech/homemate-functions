/**
 * The PushPort used when push is configured wrongly (container.mjs). It sends
 * nothing and says why, so the push outbox keeps the notifications queued and
 * retries them — a corrected setting delivers them — while the API, the inbox
 * and SMS carry on. Better a loud log line than an API that will not start.
 */
export function createDisabledPushAdapter(reason) {
    return {
        provider: 'disabled',

        /** @type {import('../ports.mjs').PushPort['send']} */
        async send() {
            return {ok: false, provider: 'disabled', retryable: true, error: `push is disabled: ${reason}`};
        },
    };
}
