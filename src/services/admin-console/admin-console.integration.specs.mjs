import {test, describe, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createUsersService} from './users.mjs';
import {createOrganizationsService} from './organizations.mjs';
import {createPropertiesService} from './properties.mjs';
import {createDictionariesService} from './dictionaries.mjs';
import {createSettingsService} from './settings.mjs';
import {createInsightsService} from './insights.mjs';
import {ErrorCodes} from '../../shared/errors.mjs';

/**
 * These run against the real `homemate_test` database, because the behaviour
 * under test mostly *is* the database: trigger-enforced lifecycles, generated
 * reference codes, PostGIS radius search, audit rows, settings history. A
 * mocked pg client would prove nothing here.
 */

const ACTOR = 'admin@homemate.co.tz';

function expectDomainError(code) {
    return (error) => {
        assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
        return true;
    };
}

describe('admin console (Postgres integration)', () => {
    /** @type {pg.Pool} */
    let pool;
    let users;
    let organizations;
    let properties;
    let dictionaries;
    let settings;
    let insights;
    let dictionaryIds;
    let seededSettings;

    before(async () => {
        pool = new pg.Pool({connectionString: process.env.DATABASE_URL});
        users = createUsersService({pool});
        organizations = createOrganizationsService({pool});
        properties = createPropertiesService({pool});
        dictionaries = createDictionariesService({pool});
        settings = createSettingsService({pool});
        insights = createInsightsService({pool});

        const {rows} = await pool.query(
            `select category, code, id from dictionary_items
              where code in ('apartment', 'dar_es_salaam', 'kinondoni', 'masaki')`
        );
        dictionaryIds = Object.fromEntries(rows.map((r) => [r.code, r.id]));

        // Reference data (dictionaries, settings) is seeded by migration and
        // deliberately NOT truncated — but tests legitimately mutate it, so it
        // has to be restored per test or edits leak into later tests and later
        // runs. Dictionary rows created by tests use a `test_` code prefix so
        // they can be removed without needing to know the seed list.
        const {rows: seededSettingRows} = await pool.query('select key, value from settings');
        seededSettings = seededSettingRows;
    });

    after(async () => {
        await pool.end();
    });

    beforeEach(async () => {
        await pool.query(
            'truncate table property_media, properties, users, organizations restart identity cascade'
        );
        await pool.query("delete from dictionary_items where code like 'test\\_%'");
        await pool.query('update dictionary_items set is_active = true where not is_active');
        for (const setting of seededSettings) {
            // pg hands jsonb back parsed, so it must be re-serialised on the
            // way in or a bare string like `HomeMate Africa` is invalid JSON.
            await pool.query(
                'update settings set value = $2::jsonb where key = $1 and value is distinct from $2::jsonb',
                [setting.key, JSON.stringify(setting.value)]
            );
        }
        // cleared last: the restores above themselves fire audit/history triggers
        await pool.query('truncate table audit_log, settings_history restart identity');
    });

    // --- Users ---------------------------------------------------------------

    describe('users', () => {
        test('creates a landlord and finds it by search', async () => {
            const created = await users.create(
                {fullName: 'Baraka Mushi', phoneNumber: '+255712000001', role: 'landlord'},
                ACTOR
            );
            assert.equal(created.role, 'landlord');
            assert.equal(created.status, 'active');
            assert.equal(created.is_staff, false);

            const page = await users.search({query: 'Baraka'});
            assert.equal(page.pagination.total, 1);
            assert.equal(page.items[0].id, created.id);
        });

        test('creates staff with pending status and marks them as staff', async () => {
            const moderator = await users.create(
                {fullName: 'Amani M', email: 'amani@homemate.co.tz', role: 'moderator'},
                ACTOR
            );
            assert.equal(moderator.status, 'pending');
            assert.equal(moderator.is_staff, true);

            const staffPage = await users.search({staffOnly: true});
            assert.equal(staffPage.pagination.total, 1);
            const platformPage = await users.search({staffOnly: false});
            assert.equal(platformPage.pagination.total, 0);
        });

        test('rejects an unknown role and a user with neither phone nor email', async () => {
            await assert.rejects(
                () => users.create({fullName: 'X', phoneNumber: '+255712000002', role: 'wizard'}, ACTOR),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
            await assert.rejects(
                () => users.create({fullName: 'X', role: 'customer'}, ACTOR),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
        });

        test('database refuses staff scoped to an organization', async () => {
            const org = await organizations.create({name: 'Kinondoni Homes'}, ACTOR);
            await assert.rejects(
                () =>
                    users.create(
                        {fullName: 'Bad Staff', email: 'bad@homemate.co.tz', role: 'admin', organizationId: org.id},
                        ACTOR
                    ),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
        });

        test('database refuses an agency user with no organization', async () => {
            await assert.rejects(
                () => users.create({fullName: 'Orphan Agency', phoneNumber: '+255712000003', role: 'agency'}, ACTOR),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
        });

        test('rejects a duplicate phone number with a conflict', async () => {
            await users.create({fullName: 'One', phoneNumber: '+255712000004', role: 'customer'}, ACTOR);
            await assert.rejects(
                () => users.create({fullName: 'Two', phoneNumber: '+255712000004', role: 'customer'}, ACTOR),
                expectDomainError(ErrorCodes.CONFLICT)
            );
        });

        test('suspends a user with a reason and reactivates them', async () => {
            const user = await users.create(
                {fullName: 'Suspend Me', phoneNumber: '+255712000005', role: 'customer'},
                ACTOR
            );

            await assert.rejects(
                () => users.changeStatus(user.id, {status: 'suspended'}, ACTOR),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );

            const suspended = await users.changeStatus(
                user.id,
                {status: 'suspended', reason: 'Fraudulent listings'},
                ACTOR
            );
            assert.equal(suspended.status, 'suspended');
            assert.equal(suspended.suspension_reason, 'Fraudulent listings');

            const reactivated = await users.changeStatus(user.id, {status: 'active'}, ACTOR);
            assert.equal(reactivated.status, 'active');
            assert.equal(reactivated.suspension_reason, null, 'stale suspension reason must be cleared');
        });

        test('database refuses an illegal user status transition', async () => {
            const user = await users.create(
                {fullName: 'Deactivated', phoneNumber: '+255712000006', role: 'customer'},
                ACTOR
            );
            await users.changeStatus(user.id, {status: 'deactivated'}, ACTOR);
            await assert.rejects(
                () => users.changeStatus(user.id, {status: 'suspended', reason: 'nope'}, ACTOR),
                expectDomainError(ErrorCodes.ILLEGAL_TRANSITION)
            );
        });

        test('updates a profile and 404s for an unknown id', async () => {
            const user = await users.create(
                {fullName: 'Old Name', phoneNumber: '+255712000007', role: 'customer'},
                ACTOR
            );
            const updated = await users.update(user.id, {fullName: 'New Name'}, ACTOR);
            assert.equal(updated.full_name, 'New Name');

            await assert.rejects(
                () => users.getById('00000000-0000-0000-0000-000000000000'),
                expectDomainError(ErrorCodes.NOT_FOUND)
            );
        });

        test('every write leaves an attributed audit row', async () => {
            const user = await users.create(
                {fullName: 'Audited', phoneNumber: '+255712000008', role: 'customer'},
                ACTOR
            );
            await users.changeStatus(user.id, {status: 'suspended', reason: 'spam'}, ACTOR);

            const {rows} = await pool.query(
                `select operation, actor, changed_fields from audit_log
                  where table_name = 'users' and record_id = $1 order by id`,
                [user.id]
            );
            assert.equal(rows.length, 2);
            assert.equal(rows[0].operation, 'INSERT');
            assert.equal(rows[0].actor, ACTOR);
            assert.equal(rows[1].operation, 'UPDATE');
            assert.ok(rows[1].changed_fields.includes('status'));
        });
    });

    // --- Organizations -------------------------------------------------------

    describe('organizations', () => {
        test('approves a pending agency and stamps the verifier', async () => {
            const org = await organizations.create({name: 'Masaki Realty', type: 'agency'}, ACTOR);
            assert.equal(org.status, 'pending');

            const approved = await organizations.changeStatus(org.id, {status: 'active'}, ACTOR);
            assert.equal(approved.status, 'active');
            assert.equal(approved.verified_by, ACTOR);
            assert.ok(approved.verified_at);
        });

        test('rejection requires a reason and is stored', async () => {
            const org = await organizations.create({name: 'Sketchy Agency'}, ACTOR);
            await assert.rejects(
                () => organizations.changeStatus(org.id, {status: 'rejected'}, ACTOR),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
            const rejected = await organizations.changeStatus(
                org.id,
                {status: 'rejected', reason: 'Registration number unverifiable'},
                ACTOR
            );
            assert.equal(rejected.status, 'rejected');
            assert.equal(rejected.rejection_reason, 'Registration number unverifiable');
        });

        test('database refuses an illegal organization transition', async () => {
            const org = await organizations.create({name: 'Straight to suspended'}, ACTOR);
            await assert.rejects(
                () => organizations.changeStatus(org.id, {status: 'suspended'}, ACTOR),
                expectDomainError(ErrorCodes.ILLEGAL_TRANSITION)
            );
        });

        test('counts members and properties', async () => {
            const org = await organizations.create({name: 'Counted Agency'}, ACTOR);
            await organizations.changeStatus(org.id, {status: 'active'}, ACTOR);
            await users.create(
                {fullName: 'Agency User', phoneNumber: '+255712000010', role: 'agency', organizationId: org.id},
                ACTOR
            );
            await properties.create({title: 'Agency listing', organizationId: org.id}, ACTOR);

            const fetched = await organizations.getById(org.id);
            assert.equal(Number(fetched.member_count), 1);
            assert.equal(Number(fetched.property_count), 1);
        });

        test('search filters by status', async () => {
            const a = await organizations.create({name: 'Active One'}, ACTOR);
            await organizations.create({name: 'Pending One'}, ACTOR);
            await organizations.changeStatus(a.id, {status: 'active'}, ACTOR);

            const active = await organizations.search({status: 'active'});
            assert.equal(active.pagination.total, 1);
            assert.equal(active.items[0].name, 'Active One');
        });
    });

    // --- Properties ----------------------------------------------------------

    describe('properties', () => {
        async function createOwner(phone = '+255712000020') {
            return users.create({fullName: 'Owner', phoneNumber: phone, role: 'landlord'}, ACTOR);
        }

        async function createCompleteProperty(overrides = {}) {
            const owner = await createOwner(overrides.ownerPhone ?? '+255712000021');
            return properties.create(
                {
                    title: 'Masaki 3BR Apartment',
                    ownerId: owner.id,
                    propertyTypeId: dictionaryIds.apartment,
                    regionId: dictionaryIds.dar_es_salaam,
                    districtId: dictionaryIds.kinondoni,
                    wardId: dictionaryIds.masaki,
                    price: 1500000,
                    bedrooms: 3,
                    latitude: -6.746,
                    longitude: 39.2803,
                    addressLine: 'Masaki, Dar es Salaam',
                    ...overrides,
                },
                ACTOR
            );
        }

        test('assigns a generated reference code and starts as draft', async () => {
            const property = await createCompleteProperty();
            assert.match(property.reference_code, /^HM-P-\d{6}$/);
            assert.equal(property.status, 'draft');
        });

        test('walks the full moderation lifecycle and stamps the reviewer', async () => {
            const property = await createCompleteProperty();

            const submitted = await properties.changeStatus(property.id, {status: 'pending_review'}, ACTOR);
            assert.equal(submitted.status, 'pending_review');
            assert.ok(submitted.submitted_at);

            const approved = await properties.changeStatus(property.id, {status: 'approved'}, ACTOR);
            assert.equal(approved.status, 'approved');
            assert.equal(approved.reviewed_by, ACTOR);
            assert.ok(approved.reviewed_at);
        });

        test('rejection and change-requests require a reason, which is cleared on resubmit', async () => {
            const property = await createCompleteProperty();
            await properties.changeStatus(property.id, {status: 'pending_review'}, ACTOR);

            await assert.rejects(
                () => properties.changeStatus(property.id, {status: 'rejected'}, ACTOR),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );

            const changes = await properties.changeStatus(
                property.id,
                {status: 'changes_requested', reason: 'Photos unclear or insufficient'},
                ACTOR
            );
            assert.equal(changes.rejection_reason, 'Photos unclear or insufficient');

            const resubmitted = await properties.changeStatus(property.id, {status: 'pending_review'}, ACTOR);
            assert.equal(resubmitted.rejection_reason, null);
        });

        test('database refuses draft -> approved (skipping review)', async () => {
            const property = await createCompleteProperty();
            await assert.rejects(
                () => properties.changeStatus(property.id, {status: 'approved'}, ACTOR),
                expectDomainError(ErrorCodes.ILLEGAL_TRANSITION)
            );
        });

        test('database refuses approving a property with incomplete data (BR-001)', async () => {
            const incomplete = await properties.create({title: 'Bare minimum listing'}, ACTOR);
            await properties.changeStatus(incomplete.id, {status: 'pending_review'}, ACTOR);
            await assert.rejects(
                () => properties.changeStatus(incomplete.id, {status: 'approved'}, ACTOR),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
        });

        test('archived is terminal', async () => {
            const property = await createCompleteProperty();
            await properties.changeStatus(property.id, {status: 'archived'}, ACTOR);
            await assert.rejects(
                () => properties.changeStatus(property.id, {status: 'pending_review'}, ACTOR),
                expectDomainError(ErrorCodes.ILLEGAL_TRANSITION)
            );
        });

        test('finds properties by radius and excludes ones outside it', async () => {
            await createCompleteProperty({ownerPhone: '+255712000030'});
            const owner = await createOwner('+255712000031');
            await properties.create(
                {
                    title: 'Mbeya Cottage',
                    ownerId: owner.id,
                    price: 400000,
                    latitude: -8.909,
                    longitude: 33.46,
                },
                ACTOR
            );

            const near = await properties.search({latitude: -6.746, longitude: 39.2803, radiusMetres: 5000});
            assert.equal(near.pagination.total, 1);
            assert.equal(near.items[0].title, 'Masaki 3BR Apartment');
            assert.ok(near.items[0].distance_metres < 100);

            const wide = await properties.search({latitude: -6.746, longitude: 39.2803, radiusMetres: 2000000});
            assert.equal(wide.pagination.total, 2);
            assert.equal(wide.items[0].title, 'Masaki 3BR Apartment', 'nearest first');
        });

        test('full-text search matches title and reference code', async () => {
            const property = await createCompleteProperty({ownerPhone: '+255712000032'});

            const byWord = await properties.search({query: 'Masaki'});
            assert.equal(byWord.pagination.total, 1);

            const byRef = await properties.search({query: property.reference_code});
            assert.equal(byRef.pagination.total, 1);

            const miss = await properties.search({query: 'nonexistentterm'});
            assert.equal(miss.pagination.total, 0);
        });

        test('facet filters and price bounds narrow results', async () => {
            await createCompleteProperty({ownerPhone: '+255712000033'});

            assert.equal((await properties.search({status: 'draft'})).pagination.total, 1);
            assert.equal((await properties.search({status: 'approved'})).pagination.total, 0);
            assert.equal((await properties.search({minPrice: 2000000})).pagination.total, 0);
            assert.equal((await properties.search({maxPrice: 2000000})).pagination.total, 1);
            assert.equal((await properties.search({minBedrooms: 4})).pagination.total, 0);
            assert.equal((await properties.search({regionId: dictionaryIds.dar_es_salaam})).pagination.total, 1);
        });

        test('paginates with a stable total', async () => {
            const owner = await createOwner('+255712000034');
            for (let i = 0; i < 5; i++) {
                await properties.create({title: `Listing ${i}`, ownerId: owner.id}, ACTOR);
            }
            const firstPage = await properties.search({limit: 2, offset: 0});
            assert.equal(firstPage.items.length, 2);
            assert.equal(firstPage.pagination.total, 5);
            assert.equal(firstPage.pagination.hasMore, true);

            const lastPage = await properties.search({limit: 2, offset: 4});
            assert.equal(lastPage.items.length, 1);
            assert.equal(lastPage.pagination.hasMore, false);
        });

        test('rejects a half-specified coordinate pair', async () => {
            await assert.rejects(
                () => properties.create({title: 'Half geo', latitude: -6.7}, ACTOR),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
        });

        test('rejects a non-existent owner reference', async () => {
            await assert.rejects(
                () =>
                    properties.create(
                        {title: 'Ghost owner', ownerId: '00000000-0000-0000-0000-000000000000'},
                        ACTOR
                    ),
                expectDomainError(ErrorCodes.REFERENCE_NOT_FOUND)
            );
        });

        test('updates details', async () => {
            const property = await createCompleteProperty({ownerPhone: '+255712000035'});
            const updated = await properties.update(property.id, {price: 1750000, bedrooms: 4}, ACTOR);
            assert.equal(Number(updated.price), 1750000);
            assert.equal(updated.bedrooms, 4);

            const fetched = await properties.getById(property.id);
            assert.equal(fetched.media.length, 0, 'media is attached through the storage-backed path');
        });
    });

    // --- Dictionaries --------------------------------------------------------

    describe('dictionaries', () => {
        test('lists seeded categories and items', async () => {
            const {items} = await dictionaries.categories();
            const names = items.map((i) => i.category);
            assert.ok(names.includes('region'));
            assert.ok(names.includes('property_type'));

            const propertyTypes = await dictionaries.list({category: 'property_type'});
            assert.ok(propertyTypes.items.length >= 9);
        });

        test('walks the geography tree region → district → ward', async () => {
            const regions = await dictionaries.list({category: 'region'});
            const dar = regions.items.find((r) => r.code === 'dar_es_salaam');
            assert.ok(Number(dar.child_count) > 0);

            const districts = await dictionaries.list({category: 'district', parentId: dar.id});
            const kinondoni = districts.items.find((d) => d.code === 'kinondoni');
            assert.ok(kinondoni);

            const wards = await dictionaries.list({category: 'ward', parentId: kinondoni.id});
            assert.ok(wards.items.some((w) => w.code === 'masaki'));
        });

        test('database refuses a ward without a district parent', async () => {
            await assert.rejects(
                () => dictionaries.create({category: 'ward', code: 'test_orphan', name: 'Orphan Ward'}, ACTOR),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
        });

        test('database refuses a district parented to a ward', async () => {
            const wards = await dictionaries.list({
                category: 'ward',
                parentId: (
                    await dictionaries.list({
                        category: 'district',
                        parentId: (await dictionaries.list({category: 'region'})).items.find(
                            (r) => r.code === 'dar_es_salaam'
                        ).id,
                    })
                ).items.find((d) => d.code === 'kinondoni').id,
            });
            await assert.rejects(
                () =>
                    dictionaries.create(
                        {category: 'district', code: 'test_wrong_parent', name: 'Wrong', parentId: wards.items[0].id},
                        ACTOR
                    ),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
        });

        test('creates and deactivates an item, hiding it from the default list', async () => {
            const created = await dictionaries.create(
                {category: 'amenity', code: 'test_borehole', name: 'Borehole', sortOrder: 110},
                ACTOR
            );
            assert.equal(created.is_active, true);

            await dictionaries.update(created.id, {isActive: false}, ACTOR);
            const active = await dictionaries.list({category: 'amenity'});
            assert.ok(!active.items.some((i) => i.code === 'test_borehole'));

            const all = await dictionaries.list({category: 'amenity', includeInactive: true});
            assert.ok(all.items.some((i) => i.code === 'test_borehole'));
        });

        test('rejects a duplicate code within a category', async () => {
            await assert.rejects(
                () => dictionaries.create({category: 'property_type', code: 'apartment', name: 'Dup'}, ACTOR),
                expectDomainError(ErrorCodes.CONFLICT)
            );
        });

        test('lists across every category when none is named', async () => {
            // Master data is searchable like any other entity, so the category
            // is a filter rather than a precondition.
            const {items} = await dictionaries.list({});
            const categories = new Set(items.map((item) => item.category));
            assert.ok(categories.size > 1, 'expected items from more than one category');
        });
    });

    // --- Settings ------------------------------------------------------------

    describe('settings', () => {
        test('lists seeded settings grouped by category', async () => {
            const {items, grouped} = await settings.list();
            assert.ok(items.length >= 10);
            assert.ok(grouped.commission);
            assert.ok(grouped.listings);
        });

        // `settings` rows are seeded by migration and deliberately survive the
        // per-test truncate (only their history is cleared), so these tests
        // derive the next value from the current one instead of hardcoding it
        // — otherwise a second run would write the value it already holds and
        // the trigger would correctly skip the history row.
        async function currentValue(key) {
            const {items} = await settings.list();
            return Number(items.find((s) => s.key === key).value);
        }

        test('updates a value and records history with the actor', async () => {
            const before = await currentValue('commission.platform_percentage');
            const next = before === 99 ? 98 : before + 1;

            const updated = await settings.update('commission.platform_percentage', {value: next}, ACTOR);
            assert.equal(Number(updated.value), next);
            assert.equal(updated.updated_by, ACTOR);

            const {items} = await settings.history('commission.platform_percentage');
            assert.equal(items.length, 1);
            assert.equal(Number(items[0].old_value), before);
            assert.equal(Number(items[0].new_value), next);
            assert.equal(items[0].changed_by, ACTOR);
        });

        test('the fee percentages must stay a number from 0 to 100', async () => {
            for (const bad of [101, -1, 'half', null, true]) {
                await assert.rejects(
                    settings.update('commission.tenant_fee_percentage', {value: bad}, ACTOR),
                    (error) => /percentage/.test(error.message)
                );
            }
            const updated = await settings.update('commission.tenant_fee_percentage', {value: '40'}, ACTOR);
            assert.equal(updated.value, 40, 'stored as a number, not the string the form sent');
            await settings.update('commission.tenant_fee_percentage', {value: 50}, ACTOR);
        });

        test('writing the same value again records no new history row', async () => {
            const next = (await currentValue('listing.min_photos')) + 1;
            await settings.update('listing.min_photos', {value: next}, ACTOR);
            await settings.update('listing.min_photos', {value: next}, ACTOR);

            const {items} = await settings.history('listing.min_photos');
            assert.equal(items.length, 1);
        });

        test('404s for an unknown key and rejects a missing value', async () => {
            await assert.rejects(
                () => settings.update('does.not.exist', {value: 1}, ACTOR),
                expectDomainError(ErrorCodes.NOT_FOUND)
            );
            await assert.rejects(
                () => settings.update('listing.min_photos', {}, ACTOR),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
        });
    });

    // --- Dashboard -----------------------------------------------------------

    describe('dashboard insights', () => {
        test('counts users, properties and organizations from the database view', async () => {
            const owner = await users.create(
                {fullName: 'KPI Owner', phoneNumber: '+255712000040', role: 'landlord'},
                ACTOR
            );
            await users.create({fullName: 'KPI Staff', email: 'kpi@homemate.co.tz', role: 'moderator'}, ACTOR);
            const org = await organizations.create({name: 'KPI Agency'}, ACTOR);
            const property = await properties.create(
                {
                    title: 'KPI listing',
                    ownerId: owner.id,
                    propertyTypeId: dictionaryIds.apartment,
                    regionId: dictionaryIds.dar_es_salaam,
                    price: 900000,
                    latitude: -6.8,
                    longitude: 39.28,
                },
                ACTOR
            );
            await properties.changeStatus(property.id, {status: 'pending_review'}, ACTOR);

            const {kpis} = await insights.dashboard();
            assert.equal(kpis.totalPlatformUsers, 1);
            assert.equal(kpis.totalStaffUsers, 1);
            assert.equal(kpis.pendingProperties, 1);
            assert.equal(kpis.activeProperties, 0);
            assert.equal(kpis.pendingOrganizations, 1);
            assert.ok(org.id);
        });

        test('surfaces recent audit activity with subject and actor', async () => {
            await users.create({fullName: 'Feed Me', phoneNumber: '+255712000041', role: 'customer'}, ACTOR);
            const {recentActivity} = await insights.dashboard();
            assert.ok(recentActivity.length >= 1);
            assert.equal(recentActivity[0].actor, ACTOR);
            assert.equal(recentActivity[0].subject, 'Feed Me');
        });

        test('audit log filters by table and paginates', async () => {
            await users.create({fullName: 'Audited One', phoneNumber: '+255712000042', role: 'customer'}, ACTOR);
            await organizations.create({name: 'Audited Org'}, ACTOR);

            const all = await insights.auditLog({});
            assert.ok(all.pagination.total >= 2);

            const orgsOnly = await insights.auditLog({tableName: 'organizations'});
            assert.equal(orgsOnly.pagination.total, 1);
            assert.equal(orgsOnly.items[0].subject, 'Audited Org');
        });
    });
});
