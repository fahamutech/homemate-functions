import {getPool} from '../../db/pool.mjs';
import {smsPort} from '../customer-access/container.mjs';
import {createSmsOutbox} from './sms-outbox.mjs';
import {createPushOutbox} from './push-outbox.mjs';
import {createPushDevicesService} from './devices.mjs';
import {createSandboxPushAdapter} from './adapters/sandbox-push.adapter.mjs';
import {createFcmPushAdapter} from './adapters/fcm-push.adapter.mjs';
import {createDisabledPushAdapter} from './adapters/disabled-push.adapter.mjs';

const pool = getPool();

/**
 * Event SMS go through the same port as sign-in codes — one vendor, one set of
 * credentials, one balance the portal watches.
 */
export const smsOutbox = createSmsOutbox({pool, smsPort});

/**
 * The one place that picks the push vendor. `sandbox` (the default) records
 * pushes in memory; `fcm` needs FCM_SERVICE_ACCOUNT_JSON or
 * FCM_SERVICE_ACCOUNT_FILE.
 *
 * Unlike the SMS port, a wrong push setting does NOT stop the server. Push is
 * a copy of what is already in the inbox, and this module is loaded when the
 * API starts — before migrations run — so throwing here took the whole API
 * down over a missing credentials file. It logs loudly and disables push
 * instead; notifications stay queued and are pushed once the setting is fixed.
 */
function createPushPort() {
    const provider = process.env.PUSH_PROVIDER ?? 'sandbox';
    try {
        switch (provider) {
            case 'sandbox':
                return createSandboxPushAdapter();
            case 'fcm':
                return createFcmPushAdapter();
            default:
                throw new Error(`Unknown PUSH_PROVIDER "${provider}" — no adapter is registered for it`);
        }
    } catch (error) {
        const reason = `${error?.message ?? error}`;
        console.error(`[push] DISABLED — ${reason}. The API, the inbox and SMS keep working; fix the push settings and restart to send pushes.`);
        return createDisabledPushAdapter(reason);
    }
}

export const pushPort = createPushPort();
export const pushOutbox = createPushOutbox({pool, pushPort});
export const pushDevices = createPushDevicesService({pool});
