import {getPool} from '../../db/pool.mjs';
import * as repository from './repository.mjs';
import {createIdentityAccessService} from './service.mjs';
import {createSandboxNotificationAdapter} from './adapters/sandbox-notification.adapter.mjs';
import {getSharedSessionTokens} from '../../shared/session-tokens.mjs';

/**
 * Composition root for identity-access: the ONE place that picks a real
 * NotificationPort adapter based on config. `functions/rest/*` and
 * `functions/guards/*` import from here, never from an adapter directly —
 * so adding a real SMS vendor later means adding one file under
 * `adapters/` and one branch here, with zero changes to service.mjs, the
 * guard, or the HTTP handlers (IMPLEMENTATION_PLAN.md Section 2.1).
 */
function createNotificationPort() {
    const provider = process.env.NOTIFICATION_PROVIDER ?? 'sandbox';
    switch (provider) {
        case 'sandbox':
            return createSandboxNotificationAdapter();
        default:
            throw new Error(`Unknown NOTIFICATION_PROVIDER "${provider}" — no adapter registered for it yet`);
    }
}

export const notificationPort = createNotificationPort();

export const identityAccessService = createIdentityAccessService({
    db: getPool(),
    repository,
    notificationPort,
    sessionTokens: getSharedSessionTokens(),
});
