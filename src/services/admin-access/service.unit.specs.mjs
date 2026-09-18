import {test, describe, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {createAdminAccessService} from './service.mjs';
import {createSessionTokenService} from '../../shared/session-tokens.mjs';
import {AdminAccessError, AdminAccessErrorCodes} from './ports.mjs';
import {hashPassword} from '../../shared/passwords.mjs';

/** A fake pg.Pool that answers `findStaffByEmail`'s one query from an in-memory row set. */
function fakePool(rows) {
    return {
        async query(_text, [email]) {
            return {rows: rows.filter((row) => row.email.toLowerCase() === email)};
        },
    };
}

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

describe('admin-access service — invited staff login journey', () => {
    let sessionTokens;

    beforeEach(() => {
        sessionTokens = createSessionTokenService('unit-test-secret');
    });

    async function serviceWithStaff(staffRow) {
        return createAdminAccessService({
            adminEmail: 'admin@homemate.co.tz',
            adminPassword: 'correct-horse-battery-staple',
            sessionTokens,
            pool: fakePool([staffRow]),
        });
    }

    test('an active, KYC-verified moderator signs in with their issued password and gets their ACL', async () => {
        const service = await serviceWithStaff({
            id: 'staff-1',
            email: 'amani@homemate.co.tz',
            role: 'moderator',
            status: 'active',
            kyc_status: 'verified',
            password_hash: await hashPassword('one-time-secret'),
            allowed_routes: ['properties', 'inquiries'],
        });

        const result = await service.login({email: 'amani@homemate.co.tz', password: 'one-time-secret'});
        assert.equal(result.admin.role, 'moderator');
        assert.equal(result.admin.userId, 'staff-1');
        assert.deepEqual(result.admin.allowedRoutes, ['properties', 'inquiries']);

        const decoded = sessionTokens.verify(result.token);
        assert.deepEqual(decoded.allowedRoutes, ['properties', 'inquiries']);
    });

    test('an admin-role staff account gets allowedRoutes: null (full access)', async () => {
        const service = await serviceWithStaff({
            id: 'staff-2',
            email: 'lead@homemate.co.tz',
            role: 'admin',
            status: 'active',
            kyc_status: 'verified',
            password_hash: await hashPassword('one-time-secret'),
            allowed_routes: [],
        });

        const result = await service.login({email: 'lead@homemate.co.tz', password: 'one-time-secret'});
        assert.equal(result.admin.allowedRoutes, null);
    });

    test('a pending (not yet activated) staff account is rejected with ACCOUNT_INACTIVE', async () => {
        const service = await serviceWithStaff({
            id: 'staff-3',
            email: 'new@homemate.co.tz',
            role: 'moderator',
            status: 'pending',
            kyc_status: 'verified',
            password_hash: await hashPassword('one-time-secret'),
            allowed_routes: [],
        });

        await assert.rejects(
            () => service.login({email: 'new@homemate.co.tz', password: 'one-time-secret'}),
            (err) => {
                assert.equal(err.code, AdminAccessErrorCodes.ACCOUNT_INACTIVE);
                return true;
            }
        );
    });

    test('an active staff account without verified KYC is rejected with KYC_REQUIRED', async () => {
        const service = await serviceWithStaff({
            id: 'staff-4',
            email: 'unverified@homemate.co.tz',
            role: 'moderator',
            status: 'active',
            kyc_status: 'pending',
            password_hash: await hashPassword('one-time-secret'),
            allowed_routes: [],
        });

        await assert.rejects(
            () => service.login({email: 'unverified@homemate.co.tz', password: 'one-time-secret'}),
            (err) => {
                assert.equal(err.code, AdminAccessErrorCodes.KYC_REQUIRED);
                return true;
            }
        );
    });

    test('the wrong password for a real staff email is rejected with INVALID_CREDENTIALS', async () => {
        const service = await serviceWithStaff({
            id: 'staff-5',
            email: 'amani@homemate.co.tz',
            role: 'moderator',
            status: 'active',
            kyc_status: 'verified',
            password_hash: await hashPassword('one-time-secret'),
            allowed_routes: [],
        });

        await assert.rejects(
            () => service.login({email: 'amani@homemate.co.tz', password: 'nope'}),
            (err) => {
                assert.equal(err.code, AdminAccessErrorCodes.INVALID_CREDENTIALS);
                return true;
            }
        );
    });
});
