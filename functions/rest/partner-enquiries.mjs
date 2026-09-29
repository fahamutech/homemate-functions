import {partnerEnquiries} from '../../src/services/partner-app/container.mjs';
import {route} from '../../src/shared/http.mjs';

/**
 * Enquiries on a partner's listings (T05, BRK-040–042). Behind
 * requirePartnerInquiriesWorkspace, which resolves `request.partnerRole`:
 * a broker sees and answers their listings' enquiries; a landlord sees theirs
 * and answers only where no broker listed the home.
 */

const me = (request) => request.auth.userId;
const role = (request) => request.partnerRole;

export const partnerListInquiries = route({
    method: 'get',
    path: '/app/partner/inquiries',
    description: 'Enquiries on my listings: status=new|replied|accepted|closed',
    handler: (request) => partnerEnquiries.list(me(request), role(request), {status: request.query?.status}),
});

export const partnerGetInquiry = route({
    method: 'get',
    path: '/app/partner/inquiries/:id',
    description: 'One enquiry; the customer’s phone only for whoever answers it',
    handler: (request) => partnerEnquiries.get(me(request), role(request), request.params.id),
});

export const partnerRespondToInquiry = route({
    method: 'post',
    path: '/app/partner/inquiries/:id/respond',
    description: 'Reply, accept (unlocks checkout), decline with a reason, or close',
    requestSample: {status: 'accepted', response: 'You can move in on the 1st'},
    handler: (request) =>
        partnerEnquiries.respond(me(request), role(request), request.params.id, request.body ?? {}),
});

export const partnerInquiryJourney = route({
    method: 'get',
    path: '/app/partner/inquiries/:id/journey',
    description: 'The BRK-042 tracker (received → decision → payment → verified → moved in → ended) and the earning preview',
    handler: (request) => partnerEnquiries.journey(me(request), role(request), request.params.id),
});
