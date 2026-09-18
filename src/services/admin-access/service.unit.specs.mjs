import {test, describe, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {createAdminAccessService} from './service.mjs';
import {createSessionTokenService} from '../../shared/session-tokens.mjs';
import {AdminAccessError, AdminAccessErrorCodes} from './ports.mjs';

describe('admin-access service — env-credential login journey', () => {
    let service;
    let sessionTokens;

    beforeEach(() => {
        sessionTokens = createSessionTokenService('unit-test-secret');
        service = createAdminAccessService({
            adminEmail: 'admin@homemate.co.tz',
            adminPassword: 'correct-horse-battery-staple',
            sessionTokens,
        });
    });

    test('login with the correct email and password returns a valid admin session token', async () => {
        const result = await service.login({email: 'admin@homemate.co.tz', password: 'correct-horse-battery-staple'});

        assert.equal(result.admin.email, 'admin@homemate.co.tz');
        assert.equal(result.admin.role, 'admin');

        const decoded = sessionTokens.verify(result.token);
        assert.ok(decoded);
        assert.equal(decoded.role, 'admin');
        assert.equal(decoded.email, 'admin@homemate.co.tz');
    });

    test('login is case-insensitive on email', async () => {
        const result = await service.login({email: 'Admin@HomeMate.co.tz', password: 'correct-horse-battery-staple'});
        assert.equal(result.admin.email, 'admin@homemate.co.tz');
    });

    test('login rejects the wrong password with INVALID_CREDENTIALS', async () => {
        await assert.rejects(
            () => service.login({email: 'admin@homemate.co.tz', password: 'wrong-password'}),
            (err) => {
                assert.ok(err instanceof AdminAccessError);
                assert.equal(err.code, AdminAccessErrorCodes.INVALID_CREDENTIALS);
                return true;
            }
        );
    });

    test('login rejects an unknown email with INVALID_CREDENTIALS', async () => {
        await assert.rejects(
            () => service.login({email: 'someone-else@homemate.co.tz', password: 'correct-horse-battery-staple'}),
            (err) => {
                assert.equal(err.code, AdminAccessErrorCodes.INVALID_CREDENTIALS);
                return true;
            }
        );
    });

    test('login rejects a password that is a prefix/suffix of the real one', async () => {
        await assert.rejects(
            () => service.login({email: 'admin@homemate.co.tz', password: 'correct-horse-battery-stapl'}),
            (err) => {
                assert.equal(err.code, AdminAccessErrorCodes.INVALID_CREDENTIALS);
                return true;
            }
        );
    });

    test('service refuses to start when ADMIN_EMAIL/ADMIN_PASSWORD are not configured', () => {
        assert.throws(
            () => createAdminAccessService({adminEmail: '', adminPassword: '', sessionTokens}),
            (err) => {
                assert.ok(err instanceof AdminAccessError);
                assert.equal(err.code, AdminAccessErrorCodes.NOT_CONFIGURED);
                return true;
            }
        );
    });
});
