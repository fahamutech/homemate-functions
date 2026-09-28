import {test, describe, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {createCustomerAccessService} from './service.mjs';
import {createSessionTokenService} from '../../shared/session-tokens.mjs';
import {publicUser} from './repository.mjs';

/**
 * The auth rules, against a fake repository. These are decisions the service
 * itself makes — what counts as an acceptable PIN, what a wrong code costs,
 * what a login failure is allowed to reveal — so they are tested without a
 * database. The quota arithmetic is the database's job and is covered by the
 * integration spec instead.
 */

const PHONE = '+255712345678';

function makeRepository(overrides = {}) {
    const state = {
        users: new Map(),
        challenges: new Map(),
        quotaAllowed: true,
        quotaReason: null,
        logged: [],
        deliveries: [],
        sequence: 0,
        // user_roles, keyed by user id: what migration 027 keeps per person.
        roles: new Map(),
    };

    const repository = {
        state,
        publicUser,
        async otpSettings() {
            return {ttlSeconds: 300, maxAttempts: 5, resendCooldownSeconds: 60, pinMaxAttempts: 5, pinLockoutMinutes: 15};
        },
        async checkOtpQuota() {
            return {allowed: state.quotaAllowed, reason: state.quotaReason, retryAfterSeconds: 42};
        },
        async logOtpRequest(entry) {
            state.logged.push(entry);
        },
        async createChallenge(input) {
            const id = `ch-${++state.sequence}`;
            const row = {
                id,
                phone_number: input.phoneNumber,
                purpose: input.purpose,
                code_hash: input.codeHash,
                expires_at: input.expiresAt,
                max_attempts: input.maxAttempts,
                attempts: 0,
                consumed_at: null,
            };
            state.challenges.set(id, row);
            return row;
        },
        async recordDelivery(entry) {
            state.deliveries.push(entry);
        },
        async findChallenge(id) {
            return state.challenges.get(id) ?? null;
        },
        async incrementAttempts(id) {
            const row = state.challenges.get(id);
            row.attempts += 1;
            return row.attempts;
        },
        async consumeChallenge(id) {
            state.challenges.get(id).consumed_at = new Date();
        },
        async findUserByPhone(phone) {
            return [...state.users.values()].find((u) => u.phone_number === phone) ?? null;
        },
        async findUserById(id) {
            return state.users.get(id) ?? null;
        },
        async markPhoneVerified(phone) {
            let user = [...state.users.values()].find((u) => u.phone_number === phone);
            if (!user) {
                user = {
                    id: `user-${++state.sequence}`,
                    phone_number: phone,
                    role: 'customer',
                    status: 'active',
                    pin_hash: null,
                    pin_failed_attempts: 0,
                    pin_locked_until: null,
                    onboarding_completed_at: null,
                    last_active_role: null,
                    created_at: new Date(),
                };
                state.users.set(user.id, user);
                // The database trigger in 027 gives every new platform user
                // an active customer role; the fake does the same.
                state.roles.set(user.id, [{role: 'customer', status: 'active'}]);
            }
            user.phone_verified_at = new Date();
            return user;
        },
        async setPinHash(userId, hash) {
            const user = state.users.get(userId);
            user.pin_hash = hash;
            user.pin_failed_attempts = 0;
            user.pin_locked_until = null;
            return user;
        },
        async registerPinFailure(userId) {
            const user = state.users.get(userId);
            user.pin_failed_attempts += 1;
            if (user.pin_failed_attempts >= 5) {
                user.pin_locked_until = new Date(Date.now() + 15 * 60 * 1000);
            }
            return {
                attempts: user.pin_failed_attempts,
                locked: Boolean(user.pin_locked_until),
                lockedUntil: user.pin_locked_until,
            };
        },
        async clearPinFailures(userId) {
            const user = state.users.get(userId);
            user.pin_failed_attempts = 0;
            user.pin_locked_until = null;
            return user;
        },
        async completeOnboarding(userId, patch) {
            const user = state.users.get(userId);
            Object.assign(user, {
                full_name: patch.fullName,
                email: patch.email,
                preferred_language: patch.preferredLanguage,
                onboarding_completed_at: new Date(),
            });
            return user;
        },
        async findUserRoles(userId) {
            return state.roles.get(userId) ?? [];
        },
        async setLastActiveRole(userId, role) {
            const user = state.users.get(userId);
            user.last_active_role = role;
            return user;
        },
        ...overrides,
    };
    return repository;
}

function makeNotifications() {
    const sent = [];
    return {
        sent,
        async send(message) {
            sent.push(message);
            return {provider: 'fake', externalId: `x${sent.length}`, status: 'sent', smsCount: 1, raw: {}};
        },
    };
}

function build(overrides = {}) {
    const repository = overrides.repository ?? makeRepository();
    const notificationPort = overrides.notificationPort ?? makeNotifications();
    const sessionTokens = createSessionTokenService('unit-test-secret');
    const service = createCustomerAccessService({
        repository,
        notificationPort,
        sessionTokens,
        generateCode: () => '123456',
        ...overrides,
    });
    return {service, repository, notificationPort, sessionTokens};
}

async function verifiedToken(service, {purpose = 'login'} = {}) {
    const {challengeId} = await service.requestOtp({phoneNumber: PHONE, purpose});
    const {verificationToken} = await service.verifyOtp({challengeId, code: '123456'});
    return verificationToken;
}

describe('customer access', () => {
    describe('requesting a code', () => {
        test('sends one and says when another may be asked for', async () => {
            const {service, notificationPort, repository} = build();

            const result = await service.requestOtp({phoneNumber: PHONE, ipAddress: '127.0.0.1'});

            assert.ok(result.challengeId);
            assert.equal(result.resendAfterSeconds, 60);
            assert.equal(notificationPort.sent.length, 1);
            assert.equal(notificationPort.sent[0].to, PHONE);
            assert.equal(notificationPort.sent[0].params.code, '123456');
            assert.deepEqual(
                repository.state.logged.map((l) => l.outcome),
                ['sent']
            );
        });

        test('refuses a number that is not Tanzanian mobile format', async () => {
            const {service, notificationPort} = build();
            for (const bad of ['0712345678', '+254712345678', '+2557123', 'not a number', '']) {
                await assert.rejects(
                    service.requestOtp({phoneNumber: bad}),
                    (error) => error.code === 'VALIDATION_FAILED'
                );
            }
            assert.equal(notificationPort.sent.length, 0, 'no credit should be spent on a malformed number');
        });

        test('a throttled request spends no SMS and says how long to wait', async () => {
            const repository = makeRepository();
            repository.state.quotaAllowed = false;
            repository.state.quotaReason = 'Please wait before asking for another code';
            const {service, notificationPort} = build({repository});

            await assert.rejects(
                service.requestOtp({phoneNumber: PHONE}),
                (error) => {
                    assert.equal(error.code, 'RATE_LIMITED');
                    assert.equal(error.status, 429);
                    assert.equal(error.retryAfterSeconds, 42);
                    return true;
                }
            );

            assert.equal(notificationPort.sent.length, 0);
            // The refusal is recorded — a spike is only visible if misses count.
            assert.deepEqual(repository.state.logged.map((l) => l.outcome), ['throttled']);
        });

        test('a reset for an unknown number looks identical but spends nothing', async () => {
            const {service, notificationPort} = build();

            const result = await service.requestOtp({phoneNumber: PHONE, purpose: 'reset_pin'});

            // No error, no challenge, no SMS: the caller cannot tell whether
            // that number is registered.
            assert.equal(result.challengeId, null);
            assert.equal(notificationPort.sent.length, 0);
        });

        test('a provider failure is reported without leaking vendor detail', async () => {
            const notificationPort = {
                async send() {
                    throw new Error('ECONNREFUSED messaging-service.co.tz');
                },
            };
            const repository = makeRepository();
            const {service} = build({repository, notificationPort});

            await assert.rejects(service.requestOtp({phoneNumber: PHONE}), (error) => {
                assert.equal(error.status, 502);
                assert.doesNotMatch(error.message, /ECONNREFUSED|messaging-service/);
                return true;
            });
            assert.deepEqual(repository.state.logged.map((l) => l.outcome), ['failed']);
        });

        test('the review number gets its fixed code, and no SMS is sent', async () => {
            const repository = makeRepository();
            const {service, notificationPort} = build({
                repository,
                reviewAccount: {phoneNumber: PHONE, code: '246810'},
            });

            const {challengeId} = await service.requestOtp({phoneNumber: PHONE});

            assert.equal(notificationPort.sent.length, 0, 'a reviewer has no SIM to send to');
            // The fixed code works, and the random one does not — the challenge
            // really was created with the configured code.
            await assert.rejects(service.verifyOtp({challengeId, code: '123456'}));
            const {challengeId: second} = await service.requestOtp({phoneNumber: PHONE});
            const result = await service.verifyOtp({challengeId: second, code: '246810'});
            assert.ok(result.verificationToken);
        });

        test('the review number is not throttled, but every other number still is', async () => {
            const repository = makeRepository();
            repository.state.quotaAllowed = false;
            repository.state.quotaReason = 'Please wait before asking for another code';
            const {service} = build({repository, reviewAccount: {phoneNumber: PHONE, code: '246810'}});

            const result = await service.requestOtp({phoneNumber: PHONE});
            assert.ok(result.challengeId);

            await assert.rejects(
                service.requestOtp({phoneNumber: '+255754000111'}),
                (error) => error.code === 'RATE_LIMITED'
            );
        });

        test('with no review account configured, that number behaves like any other', async () => {
            const {service, notificationPort} = build();

            await service.requestOtp({phoneNumber: PHONE});

            assert.equal(notificationPort.sent.length, 1);
            assert.equal(notificationPort.sent[0].params.code, '123456');
        });
    });

    describe('verifying a code', () => {
        test('proves the phone but does not hand out a session', async () => {
            const {service} = build();
            const {challengeId} = await service.requestOtp({phoneNumber: PHONE});

            const result = await service.verifyOtp({challengeId, code: '123456'});

            assert.ok(result.verificationToken);
            assert.equal(result.token, undefined, 'verifying must not sign anyone in');
            assert.equal(result.hasPin, false);
            assert.equal(result.user.phoneNumber, PHONE);
        });

        test('counts down the remaining tries on a wrong code', async () => {
            const {service} = build();
            const {challengeId} = await service.requestOtp({phoneNumber: PHONE});

            await assert.rejects(
                service.verifyOtp({challengeId, code: '000000'}),
                (error) => /4 tries left/.test(error.message)
            );
            await assert.rejects(
                service.verifyOtp({challengeId, code: '000000'}),
                (error) => /3 tries left/.test(error.message)
            );
        });

        test('locks the code after too many wrong attempts', async () => {
            const {service} = build();
            const {challengeId} = await service.requestOtp({phoneNumber: PHONE});

            for (let i = 0; i < 5; i += 1) {
                await assert.rejects(service.verifyOtp({challengeId, code: '000000'}));
            }
            // Even the right code is no good now — a locked challenge is spent.
            await assert.rejects(
                service.verifyOtp({challengeId, code: '123456'}),
                (error) => /request a new code/.test(error.message)
            );
        });

        test('a code cannot be used twice', async () => {
            const {service} = build();
            const {challengeId} = await service.requestOtp({phoneNumber: PHONE});
            await service.verifyOtp({challengeId, code: '123456'});

            await assert.rejects(
                service.verifyOtp({challengeId, code: '123456'}),
                (error) => /already been used/.test(error.message)
            );
        });

        test('an expired code is refused', async () => {
            let clock = new Date('2026-09-18T10:00:00Z');
            const {service} = build({now: () => clock});
            const {challengeId} = await service.requestOtp({phoneNumber: PHONE});

            clock = new Date('2026-09-18T10:06:00Z');
            await assert.rejects(
                service.verifyOtp({challengeId, code: '123456'}),
                (error) => /expired/.test(error.message)
            );
        });
    });

    describe('setting and using a PIN', () => {
        test('a verified phone sets a PIN and gets a session', async () => {
            const {service} = build();
            const verificationToken = await verifiedToken(service);

            const result = await service.setPin({verificationToken, pin: '4820', confirmPin: '4820'});

            assert.ok(result.token);
            assert.equal(result.user.hasPin, true);
            assert.equal(result.user.phoneNumber, PHONE);
        });

        test('a PIN cannot be set without having proved the phone', async () => {
            const {service, sessionTokens} = build();
            // A perfectly valid *session* token is still not a verification.
            const sessionToken = sessionTokens.sign({userId: 'user-1', role: 'customer'});

            await assert.rejects(
                service.setPin({verificationToken: sessionToken, pin: '4820'}),
                (error) => error.code === 'UNAUTHORIZED'
            );
            await assert.rejects(
                service.setPin({verificationToken: 'nonsense', pin: '4820'}),
                (error) => error.code === 'UNAUTHORIZED'
            );
        });

        test('refuses predictable and malformed PINs', async () => {
            const {service} = build();
            const verificationToken = await verifiedToken(service);

            for (const bad of ['1234', '0000', '1111', '4321', '123456']) {
                await assert.rejects(
                    service.setPin({verificationToken, pin: bad}),
                    (error) => /predictable/.test(error.message),
                    `expected ${bad} to be refused as predictable`
                );
            }
            for (const bad of ['12', '1234567', 'abcd', '']) {
                await assert.rejects(
                    service.setPin({verificationToken, pin: bad}),
                    (error) => /4 to 6 digits/.test(error.message),
                    `expected ${bad} to be refused as malformed`
                );
            }
        });

        test('refuses a confirmation that does not match', async () => {
            const {service} = build();
            const verificationToken = await verifiedToken(service);

            await assert.rejects(
                service.setPin({verificationToken, pin: '4820', confirmPin: '4821'}),
                (error) => /do not match/.test(error.message)
            );
        });

        test('signs in with the PIN, and no SMS is sent to do it', async () => {
            const {service, notificationPort} = build();
            const verificationToken = await verifiedToken(service);
            await service.setPin({verificationToken, pin: '4820'});
            const before = notificationPort.sent.length;

            const session = await service.loginWithPin({phoneNumber: PHONE, pin: '4820'});

            assert.ok(session.token);
            assert.equal(notificationPort.sent.length, before, 'logging in must not cost an SMS');
        });

        test('a wrong PIN and an unknown number are indistinguishable', async () => {
            const {service} = build();
            const verificationToken = await verifiedToken(service);
            await service.setPin({verificationToken, pin: '4820'});

            const wrongPin = await service
                .loginWithPin({phoneNumber: PHONE, pin: '9999'})
                .catch((error) => error);
            const unknownNumber = await service
                .loginWithPin({phoneNumber: '+255799999999', pin: '4820'})
                .catch((error) => error);

            assert.equal(wrongPin.message, unknownNumber.message);
            assert.equal(wrongPin.status, unknownNumber.status);
        });

        test('locks the account after repeated wrong PINs', async () => {
            const {service} = build();
            const verificationToken = await verifiedToken(service);
            await service.setPin({verificationToken, pin: '4820'});

            for (let i = 0; i < 4; i += 1) {
                await assert.rejects(service.loginWithPin({phoneNumber: PHONE, pin: '9999'}));
            }
            await assert.rejects(
                service.loginWithPin({phoneNumber: PHONE, pin: '9999'}),
                (error) => {
                    assert.equal(error.code, 'RATE_LIMITED');
                    assert.ok(error.retryAfterSeconds > 0);
                    return true;
                }
            );
            // Even the right PIN waits out the lock.
            await assert.rejects(
                service.loginWithPin({phoneNumber: PHONE, pin: '4820'}),
                (error) => error.code === 'RATE_LIMITED'
            );
        });

        test('a successful login clears the failure count', async () => {
            const {service, repository} = build();
            const verificationToken = await verifiedToken(service);
            const {user} = await service.setPin({verificationToken, pin: '4820'});

            await assert.rejects(service.loginWithPin({phoneNumber: PHONE, pin: '9999'}));
            await service.loginWithPin({phoneNumber: PHONE, pin: '4820'});

            assert.equal(repository.state.users.get(user.id).pin_failed_attempts, 0);
        });

        test('a suspended account cannot sign in even with the right PIN', async () => {
            const {service, repository} = build();
            const verificationToken = await verifiedToken(service);
            const {user} = await service.setPin({verificationToken, pin: '4820'});
            repository.state.users.get(user.id).status = 'suspended';

            await assert.rejects(
                service.loginWithPin({phoneNumber: PHONE, pin: '4820'}),
                (error) => error.code === 'FORBIDDEN'
            );
        });
    });

    describe('forgetting and changing a PIN', () => {
        test('a reset needs a code issued for a reset, not just any code', async () => {
            const {service} = build();
            const loginToken = await verifiedToken(service, {purpose: 'login'});

            await assert.rejects(
                service.resetPin({verificationToken: loginToken, pin: '4820'}),
                (error) => /was for something else/.test(error.message)
            );
        });

        test('resets the PIN and signs in with the new one', async () => {
            const {service, repository} = build();
            const first = await verifiedToken(service);
            await service.setPin({verificationToken: first, pin: '4820'});

            // The account now exists, so a reset code is genuinely sent.
            const {challengeId} = await service.requestOtp({phoneNumber: PHONE, purpose: 'reset_pin'});
            const {verificationToken} = await service.verifyOtp({challengeId, code: '123456'});
            await service.resetPin({verificationToken, pin: '5731'});

            await assert.rejects(service.loginWithPin({phoneNumber: PHONE, pin: '4820'}));
            assert.ok((await service.loginWithPin({phoneNumber: PHONE, pin: '5731'})).token);
            assert.equal(repository.state.logged.filter((l) => l.outcome === 'sent').length, 2);
        });

        test('changing a PIN in the app requires the current one', async () => {
            const {service} = build();
            const verificationToken = await verifiedToken(service);
            const {user} = await service.setPin({verificationToken, pin: '4820'});

            await assert.rejects(
                service.changePin({userId: user.id, currentPin: '0000', pin: '5731'}),
                (error) => error.code === 'UNAUTHORIZED'
            );

            await service.changePin({userId: user.id, currentPin: '4820', pin: '5731'});
            assert.ok((await service.loginWithPin({phoneNumber: PHONE, pin: '5731'})).token);
        });
    });

    describe('onboarding profile', () => {
        test('records the name and language and marks onboarding done', async () => {
            const {service} = build();
            const verificationToken = await verifiedToken(service);
            const {user} = await service.setPin({verificationToken, pin: '4820'});

            const profile = await service.completeProfile({
                userId: user.id,
                fullName: '  Neema Kileo  ',
                email: 'neema@example.com',
                preferredLanguage: 'sw',
            });

            assert.equal(profile.fullName, 'Neema Kileo');
            assert.equal(profile.preferredLanguage, 'sw');
            assert.equal(profile.onboardingComplete, true);
        });

        test('needs a name', async () => {
            const {service} = build();
            const verificationToken = await verifiedToken(service);
            const {user} = await service.setPin({verificationToken, pin: '4820'});

            await assert.rejects(
                service.completeProfile({userId: user.id, fullName: '   '}),
                (error) => /enter your name/.test(error.message)
            );
        });
    });

    test('a PIN hash never leaves the service', async () => {
        const {service} = build();
        const verificationToken = await verifiedToken(service);
        const {user} = await service.setPin({verificationToken, pin: '4820'});
        const session = await service.loginWithPin({phoneNumber: PHONE, pin: '4820'});

        for (const shape of [user, session.user, await service.me({userId: user.id})]) {
            assert.equal(shape.pin_hash, undefined);
            assert.equal(shape.pinHash, undefined);
            assert.equal(shape.hasPin, true, 'the app still needs to know a PIN exists');
        }
    });
});

describe('one account, many roles (T01)', () => {
    async function signedUp({roles = [], lastActiveRole = null} = {}) {
        const built = build();
        const verificationToken = await verifiedToken(built.service);
        const {user} = await built.service.setPin({verificationToken, pin: '4820'});
        const stored = built.repository.state.users.get(user.id);
        stored.last_active_role = lastActiveRole;
        built.repository.state.roles.set(user.id, [{role: 'customer', status: 'active'}, ...roles]);
        return {...built, userId: user.id};
    }

    describe('the session token', () => {
        test('a plain customer signs in as customer, with role kept for the current app', async () => {
            const {service, sessionTokens, userId} = await signedUp();

            const {token} = await service.loginWithPin({phoneNumber: PHONE, pin: '4820'});
            const claims = sessionTokens.verify(token);

            assert.equal(claims.userId, userId);
            assert.equal(claims.phoneNumber, PHONE);
            assert.equal(claims.role, 'customer');
            assert.deepEqual(claims.roles, ['customer']);
            assert.equal(claims.activeRole, 'customer');
        });

        test('a broker who last worked as a broker opens as a broker', async () => {
            const {service, sessionTokens} = await signedUp({
                roles: [{role: 'broker', status: 'active'}],
                lastActiveRole: 'broker',
            });

            const {token, activeRole, roles} = await service.loginWithPin({phoneNumber: PHONE, pin: '4820'});
            const claims = sessionTokens.verify(token);

            assert.deepEqual(claims.roles, ['customer', 'broker']);
            assert.equal(claims.activeRole, 'broker');
            assert.equal(activeRole, 'broker', 'the app reads the role to open without decoding the token');
            assert.deepEqual(roles, ['customer', 'broker']);
        });

        test('a broker whose role was suspended since last time opens as a customer', async () => {
            const {service, sessionTokens} = await signedUp({
                roles: [{role: 'broker', status: 'suspended'}],
                lastActiveRole: 'broker',
            });

            const {token} = await service.loginWithPin({phoneNumber: PHONE, pin: '4820'});
            const claims = sessionTokens.verify(token);

            assert.deepEqual(claims.roles, ['customer']);
            assert.equal(claims.activeRole, 'customer');
        });
    });

    describe('/app/me', () => {
        test('lists every role with its status, and the last role used', async () => {
            const {service, userId} = await signedUp({
                roles: [
                    {role: 'broker', status: 'active', activated_at: new Date('2026-09-01T00:00:00Z')},
                    {role: 'landlord', status: 'rejected', rejection_reason: 'Title deed unreadable'},
                ],
                lastActiveRole: 'broker',
            });

            const me = await service.me({userId});

            assert.equal(me.lastActiveRole, 'broker');
            assert.deepEqual(
                me.roles.map((r) => [r.role, r.status]),
                [['customer', 'active'], ['broker', 'active'], ['landlord', 'rejected']]
            );
            assert.equal(me.roles[2].rejectionReason, 'Title deed unreadable');
            assert.equal(me.hasPin, true, 'the existing profile fields are still there');
        });
    });

    describe('switching role', () => {
        test('switches to an active role, remembers it and returns a re-signed token', async () => {
            const {service, sessionTokens, repository, userId} = await signedUp({
                roles: [{role: 'landlord', status: 'active'}],
            });

            const result = await service.switchActiveRole({userId, role: 'landlord'});
            const claims = sessionTokens.verify(result.token);

            assert.equal(result.activeRole, 'landlord');
            assert.equal(claims.activeRole, 'landlord');
            assert.deepEqual(claims.roles, ['customer', 'landlord']);
            assert.equal(claims.role, 'customer');
            assert.equal(repository.state.users.get(userId).last_active_role, 'landlord');
        });

        test('switching back to customer is always allowed', async () => {
            const {service, userId, sessionTokens} = await signedUp({
                roles: [{role: 'broker', status: 'active'}],
                lastActiveRole: 'broker',
            });

            const result = await service.switchActiveRole({userId, role: 'customer'});

            assert.equal(sessionTokens.verify(result.token).activeRole, 'customer');
        });

        for (const status of ['invited', 'applied', 'pending_review', 'action_needed', 'rejected', 'suspended']) {
            test(`a ${status} role is refused with ROLE_NOT_ACTIVE and nothing is remembered`, async () => {
                const extra = status === 'rejected' ? {rejection_reason: 'No'} : {};
                const {service, repository, userId} = await signedUp({
                    roles: [{role: 'broker', status, ...extra}],
                });

                await assert.rejects(
                    service.switchActiveRole({userId, role: 'broker'}),
                    (error) => error.code === 'ROLE_NOT_ACTIVE' && error.status === 403
                );
                assert.equal(repository.state.users.get(userId).last_active_role, null);
            });
        }

        test('a role the person never had is refused the same way', async () => {
            const {service, userId} = await signedUp();
            await assert.rejects(
                service.switchActiveRole({userId, role: 'landlord'}),
                (error) => error.code === 'ROLE_NOT_ACTIVE' && error.status === 403
            );
        });

        test('something that is not a platform role is a validation error, not a 403', async () => {
            const {service, userId} = await signedUp();
            for (const bad of ['admin', 'agency', 'moderator', '', undefined, 42]) {
                await assert.rejects(
                    service.switchActiveRole({userId, role: bad}),
                    (error) => error.code === 'VALIDATION_FAILED' && error.status === 400
                );
            }
        });

        test('a suspended account cannot mint itself a fresh token by switching', async () => {
            const {service, repository, userId} = await signedUp({roles: [{role: 'broker', status: 'active'}]});
            repository.state.users.get(userId).status = 'suspended';

            await assert.rejects(
                service.switchActiveRole({userId, role: 'broker'}),
                (error) => error.code === 'FORBIDDEN' && error.status === 403
            );
        });

        test('an account that no longer exists is not found', async () => {
            const {service} = await signedUp();
            await assert.rejects(
                service.switchActiveRole({userId: 'nobody', role: 'customer'}),
                (error) => error.code === 'NOT_FOUND'
            );
        });
    });
});
