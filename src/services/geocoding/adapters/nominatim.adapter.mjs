/**
 * MapPort adapter for OpenStreetMap's Nominatim.
 *
 * Proxied through our own API rather than called from the browser: Nominatim
 * asks for an identifying User-Agent and rate-limits per client, and going
 * through the server keeps the provider swappable (the UI only ever talks to
 * /admin/geocode).
 */
export function createNominatimAdapter({
    baseUrl = 'https://nominatim.openstreetmap.org',
    userAgent = 'HomeMateAfricaAdmin/1.0 (admin backoffice)',
    countryCodes = 'tz',
    fetchImpl = fetch,
} = {}) {
    function toResult(entry) {
        return {
            displayName: entry.display_name,
            latitude: Number(entry.lat),
            longitude: Number(entry.lon),
            type: entry.type,
            category: entry.class,
            address: entry.address ?? {},
        };
    }

    return {
        provider: 'nominatim',

        async search(query, {limit = 6} = {}) {
            const url = new URL(`${baseUrl}/search`);
            url.searchParams.set('q', query);
            url.searchParams.set('format', 'jsonv2');
            url.searchParams.set('addressdetails', '1');
            url.searchParams.set('limit', String(limit));
            if (countryCodes) url.searchParams.set('countrycodes', countryCodes);

            const response = await fetchImpl(url, {headers: {'user-agent': userAgent, accept: 'application/json'}});
            if (!response.ok) return {items: []};
            const payload = await response.json();
            return {items: (Array.isArray(payload) ? payload : []).map(toResult)};
        },

        async reverse(latitude, longitude) {
            const url = new URL(`${baseUrl}/reverse`);
            url.searchParams.set('lat', String(latitude));
            url.searchParams.set('lon', String(longitude));
            url.searchParams.set('format', 'jsonv2');
            url.searchParams.set('addressdetails', '1');

            const response = await fetchImpl(url, {headers: {'user-agent': userAgent, accept: 'application/json'}});
            if (!response.ok) return null;
            const payload = await response.json();
            return payload?.lat ? toResult(payload) : null;
        },
    };
}

/** Deterministic MapPort for tests — no network, predictable results. */
export function createStubGeocodingAdapter(results = []) {
    return {
        provider: 'stub',
        async search(query) {
            return {items: results.filter((r) => r.displayName.toLowerCase().includes(query.toLowerCase()))};
        },
        async reverse() {
            return results[0] ?? null;
        },
    };
}
