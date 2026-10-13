import {getPool} from '../../db/pool.mjs';
import {smsPort} from '../customer-access/container.mjs';
import {createSmsOutbox} from './sms-outbox.mjs';
import {createPushOutbox} from './push-outbox.mjs';
import {createPushDevicesService} from './devices.mjs';
import {createSandboxPushAdapter} from './adapters/sandbox-push.adapter.mjs';
import {createFcmPushAdapter} from './adapters/fcm-push.adapter.mjs';

const pool = getPool();

/**
 * Event SMS go through the same port as sign-in codes — one vendor, one set of
 * credentials, one balance the portal watches.
 */
export const smsOutbox = createSmsOutbox({pool, smsPort});

/**
 * The one place that picks the push vendor. `sandbox` (the default) records
 * pushes in memory; `fcm` needs FCM_SERVICE_ACCOUNT_JSON or
 * FCM_SERVICE_ACCOUNT_FILE and fails the start without it, like the SMS port.
 */
function createPushPort() {
    const provider = process.env.PUSH_PROVIDER ?? 'sandbox';
    switch (provider) {
        case 'sandbox':
            return createSandboxPushAdapter();
        case 'fcm':
            return createFcmPushAdapter();
        default:
            throw new Error(`Unknown PUSH_PROVIDER "${provider}" — no adapter is registered for it`);
    }
}

export const pushPort = createPushPort();
export const pushOutbox = createPushOutbox({pool, pushPort});
export const pushDevices = createPushDevicesService({pool});
