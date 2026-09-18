import {adminConsole} from '../../src/services/admin-console/container.mjs';
import {route, actorOf} from '../../src/shared/http.mjs';
import {invalid} from '../../src/shared/errors.mjs';

/**
 * Everything that hangs off a property — attribution, amenities, charges,
 * media and accepted payment methods — plus the image read path.
 *
 * Images are uploaded as base64 WebP in a JSON body rather than multipart:
 * the browser has already decoded, resized and re-encoded the file to produce
 * the image *and* its thumbnail, so what arrives is two small known-type
 * payloads, and the route stays a plain JSON handler like every other one.
 */

function decodeImagePayload(payload, field) {
    if (!payload) return null;
    const {base64, name, contentType} = payload;
    if (!base64) throw invalid(`${field}.base64 is required`);
    if (contentType && contentType !== 'image/webp') {
        throw invalid(`${field} must be image/webp — convert in the browser before uploading`);
    }
    return {
        name,
        contentType: 'image/webp',
        body: Buffer.from(String(base64).replace(/^data:[^,]+,/, ''), 'base64'),
    };
}

// --- Parties -----------------------------------------------------------------

export const adminListPropertyParties = route({
    method: 'get',
    path: '/admin/properties/:id/parties',
    description: 'Landlord, broker and agency attribution for a property',
    handler: (request) => adminConsole.propertyDetails.listParties(request.params.id),
});

export const adminAssignPropertyParty = route({
    method: 'post',
    path: '/admin/properties/:id/parties',
    description: 'Assign a landlord, broker or agency to a property',
    requestSample: {userId: 'uuid', role: 'broker', commissionPercentage: 5, isPrimary: true},
    handler: async (request) => ({
        status: 201,
        body: await adminConsole.propertyDetails.assignParty(request.params.id, request.body ?? {}, actorOf(request)),
    }),
});

export const adminRemovePropertyParty = route({
    method: 'delete',
    path: '/admin/properties/:id/parties/:partyId',
    description: 'Remove a party assignment',
    handler: (request) =>
        adminConsole.propertyDetails.removeParty(request.params.id, request.params.partyId, actorOf(request)),
});

// --- Amenities ---------------------------------------------------------------

export const adminListPropertyAmenities = route({
    method: 'get',
    path: '/admin/properties/:id/amenities',
    description: 'Amenities attached to a property',
    handler: (request) => adminConsole.propertyDetails.listAmenities(request.params.id),
});

export const adminSetPropertyAmenities = route({
    method: 'put',
    path: '/admin/properties/:id/amenities',
    description: 'Replace the amenity set for a property',
    requestSample: {amenityIds: ['uuid', 'uuid']},
    handler: (request) =>
        adminConsole.propertyDetails.setAmenities(request.params.id, request.body?.amenityIds, actorOf(request)),
});

// --- Charges -----------------------------------------------------------------

export const adminListPropertyCharges = route({
    method: 'get',
    path: '/admin/properties/:id/charges',
    description: 'Charges payable alongside rent',
    handler: (request) => adminConsole.propertyDetails.listCharges(request.params.id),
});

export const adminAddPropertyCharge = route({
    method: 'post',
    path: '/admin/properties/:id/charges',
    description: 'Add a charge (service charge, water, garbage, deposit…)',
    requestSample: {name: 'Service charge', amount: 50000, frequency: 'monthly', isMandatory: true},
    handler: async (request) => ({
        status: 201,
        body: await adminConsole.propertyDetails.addCharge(request.params.id, request.body ?? {}, actorOf(request)),
    }),
});

export const adminRemovePropertyCharge = route({
    method: 'delete',
    path: '/admin/properties/:id/charges/:chargeId',
    description: 'Remove a charge',
    handler: (request) =>
        adminConsole.propertyDetails.removeCharge(request.params.id, request.params.chargeId, actorOf(request)),
});

// --- Media -------------------------------------------------------------------

export const adminListPropertyMedia = route({
    method: 'get',
    path: '/admin/properties/:id/media',
    description: 'Images attached to a property',
    handler: (request) => adminConsole.propertyDetails.listMedia(request.params.id),
});

export const adminUploadPropertyImage = route({
    method: 'post',
    path: '/admin/properties/:id/media',
    description: 'Upload a WebP image and its WebP thumbnail (both produced in the browser)',
    requestSample: {
        image: {base64: '…', name: 'front.webp', contentType: 'image/webp'},
        thumbnail: {base64: '…', name: 'front-thumb.webp', contentType: 'image/webp'},
        caption: 'Front elevation',
        isCover: true,
    },
    handler: async (request) => ({
        status: 201,
        body: await adminConsole.propertyDetails.addImage(
            request.params.id,
            {
                image: decodeImagePayload(request.body?.image, 'image'),
                thumbnail: decodeImagePayload(request.body?.thumbnail, 'thumbnail'),
                caption: request.body?.caption,
                isCover: request.body?.isCover,
                width: request.body?.width,
                height: request.body?.height,
            },
            actorOf(request)
        ),
    }),
});

export const adminSetPropertyCoverImage = route({
    method: 'post',
    path: '/admin/properties/:id/media/:mediaId/cover',
    description: 'Make an image the cover for its property',
    handler: (request) =>
        adminConsole.propertyDetails.setCoverImage(request.params.id, request.params.mediaId, actorOf(request)),
});

export const adminRemovePropertyImage = route({
    method: 'delete',
    path: '/admin/properties/:id/media/:mediaId',
    description: 'Detach an image from a property',
    handler: (request) =>
        adminConsole.propertyDetails.removeImage(request.params.id, request.params.mediaId, actorOf(request)),
});

/**
 * Image bytes. Object storage requires its own credentials, so the browser is
 * never given a storage URL — it asks HomeMate, which reads through the
 * StoragePort with the service account. `?thumbnail=1` serves the small one.
 */
export const adminReadPropertyImage = route({
    method: 'get',
    path: '/admin/media/:mediaId/raw',
    description: 'Stream an image through the API (storage credentials stay server-side)',
    handler: async (request, response) => {
        const {body, contentType} = await adminConsole.propertyDetails.readImage(request.params.mediaId, {
            thumbnail: request.query?.thumbnail === '1' || request.query?.thumbnail === 'true',
        });
        response.setHeader('content-type', contentType);
        response.setHeader('cache-control', 'private, max-age=3600');
        response.status(200).send(body);
    },
});

// --- Accepted payment methods -------------------------------------------------

export const adminListPropertyPaymentMethods = route({
    method: 'get',
    path: '/admin/properties/:id/payment-methods',
    description: 'Payment methods this property accepts',
    handler: (request) => adminConsole.propertyDetails.listPaymentMethods(request.params.id),
});

export const adminSetPropertyPaymentMethods = route({
    method: 'put',
    path: '/admin/properties/:id/payment-methods',
    description: 'Replace the accepted payment methods for a property',
    handler: (request) =>
        adminConsole.propertyDetails.setPaymentMethods(
            request.params.id,
            request.body?.paymentMethodIds,
            actorOf(request)
        ),
});
