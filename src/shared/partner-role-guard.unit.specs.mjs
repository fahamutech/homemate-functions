import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {createPartnerRoleGuard} from './partner-role-guard.mjs';

/**
 * The partner guard: a route under a broker or landlord workspace must only
 * answer a session acting in that role, and must stop answering the moment
 * the role is suspended — not when the token expires a week later.
 */

function fakeResponse() {
    const response = {
        statusCode: null,
        body: null,
        status(code) {
            response.statusCode = code;
            return response;
        },
        json(body) {
            response.body = body;
            return response;
        },
    };
    return response;
}

function makeGuard({payload, status = 'active', role = 'broker', fail = false} = {}) {
    const lookups = [];
    const guard = createPartnerRoleGuard({
        role,
        path: `/app/${role}`,
        verify: (token) => (token === 'good' ? payload : null),
        roleStatusOf: async (userId, askedRole) => {
            lookups.push({userId, askedRole});
            if (fail) throw new Error('db down');
            return status;
        },
    });
    return {guard, lookups};
}

async function run(guard, authorization) {
    const request = {headers: authorization ? {authorization} : {}};
    const response = fakeResponse();
    let nextCalled = false;
    let nextError;
    await guard.onGuard(request, response, (error) => {
        nextCalled = true;
        nextError = error;
    });
    return {request, response, nextCalled, nextError};
}

const brokerSession = {userId: 'u-1', phoneNumber: '+255712345678', role: 'customer', roles: ['customer', 'broker'], activeRole: 'broker'};

describe('createPartnerRoleGuard', () => {
    test('refuses to build for a role that is not a partner role', () => {
        assert.throws(() => createPartnerRoleGuard({role: 'customer', verify: () => null, roleStatusOf: async () => null}));
        assert.throws(() => createPartnerRoleGuard({role: 'agency', verify: () => null, roleStatusOf: async () => null}));
    });

    test('mounts on the path it is given, defaulting to the role workspace', () => {
        const {guard} = makeGuard();
        assert.equal(guard.path, '/app/broker');
        const fallback = createPartnerRoleGuard({role: 'landlord', verify: () => null, roleStatusOf: async () => null});
        assert.equal(fallback.path, '/app/landlord');
    });

    test('no bearer token → 401', async () => {
        const {guard} = makeGuard({payload: brokerSession});
        const {response, nextCalled} = await run(guard, null);
        assert.equal(response.statusCode, 401);
        assert.equal(nextCalled, false);
    });

    test('a token that does not verify → 401', async () => {
        const {guard} = makeGuard({payload: brokerSession});
        const {response, nextCalled} = await run(guard, 'Bearer forged');
        assert.equal(response.statusCode, 401);
        assert.equal(nextCalled, false);
    });

    test('a session acting as another role → 403 ROLE_NOT_ACTIVE, without touching the database', async () => {
        const {guard, lookups} = makeGuard({payload: {...brokerSession, activeRole: 'customer'}});
        const {response, nextCalled} = await run(guard, 'Bearer good');
        assert.equal(response.statusCode, 403);
        assert.equal(response.body.error, 'ROLE_NOT_ACTIVE');
        assert.equal(nextCalled, false);
        assert.equal(lookups.length, 0);
    });

    test('an old token with no activeRole → 403', async () => {
        const {guard} = makeGuard({payload: {userId: 'u-1', role: 'customer'}});
        const {response} = await run(guard, 'Bearer good');
        assert.equal(response.statusCode, 403);
    });

    test('the right active role, still active in the database → passes and attaches the session', async () => {
        const {guard, lookups} = makeGuard({payload: brokerSession});
        const {request, response, nextCalled, nextError} = await run(guard, 'Bearer good');
        assert.equal(nextCalled, true);
        assert.equal(nextError, undefined);
        assert.equal(response.statusCode, null);
        assert.deepEqual(request.auth, brokerSession);
        assert.deepEqual(lookups, [{userId: 'u-1', askedRole: 'broker'}]);
    });

    test('the role was suspended after the token was issued → 403 at once', async () => {
        const {guard} = makeGuard({payload: brokerSession, status: 'suspended'});
        const {response, nextCalled} = await run(guard, 'Bearer good');
        assert.equal(response.statusCode, 403);
        assert.equal(response.body.error, 'ROLE_NOT_ACTIVE');
        assert.equal(nextCalled, false);
    });

    test('the role row is gone → 403', async () => {
        const {guard} = makeGuard({payload: brokerSession, status: null});
        const {response} = await run(guard, 'Bearer good');
        assert.equal(response.statusCode, 403);
    });

    test('the database lookup failing → 500, never a pass', async () => {
        const {guard} = makeGuard({payload: brokerSession, fail: true});
        const {response, nextCalled} = await run(guard, 'Bearer good');
        assert.equal(response.statusCode, 500);
        assert.equal(nextCalled, false);
    });
});
