import {test, describe, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createCustomerAccessRepository} from './repository.mjs';
import {createCustomerAccessService} from './service.mjs';
import {createSessionTokenService} from '../../shared/session-tokens.mjs';
import {createPartnerRoleGuard} from '../../shared/partner-role-guard.mjs';
import {readRoleStatus} from '../../shared/roles.mjs';
import {createUsersService} from '../admin-console/users.mjs';
import {createPropertiesService} from '../admin-console/properties.mjs';
import {createPropertyDetailsService} from '../admin-console/property-details.mjs';
import {createMemoryStorageAdapter} from '../storage/adapters/memory-storage.adapter.mjs';
import {ErrorCodes} from '../../shared/errors.mjs';

/**
 * One phone, one PIN, many roles (T01, migration 027) against a real
 * database: the backfill, the triggers that keep `user_roles` whole, the
 * property-party rule, and the journey a multi-role person walks — sign in,
 * see their roles, switch, and lose a workspace the moment its role is
 * suspended.
 */

const ACTOR = 'admin@homemate.co.tz';
const PIN = '4820';

function expectDomainError(code) {
    return (error) => {
        assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
        return true;
    };
}

describe('multi-role accounts (Postgres integration)', () => {
    /** @type {pg.Pool} */
    let pool;
    let sessionTokens;
    let access;
    let users;
    let properties;
    let details;
    let dictionaryIds;

    before(async () => {
        pool = new pg.Pool({connectionString: process.env.DATABASE_URL});
        sessionTokens = createSessionTokenService('integration-secret');
        access = createCustomerAccessService({
            repository: createCustomerAccessRepository({pool}),
            notificationPort: {send: async () => ({provider: 'none', status: 'sent'})},
            sessionTokens,
        });
        users = createUsersService({pool});
        properties = createPropertiesService({pool});
        details = createPropertyDetailsService({pool, storagePort: createMemoryStorageAdapter()});

        const {rows} = await pool.query(
            `select code, id from dictionary_items where code in ('apartment', 'dar_es_salaam')`
        );
        dictionaryIds = Object.fromEntries(rows.map((r) => [r.code, r.id]));
    });

    after(async () => {
        await pool.end();
    });

    beforeEach(async () => {
        await pool.query(
            `truncate table property_parties, properties, users, organizations restart identity cascade`
        );
        await pool.query('truncate table audit_log restart identity');
    });

    async function insertUser(phone, role = 'customer', extra = {}) {
        const {rows} = await pool.query(
            `insert into users (phone_number, full_name, role, status, email, organization_id)
             values ($1, $2, $3, 'active', $4, $5) returning *`,
            [phone, `${role} ${phone}`, role, extra.email ?? null, extra.organizationId ?? null]
        );
        return rows[0];
    }

    async function rolesOf(userId) {
        const {rows} = await pool.query(
            `select role::text, status::text from user_roles where user_id = $1
              order by array_position(array['customer', 'broker', 'landlord']::user_role[], role)`,
            [userId]
        );
        return rows.map((r) => [r.role, r.status]);
    }

    async function setRole(userId, role, status, reason = null) {
        await pool.query(
            `insert into user_roles (user_id, role, status, rejection_reason) values ($1, $2, $3, $4)
             on conflict (user_id, role) do update set status = excluded.status,
                                                      rejection_reason = excluded.rejection_reason`,
            [userId, role, status, reason]
        );
    }

    /** A customer with a PIN, as the app would have created them. */
    async function customerWithPin(phone) {
        const user = await insertUser(phone);
        // The token verifyOtp would have handed out after a real code.
        const verificationToken = sessionTokens.sign({userId: user.id, phoneNumber: phone, scope: 'verify', purpose: 'login'});
        await access.setPin({verificationToken, pin: PIN, confirmPin: PIN});
        return user;
    }

    async function createProperty() {
        return properties.create(
            {
                title: 'Masaki 3BR Apartment',
                propertyTypeId: dictionaryIds.apartment,
                regionId: dictionaryIds.dar_es_salaam,
                price: 1500000,
                latitude: -6.746,
                longitude: 39.2803,
            },
            ACTOR
        );
    }

    describe('the schema', () => {
        test('a new platform user starts with an active customer role', async () => {
            const user = await insertUser('+255713100001');
            assert.deepEqual(await rolesOf(user.id), [['customer', 'active']]);
        });

        test('a user created as a broker or landlord also holds that role, active', async () => {
            const broker = await insertUser('+255713100002', 'broker');
            const landlord = await insertUser('+255713100003', 'landlord');
            assert.deepEqual(await rolesOf(broker.id), [['customer', 'active'], ['broker', 'active']]);
            assert.deepEqual(await rolesOf(landlord.id), [['customer', 'active'], ['landlord', 'active']]);
        });

        test('staff get no platform roles; agency users are customers only', async () => {
            const staff = await insertUser('+255713100004', 'moderator', {email: 'mod@homemate.co.tz'});
            const {rows: orgs} = await pool.query(
                `insert into organizations (name) values ('Masaki Homes') returning id`
            );
            const agency = await insertUser('+255713100005', 'agency', {organizationId: orgs[0].id});
            assert.deepEqual(await rolesOf(staff.id), []);
            assert.deepEqual(await rolesOf(agency.id), [['customer', 'active']]);
        });

        test('only customer, broker and landlord can be held in user_roles', async () => {
            const user = await insertUser('+255713100006');
            for (const role of ['agency', 'admin', 'moderator']) {
                await assert.rejects(
                    pool.query(`insert into user_roles (user_id, role, status) values ($1, $2, 'active')`, [
                        user.id,
                        role,
                    ]),
                    /user_roles_platform_role/
                );
            }
        });

        test('a rejection reason is required when rejected and refused otherwise', async () => {
            const user = await insertUser('+255713100007');
            await assert.rejects(
                pool.query(`insert into user_roles (user_id, role, status) values ($1, 'broker', 'rejected')`, [
                    user.id,
                ]),
                /user_roles_rejection_reason_required/
            );
            await assert.rejects(
                pool.query(
                    `insert into user_roles (user_id, role, status, rejection_reason)
                     values ($1, 'broker', 'applied', 'nope')`,
                    [user.id]
                ),
                /user_roles_rejection_reason_required/
            );
            await setRole(user.id, 'broker', 'rejected', 'NIDA did not match');
            assert.deepEqual(await rolesOf(user.id), [['customer', 'active'], ['broker', 'rejected']]);
        });

        test('user_active_roles() lists only active roles, customer → broker → landlord', async () => {
            const user = await insertUser('+255713100008');
            await setRole(user.id, 'broker', 'suspended');
            await setRole(user.id, 'landlord', 'active');
            const {rows} = await pool.query('select user_active_roles($1)::text[] as roles', [user.id]);
            assert.deepEqual(rows[0].roles, ['customer', 'landlord']);

            const {rows: none} = await pool.query(
                'select user_active_roles(gen_random_uuid())::text[] as roles'
            );
            assert.deepEqual(none[0].roles, []);
        });

        test('role changes are audited and stamp updated_at', async () => {
            const user = await insertUser('+255713100009');
            const {rows: before} = await pool.query(
                `select updated_at from user_roles where user_id = $1 and role = 'customer'`,
                [user.id]
            );
            await pool.query(
                `update user_roles set status = 'suspended' where user_id = $1 and role = 'customer'`,
                [user.id]
            );
            const {rows: after} = await pool.query(
                `select updated_at from user_roles where user_id = $1 and role = 'customer'`,
                [user.id]
            );
            assert.ok(after[0].updated_at > before[0].updated_at);

            const {rows: audit} = await pool.query(
                `select operation::text, changed_fields from audit_log where table_name = 'user_roles' order by id`
            );
            assert.deepEqual(audit.map((a) => a.operation), ['INSERT', 'UPDATE']);
            assert.ok(audit[1].changed_fields.includes('status'));
        });

        test('the backfill gives everyone the roles they already had, and nothing twice', async () => {
            const customer = await insertUser('+255713100010');
            const broker = await insertUser('+255713100011', 'broker');
            const landlord = await insertUser('+255713100012', 'landlord');
            const staff = await insertUser('+255713100013', 'admin', {email: 'boss@homemate.co.tz'});
            // Rows as they were before 027: nobody has any.
            await pool.query('delete from user_roles');

            await pool.query('select backfill_user_roles()');
            await pool.query('select backfill_user_roles()');

            assert.deepEqual(await rolesOf(customer.id), [['customer', 'active']]);
            assert.deepEqual(await rolesOf(broker.id), [['customer', 'active'], ['broker', 'active']]);
            assert.deepEqual(await rolesOf(landlord.id), [['customer', 'active'], ['landlord', 'active']]);
            assert.deepEqual(await rolesOf(staff.id), []);
            const {rows} = await pool.query(
                `select activated_at is not null as stamped from user_roles where user_id = $1`,
                [broker.id]
            );
            assert.ok(rows.every((r) => r.stamped), 'a backfilled active role carries its activation time');
        });

        test('the backfill leaves a role an admin already suspended alone', async () => {
            const broker = await insertUser('+255713100014', 'broker');
            await setRole(broker.id, 'broker', 'suspended');
            await pool.query('select backfill_user_roles()');
            assert.deepEqual(await rolesOf(broker.id), [['customer', 'active'], ['broker', 'suspended']]);
        });

        test('promoting a customer to broker from the backoffice grants the role', async () => {
            const user = await users.create({fullName: 'Juma', phoneNumber: '+255713100015'}, ACTOR);
            await users.update(user.id, {role: 'broker'}, ACTOR);
            assert.deepEqual(await rolesOf(user.id), [['customer', 'active'], ['broker', 'active']]);
        });

        test('last_active_role exists and starts empty', async () => {
            const user = await insertUser('+255713100016');
            assert.equal(user.last_active_role, null);
        });
    });

    describe('who may fill a property party slot', () => {
        test('a broker slot needs an active broker role', async () => {
            const property = await createProperty();
            const broker = await insertUser('+255713100020');
            await setRole(broker.id, 'broker', 'active');

            await details.assignParty(property.id, {userId: broker.id, role: 'broker'}, ACTOR);
        });

        test('a broker whose role is pending or suspended cannot fill the broker slot', async () => {
            const property = await createProperty();
            const pending = await insertUser('+255713100021');
            await setRole(pending.id, 'broker', 'pending_review');
            const suspended = await insertUser('+255713100022', 'broker');
            await setRole(suspended.id, 'broker', 'suspended');

            for (const user of [pending, suspended]) {
                await assert.rejects(
                    details.assignParty(property.id, {userId: user.id, role: 'broker'}, ACTOR),
                    expectDomainError(ErrorCodes.VALIDATION_FAILED)
                );
            }
        });

        test('an invited landlord can already be named, so a broker can list for them', async () => {
            const property = await createProperty();
            for (const [index, status] of ['invited', 'applied', 'pending_review', 'active'].entries()) {
                const landlord = await insertUser(`+25571310003${index}`);
                await setRole(landlord.id, 'landlord', status);
                await details.assignParty(property.id, {userId: landlord.id, role: 'landlord'}, ACTOR);
            }
        });

        test('a landlord role that was rejected, suspended or needs action cannot be named', async () => {
            const property = await createProperty();
            for (const [index, status] of ['action_needed', 'rejected', 'suspended'].entries()) {
                const landlord = await insertUser(`+25571310004${index}`);
                await setRole(landlord.id, 'landlord', status, status === 'rejected' ? 'No title deed' : null);
                await assert.rejects(
                    details.assignParty(property.id, {userId: landlord.id, role: 'landlord'}, ACTOR),
                    expectDomainError(ErrorCodes.VALIDATION_FAILED)
                );
            }
        });

        test('a customer-only account is refused from both partner slots', async () => {
            const property = await createProperty();
            const customer = await insertUser('+255713100050');
            for (const role of ['broker', 'landlord']) {
                await assert.rejects(
                    details.assignParty(property.id, {userId: customer.id, role}, ACTOR),
                    expectDomainError(ErrorCodes.VALIDATION_FAILED)
                );
            }
        });

        test('an agency user can still fill the landlord slot, as before', async () => {
            const property = await createProperty();
            const {rows: orgs} = await pool.query(
                `insert into organizations (name) values ('Masaki Homes') returning id`
            );
            const agency = await insertUser('+255713100051', 'agency', {organizationId: orgs[0].id});
            await details.assignParty(property.id, {userId: agency.id, role: 'landlord'}, ACTOR);
            await details.assignParty(property.id, {userId: agency.id, role: 'agency'}, ACTOR);
        });
    });

    describe('the journey: sign in, see roles, switch', () => {
        test('a multi-role person signs in as customer first, sees every role on /app/me', async () => {
            const user = await customerWithPin('+255713100060');
            await setRole(user.id, 'broker', 'active');
            await setRole(user.id, 'landlord', 'pending_review');

            const session = await access.loginWithPin({phoneNumber: '+255713100060', pin: PIN});
            const claims = sessionTokens.verify(session.token);
            assert.deepEqual(claims.roles, ['customer', 'broker']);
            assert.equal(claims.activeRole, 'customer');
            assert.equal(claims.role, 'customer');

            const me = await access.me({userId: user.id});
            assert.equal(me.lastActiveRole, null);
            assert.deepEqual(
                me.roles.map((r) => [r.role, r.status]),
                [['customer', 'active'], ['broker', 'active'], ['landlord', 'pending_review']]
            );
            assert.ok(me.roles[1].activatedAt === null || me.roles[1].activatedAt instanceof Date);
        });

        test('switching to an active role is remembered for the next sign-in', async () => {
            const user = await customerWithPin('+255713100061');
            await setRole(user.id, 'broker', 'active');

            const switched = await access.switchActiveRole({userId: user.id, role: 'broker'});
            assert.equal(switched.activeRole, 'broker');
            assert.equal(sessionTokens.verify(switched.token).activeRole, 'broker');

            const {rows} = await pool.query('select last_active_role::text from users where id = $1', [user.id]);
            assert.equal(rows[0].last_active_role, 'broker');

            const again = await access.loginWithPin({phoneNumber: '+255713100061', pin: PIN});
            assert.equal(sessionTokens.verify(again.token).activeRole, 'broker');
            assert.equal((await access.me({userId: user.id})).lastActiveRole, 'broker');
        });

        test('switching to a role that is not active is refused with ROLE_NOT_ACTIVE', async () => {
            const user = await customerWithPin('+255713100062');
            await setRole(user.id, 'landlord', 'pending_review');

            await assert.rejects(
                access.switchActiveRole({userId: user.id, role: 'landlord'}),
                expectDomainError(ErrorCodes.ROLE_NOT_ACTIVE)
            );
            await assert.rejects(
                access.switchActiveRole({userId: user.id, role: 'broker'}),
                expectDomainError(ErrorCodes.ROLE_NOT_ACTIVE)
            );
        });

        test('once the last role is suspended, the next sign-in opens as customer', async () => {
            const user = await customerWithPin('+255713100063');
            await setRole(user.id, 'broker', 'active');
            await access.switchActiveRole({userId: user.id, role: 'broker'});
            await setRole(user.id, 'broker', 'suspended');

            const session = await access.loginWithPin({phoneNumber: '+255713100063', pin: PIN});
            const claims = sessionTokens.verify(session.token);
            assert.deepEqual(claims.roles, ['customer']);
            assert.equal(claims.activeRole, 'customer');
        });
    });

    describe('the partner guard against the real table', () => {
        function brokerGuard() {
            return createPartnerRoleGuard({
                role: 'broker',
                verify: sessionTokens.verify,
                roleStatusOf: (userId, role) => readRoleStatus(pool, userId, role),
            });
        }

        async function callGuard(token) {
            const response = {
                statusCode: null,
                body: null,
                status(code) {
                    this.statusCode = code;
                    return this;
                },
                json(body) {
                    this.body = body;
                    return this;
                },
            };
            let passed = false;
            await brokerGuard().onGuard({headers: {authorization: `Bearer ${token}`}}, response, () => {
                passed = true;
            });
            return {passed, response};
        }

        test('lets an active broker in, and stops them the moment the role is suspended', async () => {
            const user = await customerWithPin('+255713100070');
            await setRole(user.id, 'broker', 'active');
            const {token} = await access.switchActiveRole({userId: user.id, role: 'broker'});

            assert.equal((await callGuard(token)).passed, true);

            await setRole(user.id, 'broker', 'suspended');
            const refused = await callGuard(token);
            assert.equal(refused.passed, false);
            assert.equal(refused.response.statusCode, 403);
            assert.equal(refused.response.body.error, 'ROLE_NOT_ACTIVE');
        });

        test('a customer session is refused from the broker workspace', async () => {
            const user = await customerWithPin('+255713100071');
            await setRole(user.id, 'broker', 'active');
            const {token} = await access.loginWithPin({phoneNumber: '+255713100071', pin: PIN});

            const refused = await callGuard(token);
            assert.equal(refused.passed, false);
            assert.equal(refused.response.statusCode, 403);
        });
    });
});
