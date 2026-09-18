/**
 * Raw parameterized SQL for the identity-access module's HomeMate entities
 * (users, auth_otp_challenges) and the external mirror table
 * (external_notification_events). No ORM, per Agent.md.
 *
 * Every function takes `db` (anything with a pg-Pool-shaped `.query(text,
 * params)`) as its first argument instead of importing a shared pool
 * directly — this is what lets service.unit.specs.mjs test business logic
 * against a fake in-memory db with no real Postgres involved.
 */

export async function createOtpChallenge(db, {phoneNumber, purpose, codeHash, expiresAt, maxAttempts}) {
    const {rows} = await db.query(
        `insert into auth_otp_challenges
            (phone_number, purpose, code_hash, expires_at, max_attempts)
         values ($1, $2, $3, $4, $5)
         returning id, phone_number, purpose, code_hash, expires_at, attempts, max_attempts, consumed_at, created_at`,
        [phoneNumber, purpose, codeHash, expiresAt, maxAttempts]
    );
    return rows[0];
}

export async function findOtpChallengeById(db, id) {
    const {rows} = await db.query(
        `select id, phone_number, purpose, code_hash, expires_at, attempts, max_attempts, consumed_at, created_at
         from auth_otp_challenges
         where id = $1`,
        [id]
    );
    return rows[0] ?? null;
}

export async function incrementOtpChallengeAttempts(db, id) {
    await db.query(
        `update auth_otp_challenges set attempts = attempts + 1 where id = $1`,
        [id]
    );
}

export async function markOtpChallengeConsumed(db, id) {
    await db.query(
        `update auth_otp_challenges set consumed_at = now() where id = $1`,
        [id]
    );
}

export async function recordExternalNotificationEvent(db, {otpChallengeId, channel, provider, externalId, status, rawPayload}) {
    await db.query(
        `insert into external_notification_events
            (otp_challenge_id, channel, provider, external_id, status, raw_payload)
         values ($1, $2, $3, $4, $5, $6)`,
        [otpChallengeId, channel, provider, externalId, status, rawPayload]
    );
}

export async function findUserByPhoneNumber(db, phoneNumber) {
    const {rows} = await db.query(
        `select id, phone_number, display_name, status, created_at, updated_at
         from users
         where phone_number = $1`,
        [phoneNumber]
    );
    return rows[0] ?? null;
}

export async function createUser(db, {phoneNumber}) {
    const {rows} = await db.query(
        `insert into users (phone_number)
         values ($1)
         returning id, phone_number, display_name, status, created_at, updated_at`,
        [phoneNumber]
    );
    return rows[0];
}

export async function findUserById(db, id) {
    const {rows} = await db.query(
        `select id, phone_number, display_name, status, created_at, updated_at
         from users
         where id = $1`,
        [id]
    );
    return rows[0] ?? null;
}
