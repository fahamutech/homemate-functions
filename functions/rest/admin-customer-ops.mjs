import {adminConsole} from '../../src/services/admin-console/container.mjs';
import {smsPort} from '../../src/services/customer-access/container.mjs';
import {route, actorOf} from '../../src/shared/http.mjs';
import {getPool} from '../../src/db/pool.mjs';

/**
 * The backoffice half of the mobile app: answering what customers ask, looking
 * after the tenancies that follow, and handling the money they send — which
 * for now is verified by a person reading a bank statement.
 */

// --- inquiries ----------------------------------------------------------------

export const adminListInquiries = route({
    method: 'get',
    path: '/admin/inquiries',
    description: 'Customer enquiries, newest first',
    handler: (request) => adminConsole.customerOps.listInquiries(request.query),
});

export const adminGetInquiry = route({
    method: 'get',
    path: '/admin/inquiries/:id',
    description: 'One enquiry with its property and customer',
    handler: (request) => adminConsole.customerOps.getInquiry(request.params.id),
});

export const adminRespondToInquiry = route({
    method: 'post',
    path: '/admin/inquiries/:id/respond',
    description: 'Reply to, accept, decline or close an enquiry',
    requestSample: {status: 'responded', response: 'Yes, still available from 1 November'},
    handler: (request) =>
        adminConsole.customerOps.respondToInquiry(request.params.id, request.body ?? {}, actorOf(request)),
});

// --- bookings ------------------------------------------------------------------

export const adminListBookings = route({
    method: 'get',
    path: '/admin/bookings',
    description: 'Reservations and the tenancies they became',
    handler: (request) => adminConsole.customerOps.listBookings(request.query),
});

export const adminGetBooking = route({
    method: 'get',
    path: '/admin/bookings/:id',
    description: 'One booking with its payments and what is outstanding',
    handler: (request) => adminConsole.customerOps.getBooking(request.params.id),
});

export const adminChangeBookingStatus = route({
    method: 'post',
    path: '/admin/bookings/:id/status',
    description: 'Start (active) or end (completed) a tenancy',
    requestSample: {status: 'active'},
    handler: (request) =>
        adminConsole.customerOps.changeBookingStatus(request.params.id, request.body ?? {}, actorOf(request)),
});

// --- payment instructions and verification --------------------------------------

export const adminPaymentsNeedingInstructions = route({
    method: 'get',
    path: '/admin/payment-queue/needs-instructions',
    description: 'Payments a customer cannot settle yet, because nobody has said where to pay',
    handler: (request) => adminConsole.customerOps.listPaymentsNeedingInstructions(request.query),
});

export const adminDeclaredPayments = route({
    method: 'get',
    path: '/admin/payment-queue/declared',
    description: 'Payments a customer says they have made, waiting to be verified',
    handler: (request) => adminConsole.customerOps.listDeclaredPayments(request.query),
});

export const adminGetPaymentInstructions = route({
    method: 'get',
    path: '/admin/payments/:id/instructions',
    description: 'The account details the app is showing for this payment',
    handler: async (request) => ({
        status: 200,
        body: {instructions: await adminConsole.customerOps.getPaymentInstructions(request.params.id)},
    }),
});

export const adminSetPaymentInstructions = route({
    method: 'put',
    path: '/admin/payments/:id/instructions',
    description: 'Publish where the customer should pay; the app shows this verbatim',
    requestSample: {
        displayName: 'HomeMate Africa Ltd',
        accountNumber: '5566778',
        paymentReference: 'HM-BK-000001',
        instructions: 'Send to Lipa Namba 5566778 and quote the reference.',
    },
    handler: (request) =>
        adminConsole.customerOps.setPaymentInstructions(request.params.id, request.body ?? {}, actorOf(request)),
});

// --- SMS credit ------------------------------------------------------------------

/**
 * What the OTP journey is running on. A login that fails because the account
 * ran dry looks exactly like a broken login, so the number has to be visible
 * before it becomes an incident.
 */
export const adminSmsBalance = route({
    method: 'get',
    path: '/admin/sms/balance',
    description: 'Remaining SMS credits, with the configured low-balance threshold',
    handler: async () => {
        const {rows} = await getPool().query(
            "select value from settings where key = 'sms.low_balance_threshold'"
        );
        const threshold = Number(rows[0]?.value ?? 200);

        if (typeof smsPort.balance !== 'function') {
            // The sandbox adapter has no credit to run out of; saying so is
            // more honest than reporting a fabricated number.
            return {provider: smsPort.provider ?? 'sandbox', credits: null, threshold, low: false};
        }
        const balance = await smsPort.balance();
        return {
            provider: balance.provider,
            credits: balance.credits,
            threshold,
            low: balance.credits <= threshold,
        };
    },
});

export const adminSmsActivity = route({
    method: 'get',
    path: '/admin/sms/activity',
    description: 'Codes sent, throttled and failed by hour, and who is asking most',
    handler: async () => {
        const pool = getPool();
        const [activity, top] = await Promise.all([
            pool.query('select * from v_otp_activity order by hour desc limit 48'),
            pool.query('select * from v_otp_top_requesters order by sent desc, throttled desc limit 20'),
        ]);
        return {activity: activity.rows, topRequesters: top.rows};
    },
});
