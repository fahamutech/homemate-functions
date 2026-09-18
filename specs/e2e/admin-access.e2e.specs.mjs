import {test, describe, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {start} from 'bfast-function';
import {notificationPort} from '../../src/services/identity-access/container.mjs';

/**
 * True end-to-end test for the admin portal's login journey: an env-
 * predefined administrator signs in with email + password and calls an
 * authenticated endpoint. Starts the real bfast-functions server exactly
 * like identity-access.e2e.specs.mjs — see that file for why (real routes,
 * real guard, no mocking except what's inherently external).
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('journey: admin email/password login (e2e)', () => {
    /** @type {import('node:http').Server} */
    let server;
    let baseUrl;

    before(async () => {
        if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
            throw new Error('ADMIN_EMAIL/ADMIN_PASSWORD must be set (run with `npm run test:e2e`, which loads .env.test)');
        }

        server = await start({
            port: process.env.PORT ?? '0',
            functionsConfig: {
                functionsDirPath: join(repoRoot, 'functions'),
                bfastJsonPath: join(repoRoot, 'bfast.json'),
            },
        });
        if (!server.listening) {
            await once(server, 'listening');
        }
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        await new Promise(resolve => server.close(resolve));
        // see identity-access.e2e.specs.mjs for why this is necessary
        // (the sample everyMinute cron job keeps the process alive).
        // setImmediate (not a bare call) so the test runner's reporter gets
        // a turn to flush the last test's result before the process dies —
        // an immediate exit here was observed to race ahead of it.
        setImmediate(() => process.exit(0));
    });

    test('the configured admin can log in and call an authenticated endpoint', async () => {
        const loginResponse = await fetch(`${baseUrl}/auth/admin/login`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD}),
        });
        assert.equal(loginResponse.status, 200);
        const {token, admin} = await loginResponse.json();
        assert.ok(token);
        assert.equal(admin.email, process.env.ADMIN_EMAIL.toLowerCase());
        assert.equal(admin.role, 'admin');

        const meResponse = await fetch(`${baseUrl}/auth/admin/me`, {
            headers: {authorization: `Bearer ${token}`},
        });
        assert.equal(meResponse.status, 200);
        const {admin: me} = await meResponse.json();
        assert.equal(me.email, admin.email);
        assert.equal(me.role, 'admin');
    });

    test('the wrong password is rejected with 401', async () => {
        const response = await fetch(`${baseUrl}/auth/admin/login`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({email: process.env.ADMIN_EMAIL, password: 'not-the-right-password'}),
        });
        assert.equal(response.status, 401);
    });

    test('GET /auth/admin/me is rejected without a session token', async () => {
        const response = await fetch(`${baseUrl}/auth/admin/me`);
        assert.equal(response.status, 401);
    });

    test('a real customer session token is rejected by the admin route with 403, not silently accepted', async () => {
        const phoneNumber = '+255711000111';
        const requestResponse = await fetch(`${baseUrl}/auth/otp/request`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({phoneNumber}),
        });
        assert.equal(requestResponse.status, 200);
        const {challengeId} = await requestResponse.json();
        const code = notificationPort.lastMessageTo(phoneNumber).params.code;

        const verifyResponse = await fetch(`${baseUrl}/auth/otp/verify`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({challengeId, code}),
        });
        assert.equal(verifyResponse.status, 200);
        const {token: customerToken} = await verifyResponse.json();

        // The customer token is validly signed by the same shared secret,
        // so it passes signature verification — it must still be rejected
        // here because it carries no `role: 'admin'` claim.
        const response = await fetch(`${baseUrl}/auth/admin/me`, {
            headers: {authorization: `Bearer ${customerToken}`},
        });
        assert.equal(response.status, 403);
    });
});
