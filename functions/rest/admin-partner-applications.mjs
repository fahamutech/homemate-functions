import {partnerReview} from '../../src/services/partner-app/container.mjs';
import {route, actorOf} from '../../src/shared/http.mjs';

/**
 * The partner applications queue (T03; portal screen in T08). Guarded by
 * requireAdminForConsole, and scoped for restricted staff to the `partners`
 * sidebar section (src/shared/admin-acl.mjs).
 */

export const adminListPartnerApplications = route({
    method: 'get',
    path: '/admin/partner-applications',
    description: 'Broker and landlord applications with the person, documents and step state',
    handler: (request) => partnerReview.queue(request.query ?? {}),
});

export const adminGetPartnerApplication = route({
    method: 'get',
    path: '/admin/partner-applications/:userId/:role',
    description: 'One application with the person, documents, open remediations and step state',
    handler: (request) => partnerReview.get(request.params.userId, request.params.role),
});

export const adminDecidePartnerApplication = route({
    method: 'post',
    path: '/admin/partner-applications/:userId/:role/decision',
    description: 'Approve, ask for action (opens a remediation) or reject (with a reason)',
    requestSample: {
        decision: 'action_needed',
        reason: 'The selfie is blurry',
        remediation: {requestedAction: 'Take a new selfie in good light', documentId: null},
    },
    handler: (request) =>
        partnerReview.decide(request.params.userId, request.params.role, request.body ?? {}, actorOf(request)),
});
