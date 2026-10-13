import {smsOutbox, pushOutbox} from '../../src/services/notifications/container.mjs';

/**
 * The outbox sweeps. SMS are drained straight after the commits that queue
 * them, and pushes as soon as the database announces a notification; these
 * catch what that missed — a provider outage, a process that stopped
 * mid-send, a listener that was reconnecting — and retry it.
 */
export const drainSmsOutbox = {
    rule: '* * * * *',
    description: 'Send queued event SMS (payment receipts, payouts) and retry failures',
    onJob: () => smsOutbox.drain().catch((error) => console.error('[job] drainSmsOutbox failed', error)),
};

export const drainPushOutbox = {
    rule: '* * * * *',
    description: 'Push notifications the listener missed, and retry failed pushes',
    onJob: () => pushOutbox.drain().catch((error) => console.error('[job] drainPushOutbox failed', error)),
};
