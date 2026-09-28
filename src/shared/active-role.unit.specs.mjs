import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {activeRolesOf, pickActiveRole, customerSessionClaims, publicRole} from './active-role.mjs';

/**
 * One phone, one PIN, many roles (T01). These are the rules that decide what a
 * signed-in person's token says about them: which roles they may act in, and
 * which one the app opens in.
 */

const row = (role, status, extra = {}) => ({role, status, ...extra});

describe('activeRolesOf', () => {
    test('keeps only active roles, customer first then broker then landlord', () => {
        const rows = [
            row('landlord', 'active'),
            row('broker', 'pending_review'),
            row('customer', 'active'),
        ];
        assert.deepEqual(activeRolesOf(rows), ['customer', 'landlord']);
    });

    test('a suspended, rejected or invited role is not something you can act in', () => {
        const rows = [
            row('customer', 'active'),
            row('broker', 'suspended'),
            row('landlord', 'invited'),
        ];
        assert.deepEqual(activeRolesOf(rows), ['customer']);
    });

    test('no rows means no roles', () => {
        assert.deepEqual(activeRolesOf([]), []);
        assert.deepEqual(activeRolesOf(undefined), []);
    });
});

describe('pickActiveRole', () => {
    test('reopens the app in the role last used when it is still active', () => {
        assert.equal(pickActiveRole({lastActiveRole: 'broker', activeRoles: ['customer', 'broker']}), 'broker');
    });

    test('falls back to customer when the last role has since been suspended', () => {
        assert.equal(pickActiveRole({lastActiveRole: 'broker', activeRoles: ['customer']}), 'customer');
    });

    test('falls back to customer when no role was ever chosen', () => {
        assert.equal(pickActiveRole({lastActiveRole: null, activeRoles: ['customer', 'landlord']}), 'customer');
    });
});

describe('customerSessionClaims', () => {
    const user = {id: 'u-1', phone_number: '+255712345678', last_active_role: 'landlord'};

    test('signs userId, phone, the active roles, the active role and the legacy role', () => {
        const claims = customerSessionClaims(user, [row('customer', 'active'), row('landlord', 'active')]);
        assert.deepEqual(claims, {
            userId: 'u-1',
            phoneNumber: '+255712345678',
            role: 'customer',
            roles: ['customer', 'landlord'],
            activeRole: 'landlord',
        });
    });

    test('keeps role "customer" for the current app even when acting as a partner', () => {
        const claims = customerSessionClaims(user, [row('customer', 'active'), row('landlord', 'active')]);
        assert.equal(claims.role, 'customer');
    });

    test('an inactive last role never makes it into the token', () => {
        const claims = customerSessionClaims(user, [row('customer', 'active'), row('landlord', 'suspended')]);
        assert.deepEqual(claims.roles, ['customer']);
        assert.equal(claims.activeRole, 'customer');
    });
});

describe('publicRole', () => {
    test('exposes status and dates in camelCase, never the reviewer', () => {
        const applied = new Date('2026-09-01T10:00:00Z');
        const shaped = publicRole({
            user_id: 'u-1',
            role: 'broker',
            status: 'rejected',
            applied_at: applied,
            submitted_at: applied,
            activated_at: null,
            reviewed_at: applied,
            reviewed_by: 'moderator@homemate.co.tz',
            rejection_reason: 'NIDA did not match',
        });
        assert.deepEqual(shaped, {
            role: 'broker',
            status: 'rejected',
            appliedAt: applied,
            submittedAt: applied,
            activatedAt: null,
            reviewedAt: applied,
            rejectionReason: 'NIDA did not match',
        });
    });

    test('missing optional columns read as null', () => {
        assert.deepEqual(publicRole({role: 'customer', status: 'active'}), {
            role: 'customer',
            status: 'active',
            appliedAt: null,
            submittedAt: null,
            activatedAt: null,
            reviewedAt: null,
            rejectionReason: null,
        });
    });
});
