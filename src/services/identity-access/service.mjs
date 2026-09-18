import {randomInt, createHash} from 'node:crypto';
import {IdentityAccessError, IdentityAccessErrorCodes} from './ports.mjs';

const PHONE_NUMBER_PATTERN = /^\+255\d{9}$/; // Tanzania E.164, e.g. +255712345678
const OTP_TTL_SECONDS = 5 * 60;
const OTP_MAX_ATTEMPTS = 5;

function defaultGenerateOtpCode() {
    return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function hashCode(phoneNumber, code) {
    return createHash('sha256').update(`${phoneNumber}:${code}`).digest('hex');
}

/**
 * The identity-access domain service: phone-OTP registration/login
 * (FR-IAM-001..003). Depends only on the `repository` and `notificationPort`
 * contracts passed in — never imports a pg pool or a vendor SDK directly, so
 * it can be fully unit tested (service.unit.specs.mjs) without a database
 * or a real SMS provider. See IMPLEMENTATION_PLAN.md Section 2.1.
 *
 * @param {object} deps
 * @param {*} deps.db - opaque handle passed through to `repository` calls
 * @param {typeof import('./repository.mjs')} deps.repository
 * @param {import('./ports.mjs').NotificationPort} deps.notificationPort
 * @param {ReturnType<typeof import('../../shared/session-tokens.mjs').createSessionTokenService>} deps.sessionTokens
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.generateOtpCode]
 */
export function createIdentityAccessService({
    db,
    repository,
    notificationPort,
    sessionTokens,
    now = () => new Date(),
    generateOtpCode = defaultGenerateOtpCode,
}) {
    async function requestOtp({phoneNumber, purpose = 'login'}) {
        if (typeof phoneNumber !== 'string' || !PHONE_NUMBER_PATTERN.test(phoneNumber)) {
            throw new IdentityAccessError(
                IdentityAccessErrorCodes.INVALID_PHONE_NUMBER,
                'phoneNumber must be in +255XXXXXXXXX format'
            );
        }

        const code = generateOtpCode();
        const expiresAt = new Date(now().getTime() + OTP_TTL_SECONDS * 1000);

        const challenge = await repository.createOtpChallenge(db, {
            phoneNumber,
            purpose,
            codeHash: hashCode(phoneNumber, code),
            expiresAt,
            maxAttempts: OTP_MAX_ATTEMPTS,
        });

        const delivery = await notificationPort.send({
            to: phoneNumber,
            template: 'otp-code',
            params: {code},
        });

        await repository.recordExternalNotificationEvent(db, {
            otpChallengeId: challenge.id,
            channel: 'sms',
            provider: delivery.provider,
            externalId: delivery.externalId,
            status: delivery.status,
            rawPayload: delivery.raw,
        });

        return {challengeId: challenge.id, expiresAt: challenge.expires_at};
    }

    async function verifyOtp({challengeId, code}) {
        const challenge = await repository.findOtpChallengeById(db, challengeId);
        if (!challenge) {
            throw new IdentityAccessError(IdentityAccessErrorCodes.CHALLENGE_NOT_FOUND, 'OTP challenge not found');
        }
        if (challenge.consumed_at) {
            throw new IdentityAccessError(IdentityAccessErrorCodes.CHALLENGE_ALREADY_USED, 'OTP challenge already used');
        }
        if (new Date(challenge.expires_at).getTime() < now().getTime()) {
            throw new IdentityAccessError(IdentityAccessErrorCodes.CHALLENGE_EXPIRED, 'OTP challenge expired');
        }
        if (challenge.attempts >= challenge.max_attempts) {
            throw new IdentityAccessError(IdentityAccessErrorCodes.CHALLENGE_LOCKED, 'OTP challenge locked after too many attempts');
        }

        const expectedHash = hashCode(challenge.phone_number, code);
        if (expectedHash !== challenge.code_hash) {
            await repository.incrementOtpChallengeAttempts(db, challengeId);
            throw new IdentityAccessError(IdentityAccessErrorCodes.INVALID_CODE, 'Incorrect OTP code');
        }

        await repository.markOtpChallengeConsumed(db, challengeId);

        let user = await repository.findUserByPhoneNumber(db, challenge.phone_number);
        if (!user) {
            user = await repository.createUser(db, {phoneNumber: challenge.phone_number});
        }

        const token = sessionTokens.sign({userId: user.id, phoneNumber: user.phone_number});
        return {token, user};
    }

    async function getUserById({userId}) {
        const user = await repository.findUserById(db, userId);
        if (!user) {
            throw new IdentityAccessError(IdentityAccessErrorCodes.USER_NOT_FOUND, 'User not found');
        }
        return user;
    }

    return {requestOtp, verifyOtp, getUserById};
}
