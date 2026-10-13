/**
 * The outbox sweeps. SMS are drained straight after the commits that queue
 * them, and pushes as soon as the database announces a notification; these
 * catch what that missed — a provider outage, a process that stopped
 * mid-send, a listener that was reconnecting — and retry it.
 *
 * The notifications container is loaded when a job runs, not when the file is
 * read, so a problem there can never stop the API from starting.
 */
const container = () => import('../../src/services/notifications/container.mjs');

export const drainSmsOutbox = {
    rule: '* * * * *',
    description: 'Send queued event SMS (payment receipts, payouts) and retry failures',
    onJob: async () => {
        try {
            await (await container()).smsOutbox.drain();
        } catch (error) {
            console.error('[job] drainSmsOutbox failed', error);
        }
    },
};

export const drainPushOutbox = {
    rule: '* * * * *',
    description: 'Push notifications the listener missed, and retry failed pushes',
    onJob: async () => {
        try {
            await (await container()).pushOutbox.drain();
        } catch (error) {
            console.error('[job] drainPushOutbox failed', error);
        }
    },
};
