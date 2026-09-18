import {test, describe, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createUsersService} from './users.mjs';
import {createOrganizationsService} from './organizations.mjs';
import {createPropertiesService} from './properties.mjs';
import {createPropertyDetailsService} from './property-details.mjs';
import {createPaymentMethodsService} from './payment-methods.mjs';
import {createMemoryStorageAdapter} from '../storage/adapters/memory-storage.adapter.mjs';
import {createSandboxPaymentAdapter} from '../payments/adapters/sandbox-payment.adapter.mjs';
import {ErrorCodes} from '../../shared/errors.mjs';

const ACTOR = 'admin@homemate.co.tz';

function expectDomainError(code) {
    return (error) => {
        assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
        return true;
    };
}

/** A tiny valid-enough WebP payload; the service only cares about type + bytes. */
function webp(label) {
    return {name: `${label}.webp`, contentType: 'image/webp', body: Buffer.from(`RIFF----WEBPVP8 ${label}`)};
}

describe('property details (Postgres integration)', () => {
    /** @type {pg.Pool} */
    let pool;
    let users;
    let organizations;
    let properties;
    let details;
    let paymentMethods;
    let storage;
    let dictionaryIds;
    let amenityIds;

    before(async () => {
        pool = new pg.Pool({connectionString: process.env.DATABASE_URL});
        users = createUsersService({pool});
        organizations = createOrganizationsService({pool});
        properties = createPropertiesService({pool});
        storage = createMemoryStorageAdapter();
        details = createPropertyDetailsService({pool, storagePort: storage});
        paymentMethods = createPaymentMethodsService({
            pool,
            paymentPorts: {sandbox: createSandboxPaymentAdapter(), manual: createSandboxPaymentAdapter()},
        });

        const {rows} = await pool.query(
            `select code, id, category from dictionary_items
              where code in ('apartment', 'dar_es_salaam', 'parking', 'security', 'generator')`
        );
        dictionaryIds = Object.fromEntries(rows.map((r) => [r.code, r.id]));
        amenityIds = rows.filter((r) => r.category === 'amenity').map((r) => r.id);
    });

    after(async () => {
        await pool.end();
    });

    beforeEach(async () => {
        await pool.query(
            `truncate table property_payment_methods, property_media, property_charges, property_amenities,
                            property_parties, properties, users, organizations restart identity cascade`
        );
        await pool.query("delete from payment_methods where code like 'test\\_%'");
        await pool.query('truncate table audit_log restart identity');
    });

    async function createLandlord(phone = '+255713000001') {
        return users.create({fullName: 'Amina Landlord', phoneNumber: phone, role: 'landlord'}, ACTOR);
    }

    async function createBroker(phone = '+255713000002') {
        return users.create({fullName: 'Neema Broker', phoneNumber: phone, role: 'broker'}, ACTOR);
    }

    async function createAgencyUser(phone = '+255713000003') {
        const org = await organizations.create({name: 'Masaki Realty'}, ACTOR);
        await organizations.changeStatus(org.id, {status: 'active'}, ACTOR);
        const user = await users.create(
            {fullName: 'Hassan Agency', phoneNumber: phone, role: 'agency', organizationId: org.id},
            ACTOR
        );
        return {org, user};
    }

    async function createProperty(overrides = {}) {
        return properties.create(
            {
                title: 'Masaki 3BR Apartment',
                propertyTypeId: dictionaryIds.apartment,
                regionId: dictionaryIds.dar_es_salaam,
                price: 1500000,
                latitude: -6.746,
                longitude: 39.2803,
                ...overrides,
            },
            ACTOR
        );
    }

    // --- Lease & payment terms ----------------------------------------------

    describe('lease and payment terms', () => {
        test('stores terms at creation and derives instalment/deposit amounts', async () => {
            const property = await createProperty({
                price: 1200000,
                paymentFrequency: 'quarterly',
                depositMonths: 2,
                advanceRentMonths: 3,
                minLeaseMonths: 6,
                maxLeaseMonths: 24,
                noticePeriodDays: 60,
                furnishing: 'semi_furnished',
                petsAllowed: true,
                maxOccupants: 5,
                terms: 'Rent payable in advance each quarter.',
                houseRules: 'No loud music after 10pm.',
            });

            assert.equal(property.payment_frequency, 'quarterly');
            assert.equal(property.payment_months, 3);
            assert.equal(Number(property.amount_per_instalment), 3600000, 'three months of rent');
            assert.equal(Number(property.deposit_amount), 2400000, 'two months of rent');
            assert.equal(property.furnishing, 'semi_furnished');
            assert.equal(property.pets_allowed, true);
            assert.equal(property.notice_period_days, 60);
        });

        test('a custom payment frequency must say how many months it covers', async () => {
            await assert.rejects(
                () => createProperty({paymentFrequency: 'custom'}),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );

            const property = await createProperty({paymentFrequency: 'custom', customPaymentMonths: 4, price: 500000});
            assert.equal(property.payment_months, 4);
            assert.equal(Number(property.amount_per_instalment), 2000000);
        });

        test('database refuses an inverted lease range and an impossible floor', async () => {
            await assert.rejects(
                () => createProperty({minLeaseMonths: 12, maxLeaseMonths: 6}),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
            await assert.rejects(
                () => createProperty({floorNumber: 9, totalFloors: 4}),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
        });

        test('terms can be edited after creation', async () => {
            const property = await createProperty();
            const updated = await properties.update(
                property.id,
                {paymentFrequency: 'annual', depositMonths: 1, houseRules: 'No pets.'},
                ACTOR
            );
            assert.equal(updated.payment_frequency, 'annual');
            assert.equal(updated.payment_months, 12);
            assert.equal(updated.house_rules, 'No pets.');
        });
    });

    // --- Party attribution ---------------------------------------------------

    describe('party attribution', () => {
        test('assigns a landlord, broker and agency and reports them on the property', async () => {
            const property = await createProperty();
            const landlord = await createLandlord();
            const broker = await createBroker();
            const {user: agencyUser} = await createAgencyUser();

            await details.assignParty(property.id, {userId: landlord.id, role: 'landlord', isPrimary: true}, ACTOR);
            await details.assignParty(
                property.id,
                {userId: broker.id, role: 'broker', commissionPercentage: 5, isPrimary: true},
                ACTOR
            );
            await details.assignParty(property.id, {userId: agencyUser.id, role: 'agency', isPrimary: true}, ACTOR);

            const full = await properties.getById(property.id);
            assert.equal(full.parties.length, 3);
            assert.equal(full.landlord_name, 'Amina Landlord');
            assert.equal(full.broker_name, 'Neema Broker');
            assert.equal(full.owner_id, landlord.id, 'primary landlord backfills the owner column');
            assert.ok(full.organization_id, 'agency assignment backfills the organization');
        });

        test('the database refuses a party whose account role does not fit the slot', async () => {
            const property = await createProperty();
            const customer = await users.create(
                {fullName: 'Juma Customer', phoneNumber: '+255713000010', role: 'customer'},
                ACTOR
            );

            await assert.rejects(
                () => details.assignParty(property.id, {userId: customer.id, role: 'broker'}, ACTOR),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );

            const landlord = await createLandlord('+255713000011');
            await assert.rejects(
                () => details.assignParty(property.id, {userId: landlord.id, role: 'broker'}, ACTOR),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
        });

        test('only one primary party per role', async () => {
            const property = await createProperty();
            const first = await createBroker('+255713000020');
            const second = await createBroker('+255713000021');

            await details.assignParty(property.id, {userId: first.id, role: 'broker', isPrimary: true}, ACTOR);
            await assert.rejects(
                () => details.assignParty(property.id, {userId: second.id, role: 'broker', isPrimary: true}, ACTOR),
                expectDomainError(ErrorCodes.CONFLICT)
            );
        });

        test('re-assigning the same party updates rather than failing', async () => {
            const property = await createProperty();
            const broker = await createBroker('+255713000030');

            await details.assignParty(property.id, {userId: broker.id, role: 'broker', commissionPercentage: 5}, ACTOR);
            const {items} = await details.assignParty(
                property.id,
                {userId: broker.id, role: 'broker', commissionPercentage: 7.5},
                ACTOR
            );

            const brokerParty = items.find((p) => p.role === 'broker');
            assert.equal(items.filter((p) => p.role === 'broker').length, 1);
            assert.equal(Number(brokerParty.commission_percentage), 7.5);
        });

        test('rejects an out-of-range commission and an unknown role', async () => {
            const property = await createProperty();
            const broker = await createBroker('+255713000031');

            await assert.rejects(
                () => details.assignParty(property.id, {userId: broker.id, role: 'broker', commissionPercentage: 140}, ACTOR),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
            await assert.rejects(
                () => details.assignParty(property.id, {userId: broker.id, role: 'janitor'}, ACTOR),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
        });

        test('a party can be removed', async () => {
            const property = await createProperty();
            const broker = await createBroker('+255713000032');
            const assigned = await details.assignParty(property.id, {userId: broker.id, role: 'broker'}, ACTOR);

            const after = await details.removeParty(property.id, assigned.id, ACTOR);
            assert.equal(after.items.length, 0);
            await assert.rejects(
                () => details.removeParty(property.id, assigned.id, ACTOR),
                expectDomainError(ErrorCodes.NOT_FOUND)
            );
        });
    });

    // --- Amenities -----------------------------------------------------------

    describe('amenities', () => {
        test('sets and replaces the amenity set', async () => {
            const property = await createProperty();

            const first = await details.setAmenities(property.id, amenityIds.slice(0, 2), ACTOR);
            assert.equal(first.items.length, 2);

            const replaced = await details.setAmenities(property.id, [amenityIds[0]], ACTOR);
            assert.equal(replaced.items.length, 1);

            const cleared = await details.setAmenities(property.id, [], ACTOR);
            assert.equal(cleared.items.length, 0);
        });

        test('the database refuses a dictionary item that is not an amenity', async () => {
            const property = await createProperty();
            await assert.rejects(
                () => details.setAmenities(property.id, [dictionaryIds.dar_es_salaam], ACTOR),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
        });

        test('amenity filters require every requested amenity, not any', async () => {
            const withBoth = await createProperty({title: 'Has parking and security'});
            const withOne = await createProperty({title: 'Has parking only'});
            await details.setAmenities(withBoth.id, [dictionaryIds.parking, dictionaryIds.security], ACTOR);
            await details.setAmenities(withOne.id, [dictionaryIds.parking], ACTOR);

            const both = await properties.search({amenityIds: [dictionaryIds.parking, dictionaryIds.security]});
            assert.equal(both.pagination.total, 1);
            assert.equal(both.items[0].title, 'Has parking and security');

            const parkingOnly = await properties.search({amenityIds: [dictionaryIds.parking]});
            assert.equal(parkingOnly.pagination.total, 2);
        });
    });

    // --- Charges -------------------------------------------------------------

    describe('charges', () => {
        test('adds charges and rolls them into the total monthly cost', async () => {
            const property = await createProperty({price: 1000000});

            await details.addCharge(property.id, {name: 'Service charge', amount: 50000, frequency: 'monthly'}, ACTOR);
            await details.addCharge(property.id, {name: 'Garbage', amount: 60000, frequency: 'quarterly'}, ACTOR);
            await details.addCharge(
                property.id,
                {name: 'Optional gym', amount: 30000, frequency: 'monthly', isMandatory: false},
                ACTOR
            );
            await details.addCharge(
                property.id,
                {name: 'Key deposit', amount: 25000, frequency: 'one_time', isRefundable: true},
                ACTOR
            );

            const full = await properties.getById(property.id);
            assert.equal(full.charges.length, 4);
            // 1,000,000 rent + 50,000 monthly + (60,000 / 3) quarterly; optional
            // and one-time charges are excluded from the recurring total
            assert.equal(Number(full.total_monthly_cost), 1070000);
            assert.equal(Number(full.one_time_charges_total), 25000);
        });

        test('rejects a charge with no name or a non-numeric amount', async () => {
            const property = await createProperty();
            await assert.rejects(
                () => details.addCharge(property.id, {amount: 1000}, ACTOR),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
            await assert.rejects(
                () => details.addCharge(property.id, {name: 'Bad', amount: 'lots'}, ACTOR),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
        });

        test('the database refuses a negative charge', async () => {
            const property = await createProperty();
            await assert.rejects(
                () => details.addCharge(property.id, {name: 'Refund', amount: -500}, ACTOR),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
        });

        test('removes a charge and updates the total', async () => {
            const property = await createProperty({price: 1000000});
            const {items} = await details.addCharge(
                property.id,
                {name: 'Service charge', amount: 50000, frequency: 'monthly'},
                ACTOR
            );

            await details.removeCharge(property.id, items[0].id, ACTOR);
            const full = await properties.getById(property.id);
            assert.equal(Number(full.total_monthly_cost), 1000000);
        });
    });

    // --- Media ---------------------------------------------------------------

    describe('media', () => {
        test('stores the image and its thumbnail through the StoragePort', async () => {
            const property = await createProperty();
            const sizeBefore = storage.size;

            const result = await details.addImage(
                property.id,
                {image: webp('front'), thumbnail: webp('front-thumb'), caption: 'Front elevation'},
                ACTOR
            );

            assert.equal(storage.size, sizeBefore + 2, 'both the image and the thumbnail are stored');
            const image = result.items[0];
            assert.ok(image.url);
            assert.ok(image.thumbnail_url);
            assert.equal(image.content_type, 'image/webp');
            assert.equal(image.caption, 'Front elevation');
        });

        test('refuses anything that is not WebP', async () => {
            const property = await createProperty();
            await assert.rejects(
                () => details.addImage(property.id, {image: {name: 'a.jpg', contentType: 'image/jpeg', body: Buffer.from('x')}}, ACTOR),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
            await assert.rejects(
                () => details.addImage(property.id, {image: webp('ok'), thumbnail: {name: 't.png', contentType: 'image/png', body: Buffer.from('x')}}, ACTOR),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
            await assert.rejects(
                () => details.addImage(property.id, {}, ACTOR),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
        });

        test('the first image becomes the cover automatically', async () => {
            const property = await createProperty();
            await details.addImage(property.id, {image: webp('one'), thumbnail: webp('one-t')}, ACTOR);
            const second = await details.addImage(property.id, {image: webp('two'), thumbnail: webp('two-t')}, ACTOR);

            const covers = second.items.filter((m) => m.is_cover);
            assert.equal(covers.length, 1);
            assert.equal(covers[0].caption, null);
            const full = await properties.getById(property.id);
            assert.ok(full.cover_media_id, 'the property reports a cover image');
        });

        test('setting a new cover clears the previous one', async () => {
            const property = await createProperty();
            await details.addImage(property.id, {image: webp('one')}, ACTOR);
            const added = await details.addImage(property.id, {image: webp('two')}, ACTOR);
            const secondId = added.items.find((m) => !m.is_cover).id;

            const after = await details.setCoverImage(property.id, secondId, ACTOR);
            const covers = after.items.filter((m) => m.is_cover);
            assert.equal(covers.length, 1);
            assert.equal(covers[0].id, secondId);
        });

        test('reads image bytes back through the storage port', async () => {
            const property = await createProperty();
            const added = await details.addImage(
                property.id,
                {image: webp('readable'), thumbnail: webp('readable-thumb')},
                ACTOR
            );
            const mediaId = added.items[0].id;

            const original = await details.readImage(mediaId);
            assert.equal(original.contentType, 'image/webp');
            assert.match(original.body.toString(), /readable/);

            const thumb = await details.readImage(mediaId, {thumbnail: true});
            assert.match(thumb.body.toString(), /readable-thumb/);
        });

        test('404s for an unknown image and for a removed one', async () => {
            const property = await createProperty();
            const added = await details.addImage(property.id, {image: webp('gone')}, ACTOR);
            const mediaId = added.items[0].id;

            await details.removeImage(property.id, mediaId, ACTOR);
            await assert.rejects(() => details.readImage(mediaId), expectDomainError(ErrorCodes.NOT_FOUND));
            await assert.rejects(
                () => details.removeImage(property.id, mediaId, ACTOR),
                expectDomainError(ErrorCodes.NOT_FOUND)
            );
        });
    });

    // --- Payment methods -----------------------------------------------------

    describe('payment methods', () => {
        test('lists seeded methods and the registered provider adapters', async () => {
            const {items, availableProviders} = await paymentMethods.list();
            assert.ok(items.some((m) => m.code === 'mpesa'));
            assert.deepEqual(availableProviders.sort(), ['manual', 'sandbox']);
        });

        test('filters to active methods only', async () => {
            const {items} = await paymentMethods.list({activeOnly: true});
            assert.ok(items.length > 0);
            assert.ok(items.every((m) => m.is_active));
            assert.ok(!items.some((m) => m.code === 'cash'), 'cash is seeded inactive');
        });

        test('refuses a method pointed at an unregistered provider', async () => {
            await assert.rejects(
                () => paymentMethods.create({code: 'test_x', name: 'X', kind: 'card', provider: 'stripe'}, ACTOR),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
        });

        test('creates, activates and reconfigures a method', async () => {
            const created = await paymentMethods.create(
                {code: 'test_halopesa', name: 'HaloPesa', kind: 'mobile_money', provider: 'sandbox'},
                ACTOR
            );
            assert.equal(created.is_active, false, 'new methods start disabled');

            const activated = await paymentMethods.update(
                created.id,
                {isActive: true, config: {shortCode: '123456'}},
                ACTOR
            );
            assert.equal(activated.is_active, true);
            assert.deepEqual(activated.config, {shortCode: '123456'});
        });

        test('rejects a duplicate code and an unknown id', async () => {
            await assert.rejects(
                () => paymentMethods.create({code: 'mpesa', name: 'Dup', kind: 'mobile_money'}, ACTOR),
                expectDomainError(ErrorCodes.CONFLICT)
            );
            await assert.rejects(
                () => paymentMethods.update('00000000-0000-0000-0000-000000000000', {isActive: true}, ACTOR),
                expectDomainError(ErrorCodes.NOT_FOUND)
            );
        });

        test('a property can accept a specific subset of methods', async () => {
            const property = await createProperty();
            const {items} = await paymentMethods.list({activeOnly: true});
            const chosen = items.slice(0, 2).map((m) => m.id);

            const set = await details.setPaymentMethods(property.id, chosen, ACTOR);
            assert.equal(set.items.length, 2);

            const full = await properties.getById(property.id);
            assert.equal(full.paymentMethods.length, 2);

            const cleared = await details.setPaymentMethods(property.id, [], ACTOR);
            assert.equal(cleared.items.length, 0);
        });
    });

    // --- Attribution is audited ---------------------------------------------

    test('party, amenity, charge and media changes are all audited with the actor', async () => {
        const property = await createProperty();
        const broker = await createBroker('+255713000099');
        await details.assignParty(property.id, {userId: broker.id, role: 'broker'}, ACTOR);
        await details.addCharge(property.id, {name: 'Water', amount: 20000}, ACTOR);

        const {rows} = await pool.query(
            `select table_name, operation, actor from audit_log
              where table_name in ('property_parties', 'property_charges') order by id`
        );
        assert.equal(rows.length, 2);
        assert.ok(rows.every((r) => r.actor === ACTOR));
    });
});
