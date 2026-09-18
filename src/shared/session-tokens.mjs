import {createHmac, timingSafeEqual} from 'node:crypto';

function base64url(input) {
    return Buffer.from(input).toString('base64url');
}

/**
 * Minimal stateless session token: base64url(payload) + "." + HMAC-SHA256
 * signature. No external dependency, no session table — good enough for
 * the current MVP slices. Every auth module (identity-access's phone-OTP
 * login, admin-access's env-credential login, functions/guards/auth.mjs)
 * shares this one implementation instead of each rolling its own HMAC
 * logic — the payload shape is caller-defined (e.g. {userId, phoneNumber}
 * for a customer/broker session vs {role: 'admin', email} for an admin
 * session), verify() just returns whatever was signed.
 *
 * @param {string} secret
 */
export function createSessionTokenService(secret) {
    if (!secret) {
        throw new Error('createSessionTokenService requires a non-empty secret');
    }

    function sign(payload, {expiresInSeconds = 60 * 60 * 24 * 7} = {}) {
        const body = {...payload, exp: Math.floor(Date.now() / 1000) + expiresInSeconds};
        const encodedBody = base64url(JSON.stringify(body));
        const signature = createHmac('sha256', secret).update(encodedBody).digest('base64url');
        return `${encodedBody}.${signature}`;
    }

    /**
     * @returns {Record<string, unknown>|null} the signed payload, or null
     * when the token is missing, malformed, tampered with, or expired.
     */
    function verify(token) {
        if (typeof token !== 'string' || !token.includes('.')) return null;
        const [encodedBody, signature] = token.split('.');
        const expectedSignature = createHmac('sha256', secret).update(encodedBody).digest('base64url');

        const signatureBuffer = Buffer.from(signature ?? '');
        const expectedBuffer = Buffer.from(expectedSignature);
        if (signatureBuffer.length !== expectedBuffer.length) return null;
        if (!timingSafeEqual(signatureBuffer, expectedBuffer)) return null;

        let payload;
        try {
            payload = JSON.parse(Buffer.from(encodedBody, 'base64url').toString('utf8'));
        } catch {
            return null;
        }
        if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
        return payload;
    }

    return {sign, verify};
}

let sharedInstance;

/**
 * Production singleton, built lazily (on first call, not on import) from
 * SESSION_TOKEN_SECRET — every real container.mjs calls this instead of
 * each constructing its own from process.env, so one secret produces one
 * signer and tokens issued by identity-access and admin-access are equally
 * verifiable by any guard. Laziness matters here: this module is also
 * imported by unit tests (for the plain `createSessionTokenService`
 * factory) that set no env vars at all and must never pay this check.
 */
export function getSharedSessionTokens() {
    if (!sharedInstance) {
        sharedInstance = createSessionTokenService(
            process.env.SESSION_TOKEN_SECRET ?? (() => {
                throw new Error('SESSION_TOKEN_SECRET is not set');
            })()
        );
    }
    return sharedInstance;
}
