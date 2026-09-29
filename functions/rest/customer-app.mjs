import {
    customerApp,
    customerJourney,
    customerIdentity,
    customerGeocoding,
    storagePort,
} from '../../src/services/customer-app/container.mjs';
import {route} from '../../src/shared/http.mjs';
import {invalid} from '../../src/shared/errors.mjs';
import {getPool} from '../../src/db/pool.mjs';

/**
 * Everything the signed-in app calls. Every handler takes the customer from
 * `request.auth`, never from the body or the path — an id in a URL is a
 * suggestion, a session is a fact.
 */

const me = (request) => request.auth.userId;

// --- discovery ---------------------------------------------------------------

export const appSearchProperties = route({
    method: 'get',
    path: '/app/properties',
    description: 'Search published listings, with the customer’s saved ones marked',
    handler: (request) =>
        customerApp.searchProperties(
            {
                ...request.query,
                amenityIds: request.query?.amenityIds
                    ? `${request.query.amenityIds}`.split(',').filter(Boolean)
                    : undefined,
            },
            me(request)
        ),
});

export const appPropertyDetail = route({
    method: 'get',
    path: '/app/properties/:id',
    description: 'Everything one property screen shows, in a single call',
    handler: (request) => customerApp.propertyDetail(request.params.id, me(request)),
});

/**
 * Listing images. The app cannot hold storage credentials, so it asks us and
 * we read through the StoragePort — the same arrangement the backoffice uses.
 */
export const appPropertyImage = route({
    method: 'get',
    path: '/app/media/:mediaId/raw',
    description: 'Stream a listing image through the API',
    handler: async (request, response) => {
        const {rows} = await getPool().query(
            'select url, thumbnail_url, content_type from property_media where id = $1',
            [request.params.mediaId]
        );
        if (rows.length === 0) {
            response.status(404).json({error: 'NOT_FOUND', message: 'Image not found'});
            return;
        }
        const wantsThumbnail = request.query?.thumbnail === '1' || request.query?.thumbnail === 'true';
        const key = wantsThumbnail ? (rows[0].thumbnail_url ?? rows[0].url) : rows[0].url;
        const object = await storagePort.get(key);
        response.setHeader('content-type', object.contentType ?? rows[0].content_type);
        // A listing photo is public-ish once you can see the listing, so it may
        // be cached on the device — unlike an identity document.
        response.setHeader('cache-control', 'private, max-age=86400');
        response.status(200).send(object.body);
    },
});

export const appGeocode = route({
    method: 'get',
    path: '/app/geocode',
    description: 'OpenStreetMap place search for the location picker',
    handler: (request) => {
        const query = `${request.query?.q ?? ''}`.trim();
        if (query.length < 3) throw invalid('Enter at least 3 characters to search for a place');
        return customerGeocoding.search(query, {limit: Number(request.query?.limit ?? 6)});
    },
});

export const appReverseGeocode = route({
    method: 'get',
    path: '/app/geocode/reverse',
    description: 'Turn a dropped pin back into an address',
    handler: async (request) => {
        const latitude = Number(request.query?.latitude);
        const longitude = Number(request.query?.longitude);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            throw invalid('latitude and longitude are required');
        }
        return {result: await customerGeocoding.reverse(latitude, longitude)};
    },
});

// --- reference data -----------------------------------------------------------

export const appReferenceData = route({
    method: 'get',
    path: '/app/reference',
    description: 'Property types, amenities, the region/district/ward tree, banks and wallets, for the app’s pickers',
    handler: () => customerApp.referenceData(),
});

// --- saved -------------------------------------------------------------------

export const appListSaved = route({
    method: 'get',
    path: '/app/saved',
    description: 'The customer’s saved properties',
    handler: (request) => customerApp.listSaved(me(request), request.query),
});

export const appSaveProperty = route({
    method: 'put',
    path: '/app/saved/:propertyId',
    description: 'Save a property (idempotent)',
    handler: (request) => customerApp.saveProperty(me(request), request.params.propertyId, request.body?.note),
});

export const appUnsaveProperty = route({
    method: 'delete',
    path: '/app/saved/:propertyId',
    description: 'Remove a saved property',
    handler: (request) => customerApp.unsaveProperty(me(request), request.params.propertyId),
});

// --- inquiries ---------------------------------------------------------------

export const appListInquiries = route({
    method: 'get',
    path: '/app/inquiries',
    description: 'The customer’s enquiries',
    handler: (request) => customerApp.listInquiries(me(request), request.query),
});

export const appCreateInquiry = route({
    method: 'post',
    path: '/app/inquiries',
    description: 'Ask about a property',
    requestSample: {propertyId: '…', message: 'Is it still available?', occupants: 2},
    handler: async (request) => ({
        status: 201,
        body: await customerApp.createInquiry(me(request), request.body ?? {}),
    }),
});

export const appGetInquiry = route({
    method: 'get',
    path: '/app/inquiries/:id',
    description: 'One enquiry and its answer',
    handler: (request) => customerApp.getInquiry(me(request), request.params.id),
});

export const appWithdrawInquiry = route({
    method: 'post',
    path: '/app/inquiries/:id/withdraw',
    description: 'Withdraw an enquiry that is still open',
    handler: (request) => customerApp.withdrawInquiry(me(request), request.params.id),
});

// --- payments ----------------------------------------------------------------

export const appListPayments = route({
    method: 'get',
    path: '/app/payments',
    description: 'The customer’s payments and how to settle them',
    handler: (request) => customerApp.listPayments(me(request), request.query),
});

export const appGetPayment = route({
    method: 'get',
    path: '/app/payments/:id',
    description: 'One payment, with the account details an operator configured',
    handler: (request) => customerApp.getPayment(me(request), request.params.id),
});

/**
 * "I have paid." This is a claim, not a settlement: it puts the payment in
 * front of a finance officer and tells the customer honestly that it is being
 * checked. Only the backoffice can mark it received (BR-005).
 */
export const appDeclarePaid = route({
    method: 'post',
    path: '/app/payments/:id/declare',
    description: 'Tell us the payment has been sent, so someone can verify it',
    requestSample: {reference: 'MPESA-CONF-77', note: 'Paid at 10am'},
    handler: (request) => customerApp.declarePaid(me(request), request.params.id, request.body ?? {}),
});

// --- profile, preferences, notifications, summary -----------------------------

export const appGetPreferences = route({
    method: 'get',
    path: '/app/preferences',
    description: 'The customer’s search preferences',
    handler: (request) => customerApp.getPreferences(me(request)),
});

export const appSavePreferences = route({
    method: 'put',
    path: '/app/preferences',
    description: 'Save search preferences and notification choices',
    handler: (request) => customerApp.savePreferences(me(request), request.body ?? {}),
});

export const appListNotifications = route({
    method: 'get',
    path: '/app/notifications',
    description: 'The notification feed',
    handler: (request) => customerApp.listNotifications(me(request), request.query),
});

export const appReadNotification = route({
    method: 'post',
    path: '/app/notifications/:id/read',
    description: 'Mark one notification read',
    handler: (request) => customerApp.markNotificationRead(me(request), request.params.id),
});

export const appReadAllNotifications = route({
    method: 'post',
    path: '/app/notifications/read-all',
    description: 'Mark every notification read',
    handler: (request) => customerApp.markAllNotificationsRead(me(request)),
});

export const appActivitySummary = route({
    method: 'get',
    path: '/app/summary',
    description: 'Counts for the home screen and profile badges',
    handler: (request) => customerApp.activitySummary(me(request)),
});

// --- identity (KYC), from the customer's own phone ---------------------------

/**
 * Files arrive as base64 in the JSON body, the same way the backoffice takes
 * them: the app has no storage credentials and never will, so every byte goes
 * through here.
 */
function decodeUpload(payload, field) {
    if (!payload) return null;
    const base64 = payload.base64 ?? payload.data;
    if (!base64) throw invalid(`${field}.base64 is required`);
    return {
        name: payload.name,
        contentType: payload.contentType ?? 'application/octet-stream',
        body: Buffer.from(String(base64).replace(/^data:[^,]+,/, ''), 'base64'),
    };
}

export const appGetIdentity = route({
    method: 'get',
    path: '/app/me/kyc',
    description: 'The customer’s own verification status and the documents behind it',
    handler: (request) => customerIdentity.getIdentity(me(request)),
});

export const appAddIdentityDocument = route({
    method: 'post',
    path: '/app/me/kyc/documents',
    description: 'Upload an identity document or a selfie; the first one starts the review',
    requestSample: {documentType: 'national_id', file: {base64: '…', contentType: 'image/jpeg'}},
    handler: async (request) => ({
        status: 201,
        body: await customerIdentity.addDocument(me(request), {
            documentType: request.body?.documentType,
            documentNumber: request.body?.documentNumber,
            file: decodeUpload(request.body?.file, 'file'),
            thumbnail: decodeUpload(request.body?.thumbnail, 'thumbnail'),
        }),
    }),
});

export const appReadIdentityDocument = route({
    method: 'get',
    path: '/app/me/kyc/documents/:documentId/raw',
    description: 'Stream back one of the customer’s own documents',
    handler: async (request, response) => {
        const {body, contentType} = await customerIdentity.documentContent(
            me(request),
            request.params.documentId,
            {thumbnail: request.query?.thumbnail === '1' || request.query?.thumbnail === 'true'}
        );
        response.setHeader('content-type', contentType);
        response.setHeader('cache-control', 'private, no-store');
        response.status(200).send(body);
    },
});

export const appSetProfilePhoto = route({
    method: 'put',
    path: '/app/me/photo',
    description: 'Set the profile photo shown on the account and matched against the ID',
    handler: (request) =>
        customerIdentity.setPhoto(me(request), {
            file: decodeUpload(request.body?.image ?? request.body?.file, 'image'),
            thumbnail: decodeUpload(request.body?.thumbnail, 'thumbnail'),
        }),
});

export const appReadProfilePhoto = route({
    method: 'get',
    path: '/app/me/photo/raw',
    description: 'Stream the customer’s own profile photo',
    handler: async (request, response) => {
        const {body, contentType} = await customerIdentity.photoContent(me(request), {
            thumbnail: request.query?.thumbnail === '1' || request.query?.thumbnail === 'true',
        });
        response.setHeader('content-type', contentType);
        response.setHeader('cache-control', 'private, no-store');
        response.status(200).send(body);
    },
});

// --- the journey: holds, checkout, tenancies ---------------------------------

/**
 * CUS-013a in one call. The Favourites screen is three sections — active rents,
 * saved homes, recent enquiries — and assembling it out of three requests on a
 * Tanzanian mobile connection is three chances to show a spinner instead of a
 * screen.
 */
export const appSavedOverview = route({
    method: 'get',
    path: '/app/saved/overview',
    description: 'Everything the Favourites screen shows, in one round trip',
    handler: (request) => customerJourney.savedOverview(me(request), request.query ?? {}),
});

/**
 * "Can I pay for this yet?" Every Pay button in the app asks this first. The
 * answer is yes only once the landlord has accepted the customer's enquiry.
 */
export const appCheckoutEligibility = route({
    method: 'get',
    path: '/app/properties/:id/checkout',
    description: 'Whether this customer may pay for this property, and by which route',
    handler: (request) => customerJourney.checkoutEligibility(me(request), request.params.id),
});

export const appPropertyJourney = route({
    method: 'get',
    path: '/app/properties/:id/journey',
    description: 'The customer’s own timeline for one property (CUS-013b)',
    handler: (request) => customerJourney.propertyJourney(me(request), request.params.id),
});

export const appPropertyPaymentMethods = route({
    method: 'get',
    path: '/app/properties/:id/payment-methods',
    description: 'The ways this listing accepts money, for the checkout picker',
    handler: (request) => customerJourney.paymentMethodsFor(request.params.id),
});

/**
 * Take the property for ten minutes. This is the bus-seat rule: while one
 * customer is inside the payment flow nobody else may start, so two people
 * cannot both pay for the same home and one of them be refunded by hand.
 */
export const appHoldProperty = route({
    method: 'post',
    path: '/app/properties/:id/hold',
    description: 'Reserve this property for ten minutes while the customer pays',
    handler: async (request) => ({
        status: 201,
        body: await customerJourney.hold(me(request), request.params.id, request.body ?? {}),
    }),
});

export const appMyHolds = route({
    method: 'get',
    path: '/app/holds',
    description: 'Whatever this customer is currently holding, with the time left on it',
    handler: (request) => customerJourney.myHolds(me(request)),
});

export const appReleaseHold = route({
    method: 'delete',
    path: '/app/holds/:id',
    description: 'Give the property back early rather than making the next person wait',
    handler: (request) =>
        customerJourney.releaseHold(me(request), request.params.id, request.query?.reason),
});

/**
 * Turn an accepted enquiry into something payable: a reservation, a payment
 * (rent, deposit and the HomeMate fee, already split), and a hold, all in one
 * transaction.
 */
export const appStartCheckout = route({
    method: 'post',
    path: '/app/properties/:id/checkout',
    description: 'Start paying for a property whose enquiry the landlord accepted',
    requestSample: {leaseMonths: 12, moveInDate: '2026-10-01'},
    handler: async (request) => ({
        status: 201,
        body: await customerJourney.startCheckout(me(request), request.params.id, request.body ?? {}),
    }),
});

export const appCheckoutSummary = route({
    method: 'get',
    path: '/app/bookings/:id/summary',
    description: 'CUS-011 — what is being paid and what each part of it is for',
    handler: (request) => customerJourney.checkoutSummary(me(request), request.params.id),
});

/**
 * CUS-014. The customer has chosen a method and pressed pay.
 *
 * This opens a charge with the provider and hands back the instruction — the
 * till number, the reference, or "check your phone". It cannot settle
 * anything: BR-005 means only a provider callback or a finance officer can
 * make a payment successful.
 */
export const appPayNow = route({
    method: 'post',
    path: '/app/payments/:id/pay',
    description: 'Open a charge with the chosen provider and return how to complete it',
    requestSample: {paymentMethodId: '…', payerPhone: '+255712345678'},
    handler: (request) => customerJourney.payNow(me(request), request.params.id, request.body ?? {}),
});

/** CUS-007e. Ask a landlord who has gone quiet to look again. */
export const appNudgeInquiry = route({
    method: 'post',
    path: '/app/inquiries/:id/nudge',
    description: 'Send the landlord a reminder about an enquiry still waiting',
    handler: (request) => customerJourney.nudgeInquiry(me(request), request.params.id),
});

export const appInquiryJourney = route({
    method: 'get',
    path: '/app/inquiries/:id/journey',
    description: 'The status timeline behind one enquiry (CUS-007d/e)',
    handler: (request) => customerJourney.inquiryJourney(me(request), request.params.id),
});

// --- tenancies ---------------------------------------------------------------

export const appListRentals = route({
    method: 'get',
    path: '/app/rentals',
    description: 'CUS-012a — every lease the customer is currently living under',
    handler: (request) => customerJourney.listRentals(me(request), request.query ?? {}),
});

export const appGetRental = route({
    method: 'get',
    path: '/app/rentals/:id',
    description: 'CUS-012b — one tenancy: money, paperwork, payment history and extras',
    handler: (request) => customerJourney.getRental(me(request), request.params.id),
});

export const appGetLease = route({
    method: 'get',
    path: '/app/rentals/:id/lease',
    description: 'CUS-012c — the lease agreement behind a tenancy',
    handler: (request) => customerJourney.getLease(me(request), request.params.id),
});
