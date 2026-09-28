import {test, describe, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createUsersService} from './users.mjs';

/**
 * The backoffice sees every role a person holds (T01), so the partner
 * applications screen (T08) can show them. Read-only here: granting and
 * deciding roles arrives with T03/T08.
 */

const ACTOR = 'admin@homemate.co.tz';

describe('admin users carry their roles (Postgres integration)', () => {
    /** @type {pg.Pool} */
    let pool;
    let users;

    before(async () => {
        pool = new pg.Pool({connectionString: process.env.DATABASE_URL});
        users = createUsersService({pool});
    });

    after(async () => {
        await pool.end();
    });

    beforeEach(async () => {
        await pool.query('truncate table users, organizations restart identity cascade');
    });

    const summary = (roles) => roles.map((r) => [r.role, r.status]);

    test('a user fetched by id lists their roles with status and dates', async () => {
        const broker = await users.create({fullName: 'Neema', phoneNumber: '+255713200001', role: 'broker'}, ACTOR);
        await pool.query(
            `insert into user_roles (user_id, role, status, rejection_reason)
             values ($1, 'landlord', 'rejected', 'Title deed unreadable')`,
            [broker.id]
        );

        const fetched = await users.getById(broker.id);

        assert.deepEqual(summary(fetched.roles), [['customer', 'active'], ['broker', 'active'], ['landlord', 'rejected']]);
        assert.equal(fetched.roles[2].rejectionReason, 'Title deed unreadable');
        assert.ok(fetched.roles[1].activatedAt, 'an active role says when it became active');
        assert.equal('reviewed_by' in fetched.roles[0], false);
    });

    test('every user on a list page carries their own roles', async () => {
        await users.create({fullName: 'Juma', phoneNumber: '+255713200002'}, ACTOR);
        await users.create({fullName: 'Amina', phoneNumber: '+255713200003', role: 'landlord'}, ACTOR);
        await users.create({fullName: 'Staff', email: 'mod@homemate.co.tz', role: 'moderator'}, ACTOR);

        const page = await users.search({limit: 10});
        const byName = Object.fromEntries(page.items.map((u) => [u.full_name, summary(u.roles)]));

        assert.deepEqual(byName.Juma, [['customer', 'active']]);
        assert.deepEqual(byName.Amina, [['customer', 'active'], ['landlord', 'active']]);
        assert.deepEqual(byName.Staff, [], 'staff keep users.role and hold no platform roles');
    });

    test('create, update and status changes return the same shape', async () => {
        const created = await users.create({fullName: 'Baraka', phoneNumber: '+255713200004'}, ACTOR);
        assert.deepEqual(summary(created.roles), [['customer', 'active']]);

        const updated = await users.update(created.id, {role: 'broker'}, ACTOR);
        assert.deepEqual(summary(updated.roles), [['customer', 'active'], ['broker', 'active']]);

        const suspended = await users.changeStatus(created.id, {status: 'suspended', reason: 'Fraud check'}, ACTOR);
        assert.deepEqual(summary(suspended.roles), [['customer', 'active'], ['broker', 'active']]);
    });

    test('an empty search page is still a page', async () => {
        const page = await users.search({query: 'nobody-matches-this'});
        assert.deepEqual(page.items, []);
    });
});
