import {StorageError} from '../ports.mjs';

/**
 * StoragePort adapter for the Zebra / smartstock-storage service
 * (bfast-functions + Helia). Its contract, confirmed against a running
 * instance:
 *
 *   POST /auth/token   {username, password}      -> {accessToken, expiresIn}
 *   POST /storage      multipart, Bearer token   -> {urls: ['/storage/<cid>/<name>']}
 *   GET  /storage/<cid>/<name>  Bearer token     -> the bytes
 *
 * Both reading and writing require a token, so the credentials stay here on
 * the server and HomeMate proxies image reads for the browser rather than
 * handing out storage URLs.
 */
export function createZebraStorageAdapter({baseUrl, username, password, fetchImpl = fetch, now = () => Date.now()}) {
    if (!baseUrl) throw new StorageError('NOT_CONFIGURED', 'STORAGE_BASE_URL is not set', 500);

    const root = baseUrl.replace(/\/+$/, '');
    let cachedToken = null;
    let tokenExpiresAt = 0;

    async function accessToken() {
        // refresh a minute before expiry so a long upload can't straddle it
        if (cachedToken && now() < tokenExpiresAt - 60_000) return cachedToken;

        const response = await fetchImpl(`${root}/auth/token`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({username, password}),
        });
        if (!response.ok) {
            throw new StorageError('AUTH_FAILED', `Storage rejected the service credentials (${response.status})`);
        }
        const payload = await response.json();
        cachedToken = payload.accessToken;
        tokenExpiresAt = now() + Number(payload.expiresIn ?? 3600) * 1000;
        return cachedToken;
    }

    return {
        provider: 'zebra',

        async put({name, contentType, body}) {
            const token = await accessToken();
            const form = new FormData();
            form.append('file', new Blob([body], {type: contentType}), name);

            const response = await fetchImpl(`${root}/storage`, {
                method: 'POST',
                headers: {authorization: `Bearer ${token}`},
                body: form,
            });
            if (!response.ok) {
                const detail = await response.text().catch(() => '');
                throw new StorageError('UPLOAD_FAILED', `Storage upload failed (${response.status}) ${detail}`.trim());
            }

            const payload = await response.json();
            const url = payload?.urls?.[0];
            if (!url) throw new StorageError('UPLOAD_FAILED', 'Storage returned no URL for the upload');

            return {
                // the service returns a root-relative path; that path *is* the key
                key: url,
                url: `${root}${url}`,
                name,
                contentType,
                sizeBytes: body.length,
            };
        },

        async get(key) {
            const token = await accessToken();
            const path = key.startsWith('http') ? key : `${root}${key}`;
            const response = await fetchImpl(path, {headers: {authorization: `Bearer ${token}`}});
            if (response.status === 404) {
                throw new StorageError('NOT_FOUND', 'That file is not in storage', 404);
            }
            if (!response.ok) {
                throw new StorageError('READ_FAILED', `Storage read failed (${response.status})`);
            }
            return {
                body: Buffer.from(await response.arrayBuffer()),
                contentType: response.headers.get('content-type') ?? 'application/octet-stream',
            };
        },
    };
}
