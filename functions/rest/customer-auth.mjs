import {customerAccess, smsPort} from '../../src/services/customer-access/container.mjs';
import {route} from '../../src/shared/http.mjs';
import {DomainError, ErrorCodes} from '../../src/shared/errors.mjs';

/**
 * The unauthenticated part of the customer journey: prove the phone once with
 * a code, choose a PIN, then sign in with the PIN from then on.
 *
 * These sit outside `/app/*` on purpose — that prefix is guarded, and you
 * cannot present a session before you have one. Everything here is rate
 * limited in the database, because each code costs real credit.
 */

/**
 * The caller's address, for the per-IP quota. A proxy header is only trusted
 * when the deployment says there is a proxy in front — otherwise anyone could
 * set it and sidestep their own limit.
 */
function callerIp(request) {
    if (process.env.TRUST_PROXY === 'true') {
        const forwarded = `${request.headers['x-forwarded-for'] ?? ''}`.split(',')[0].trim();
        if (forwarded) return forwarded;
    }
    const address = request.ip ?? request.socket?.remoteAddress ?? null;
    // Express reports IPv4 clients as ::ffff:1.2.3.4; inet accepts either, but
    // one shape per client keeps the quota counting the same person once.
    return address?.startsWith('::ffff:') ? address.slice(7) : address;
}

function rateLimited(result, response) {
    if (result?.retryAfterSeconds) response.setHeader('retry-after', String(result.retryAfterSeconds));
}

export const customerRequestOtp = route({
    method: 'post',
    path: '/customer/auth/otp/request',
    description: 'Send a verification code, subject to the per-number, per-IP and platform limits',
    requestSample: {phoneNumber: '+255712345678', purpose: 'login'},
    handler: async (request, response) => {
        try {
            return await customerAccess.requestOtp({
                phoneNumber: request.body?.phoneNumber,
                purpose: request.body?.purpose,
                ipAddress: callerIp(request),
                userAgent: request.headers['user-agent'],
            });
        } catch (error) {
            rateLimited(error, response);
            throw error;
        }
    },
});

export const customerVerifyOtp = route({
    method: 'post',
    path: '/customer/auth/otp/verify',
    description: 'Check a code. Returns a short-lived verification token, not a session',
    requestSample: {challengeId: '…', code: '123456'},
    handler: (request) =>
        customerAccess.verifyOtp({
            challengeId: request.body?.challengeId,
            code: request.body?.code,
        }),
});

export const customerSetPin = route({
    method: 'post',
    path: '/customer/auth/pin',
    description: 'Choose the PIN used to sign in from now on; returns a session',
    requestSample: {verificationToken: '…', pin: '4820', confirmPin: '4820'},
    handler: (request) => customerAccess.setPin(request.body ?? {}),
});

export const customerLogin = route({
    method: 'post',
    path: '/customer/auth/login',
    description: 'Sign in with a phone number and PIN — no SMS is sent',
    requestSample: {phoneNumber: '+255712345678', pin: '4820'},
    handler: async (request, response) => {
        try {
            return await customerAccess.loginWithPin({
                phoneNumber: request.body?.phoneNumber,
                pin: request.body?.pin,
            });
        } catch (error) {
            rateLimited(error, response);
            throw error;
        }
    },
});

export const customerResetPin = route({
    method: 'post',
    path: '/customer/auth/pin/reset',
    description: 'Set a new PIN after verifying a code issued for a reset',
    handler: (request) => customerAccess.resetPin(request.body ?? {}),
});

// --- the session-bearing part of auth, under the guarded prefix -------------

export const customerMe = route({
    method: 'get',
    path: '/app/me',
    description: 'The signed-in customer',
    handler: (request) => customerAccess.me({userId: request.auth.userId}),
});

export const customerCompleteProfile = route({
    method: 'post',
    path: '/app/me/profile',
    description: 'Finish onboarding: name, email and preferred language',
    requestSample: {fullName: 'Neema Kileo', email: 'neema@example.com', preferredLanguage: 'sw'},
    handler: (request) =>
        customerAccess.completeProfile({userId: request.auth.userId, ...(request.body ?? {})}),
});

export const customerChangePin = route({
    method: 'post',
    path: '/app/me/pin',
    description: 'Change the PIN from inside the app, proving the current one',
    handler: (request) =>
        customerAccess.changePin({userId: request.auth.userId, ...(request.body ?? {})}),
});

/**
 * The code the sandbox adapter "sent", so an automated journey can read it the
 * way a customer reads their phone.
 *
 * This is a hole by construction, so it is closed by construction: it answers
 * only while the sandbox adapter is the configured provider. Point
 * `SMS_PROVIDER` at a real vendor — as any deployment does — and there is no
 * `sentMessages` to read and the route returns 404. There is no flag to forget
 * to turn off.
 */
export const customerLastSandboxOtp = route({
    method: 'get',
    path: '/customer/auth/otp/last',
    description: 'Dev only: the last sandbox OTP for a number. Absent unless the sandbox adapter is in use',
    handler: (request) => {
        if (typeof smsPort.lastMessageTo !== 'function') {
            throw new DomainError(ErrorCodes.NOT_FOUND, 'Not available', 404);
        }
        const phoneNumber = `${request.query?.phoneNumber ?? ''}`.trim();
        const message = smsPort.lastMessageTo(phoneNumber);
        if (!message) throw new DomainError(ErrorCodes.NOT_FOUND, 'No code has been sent to that number', 404);
        return {code: message.params?.code, sentAt: message.sentAt};
    },
});
