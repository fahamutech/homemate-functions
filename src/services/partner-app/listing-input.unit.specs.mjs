import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {readListingInput, maskName, describeSubmitBlockers} from './listing-input.mjs';

/**
 * What a partner may write about a listing from the wizard (BRK-030a–g):
 * the home and its terms, amenities, charges, photo order and — for a
 * broker — the landlord. Never its status, owner or organisation: those are
 * the moderator's and the database's.
 */

describe('readListingInput', () => {
    test('keeps the home, location and terms fields', () => {
        const {property} = readListingInput({
            title: 'Masaki 2BR',
            description: 'Sea view',
            propertyTypeId: 't-1',
            price: 800000,
            bedrooms: 2,
            bathrooms: 1,
            sizeSqm: 90,
            addressLine: 'Masaki',
            regionId: 'r-1',
            districtId: 'd-1',
            wardId: 'w-1',
            latitude: -6.75,
            longitude: 39.27,
            furnishing: 'furnished',
            depositMonths: 2,
            minLeaseMonths: 6,
            paymentFrequency: 'quarterly',
            houseRules: 'No parties',
        });
        assert.equal(property.title, 'Masaki 2BR');
        assert.equal(property.latitude, -6.75);
        assert.equal(property.depositMonths, 2);
        assert.equal(property.houseRules, 'No parties');
    });

    test('drops what a partner may not set', () => {
        const {property} = readListingInput({
            title: 'x',
            status: 'approved',
            ownerId: 'someone',
            organizationId: 'org',
            listingType: 'sale',
            currency: 'USD',
            referenceCode: 'HM-P-1',
            createdByUserId: 'u-9',
        });
        assert.deepEqual(Object.keys(property), ['title']);
    });

    test('amenities, charges, photo order and landlord are read separately', () => {
        const input = readListingInput({
            amenityIds: ['a-1', 'a-2'],
            charges: [{name: 'Water', amount: 20000}],
            photoOrder: ['m-2', 'm-1'],
            landlordUserId: 'l-1',
        });
        assert.deepEqual(input.amenityIds, ['a-1', 'a-2']);
        assert.deepEqual(input.charges, [{name: 'Water', amount: 20000}]);
        assert.deepEqual(input.photoOrder, ['m-2', 'm-1']);
        assert.equal(input.landlordUserId, 'l-1');
        assert.deepEqual(input.property, {});
    });

    test('lists that are not lists are refused', () => {
        for (const key of ['amenityIds', 'charges', 'photoOrder']) {
            assert.throws(() => readListingInput({[key]: 'nope'}), (error) => error.code === 'VALIDATION_FAILED' && error.message.includes(key));
        }
    });

    test('absent lists stay undefined, so an edit does not wipe them', () => {
        const input = readListingInput({title: 'x'});
        assert.equal(input.amenityIds, undefined);
        assert.equal(input.charges, undefined);
        assert.equal(input.photoOrder, undefined);
        assert.equal(input.landlordUserId, undefined);
    });
});

describe('maskName', () => {
    test('first name and the initial of the last', () => {
        assert.equal(maskName('Neema Kileo'), 'Neema K.');
        assert.equal(maskName('  Amina  Juma  Salim '), 'Amina S.');
        assert.equal(maskName('Baraka'), 'Baraka');
    });

    test('no name is null', () => {
        assert.equal(maskName(null), null);
        assert.equal(maskName('  '), null);
    });
});

describe('describeSubmitBlockers', () => {
    test('each blocker code has a sentence, in the order given', () => {
        const described = describeSubmitBlockers(['missing_price', 'no_photos', 'landlord_pending']);
        assert.deepEqual(described.map((b) => b.code), ['missing_price', 'no_photos', 'landlord_pending']);
        for (const blocker of described) assert.ok(blocker.message.length > 10, blocker.code);
    });

    test('an unknown code still reads as something', () => {
        assert.deepEqual(describeSubmitBlockers(['something_new']), [{code: 'something_new', message: 'something new'}]);
    });
});
