import {customerApp, customerGeocoding, storagePort} from '../../src/services/customer-app/container.mjs';
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

// --- viewings ----------------------------------------------------------------

export const appListViewings = route({
    method: 'get',
    path: '/app/viewings',
    description: 'Scheduled and past viewings',
    handler: (request) => customerApp.listViewings(me(request), request.query),
});

export const appRequestViewing = route({
    method: 'post',
    path: '/app/viewings',
    description: 'Ask to view a property at a time',
    requestSample: {propertyId: '…', scheduledFor: '2026-10-02T10:00:00Z'},
    handler: async (request) => ({
        status: 201,
        body: await customerApp.requestViewing(me(request), request.body ?? {}),
    }),
});

export const appGetViewing = route({
    method: 'get',
    path: '/app/viewings/:id',
    description: 'One viewing, with where to meet',
    handler: (request) => customerApp.getViewing(me(request), request.params.id),
});

export const appCancelViewing = route({
    method: 'post',
    path: '/app/viewings/:id/cancel',
    description: 'Cancel a viewing, with a reason',
    handler: (request) => customerApp.cancelViewing(me(request), request.params.id, request.body?.reason),
});

// --- bookings ----------------------------------------------------------------

export const appListBookings = route({
    method: 'get',
    path: '/app/bookings',
    description: 'The customer’s bookings and rentals',
    handler: (request) => customerApp.listBookings(me(request), request.query),
});

export const appCreateBooking = route({
    method: 'post',
    path: '/app/bookings',
    description: 'Book a property; the terms are copied and the payment is raised',
    requestSample: {propertyId: '…', moveInDate: '2026-11-01', leaseMonths: 12},
    handler: async (request) => ({
        status: 201,
        body: await customerApp.createBooking(me(request), request.body ?? {}),
    }),
});

export const appGetBooking = route({
    method: 'get',
    path: '/app/bookings/:id',
    description: 'One booking with its payments and what is still owed',
    handler: (request) => customerApp.getBooking(me(request), request.params.id),
});

export const appCancelBooking = route({
    method: 'post',
    path: '/app/bookings/:id/cancel',
    description: 'Cancel a booking, with a reason',
    handler: (request) => customerApp.cancelBooking(me(request), request.params.id, request.body?.reason),
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
