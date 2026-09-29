import {partnerListings, landlordDirectory, landlordConfirmations} from '../../src/services/partner-app/container.mjs';
import {route} from '../../src/shared/http.mjs';
import {DomainError, ErrorCodes} from '../../src/shared/errors.mjs';
import {decodeUpload} from '../../src/shared/uploads.mjs';

/**
 * Listing homes from the app (T04). `/app/partner/listings` and
 * `/app/partner/landlords` sit behind requirePartnerListingsWorkspace /
 * requirePartnerLandlordsWorkspace (functions/guards/auth.mjs), which resolve
 * `request.partnerRole`. `/app/landlord/*` only needs the customer session:
 * the landlord is whoever the listing names, invited or not.
 */

const me = (request) => request.auth.userId;
const role = (request) => request.partnerRole;

function brokerOnly(request) {
    if (role(request) !== 'broker') {
        throw new DomainError(ErrorCodes.FORBIDDEN, 'Only a broker looks up and invites landlords', 403);
    }
}

export const partnerListListings = route({
    method: 'get',
    path: '/app/partner/listings',
    description: 'My listings as broker or landlord (BRK-020), optionally by status; archived only when asked',
    handler: (request) => partnerListings.list(me(request), role(request), {status: request.query?.status}),
});

export const partnerCreateListing = route({
    method: 'post',
    path: '/app/partner/listings',
    description: 'Start a draft; the caller becomes its primary broker or landlord',
    requestSample: {title: 'Masaki 2BR Apartment', price: 900000, regionId: '…', propertyTypeId: '…'},
    handler: async (request) => ({
        status: 201,
        body: await partnerListings.create(me(request), role(request), request.body ?? {}),
    }),
});

export const partnerGetListing = route({
    method: 'get',
    path: '/app/partner/listings/:id',
    description: 'One listing with photos, terms, landlord confirmation, status history and submit blockers',
    handler: (request) => partnerListings.get(me(request), role(request), request.params.id),
});

export const partnerUpdateListing = route({
    method: 'put',
    path: '/app/partner/listings/:id',
    description: 'Wizard step save: fields, amenityIds, charges, photoOrder, landlordUserId (brokers)',
    requestSample: {depositMonths: 2, amenityIds: ['…'], charges: [{name: 'Water', amount: 20000}], photoOrder: ['…']},
    handler: (request) => partnerListings.update(me(request), role(request), request.params.id, request.body ?? {}),
});

export const partnerAddListingPhoto = route({
    method: 'post',
    path: '/app/partner/listings/:id/photos',
    description: 'Add a WebP photo (base64 JSON, like every app upload); the first becomes the cover',
    requestSample: {image: {base64: '…', contentType: 'image/webp'}, thumbnail: {base64: '…', contentType: 'image/webp'}},
    handler: async (request) => ({
        status: 201,
        body: await partnerListings.addPhoto(me(request), role(request), request.params.id, {
            image: decodeUpload(request.body?.image, 'image'),
            thumbnail: decodeUpload(request.body?.thumbnail, 'thumbnail'),
            caption: request.body?.caption,
            width: request.body?.width,
            height: request.body?.height,
        }),
    }),
});

export const partnerRemoveListingPhoto = route({
    method: 'delete',
    path: '/app/partner/listings/:id/photos/:mediaId',
    description: 'Remove a photo; the next one becomes the cover',
    handler: (request) =>
        partnerListings.removePhoto(me(request), role(request), request.params.id, request.params.mediaId),
});

export const partnerSubmitListing = route({
    method: 'post',
    path: '/app/partner/listings/:id/submit',
    description: 'Send for review (BRK-031); 422 with details.reasons when something is missing',
    handler: (request) => partnerListings.submit(me(request), role(request), request.params.id),
});

export const partnerArchiveListing = route({
    method: 'post',
    path: '/app/partner/listings/:id/archive',
    description: 'Take a listing down',
    handler: (request) => partnerListings.archive(me(request), role(request), request.params.id),
});

export const partnerLookupLandlord = route({
    method: 'get',
    path: '/app/partner/landlords/lookup',
    description: 'A masked landlord card for a phone number, or {found: false}',
    handler: (request) => {
        brokerOnly(request);
        return landlordDirectory.lookup(request.query?.phone);
    },
});

export const partnerInviteLandlord = route({
    method: 'post',
    path: '/app/partner/landlords/invite',
    description: 'Create or reuse the person by phone with an invited landlord role, ready to attach',
    requestSample: {fullName: 'Amina Mwinyi', phone: '+255713000002'},
    handler: async (request) => {
        brokerOnly(request);
        return {status: 201, body: await landlordDirectory.invite(me(request), request.body ?? {})};
    },
});

export const landlordListConfirmations = route({
    method: 'get',
    path: '/app/landlord/confirmations',
    description: 'Homes a broker listed that wait for this landlord’s confirmation (LND-003)',
    handler: (request) => landlordConfirmations.list(me(request)),
});

export const landlordConfirmListing = route({
    method: 'post',
    path: '/app/landlord/listings/:id/confirm',
    description: 'Confirm the listing is your home and its terms are right',
    handler: (request) => landlordConfirmations.confirm(me(request), request.params.id),
});

export const landlordDisputeListing = route({
    method: 'post',
    path: '/app/landlord/listings/:id/dispute',
    description: 'Dispute a listing; the broker and staff are told',
    requestSample: {reason: 'This is not my house'},
    handler: (request) =>
        landlordConfirmations.dispute(me(request), request.params.id, {reason: request.body?.reason}),
});
