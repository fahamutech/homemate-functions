import {randomInt, createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {scrypt as scryptCallback} from 'node:crypto';
import {promisify} from 'node:util';
import {DomainError, ErrorCodes} from '../../shared/errors.mjs';
import {ACCOUNT_ROLES} from '../../shared/roles.mjs';
import {activeRolesOf, customerSessionClaims, publicRole} from '../../shared/active-role.mjs';

const scrypt = promisify(scryptCallback);

const PHONE_PATTERN = /^\+255\d{9}$/;
const PIN_PATTERN = /^\d{4,6}$/;

/**
 * Customer authentication for the mobile app.
 *
 * The phone number is proved once with an OTP; from then on the customer signs
 * in with a PIN. That is not only kinder than an SMS on every login — every
 * code costs real credit, so an app that sends one per session is an app whose
 * login breaks the day the balance runs out.
 *
 * OTP therefore survives for exactly the cases that need the phone re-proved:
 * first registration, a forgotten PIN, and a new device. Whether a code may be
 * sent at all is `otp_quota_check()` in the database, so every caller — this
 * service, a future web client, a support tool — is held to the same limits.
 */

/** Weak PINs are the ones attackers try first; rejecting them is cheap. */
const OBVIOUS_PINS = new Set([
    '0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999',
    '1234', '4321', '2580', '0123', '123456', '654321', '111111', '000000',
]);

const GENDERS = new Set(['female', 'male', 'other', 'undisclosed']);

/** Mirrors users_dob_sane in 009: a birthday cannot be today or later. */
function readDateOfBirth(value) {
    if (value === undefined || value === null || `${value}`.trim() === '') return null;
    const text = `${value}`.trim();
    const parsed = new Date(`${text}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(parsed.getTime())) {
        throw new DomainError(ErrorCodes.VALIDATION_FAILED, 'Give the date of birth as YYYY-MM-DD', 400);
    }
    if (parsed >= new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z')) {
        throw new DomainError(ErrorCodes.VALIDATION_FAILED, 'That date of birth is in the future', 400);
    }
    return text;
}

/** Mirrors users_gender_known in 009. */
function readGender(value) {
    if (value === undefined || value === null || `${value}`.trim() === '') return null;
    const text = `${value}`.trim().toLowerCase();
    if (!GENDERS.has(text)) {
        throw new DomainError(
            ErrorCodes.VALIDATION_FAILED,
            `gender must be one of: ${[...GENDERS].join(', ')}`,
            400
        );
    }
    return text;
}

function defaultGenerateCode() {
    return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function hashCode(phoneNumber, code) {
    return createHash('sha256').update(`${phoneNumber}:${code}`).digest('hex');
}

/** scrypt with a per-PIN salt: a stolen table cannot be reversed in bulk. */
async function hashPin(pin, salt = randomBytes(16).toString('hex')) {
    const derived = await scrypt(pin, salt, 64);
    return `scrypt$${salt}$${derived.toString('hex')}`;
}

async function pinMatches(pin, stored) {
    if (typeof stored !== 'string') return false;
    const [scheme, salt, expected] = stored.split('$');
    if (scheme !== 'scrypt' || !salt || !expected) return false;
    const derived = await scrypt(pin, salt, 64);
    const expectedBuffer = Buffer.from(expected, 'hex');
    // Length must match before timingSafeEqual, which throws otherwise.
    return derived.length === expectedBuffer.length && timingSafeEqual(derived, expectedBuffer);
}

function invalidPhone() {
    return new DomainError(
        ErrorCodes.VALIDATION_FAILED,
        'Enter a Tanzanian mobile number like +255712345678',
        400
    );
}

export function createCustomerAccessService({
    repository,
    notificationPort,
    sessionTokens,
    now = () => new Date(),
    generateCode = defaultGenerateCode,
    reviewAccount = null,
}) {
    /**
     * Google Play reviews the app from outside Tanzania, on a device with no
     * Tanzanian SIM, so a reviewer can never receive a real code — and an app
     * whose every screen sits behind a login is rejected at the login screen.
     *
     * One number, named in configuration, therefore gets a code that is fixed
     * instead of random and is not sent anywhere. It is not a bypass: the
     * challenge is created, verified and consumed by exactly the same code
     * path as everyone else, so the reviewer sees the real flow. The account
     * is ordinary in every other respect, and unsetting the two variables
     * removes it entirely.
     */
    const isReviewNumber = (phoneNumber) =>
        reviewAccount?.phoneNumber != null && phoneNumber === reviewAccount.phoneNumber;

    /**
     * Sends a code, or explains why it will not. The quota answer carries a
     * retry time so the app can count down rather than just saying no, and a
     * refusal is logged too — a table of successes cannot show you an attack.
     */
    async function requestOtp({phoneNumber, purpose = 'login', ipAddress, userAgent}) {
        if (typeof phoneNumber !== 'string' || !PHONE_PATTERN.test(phoneNumber)) {
            throw invalidPhone();
        }

        const review = isReviewNumber(phoneNumber);

        // The quota exists to stop an attacker spending SMS credit. The review
        // number spends none, and a reviewer who re-runs the journey a dozen
        // times must not find themselves locked out mid-review.
        const quota = review
            ? {allowed: true, retryAfterSeconds: 0}
            : await repository.checkOtpQuota({phoneNumber, ipAddress, purpose});
        if (!quota.allowed) {
            await repository.logOtpRequest({
                phoneNumber, ipAddress, purpose, outcome: 'throttled', reason: quota.reason,
            });
            const error = new DomainError(ErrorCodes.RATE_LIMITED, quota.reason, 429);
            error.retryAfterSeconds = quota.retryAfterSeconds;
            throw error;
        }

        // A reset is only meaningful for an account that exists; saying so
        // would confirm which numbers are registered, so the caller gets the
        // same answer either way and simply no SMS is spent.
        const existing = await repository.findUserByPhone(phoneNumber);
        if (purpose === 'reset_pin' && !existing) {
            await repository.logOtpRequest({
                phoneNumber, ipAddress, purpose, outcome: 'throttled', reason: 'No account for that number',
            });
            return {challengeId: null, expiresAt: null, resendAfterSeconds: quota.retryAfterSeconds || 60};
        }

        const settings = await repository.otpSettings();
        const code = review ? reviewAccount.code : generateCode();
        const expiresAt = new Date(now().getTime() + settings.ttlSeconds * 1000);

        const challenge = await repository.createChallenge({
            phoneNumber,
            purpose,
            codeHash: hashCode(phoneNumber, code),
            expiresAt,
            maxAttempts: settings.maxAttempts,
            ipAddress,
            userAgent,
        });

        // Nothing to deliver: the code is already in the reviewer's hands, in
        // the note we give Play.
        if (review) {
            await repository.logOtpRequest({phoneNumber, ipAddress, purpose, outcome: 'sent', reason: 'review account'});
            return {
                challengeId: challenge.id,
                expiresAt: challenge.expires_at,
                resendAfterSeconds: 0,
            };
        }

        let delivery;
        try {
            delivery = await notificationPort.send({
                to: phoneNumber,
                template: 'otp-code',
                params: {code, purpose, reference: challenge.id},
            });
        } catch (error) {
            console.error(error);
            await repository.logOtpRequest({
                phoneNumber, ipAddress, purpose, outcome: 'failed', reason: error.message,
            });
            throw new DomainError(
                ErrorCodes.INTERNAL_ERROR,
                'We could not send the code right now. Please try again shortly.',
                502
            );
        }

        await repository.recordDelivery({
            challengeId: challenge.id,
            channel: 'sms',
            provider: delivery.provider,
            externalId: delivery.externalId,
            status: delivery.status,
            smsCount: delivery.smsCount ?? 1,
            rawPayload: delivery.raw,
        });
        await repository.logOtpRequest({phoneNumber, ipAddress, purpose, outcome: 'sent'});

        return {
            challengeId: challenge.id,
            expiresAt: challenge.expires_at,
            resendAfterSeconds: settings.resendCooldownSeconds,
        };
    }

    /**
     * Proves the phone. This does NOT sign anyone in: it returns a short-lived
     * verification token that is only good for the next step (setting a PIN, or
     * resetting one). Handing out a session here would make OTP a login route
     * again, which is the thing the PIN exists to replace.
     */
    async function verifyOtp({challengeId, code}) {
        const challenge = await repository.findChallenge(challengeId);
        if (!challenge) throw new DomainError(ErrorCodes.NOT_FOUND, 'That code has expired — request a new one', 404);
        if (challenge.consumed_at) throw new DomainError(ErrorCodes.VALIDATION_FAILED, 'That code has already been used', 422);
        if (new Date(challenge.expires_at).getTime() < now().getTime()) {
            throw new DomainError(ErrorCodes.VALIDATION_FAILED, 'That code has expired — request a new one', 422);
        }
        if (challenge.attempts >= challenge.max_attempts) {
            throw new DomainError(ErrorCodes.VALIDATION_FAILED, 'Too many wrong attempts — request a new code', 422);
        }

        if (hashCode(challenge.phone_number, code) !== challenge.code_hash) {
            const attempts = await repository.incrementAttempts(challengeId);
            const remaining = Math.max(0, challenge.max_attempts - attempts);
            throw new DomainError(
                ErrorCodes.VALIDATION_FAILED,
                remaining > 0
                    ? `That code is not right — ${remaining} ${remaining === 1 ? 'try' : 'tries'} left`
                    : 'Too many wrong attempts — request a new code',
                422
            );
        }

        await repository.consumeChallenge(challengeId);
        const user = await repository.markPhoneVerified(challenge.phone_number);

        return {
            verificationToken: sessionTokens.sign(
                {userId: user.id, phoneNumber: user.phone_number, scope: 'verify', purpose: challenge.purpose},
                {expiresInSeconds: 15 * 60}
            ),
            hasPin: Boolean(user.pin_hash),
            onboardingComplete: Boolean(user.onboarding_completed_at),
            user: repository.publicUser(user),
        };
    }

    /**
     * Chooses the PIN the customer will actually log in with. Requires the
     * verification token from `verifyOtp`, so a PIN can only ever be set by
     * someone who just proved they hold the phone.
     */
    async function setPin({verificationToken, pin, confirmPin}) {
        const claims = readVerificationToken(verificationToken);
        assertPinAcceptable(pin, confirmPin);

        const user = await repository.setPinHash(claims.userId, await hashPin(pin));
        return issueSession(user);
    }

    async function loginWithPin({phoneNumber, pin}) {
        if (typeof phoneNumber !== 'string' || !PHONE_PATTERN.test(phoneNumber)) throw invalidPhone();

        const user = await repository.findUserByPhone(phoneNumber);
        // Same answer whether the number is unknown or the PIN is wrong: the
        // login screen must not become a way to enumerate customers.
        const genericFailure = () =>
            new DomainError(ErrorCodes.UNAUTHORIZED, 'That phone number and PIN do not match', 401);

        if (!user?.pin_hash) throw genericFailure();

        if (user.pin_locked_until && new Date(user.pin_locked_until).getTime() > now().getTime()) {
            const seconds = Math.ceil(
                (new Date(user.pin_locked_until).getTime() - now().getTime()) / 1000
            );
            const error = new DomainError(
                ErrorCodes.RATE_LIMITED,
                'Too many wrong PINs — this account is locked for a few minutes',
                429
            );
            error.retryAfterSeconds = seconds;
            throw error;
        }

        assertAccountUsable(user);

        if (!(await pinMatches(pin, user.pin_hash))) {
            const {locked, lockedUntil} = await repository.registerPinFailure(user.id);
            if (locked) {
                const error = new DomainError(
                    ErrorCodes.RATE_LIMITED,
                    'Too many wrong PINs — this account is locked for a few minutes',
                    429
                );
                error.retryAfterSeconds = Math.ceil((new Date(lockedUntil).getTime() - now().getTime()) / 1000);
                throw error;
            }
            throw genericFailure();
        }

        const fresh = await repository.clearPinFailures(user.id);
        return issueSession(fresh);
    }

    /** Changing a PIN from inside the app: prove the old one, choose a new one. */
    async function changePin({userId, currentPin, pin, confirmPin}) {
        const user = await repository.findUserById(userId);
        if (!user?.pin_hash || !(await pinMatches(currentPin, user.pin_hash))) {
            throw new DomainError(ErrorCodes.UNAUTHORIZED, 'Your current PIN is not right', 401);
        }
        assertPinAcceptable(pin, confirmPin);
        const updated = await repository.setPinHash(userId, await hashPin(pin));
        return {ok: true, user: repository.publicUser(updated)};
    }

    /** After `verifyOtp` with purpose `reset_pin`. Same path as setting it. */
    async function resetPin({verificationToken, pin, confirmPin}) {
        const claims = readVerificationToken(verificationToken, 'reset_pin');
        assertPinAcceptable(pin, confirmPin);
        const user = await repository.setPinHash(claims.userId, await hashPin(pin));
        return issueSession(user);
    }

    /** The profile, plus every role the account holds and the one last used. */
    async function me({userId}) {
        const user = await repository.findUserById(userId);
        if (!user) throw new DomainError(ErrorCodes.NOT_FOUND, 'Account not found', 404);
        const roleRows = await repository.findUserRoles(userId);
        return {
            ...repository.publicUser(user),
            roles: roleRows.map(publicRole),
            lastActiveRole: user.last_active_role ?? null,
        };
    }

    /**
     * ROL-002: act as another of your roles without signing in again. Only an
     * `active` role can be switched to; the choice is remembered so the next
     * sign-in opens in the same place, and a re-signed token is returned
     * because the partner guards read `activeRole` from it.
     */
    async function switchActiveRole({userId, role}) {
        if (typeof role !== 'string' || !ACCOUNT_ROLES.includes(role)) {
            throw new DomainError(
                ErrorCodes.VALIDATION_FAILED,
                `role must be one of: ${ACCOUNT_ROLES.join(', ')}`,
                400
            );
        }

        const user = await repository.findUserById(userId);
        if (!user) throw new DomainError(ErrorCodes.NOT_FOUND, 'Account not found', 404);
        assertAccountUsable(user);

        const roleRows = await repository.findUserRoles(userId);
        if (!activeRolesOf(roleRows).includes(role)) {
            throw new DomainError(ErrorCodes.ROLE_NOT_ACTIVE, `Your ${role} role is not active`, 403);
        }

        const updated = await repository.setLastActiveRole(userId, role);
        const claims = customerSessionClaims(updated, roleRows);
        return {token: sessionTokens.sign(claims), activeRole: claims.activeRole, roles: claims.roles};
    }

    /**
     * The onboarding profile step (CUS-008a), and the same screen reached
     * later from Profile → Edit your details.
     *
     * Date of birth and gender are optional: they belong to the identity
     * record the KYC review reads, and a customer who only wants to browse
     * should not be stopped at a date picker. What is *given* still has to be
     * sane, because `users_dob_sane` and `users_gender_known` in 009 will
     * otherwise refuse the row with a constraint name nobody can act on.
     */
    async function completeProfile({userId, fullName, email, preferredLanguage, dateOfBirth, gender}) {
        if (!`${fullName ?? ''}`.trim()) {
            throw new DomainError(ErrorCodes.VALIDATION_FAILED, 'Please enter your name', 400);
        }
        const user = await repository.completeOnboarding(userId, {
            fullName: `${fullName}`.trim(),
            email: `${email ?? ''}`.trim() || null,
            preferredLanguage: preferredLanguage === 'sw' ? 'sw' : 'en',
            dateOfBirth: readDateOfBirth(dateOfBirth),
            gender: readGender(gender),
        });
        return repository.publicUser(user);
    }

    // --- internals -----------------------------------------------------------

    function readVerificationToken(token, expectedPurpose) {
        const claims = sessionTokens.verify(token);
        if (!claims || claims.scope !== 'verify') {
            throw new DomainError(ErrorCodes.UNAUTHORIZED, 'Verify your phone number first', 401);
        }
        if (expectedPurpose && claims.purpose !== expectedPurpose) {
            throw new DomainError(ErrorCodes.UNAUTHORIZED, 'That verification was for something else', 401);
        }
        return claims;
    }

    function assertPinAcceptable(pin, confirmPin) {
        if (typeof pin !== 'string' || !PIN_PATTERN.test(pin)) {
            throw new DomainError(ErrorCodes.VALIDATION_FAILED, 'Your PIN must be 4 to 6 digits', 400);
        }
        if (confirmPin !== undefined && pin !== confirmPin) {
            throw new DomainError(ErrorCodes.VALIDATION_FAILED, 'The two PINs do not match', 400);
        }
        if (OBVIOUS_PINS.has(pin)) {
            throw new DomainError(
                ErrorCodes.VALIDATION_FAILED,
                'Please choose a less predictable PIN',
                400
            );
        }
        if (/^(\d)\1+$/.test(pin)) {
            throw new DomainError(ErrorCodes.VALIDATION_FAILED, 'Please choose a less predictable PIN', 400);
        }
    }

    function assertAccountUsable(user) {
        if (user.status === 'suspended' || user.status === 'deactivated') {
            throw new DomainError(
                ErrorCodes.FORBIDDEN,
                'This account is not active. Please contact support.',
                403
            );
        }
    }

    async function issueSession(user) {
        const claims = customerSessionClaims(user, await repository.findUserRoles(user.id));
        return {
            token: sessionTokens.sign(claims),
            user: repository.publicUser(user),
            onboardingComplete: Boolean(user.onboarding_completed_at),
            roles: claims.roles,
            activeRole: claims.activeRole,
        };
    }

    return {
        requestOtp,
        verifyOtp,
        setPin,
        loginWithPin,
        changePin,
        resetPin,
        me,
        switchActiveRole,
        completeProfile,
    };
}
