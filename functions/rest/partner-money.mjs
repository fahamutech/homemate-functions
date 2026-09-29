import {partnerMoney} from '../../src/services/partner-app/container.mjs';
import {route} from '../../src/shared/http.mjs';
import {readEarningRole} from '../../src/services/partner-app/earning-view.mjs';

/**
 * A partner's money and home summaries (T06). Earnings and payouts are the
 * caller's own splits and payouts, so the customer session is enough; the
 * summaries sit behind requireBrokerForSummary / requireLandlordForSummary.
 * Nothing here creates or moves money — finance does that in the portal.
 */

const me = (request) => request.auth.userId;
const role = (request) => readEarningRole(request.query?.role, request.auth.activeRole);

export const partnerEarnings = route({
    method: 'get',
    path: '/app/partner/earnings',
    description: 'My earnings as broker or landlord: totals per state, paid this year, and a page of items',
    handler: (request) => partnerMoney.earnings(me(request), role(request), request.query ?? {}),
});

export const partnerEarning = route({
    method: 'get',
    path: '/app/partner/earnings/:id',
    description: 'One earning: the whole split of the payment, the fee from the booking snapshot, and the timeline',
    handler: (request) => partnerMoney.earning(me(request), request.params.id),
});

export const partnerPayouts = route({
    method: 'get',
    path: '/app/partner/payouts',
    description: 'My payouts as broker or landlord, and the payout account on file (masked)',
    handler: (request) => partnerMoney.payouts(me(request), role(request)),
});

export const brokerSummary = route({
    method: 'get',
    path: '/app/broker/summary',
    description: 'BRK-010: live listings, open enquiries, earned this month, and what needs you',
    handler: (request) => partnerMoney.brokerSummary(me(request)),
});

export const landlordSummary = route({
    method: 'get',
    path: '/app/landlord/summary',
    description: 'LND-010: homes, let, paid this month, and what needs you',
    handler: (request) => partnerMoney.landlordSummary(me(request)),
});
