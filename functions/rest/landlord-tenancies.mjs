import {landlordTenancies} from '../../src/services/partner-app/container.mjs';
import {route} from '../../src/shared/http.mjs';

/**
 * A landlord's tenancies (T05, LND-030–033). Only the customer session is
 * required: a tenancy is scoped to homes where the caller is the primary
 * landlord (landlord_owns_booking, 030), so a landlord a broker invited sees
 * their tenants without a separate onboarding.
 */

const me = (request) => request.auth.userId;

export const landlordListTenancies = route({
    method: 'get',
    path: '/app/landlord/tenancies',
    description: 'My tenancies: status=current|moving_in|past',
    handler: (request) => landlordTenancies.list(me(request), {status: request.query?.status}),
});

export const landlordGetTenancy = route({
    method: 'get',
    path: '/app/landlord/tenancies/:id',
    description: 'One tenancy with its tenant, dates and payment history',
    handler: (request) => landlordTenancies.get(me(request), request.params.id),
});

export const landlordGetTenancyLease = route({
    method: 'get',
    path: '/app/landlord/tenancies/:id/lease',
    description: 'The lease behind a tenancy',
    handler: (request) => landlordTenancies.lease(me(request), request.params.id),
});

export const landlordMoveIn = route({
    method: 'post',
    path: '/app/landlord/tenancies/:id/move-in',
    description: 'The tenant moved in on this day (no earlier than 7 days before the lease starts)',
    requestSample: {date: '2026-10-01'},
    handler: (request) => landlordTenancies.moveIn(me(request), request.params.id, {date: request.body?.date}),
});

export const landlordEndTenancy = route({
    method: 'post',
    path: '/app/landlord/tenancies/:id/end',
    description: 'The tenancy ended on this day',
    requestSample: {date: '2027-09-30', reason: 'Tenant relocated'},
    handler: (request) =>
        landlordTenancies.end(me(request), request.params.id, {date: request.body?.date, reason: request.body?.reason}),
});
