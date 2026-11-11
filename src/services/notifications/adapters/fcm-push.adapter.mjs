import {createSign} from 'node:crypto';
import {readFileSync} from 'node:fs';

/**
 * PushPort backed by Firebase Cloud Messaging's HTTP v1 API.
 *
 * Everything vendor-shaped is confined here: the service-account JWT, the
 * OAuth exchange, the message format per platform and FCM's error codes.
 * Plain `fetch` and `node:crypto` rather than firebase-admin — the backend
 * needs one endpoint, not an SDK.
 */

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';

/** The Android channel the app creates (and FCM falls back to) for HomeMate notices. */
export const ANDROID_CHANNEL_ID = 'homemate_default';

/** FCM's ways of saying "this token is gone": uninstalled, signed out, or another project's. */
const DEAD_TOKEN_CODES = new Set(['UNREGISTERED', 'SENDER_ID_MISMATCH']);

/**
 * The service account, from `FCM_SERVICE_ACCOUNT_JSON` (the JSON itself, for
 * hosts that only take variables) or a file named by `FCM_SERVICE_ACCOUNT_FILE`
 * or `GOOGLE_APPLICATION_CREDENTIALS`.
 */
export function loadServiceAccount({
    json = process.env.FCM_SERVICE_ACCOUNT_JSON,
    file = process.env.FCM_SERVICE_ACCOUNT_FILE ?? process.env.GOOGLE_APPLICATION_CREDENTIALS,
} = {}) {
    const text = json?.trim() ? json : file ? readFileSync(file, 'utf8') : null;
    if (!text) {
        throw new Error('FCM needs a service account: set FCM_SERVICE_ACCOUNT_JSON or FCM_SERVICE_ACCOUNT_FILE');
    }
    const account = JSON.parse(text);
    if (!account.client_email || !account.private_key || !account.project_id) {
        throw new Error('The FCM service account must have client_email, private_key and project_id');
    }
    return account;
}

const base64url = (value) => Buffer.from(value).toString('base64url');

export function createFcmPushAdapter({
    serviceAccount = loadServiceAccount(),
    projectId = process.env.FCM_PROJECT_ID ?? serviceAccount.project_id,
    fetchImpl = fetch,
    now = () => Date.now(),
    timeoutMs = 10_000,
} = {}) {
    let cached = null;

    async function call(url, init) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetchImpl(url, {...init, signal: controller.signal});
            return {response, payload: await response.json().catch(() => ({}))};
        } finally {
            clearTimeout(timer);
        }
    }

    /** A Google access token for the service account, reused until a minute before it expires. */
    async function accessToken() {
        if (cached && cached.expiresAt - 60_000 > now()) return cached.token;

        const issuedAt = Math.floor(now() / 1000);
        const tokenUri = serviceAccount.token_uri ?? DEFAULT_TOKEN_URI;
        const unsigned = `${base64url(JSON.stringify({alg: 'RS256', typ: 'JWT'}))}.${base64url(JSON.stringify({
            iss: serviceAccount.client_email,
            scope: SCOPE,
            aud: tokenUri,
            iat: issuedAt,
            exp: issuedAt + 3600,
        }))}`;
        const signature = createSign('RSA-SHA256').update(unsigned).sign(serviceAccount.private_key, 'base64url');

        const {response, payload} = await call(tokenUri, {
            method: 'POST',
            headers: {'content-type': 'application/x-www-form-urlencoded'},
            body: new URLSearchParams({
                grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                assertion: `${unsigned}.${signature}`,
            }),
        });
        if (!response.ok || !payload.access_token) {
            throw new Error(`Google refused the FCM service account (${response.status}): ${payload.error_description ?? payload.error ?? 'no token'}`);
        }
        cached = {token: payload.access_token, expiresAt: now() + Number(payload.expires_in ?? 3600) * 1000};
        return cached.token;
    }

    /** The FCM v1 message for one phone. */
    function toMessage({token, platform, title, body, data, link}) {
        const notification = {title, ...(body ? {body} : {})};
        return {
            token,
            notification,
            data,
            ...(platform === 'android'
                ? {android: {priority: 'high', notification: {channel_id: ANDROID_CHANNEL_ID, tag: data.notificationId}}}
                : {}),
            ...(platform === 'web'
                ? {
                    webpush: {
                        notification: {icon: '/icons/Icon-192.png', badge: '/icons/Icon-192.png', tag: data.notificationId},
                        ...(link ? {fcm_options: {link}} : {}),
                    },
                }
                : {}),
            ...(platform === 'ios' ? {apns: {payload: {aps: {sound: 'default'}}}} : {}),
        };
    }

    return {
        provider: 'fcm',

        /** @type {import('../ports.mjs').PushPort['send']} */
        async send(message) {
            let response;
            let payload;
            try {
                ({response, payload} = await call(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
                    method: 'POST',
                    headers: {authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json'},
                    body: JSON.stringify({message: toMessage(message)}),
                }));
            } catch (error) {
                return {ok: false, provider: 'fcm', retryable: true, error: `${error?.message ?? error}`};
            }

            if (response.ok) return {ok: true, provider: 'fcm', messageId: payload.name ?? null};

            const details = payload.error?.details ?? [];
            const code = details.find((detail) => detail.errorCode)?.errorCode ?? payload.error?.status ?? `${response.status}`;
            const error = `${code}: ${payload.error?.message ?? response.statusText}`;
            // A malformed token is as dead as an uninstalled one; any other
            // INVALID_ARGUMENT is our message's fault and retrying will not help.
            const invalidToken = DEAD_TOKEN_CODES.has(code)
                || (code === 'INVALID_ARGUMENT' && /registration token/i.test(payload.error?.message ?? ''));
            if (response.status === 401) cached = null;
            return {
                ok: false,
                provider: 'fcm',
                invalidToken,
                retryable: !invalidToken && (response.status === 401 || response.status === 429 || response.status >= 500),
                error,
            };
        },
    };
}
