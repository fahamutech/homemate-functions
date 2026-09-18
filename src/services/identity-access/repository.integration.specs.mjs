import {test, describe, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import * as repository from './repository.mjs';

/**
 * Integration tests for the raw SQL in repository.mjs, run against the real
 * `homemate_test` Postgres database (DATABASE_URL from .env.test). These
 * exist precisely because service.unit.specs.mjs fakes this module out —
 * something has to prove the SQL itself is correct against a real schema.
 */
describe('identity-access repository (Postgres integration)', () => {
    /** @type {pg.Client} */
    let db;

    before(async () => {
        db = new pg.Client({connectionString: process.env.DATABASE_URL});
        await db.connect();
    });

    after(async () => {
        await db.end();
    });

    beforeEach(async () => {
        await db.query('truncate table external_notification_events, auth_otp_challenges, users cascade');
    });

    test('createOtpChallenge + findOtpChallengeById round-trip', async () => {
        const created = await repository.createOtpChallenge(db, {
            phoneNumber: '+255712345678',
            purpose: 'login',
            codeHash: 'hash-1',
            expiresAt: new Date(Date.now() + 5 * 60 * 1000),
            maxAttempts: 5,
        });

        const found = await repository.findOtpChallengeById(db, created.id);
        assert.equal(found.phone_number, '+255712345678');
        assert.equal(found.code_hash, 'hash-1');
        assert.equal(found.attempts, 0);
        assert.equal(found.consumed_at, null);
    });

    test('incrementOtpChallengeAttempts and markOtpChallengeConsumed mutate the right row', async () => {
        const created = await repository.createOtpChallenge(db, {
            phoneNumber: '+255712345678',
            purpose: 'login',
            codeHash: 'hash-1',
            expiresAt: new Date(Date.now() + 5 * 60 * 1000),
            maxAttempts: 5,
        });

        await repository.incrementOtpChallengeAttempts(db, created.id);
        await repository.incrementOtpChallengeAttempts(db, created.id);
        let found = await repository.findOtpChallengeById(db, created.id);
        assert.equal(found.attempts, 2);

        await repository.markOtpChallengeConsumed(db, created.id);
        found = await repository.findOtpChallengeById(db, created.id);
        assert.ok(found.consumed_at);
    });

    test('recordExternalNotificationEvent links back to its challenge', async () => {
        const challenge = await repository.createOtpChallenge(db, {
            phoneNumber: '+255712345678',
            purpose: 'login',
            codeHash: 'hash-1',
            expiresAt: new Date(Date.now() + 5 * 60 * 1000),
            maxAttempts: 5,
        });

        await repository.recordExternalNotificationEvent(db, {
            otpChallengeId: challenge.id,
            channel: 'sms',
            provider: 'sandbox',
            externalId: 'sandbox-1',
            status: 'delivered',
            rawPayload: {to: '+255712345678'},
        });

        const {rows} = await db.query(
            'select * from external_notification_events where otp_challenge_id = $1',
            [challenge.id]
        );
        assert.equal(rows.length, 1);
        assert.equal(rows[0].provider, 'sandbox');
        assert.deepEqual(rows[0].raw_payload, {to: '+255712345678'});
    });

    test('findUserByPhoneNumber / createUser / findUserById', async () => {
        assert.equal(await repository.findUserByPhoneNumber(db, '+255712345678'), null);

        const created = await repository.createUser(db, {phoneNumber: '+255712345678'});
        assert.equal(created.phone_number, '+255712345678');
        assert.equal(created.status, 'active');

        const byPhone = await repository.findUserByPhoneNumber(db, '+255712345678');
        assert.equal(byPhone.id, created.id);

        const byId = await repository.findUserById(db, created.id);
        assert.equal(byId.id, created.id);
    });

    test('users.phone_number is unique', async () => {
        await repository.createUser(db, {phoneNumber: '+255712345678'});
        await assert.rejects(() => repository.createUser(db, {phoneNumber: '+255712345678'}));
    });
});
