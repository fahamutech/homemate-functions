import {adminConsole} from '../../src/services/admin-console/container.mjs';
import {route, actorOf} from '../../src/shared/http.mjs';
import {invalid} from '../../src/shared/errors.mjs';

/** Payment method configuration, and the OSM geocoding proxy used by the map picker. */

export const adminListPaymentMethods = route({
    method: 'get',
    path: '/admin/payment-methods',
    description: 'Configured payment methods and the PaymentPort adapters available to them',
    handler: (request) => adminConsole.paymentMethods.list(request.query),
});

export const adminCreatePaymentMethod = route({
    method: 'post',
    path: '/admin/payment-methods',
    description: 'Add a payment method backed by a registered provider adapter',
    requestSample: {code: 'halopesa', name: 'HaloPesa', kind: 'mobile_money', provider: 'sandbox'},
    handler: async (request) => ({
        status: 201,
        body: await adminConsole.paymentMethods.create(request.body ?? {}, actorOf(request)),
    }),
});

export const adminUpdatePaymentMethod = route({
    method: 'patch',
    path: '/admin/payment-methods/:id',
    description: 'Enable, disable or reconfigure a payment method',
    handler: (request) =>
        adminConsole.paymentMethods.update(request.params.id, request.body ?? {}, actorOf(request)),
});

/**
 * OpenStreetMap search, proxied. Nominatim wants an identifying User-Agent and
 * rate-limits per caller, so the request is made once from the server instead
 * of from every admin's browser — and the provider stays swappable.
 */
export const adminGeocodeSearch = route({
    method: 'get',
    path: '/admin/geocode',
    description: 'Search OpenStreetMap for a place and return candidate coordinates',
    handler: (request) => {
        const query = `${request.query?.q ?? ''}`.trim();
        if (query.length < 3) throw invalid('Enter at least 3 characters to search for a place');
        return adminConsole.geocoding.search(query, {limit: Number(request.query?.limit ?? 6)});
    },
});

export const adminReverseGeocode = route({
    method: 'get',
    path: '/admin/geocode/reverse',
    description: 'Resolve coordinates back to an address (used after dropping a pin)',
    handler: async (request) => {
        const latitude = Number(request.query?.latitude);
        const longitude = Number(request.query?.longitude);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            throw invalid('latitude and longitude are required');
        }
        return {result: await adminConsole.geocoding.reverse(latitude, longitude)};
    },
});
