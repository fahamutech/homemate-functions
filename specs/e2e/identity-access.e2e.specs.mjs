import {test, describe, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {start} from 'bfast-function';
import {notificationPort} from '../../src/services/identity-access/container.mjs';

/**
 * True end-to-end test for the first customer/broker journey the whole
 * platform depends on: register/login by phone OTP.
 *
 * This starts the REAL bfast-functions server (same engine as `npm run
 * dev`), loading the REAL functions/ directory — routes, the auth guard,
 * everything — and drives it over real HTTP against the real
 * `homemate_test` Postgres database. Nothing here is mocked except the
 * NotificationPort, which is the sandbox adapter by design (see
 * IMPLEMENTATION_PLAN.md Section 2.1) — no test should ever cause a real
 * SMS to be sent.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('journey: phone OTP registration/login (e2e)', () => {
    /** @type {import('node:http').Server} */
    let server;
    let baseUrl;
    let db;

    before(async () => {
        if (!process.env.DATABASE_URL) {
            throw new Error('DATABASE_URL must be set (run with `npm run test:e2e`, which loads .env.test)');
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

        db = new pg.Client({connectionString: process.env.DATABASE_URL});
        await db.connect();
    });

    after(async () => {
        await db.end();
        await new Promise(resolve => server.close(resolve));
        // The functions/schedule/index.mjs sample cron job keeps a
        // node-schedule timer alive for the whole process, so closing the
        // HTTP server alone never lets this test file's process exit.
        // Forcing it here is safe: Node 24's test runner isolates each
        // spec file in its own process, and by this point every test in
        // this describe block has already resolved. setImmediate (rather
        // than an immediate call) gives the reporter one more turn of the
        // event loop to flush the last test's result before the process
        // dies — a bare process.exit(0) here was observed to occasionally
        // race ahead of that flush and undercount the total by one.
        setImmediate(() => process.exit(0));
    });

    beforeEach(async () => {
        await db.query('truncate table external_notification_events, auth_otp_challenges, users cascade');
        notificationPort.sentMessages.length = 0;
    });

    test('a new user can request an OTP, verify it, and call an authenticated endpoint', async () => {
        const phoneNumber = '+255712345678';

        const requestResponse = await fetch(`${baseUrl}/auth/otp/request`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({phoneNumber}),
        });
        assert.equal(requestResponse.status, 200);
        const {challengeId, expiresAt} = await requestResponse.json();
        assert.ok(challengeId);
        assert.ok(expiresAt);

        // The sandbox NotificationPort recorded the "sent" OTP in memory
        // instead of paging a real SMS vendor — this is the adapter's whole
        // point: the test can read exactly what would have gone out.
        const sent = notificationPort.lastMessageTo(phoneNumber);
        assert.ok(sent, 'sandbox adapter should have recorded the OTP send');
        const code = sent.params.code;

        const verifyResponse = await fetch(`${baseUrl}/auth/otp/verify`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({challengeId, code}),
        });
        assert.equal(verifyResponse.status, 200);
        const {token, user} = await verifyResponse.json();
        assert.ok(token);
        assert.equal(user.phone_number, phoneNumber);

        const meResponse = await fetch(`${baseUrl}/auth/me`, {
            headers: {authorization: `Bearer ${token}`},
        });
        assert.equal(meResponse.status, 200);
        const {user: me} = await meResponse.json();
        assert.equal(me.id, user.id);
        assert.equal(me.phone_number, phoneNumber);
    });

    test('GET /auth/me is rejected without a session token', async () => {
        const response = await fetch(`${baseUrl}/auth/me`);
        assert.equal(response.status, 401);
    });

    test('GET /auth/me is rejected with a tampered token', async () => {
        const response = await fetch(`${baseUrl}/auth/me`, {
            headers: {authorization: 'Bearer not-a-real-token'},
        });
        assert.equal(response.status, 401);
    });

    test('verifying with the wrong code is rejected and the correct code still works afterwards', async () => {
        const phoneNumber = '+255798765432';
        const requestResponse = await fetch(`${baseUrl}/auth/otp/request`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({phoneNumber}),
        });
        const {challengeId} = await requestResponse.json();
        const code = notificationPort.lastMessageTo(phoneNumber).params.code;

        const wrongAttempt = await fetch(`${baseUrl}/auth/otp/verify`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({challengeId, code: '000000'}),
        });
        assert.equal(wrongAttempt.status, 400);

        const correctAttempt = await fetch(`${baseUrl}/auth/otp/verify`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({challengeId, code}),
        });
        assert.equal(correctAttempt.status, 200);
    });

    test('an invalid phone number is rejected before any OTP is sent', async () => {
        const response = await fetch(`${baseUrl}/auth/otp/request`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({phoneNumber: '0712345'}),
        });
        assert.equal(response.status, 400);
        assert.equal(notificationPort.sentMessages.length, 0);
    });
});
