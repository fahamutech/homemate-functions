import {query, withActor} from '../../shared/db.mjs';

/**
 * Every statement customer-access needs, and nothing else. `service.mjs` takes
 * this as a dependency, so the domain rules are unit-testable against a plain
 * object while the real one keeps the SQL in one readable place.
 *
 * The quota decision is deliberately *not* reimplemented here — it is
 * `otp_quota_check()` in migration 012, so the limits hold for any caller.
 */

/** What the app is allowed to know about an account. Never the PIN hash. */
export function publicUser(row) {
    if (!row) return null;
    return {
        id: row.id,
        phoneNumber: row.phone_number,
        email: row.email,
        fullName: row.full_name,
        role: row.role,
        status: row.status,
        preferredLanguage: row.preferred_language,
        phoneVerified: Boolean(row.phone_verified_at),
        hasPin: Boolean(row.pin_hash),
        onboardingComplete: Boolean(row.onboarding_completed_at),
        kycStatus: row.kyc_status,
        profilePhoto: Boolean(row.profile_photo_url),
        createdAt: row.created_at,
    };
}

export function createCustomerAccessRepository({pool}) {
    async function otpSettings() {
        const {rows} = await query(
            pool,
            `select key, value from settings
              where key in ('otp.ttl_seconds', 'otp.max_attempts', 'otp.resend_cooldown_seconds',
                            'auth.pin_max_attempts', 'auth.pin_lockout_minutes')`
        );
        const byKey = Object.fromEntries(rows.map((r) => [r.key, Number(r.value)]));
        return {
            ttlSeconds: byKey['otp.ttl_seconds'] ?? 300,
            maxAttempts: byKey['otp.max_attempts'] ?? 5,
            resendCooldownSeconds: byKey['otp.resend_cooldown_seconds'] ?? 60,
            pinMaxAttempts: byKey['auth.pin_max_attempts'] ?? 5,
            pinLockoutMinutes: byKey['auth.pin_lockout_minutes'] ?? 15,
        };
    }

    async function checkOtpQuota({phoneNumber, ipAddress, purpose}) {
        const {rows} = await query(pool, 'select * from otp_quota_check($1, $2::inet, $3)', [
            phoneNumber,
            ipAddress ?? null,
            purpose,
        ]);
        const row = rows[0] ?? {allowed: true};
        return {
            allowed: row.allowed,
            reason: row.reason,
            retryAfterSeconds: Number(row.retry_after_seconds ?? 0),
        };
    }

    async function logOtpRequest({phoneNumber, ipAddress, purpose, outcome, reason}) {
        await query(
            pool,
            `insert into otp_request_log (phone_number, ip_address, purpose, outcome, reason)
             values ($1, $2::inet, $3, $4, $5)`,
            [phoneNumber, ipAddress ?? null, purpose, outcome, reason ?? null]
        );
    }

    async function createChallenge({phoneNumber, purpose, codeHash, expiresAt, maxAttempts, ipAddress, userAgent}) {
        const {rows} = await query(
            pool,
            `insert into auth_otp_challenges
                 (phone_number, purpose, code_hash, expires_at, max_attempts, ip_address, user_agent)
             values ($1, $2, $3, $4, $5, $6::inet, $7)
             returning *`,
            [phoneNumber, purpose, codeHash, expiresAt, maxAttempts, ipAddress ?? null, userAgent ?? null]
        );
        return rows[0];
    }

    async function recordDelivery({challengeId, channel, provider, externalId, status, smsCount, rawPayload}) {
        await query(
            pool,
            `insert into external_notification_events
                 (otp_challenge_id, channel, provider, external_id, status, raw_payload)
             values ($1, $2, $3, $4, $5, coalesce($6::jsonb, '{}'::jsonb))`,
            [challengeId, channel, provider, externalId, status, rawPayload ? JSON.stringify(rawPayload) : null]
        );
        await query(pool, 'update auth_otp_challenges set delivery_status = $2, sms_count = $3 where id = $1', [
            challengeId,
            status,
            smsCount ?? 1,
        ]);
    }

    async function findChallenge(id) {
        const {rows} = await query(pool, 'select * from auth_otp_challenges where id = $1', [id]);
        return rows[0] ?? null;
    }

    async function incrementAttempts(id) {
        const {rows} = await query(
            pool,
            'update auth_otp_challenges set attempts = attempts + 1 where id = $1 returning attempts',
            [id]
        );
        return rows[0]?.attempts ?? 0;
    }

    async function consumeChallenge(id) {
        await query(pool, 'update auth_otp_challenges set consumed_at = now() where id = $1', [id]);
    }

    async function findUserByPhone(phoneNumber) {
        const {rows} = await query(pool, 'select * from users where phone_number = $1', [phoneNumber]);
        return rows[0] ?? null;
    }

    async function findUserById(id) {
        const {rows} = await query(pool, 'select * from users where id = $1', [id]);
        return rows[0] ?? null;
    }

    /**
     * Proving the phone is also what creates the account on first use — a
     * customer who just entered a real code should not then meet a separate
     * "now register" step.
     */
    async function markPhoneVerified(phoneNumber) {
        return withActor(pool, phoneNumber, async (client) => {
            const {rows: existing} = await client.query('select id from users where phone_number = $1', [
                phoneNumber,
            ]);
            if (existing.length === 0) {
                const {rows} = await client.query(
                    `insert into users (phone_number, role, status, phone_verified_at)
                     values ($1, 'customer', 'active', now())
                     returning *`,
                    [phoneNumber]
                );
                return rows[0];
            }
            const {rows} = await client.query(
                'update users set phone_verified_at = now() where phone_number = $1 returning *',
                [phoneNumber]
            );
            return rows[0];
        });
    }

    async function setPinHash(userId, pinHash) {
        return withActor(pool, userId, async (client) => {
            const {rows} = await client.query(
                'update users set pin_hash = $2 where id = $1 returning *',
                [userId, pinHash]
            );
            return rows[0];
        });
    }

    /**
     * Counts a wrong PIN and locks the account once the limit is reached. Done
     * in one statement so two simultaneous guesses cannot both see "4 attempts"
     * and let a fifth through.
     */
    async function registerPinFailure(userId) {
        const settings = await otpSettings();
        const {rows} = await query(
            pool,
            `update users
                set pin_failed_attempts = pin_failed_attempts + 1,
                    pin_locked_until = case
                        when pin_failed_attempts + 1 >= $2
                        then now() + make_interval(mins => $3)
                        else pin_locked_until
                    end
              where id = $1
              returning pin_failed_attempts, pin_locked_until`,
            [userId, settings.pinMaxAttempts, settings.pinLockoutMinutes]
        );
        const row = rows[0];
        return {
            attempts: row?.pin_failed_attempts ?? 0,
            locked: Boolean(row?.pin_locked_until),
            lockedUntil: row?.pin_locked_until ?? null,
        };
    }

    async function clearPinFailures(userId) {
        const {rows} = await query(
            pool,
            `update users
                set pin_failed_attempts = 0, pin_locked_until = null, last_login_at = now()
              where id = $1
              returning *`,
            [userId]
        );
        return rows[0];
    }

    async function completeOnboarding(userId, {fullName, email, preferredLanguage}) {
        return withActor(pool, userId, async (client) => {
            const {rows} = await client.query(
                `update users
                    set full_name = $2,
                        email = coalesce($3, email),
                        preferred_language = $4,
                        onboarding_completed_at = coalesce(onboarding_completed_at, now())
                  where id = $1
                  returning *`,
                [userId, fullName, email, preferredLanguage]
            );
            return rows[0];
        });
    }

    return {
        otpSettings,
        checkOtpQuota,
        logOtpRequest,
        createChallenge,
        recordDelivery,
        findChallenge,
        incrementAttempts,
        consumeChallenge,
        findUserByPhone,
        findUserById,
        markPhoneVerified,
        setPinHash,
        registerPinFailure,
        clearPinFailures,
        completeOnboarding,
        publicUser,
    };
}
