import {PaymentError} from '../ports.mjs';

/**
 * Sandbox PaymentPort: the default until a licensed Tanzanian provider is
 * contracted (Section 1 of IMPLEMENTATION_PLAN.md). It behaves like a real
 * provider in the way that matters — a charge opens as *pending* and only
 * becomes successful when a callback or reconciliation says so — so the rest
 * of the system is built against truthful semantics rather than an optimistic
 * stub that returns "paid" immediately.
 */
export function createSandboxPaymentAdapter() {
    const charges = new Map();

    return {
        provider: 'sandbox',

        async createCharge({reference, amount, currency, methodCode, payerPhone, metadata}) {
            if (!reference) throw new PaymentError('VALIDATION_FAILED', 'reference is required');
            if (!(amount > 0)) throw new PaymentError('VALIDATION_FAILED', 'amount must be greater than zero');

            const providerReference = `SBX-${reference}`;
            const raw = {reference, providerReference, amount, currency, methodCode, payerPhone, metadata,
                receivedAt: new Date().toISOString()};
            charges.set(reference, {status: 'pending', raw});

            return {
                status: 'pending',
                providerReference,
                provider: 'sandbox',
                raw,
                instructions: `Sandbox: confirm ${providerReference} via the provider callback to settle this charge.`,
            };
        },

        async handleCallback(payload) {
            const reference = payload?.reference;
            const charge = charges.get(reference);
            if (!charge) throw new PaymentError('NOT_FOUND', 'Unknown payment reference', 404);

            const status = payload?.status === 'successful' ? 'successful'
                : payload?.status === 'failed' ? 'failed'
                : 'pending';
            charges.set(reference, {status, raw: payload});

            return {reference, status, providerReference: charge.raw.providerReference, raw: payload};
        },

        async reconcile(reference) {
            const charge = charges.get(reference);
            if (!charge) throw new PaymentError('NOT_FOUND', 'Unknown payment reference', 404);
            return {status: charge.status, raw: charge.raw};
        },

        /** test-only */
        get pendingCount() {
            return [...charges.values()].filter((c) => c.status === 'pending').length;
        },
    };
}
