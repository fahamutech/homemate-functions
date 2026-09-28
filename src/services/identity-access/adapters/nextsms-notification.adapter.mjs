/**
 * NotificationPort backed by NextSMS (messaging-service.co.tz).
 *
 * Everything vendor-shaped is confined here: Basic auth, the `from` sender ID,
 * the `/api/sms/v1/text/single` payload, and the provider's own status
 * vocabulary. `service.mjs` knows only `{provider, externalId, status, raw}`,
 * so changing vendor is a new file plus one branch in container.mjs.
 *
 * The provider also reports the remaining credit, which is the number the
 * portal shows — an OTP journey that fails because the account ran dry looks
 * exactly like a broken login, so it has to be visible before it happens.
 */

const TEMPLATES = {
    'otp-code': ({code, purpose}) =>
        purpose === 'reset_pin'
            ? `${code} is your HomeMate code to reset your PIN. It expires in 5 minutes. Do not share it.`
            : `${code} is your HomeMate verification code. It expires in 5 minutes. Do not share it.`,
    'booking-confirmed': ({reference, property}) =>
        `Your HomeMate booking ${reference} for ${property} is confirmed.`,
    'payment-received': ({reference, amount, currency}) =>
        `HomeMate received your payment ${reference} of ${currency} ${amount}. Thank you.`,
    'partner-application-decision': ({decision, role, reason, text}) =>
        decision === 'approve'
            ? `HomeMate: your ${role} application is approved. Open the app and switch to your ${role} role.`
            : decision === 'reject'
              ? `HomeMate: your ${role} application was not approved. Reason: ${reason}`
              : `HomeMate: your ${role} application needs a change. ${text ?? ''} Open the app to fix it.`,
};

/** Provider status group 1/3 is pending, 20/DELIVERY is delivered, else rejected. */
function normaliseStatus(status) {
    const name = `${status?.groupName ?? ''}`.toUpperCase();
    if (name === 'DELIVERED' || name === 'DELIVERY') return 'delivered';
    if (name === 'PENDING') return 'sent';
    if (name === 'REJECTED' || name === 'UNDELIVERABLE') return 'failed';
    return 'sent';
}

/**
 * NextSMS wants a bare international number with no `+`, e.g. 255712345678.
 * Our domain stores E.164 (`+255712345678`), so the conversion lives here
 * rather than polluting the stored value.
 */
function toProviderNumber(phoneNumber) {
    return `${phoneNumber}`.replace(/[^\d]/g, '');
}

export function createNextSmsAdapter({
    baseUrl = process.env.SMS_BASE_URL ?? 'https://messaging-service.co.tz',
    username = process.env.SMS_USERNAME,
    password = process.env.SMS_PASSWORD,
    senderId = process.env.SMS_SENDER_ID ?? 'HOMEMATE',
    testMode = process.env.SMS_TEST_MODE === 'true',
    fetchImpl = fetch,
    timeoutMs = 10_000,
} = {}) {
    if (!username || !password) {
        throw new Error('SMS_USERNAME and SMS_PASSWORD are required for the nextsms provider');
    }

    console.log(`${username}:${password}`)
    const rawBase64 = Buffer.from(`${username}:${password}`).toString('base64');
    // Regex to split into 76-character chunks joined by CRLF
    const rfc2045Base64 = rawBase64.match(/.{1,76}/g).join('\r\n');
    const authorization = `Basic ${rfc2045Base64}`;
    console.log(authorization)
    const sendPath = testMode ? '/api/sms/v1/test/text/single' : '/api/sms/v1/text/single';

    async function call(path, {method = 'GET', body} = {}) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetchImpl(`${baseUrl}${path}`, {
                method,
                headers: {
                    authorization,
                    'content-type': 'application/json',
                    accept: 'application/json',
                },
                ...(body ? {body: JSON.stringify(body)} : {}),
                signal: controller.signal,
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
                const error = new Error(
                    `SMS provider refused the request (${response.status}): ${payload?.message ?? response.statusText}`
                );
                error.code = 'SMS_PROVIDER_ERROR';
                error.status = response.status;
                error.raw = payload;
                throw error;
            }
            return payload;
        } finally {
            clearTimeout(timer);
        }
    }

    return {
        provider: 'nextsms',

        /** @type {import('../ports.mjs').NotificationPort['send']} */
        async send({to, template, params}) {
            const render = TEMPLATES[template];
            if (!render) throw new Error(`No SMS template named "${template}"`);

            const payload = await call(sendPath, {
                method: 'POST',
                body: {
                    from: senderId,
                    to: toProviderNumber(to),
                    text: render(params ?? {}),
                    // Our own id travels with the message so a delivery report
                    // can be matched back without guessing from the number.
                    reference: params?.reference ?? undefined,
                },
            });

            const message = payload?.messages?.[0];
            return {
                provider: 'nextsms',
                externalId: message?.messageId ?? message?.status?.id?.toString() ?? null,
                status: normaliseStatus(message?.status),
                smsCount: message?.smsCount ?? 1,
                // The OTP itself must never reach the audit trail, so what is
                // stored is the provider's answer, not what we asked it to send.
                raw: payload,
            };
        },

        /** Remaining credits, for the portal's low-balance warning. */
        async balance() {
            const payload = await call('/api/sms/v1/balance');
            return {
                provider: 'nextsms',
                credits: Number(payload?.sms_balance ?? 0),
                raw: payload,
            };
        },
    };
}
