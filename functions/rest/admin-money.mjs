import {adminConsole} from '../../src/services/admin-console/container.mjs';
import {route, actorOf} from '../../src/shared/http.mjs';

/**
 * Money in and money out.
 *
 * Note what has no endpoint: there is no "mark this payment successful". A
 * collection is settled either by a provider event or by an explicit
 * reconciliation, because BR-005 says an operator's say-so is not evidence,
 * and the database refuses anything else.
 */

// --- Collection ----------------------------------------------------------------

export const adminSearchPayments = route({
    method: 'get',
    path: '/admin/payments',
    description: 'Search collections by reference, payer, property, status or date',
    handler: (request) => adminConsole.money.searchPayments(request.query),
});

export const adminPaymentSummary = route({
    method: 'get',
    path: '/admin/money/summary',
    description: 'Collected, pending, disbursed, owed and platform revenue',
    handler: () => adminConsole.money.summary(),
});

export const adminGetPayment = route({
    method: 'get',
    path: '/admin/payments/:id',
    description: 'One collection with its splits, provider events and ledger postings',
    handler: (request) => adminConsole.money.getPayment(request.params.id),
});

export const adminRecordPayment = route({
    method: 'post',
    path: '/admin/payments',
    description: 'Record a rent collection; it opens as pending and is split immediately',
    requestSample: {propertyId: '…', payerUserId: '…', amount: 1000000, purpose: 'rent'},
    handler: async (request) => ({
        status: 201,
        body: await adminConsole.money.recordPayment(request.body ?? {}, actorOf(request)),
    }),
});

export const adminRecordProviderEvent = route({
    method: 'post',
    path: '/admin/payments/:id/provider-events',
    description: 'Store a provider callback verbatim; a confirmation settles the payment',
    requestSample: {provider: 'sandbox', status: 'successful', providerReference: 'MPESA-9981'},
    handler: (request) =>
        adminConsole.money.recordProviderEvent(request.params.id, request.body ?? {}, actorOf(request)),
});

export const adminReconcilePayment = route({
    method: 'post',
    path: '/admin/payments/:id/reconcile',
    description: 'Settle a cash or bank payment on a finance officer’s authority',
    handler: (request) =>
        adminConsole.money.reconcilePayment(request.params.id, request.body ?? {}, actorOf(request)),
});

export const adminFailPayment = route({
    method: 'post',
    path: '/admin/payments/:id/fail',
    description: 'Close a collection that will not arrive (a reason is required)',
    handler: (request) =>
        adminConsole.money.failPayment(request.params.id, request.body ?? {}, actorOf(request)),
});

// --- Disbursement ---------------------------------------------------------------

export const adminOutstandingBalances = route({
    method: 'get',
    path: '/admin/money/outstanding',
    description: 'What each landlord, broker and agency is owed right now',
    handler: () => adminConsole.money.outstandingBalances(),
});

export const adminSearchPayouts = route({
    method: 'get',
    path: '/admin/payouts',
    description: 'Search disbursements by reference, beneficiary or status',
    handler: (request) => adminConsole.money.searchPayouts(request.query),
});

export const adminGetPayout = route({
    method: 'get',
    path: '/admin/payouts/:id',
    description: 'One disbursement with the collections it settles and its ledger postings',
    handler: (request) => adminConsole.money.getPayout(request.params.id),
});

export const adminCreatePayout = route({
    method: 'post',
    path: '/admin/payouts',
    description: 'Gather a beneficiary’s unpaid shares into one payout',
    requestSample: {beneficiaryType: 'landlord', beneficiaryUserId: '…'},
    handler: async (request) => ({
        status: 201,
        body: await adminConsole.money.createPayout(request.body ?? {}, actorOf(request)),
    }),
});

export const adminChangePayoutStatus = route({
    method: 'post',
    path: '/admin/payouts/:id/status',
    description: 'Move a payout along: processing, paid, on hold, failed or cancelled',
    requestSample: {status: 'paid', providerReference: 'MPESA-B2C-42'},
    handler: (request) =>
        adminConsole.money.changePayoutStatus(request.params.id, request.body ?? {}, actorOf(request)),
});

export const adminLedger = route({
    method: 'get',
    path: '/admin/ledger',
    description: 'The append-only ledger, newest first',
    handler: (request) => adminConsole.money.ledger(request.query),
});
