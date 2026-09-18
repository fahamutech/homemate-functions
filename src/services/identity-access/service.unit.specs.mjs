import {test, describe, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {createIdentityAccessService} from './service.mjs';
import {createSandboxNotificationAdapter} from './adapters/sandbox-notification.adapter.mjs';
import {createSessionTokenService} from '../../shared/session-tokens.mjs';
import {IdentityAccessError, IdentityAccessErrorCodes} from './ports.mjs';

/**
 * In-memory fake standing in for repository.mjs. Same function signatures
 * (db first, then args) but backed by plain arrays — no Postgres involved.
 * This is what makes service.mjs's business logic fast and fully unit
 * testable in isolation from the database (IMPLEMENTATION_PLAN.md Section
 * 2.1's "easy mocking" requirement, applied to our own repository layer
 * too, not just external ports).
 */
function createFakeRepository() {
    const challenges = new Map();
    const usersByPhone = new Map();
    let nextChallengeId = 1;
    let nextUserId = 1;

    return {
        async createOtpChallenge(_db, {phoneNumber, purpose, codeHash, expiresAt, maxAttempts}) {
            const challenge = {
                id: `challenge-${nextChallengeId++}`,
                phone_number: phoneNumber,
                purpose,
                code_hash: codeHash,
                expires_at: expiresAt,
                attempts: 0,
                max_attempts: maxAttempts,
                consumed_at: null,
            };
            challenges.set(challenge.id, challenge);
            return challenge;
        },
        async findOtpChallengeById(_db, id) {
            return challenges.get(id) ?? null;
        },
        async incrementOtpChallengeAttempts(_db, id) {
            const challenge = challenges.get(id);
            if (challenge) challenge.attempts += 1;
        },
        async markOtpChallengeConsumed(_db, id) {
            const challenge = challenges.get(id);
            if (challenge) challenge.consumed_at = new Date().toISOString();
        },
        async recordExternalNotificationEvent() {
            // not asserted on directly in these unit tests; covered by the
            // e2e journey test and repository.integration.specs.mjs.
        },
        async findUserByPhoneNumber(_db, phoneNumber) {
            return usersByPhone.get(phoneNumber) ?? null;
        },
        async createUser(_db, {phoneNumber}) {
            const user = {id: `user-${nextUserId++}`, phone_number: phoneNumber, display_name: null, status: 'active'};
            usersByPhone.set(phoneNumber, user);
            return user;
        },
        async findUserById(_db, id) {
            return [...usersByPhone.values()].find(u => u.id === id) ?? null;
        },
        _challenges: challenges,
    };
}

describe('identity-access service — phone OTP login journey', () => {
    /** @type {ReturnType<typeof createIdentityAccessService>} */
    let service;
    let repository;
    let notificationPort;
    let sessionTokens;
    let clockNow;

    beforeEach(() => {
        repository = createFakeRepository();
        notificationPort = createSandboxNotificationAdapter();
        sessionTokens = createSessionTokenService('unit-test-secret');
        clockNow = new Date('2026-01-01T00:00:00.000Z');
        service = createIdentityAccessService({
            db: {},
            repository,
            notificationPort,
            sessionTokens,
            now: () => clockNow,
            generateOtpCode: () => '123456',
        });
    });

    test('requestOtp rejects a malformed phone number without touching the notification port', async () => {
        await assert.rejects(
            () => service.requestOtp({phoneNumber: '0712345'}),
            (err) => {
                assert.ok(err instanceof IdentityAccessError);
                assert.equal(err.code, IdentityAccessErrorCodes.INVALID_PHONE_NUMBER);
                return true;
            }
        );
        assert.equal(notificationPort.sentMessages.length, 0);
    });

    test('requestOtp sends exactly one OTP and never returns the code', async () => {
        const result = await service.requestOtp({phoneNumber: '+255712345678'});

        assert.equal(notificationPort.sentMessages.length, 1);
        assert.equal(notificationPort.sentMessages[0].to, '+255712345678');
        assert.equal(notificationPort.sentMessages[0].params.code, '123456');

        assert.ok(result.challengeId);
        assert.ok(result.expiresAt);
        assert.equal(JSON.stringify(result).includes('123456'), false);
    });

    test('verifyOtp with the correct code creates a new user and issues a valid session token', async () => {
        const {challengeId} = await service.requestOtp({phoneNumber: '+255712345678'});

        const result = await service.verifyOtp({challengeId, code: '123456'});

        assert.equal(result.user.phone_number, '+255712345678');
        const decoded = sessionTokens.verify(result.token);
        assert.ok(decoded);
        assert.equal(decoded.userId, result.user.id);
        assert.equal(decoded.phoneNumber, '+255712345678');
    });

    test('verifyOtp reuses the existing user on a second login instead of creating a duplicate', async () => {
        const first = await service.requestOtp({phoneNumber: '+255712345678'});
        const {user: firstUser} = await service.verifyOtp({challengeId: first.challengeId, code: '123456'});

        const second = await service.requestOtp({phoneNumber: '+255712345678'});
        const {user: secondUser} = await service.verifyOtp({challengeId: second.challengeId, code: '123456'});

        assert.equal(secondUser.id, firstUser.id);
    });

    test('verifyOtp with the wrong code increments attempts and rejects with INVALID_CODE', async () => {
        const {challengeId} = await service.requestOtp({phoneNumber: '+255712345678'});

        await assert.rejects(
            () => service.verifyOtp({challengeId, code: '000000'}),
            (err) => {
                assert.equal(err.code, IdentityAccessErrorCodes.INVALID_CODE);
                return true;
            }
        );
        assert.equal(repository._challenges.get(challengeId).attempts, 1);

        // the correct code still works afterwards, since attempts < maxAttempts
        const result = await service.verifyOtp({challengeId, code: '123456'});
        assert.ok(result.token);
    });

    test('verifyOtp rejects an unknown challengeId with CHALLENGE_NOT_FOUND', async () => {
        await assert.rejects(
            () => service.verifyOtp({challengeId: 'does-not-exist', code: '123456'}),
            (err) => {
                assert.equal(err.code, IdentityAccessErrorCodes.CHALLENGE_NOT_FOUND);
                return true;
            }
        );
    });

    test('verifyOtp rejects reuse of an already-consumed challenge', async () => {
        const {challengeId} = await service.requestOtp({phoneNumber: '+255712345678'});
        await service.verifyOtp({challengeId, code: '123456'});

        await assert.rejects(
            () => service.verifyOtp({challengeId, code: '123456'}),
            (err) => {
                assert.equal(err.code, IdentityAccessErrorCodes.CHALLENGE_ALREADY_USED);
                return true;
            }
        );
    });

    test('verifyOtp rejects an expired challenge', async () => {
        const {challengeId} = await service.requestOtp({phoneNumber: '+255712345678'});
        clockNow = new Date('2026-01-01T01:00:00.000Z'); // 1 hour later, past the 5-minute expiry

        await assert.rejects(
            () => service.verifyOtp({challengeId, code: '123456'}),
            (err) => {
                assert.equal(err.code, IdentityAccessErrorCodes.CHALLENGE_EXPIRED);
                return true;
            }
        );
    });

    test('getUserById returns the user created by a prior verifyOtp', async () => {
        const {challengeId} = await service.requestOtp({phoneNumber: '+255712345678'});
        const {user} = await service.verifyOtp({challengeId, code: '123456'});

        const found = await service.getUserById({userId: user.id});
        assert.equal(found.id, user.id);
        assert.equal(found.phone_number, '+255712345678');
    });

    test('getUserById rejects an unknown userId with USER_NOT_FOUND', async () => {
        await assert.rejects(
            () => service.getUserById({userId: 'does-not-exist'}),
            (err) => {
                assert.equal(err.code, IdentityAccessErrorCodes.USER_NOT_FOUND);
                return true;
            }
        );
    });

    test('verifyOtp locks out a challenge after too many wrong attempts, even with the right code', async () => {
        const {challengeId} = await service.requestOtp({phoneNumber: '+255712345678'});

        for (let i = 0; i < 5; i++) {
            await assert.rejects(() => service.verifyOtp({challengeId, code: '000000'}));
        }

        await assert.rejects(
            () => service.verifyOtp({challengeId, code: '123456'}),
            (err) => {
                assert.equal(err.code, IdentityAccessErrorCodes.CHALLENGE_LOCKED);
                return true;
            }
        );
    });
});
