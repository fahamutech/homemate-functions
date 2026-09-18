/**
 * Sandbox adapter for NotificationPort (ports.mjs). Never sends a real SMS —
 * it records every message in memory so tests and local dev can inspect
 * exactly what would have been sent. This is the only adapter the plan
 * requires before a real SMS vendor is chosen (IMPLEMENTATION_PLAN.md
 * Section 2.1, item 4).
 */
export function createSandboxNotificationAdapter() {
    /** @type {Array<{to: string, template: string, params: object, sentAt: string}>} */
    const sentMessages = [];

    return {
        /** @type {import('../ports.mjs').NotificationPort['send']} */
        async send({to, template, params}) {
            const record = {to, template, params, sentAt: new Date().toISOString()};
            sentMessages.push(record);
            // Dev/manual-testing convenience only — this adapter is never
            // wired up in production (see container.mjs), so logging the
            // "sent" OTP here is safe and lets a human complete the login
            // journey locally without a real SMS provider.
            console.log(`[sandbox-notification] ${template} to ${to}:`, params);
            return {
                provider: 'sandbox',
                externalId: `sandbox-${sentMessages.length}`,
                status: 'delivered',
                raw: record,
            };
        },
        /** Test/dev-only inspection API — never used by domain code. */
        sentMessages,
        lastMessageTo(phoneNumber) {
            return [...sentMessages].reverse().find(m => m.to === phoneNumber);
        },
    };
}
