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

/**
 * The store-review account, if this deployment has one. Both variables must be
 * set and well-formed or there is no such account — a half-configured one
 * would be a number that silently never receives a code.
 */
function createReviewAccount() {
    const phoneNumber = process.env.REVIEW_ACCOUNT_PHONE?.trim();
    const code = process.env.REVIEW_ACCOUNT_OTP?.trim();
    if (!phoneNumber && !code) return null;

    if (!/^\+255\d{9}$/.test(phoneNumber ?? '') || !/^\d{6}$/.test(code ?? '')) {
        throw new Error(
            'REVIEW_ACCOUNT_PHONE must be a +255 number and REVIEW_ACCOUNT_OTP a 6-digit code, or both must be unset'
        );
    }
    console.warn(`customer-access: review account active for ${phoneNumber} — its code is fixed and never sent`);
    return {phoneNumber, code};
}

export const customerAccess = createCustomerAccessService({
    repository: createCustomerAccessRepository({pool: getPool()}),
    notificationPort: smsPort,
    sessionTokens: getSharedSessionTokens(),
    reviewAccount: createReviewAccount(),
});
