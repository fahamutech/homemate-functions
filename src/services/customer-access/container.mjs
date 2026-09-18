import {getPool} from '../../db/pool.mjs';
import {createCustomerAccessRepository} from './repository.mjs';
import {createCustomerAccessService} from './service.mjs';
import {getSharedSessionTokens} from '../../shared/session-tokens.mjs';
import {createSandboxNotificationAdapter} from '../identity-access/adapters/sandbox-notification.adapter.mjs';
import {createNextSmsAdapter} from '../identity-access/adapters/nextsms-notification.adapter.mjs';

/**
 * Composition root for customer authentication — the one place that decides
 * which SMS vendor is real. `service.mjs` never learns the vendor's name, so
 * swapping provider is a new adapter file and one branch here.
 */
function createNotificationPort() {
    const provider = process.env.SMS_PROVIDER ?? process.env.NOTIFICATION_PROVIDER ?? 'sandbox';
    switch (provider) {
        case 'sandbox':
            return createSandboxNotificationAdapter();
        case 'nextsms':
            return createNextSmsAdapter();
        default:
            throw new Error(`Unknown SMS provider "${provider}" — no adapter is registered for it`);
    }
}

export const smsPort = createNotificationPort();

export const customerAccess = createCustomerAccessService({
    repository: createCustomerAccessRepository({pool: getPool()}),
    notificationPort: smsPort,
    sessionTokens: getSharedSessionTokens(),
});
