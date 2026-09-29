import {test, describe, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createUsersService} from './users.mjs';
import {createPropertiesService} from './properties.mjs';
import {createPropertyDetailsService} from './property-details.mjs';
import {createCustomerOpsService} from './customer-ops.mjs';
import {createKycService} from './kyc.mjs';
import {createMemoryStorageAdapter} from '../storage/adapters/memory-storage.adapter.mjs';
import {ErrorCodes} from '../../shared/errors.mjs';

/**
 * What the backoffice needs for partner roles (T08, migration 032):
 * suspending and reactivating a partner role, picking people by their T01
 * roles, seeing who listed a home and whether its landlord confirmed, and
 * telling a landlord's tenancy moves apart from staff ones.
 */

const ADMIN = 'admin@homemate.co.tz';

function expectDomainError(code, pattern) {
    return (error) => {
        assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
        if (pattern) assert.match(error.message, pattern);
        return true;
    };
}

describe('backoffice support for partner roles (Postgres integration)', () => {
    /** @type {pg.Pool} */
    let pool;
    let users;
    let properties;
    let details;
    let customerOps;
    let kyc;

    before(async () => {
        pool = new pg.Pool({connectionString: process.env.DATABASE_URL});
        users = createUsersService({pool});
        properties = createPropertiesService({pool});
        details = createPropertyDetailsService({pool, storagePort: createMemoryStorageAdapter()});
        customerOps = createCustomerOpsService({pool});
        kyc = createKycService({pool, storagePort: createMemoryStorageAdapter()});
    });

    after(async () => {
        await pool.end();
    });

    beforeEach(async () => {
        await pool.query(`truncate table notifications, bookings, property_inquiries, property_parties, properties,
                                         users, organizations restart identity cascade`);
        await pool.query('truncate table audit_log restart identity');
    });

    async function user(phone, name, role = 'customer') {
        const {rows} = await pool.query(
            `insert into users (phone_number, full_name, role, status) values ($1, $2, $3, 'active') returning id`,
            [phone, name, role]
        );
        return rows[0].id;
    }

    const roleOf = async (userId, role) =>
        (await pool.query('select status::text, suspension_reason from user_roles where user_id = $1 and role = $2', [userId, role])).rows[0];

    describe('suspending and reactivating a partner role', () => {
        test('suspend needs a reason, is audited as the admin, and tells the person', async () => {
            const broker = await user('+255715000001', 'Juma Broker', 'broker');

            await assert.rejects(
                users.changeRoleStatus(broker, 'broker', {status: 'suspended'}, ADMIN),
                expectDomainError(ErrorCodes.VALIDATION_FAILED, /reason/)
            );

            const suspended = await users.changeRoleStatus(broker, 'broker', {status: 'suspended', reason: 'Fake listings'}, ADMIN);
            assert.deepEqual(suspended.roles.find((r) => r.role === 'broker').status, 'suspended');
            assert.deepEqual(await roleOf(broker, 'broker'), {status: 'suspended', suspension_reason: 'Fake listings'});

            const {rows: audit} = await pool.query(
                `select actor from audit_log where table_name = 'user_roles' and operation = 'UPDATE'`
            );
            assert.equal(audit[0].actor, ADMIN);
            const {rows: notes} = await pool.query('select body from notifications where user_id = $1', [broker]);
            assert.match(notes[0].body, /Fake listings/);
        });

        test('reactivating clears the reason', async () => {
            const broker = await user('+255715000002', 'Juma Broker', 'broker');
            await users.changeRoleStatus(broker, 'broker', {status: 'suspended', reason: 'Checks'}, ADMIN);
            await users.changeRoleStatus(broker, 'broker', {status: 'active'}, ADMIN);
            assert.deepEqual(await roleOf(broker, 'broker'), {status: 'active', suspension_reason: null});
        });

        test('only active ↔ suspended, only partner roles', async () => {
            const person = await user('+255715000003', 'Someone');
            await pool.query(`insert into user_roles (user_id, role, status) values ($1, 'landlord', 'pending_review')`, [person]);

            await assert.rejects(
                users.changeRoleStatus(person, 'landlord', {status: 'suspended', reason: 'x'}, ADMIN),
                expectDomainError(ErrorCodes.CONFLICT)
            );
            await assert.rejects(
                users.changeRoleStatus(person, 'landlord', {status: 'active'}, ADMIN),
                expectDomainError(ErrorCodes.CONFLICT)
            );
            await assert.rejects(
                users.changeRoleStatus(person, 'customer', {status: 'suspended', reason: 'x'}, ADMIN),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
            await assert.rejects(
                users.changeRoleStatus(person, 'broker', {status: 'suspended', reason: 'x'}, ADMIN),
                expectDomainError(ErrorCodes.NOT_FOUND)
            );
            await assert.rejects(
                users.changeRoleStatus(person, 'landlord', {status: 'rejected'}, ADMIN),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
        });
    });

    describe('the person screen', () => {
        test('the identity profile carries the person’s roles for the Roles tab', async () => {
            const broker = await user('+255715000004', 'Juma Broker', 'broker');
            await users.changeRoleStatus(broker, 'broker', {status: 'suspended', reason: 'Checks'}, ADMIN);
            const profile = await kyc.getProfile(broker);
            const byRole = Object.fromEntries(profile.roles.map((r) => [r.role, r.status]));
            assert.equal(byRole.broker, 'suspended');
            assert.equal(byRole.customer, 'active');
        });
    });

    describe('picking people by their roles', () => {
        test('active brokers only; landlords in any status but rejected', async () => {
            const activeBroker = await user('+255715000010', 'Active Broker', 'broker');
            const pendingBroker = await user('+255715000011', 'Pending Broker');
            await pool.query(`insert into user_roles (user_id, role, status) values ($1, 'broker', 'pending_review')`, [pendingBroker]);
            const invitedLandlord = await user('+255715000012', 'Invited Landlord');
            await pool.query(`insert into user_roles (user_id, role, status) values ($1, 'landlord', 'invited')`, [invitedLandlord]);
            const rejectedLandlord = await user('+255715000013', 'Rejected Landlord');
            await pool.query(
                `insert into user_roles (user_id, role, status, rejection_reason) values ($1, 'landlord', 'rejected', 'No')`,
                [rejectedLandlord]
            );
            const activeLandlord = await user('+255715000014', 'Active Landlord', 'landlord');

            const brokers = await users.search({partnerRole: 'broker', partnerStatus: 'active'});
            assert.deepEqual(brokers.items.map((u) => u.id), [activeBroker]);

            const landlords = await users.search({partnerRole: 'landlord', partnerStatus: 'invited,applied,pending_review,action_needed,active,suspended'});
            assert.deepEqual(landlords.items.map((u) => u.full_name).sort(), ['Active Landlord', 'Invited Landlord']);
            assert.ok(landlords.items.every((u) => Array.isArray(u.roles)));
            assert.equal((await users.search({partnerRole: 'landlord', partnerStatus: 'active', query: 'invited'})).items.length, 0);
            assert.ok(activeLandlord);
        });

        test('an unknown partner role or status is refused', async () => {
            await assert.rejects(users.search({partnerRole: 'agency'}), expectDomainError(ErrorCodes.VALIDATION_FAILED));
            await assert.rejects(users.search({partnerRole: 'broker', partnerStatus: 'sleeping'}), expectDomainError(ErrorCodes.VALIDATION_FAILED));
        });
    });

    describe('who listed a home, and whether its landlord confirmed', () => {
        async function listing({creator = null, brokerId = null, landlordId = null}) {
            const {rows} = await pool.query(
                `insert into properties (title, created_by_user_id, status) values ('A home', $1, 'draft') returning id`,
                [creator]
            );
            const id = rows[0].id;
            if (brokerId) await pool.query(`insert into property_parties (property_id, user_id, role, is_primary) values ($1, $2, 'broker', true)`, [id, brokerId]);
            if (landlordId) await pool.query(`insert into property_parties (property_id, user_id, role, is_primary) values ($1, $2, 'landlord', true)`, [id, landlordId]);
            return id;
        }

        test('the list and the detail say broker / landlord / backoffice and the confirmation', async () => {
            const broker = await user('+255715000020', 'Juma Broker', 'broker');
            const landlord = await user('+255715000021', 'Amina Landlord', 'landlord');
            const brokered = await listing({creator: broker, brokerId: broker, landlordId: landlord});
            const own = await listing({creator: landlord, landlordId: landlord});
            const staff = await listing({landlordId: landlord});
            await pool.query(
                `update property_parties set confirmation_status = 'disputed', dispute_reason = 'Not my house'
                  where property_id = $1 and role = 'landlord'`,
                [brokered]
            );

            const {items} = await properties.search({});
            const byId = Object.fromEntries(items.map((p) => [p.id, p]));
            assert.deepEqual(byId[brokered].listed_by, {kind: 'broker', user_id: broker, name: 'Juma Broker'});
            assert.deepEqual(byId[brokered].landlord_confirmation, {status: 'disputed', reason: 'Not my house', confirmed_at: null});
            assert.deepEqual(byId[own].listed_by, {kind: 'landlord', user_id: landlord, name: 'Amina Landlord'});
            assert.equal(byId[own].landlord_confirmation.status, 'not_required');
            assert.deepEqual(byId[staff].listed_by, {kind: 'backoffice', user_id: null, name: null});

            const detail = await properties.getById(brokered);
            assert.equal(detail.listed_by.kind, 'broker');
            assert.equal(detail.landlord_confirmation.status, 'disputed');
            const landlordParty = detail.parties.find((p) => p.role === 'landlord');
            assert.equal(landlordParty.confirmation_status, 'disputed');
            assert.equal(landlordParty.dispute_reason, 'Not my house');
        });

        test('the People step lists parties with their confirmation', async () => {
            const landlord = await user('+255715000022', 'Amina Landlord', 'landlord');
            const id = await listing({landlordId: landlord});
            const {items} = await details.listParties(id);
            assert.equal(items[0].confirmation_status, 'not_required');
        });
    });

    describe('rental history', () => {
        test('a move made by the landlord is labelled as the landlord’s', async () => {
            const landlord = await user('+255715000030', 'Amina Landlord', 'landlord');
            const customer = await user('+255715000031', 'Neema Customer');
            const {rows: property} = await pool.query(
                `insert into properties (title, owner_id, price, status) values ('Home', $1, 500000, 'draft') returning id`,
                [landlord]
            );
            await pool.query(`insert into property_parties (property_id, user_id, role, is_primary) values ($1, $2, 'landlord', true)`, [property[0].id, landlord]);
            const {rows: booking} = await pool.query(
                `insert into bookings (property_id, customer_id, monthly_rent, total_due, status, lease_start_date, lease_end_date, move_in_date)
                 values ($1, $2, 500000, 1000000, 'pending', current_date, current_date + 365, current_date) returning id`,
                [property[0].id, customer]
            );
            // Walk it to confirmed the way the database allows in a test: straight updates as the system.
            await pool.query(`update bookings set status = 'awaiting_payment' where id = $1`, [booking[0].id]);
            await pool.query(`alter table bookings disable trigger bookings_enforce_paid_before_confirm`);
            await pool.query(`update bookings set status = 'confirmed' where id = $1`, [booking[0].id]);
            await pool.query(`alter table bookings enable trigger bookings_enforce_paid_before_confirm`);

            await customerOps.changeBookingStatus(booking[0].id, {status: 'active'}, landlord);
            await customerOps.changeBookingStatus(booking[0].id, {status: 'completed'}, ADMIN);

            const detail = await customerOps.getBooking(booking[0].id);
            const moves = detail.history.filter((h) => ['active', 'completed'].includes(h.status));
            assert.deepEqual(moves.map((h) => [h.status, h.label, h.by_landlord]), [
                ['active', 'Confirmed by landlord', true],
                ['completed', 'Ended', false],
            ]);
            assert.equal(moves[1].actor, ADMIN);
        });
    });
});
