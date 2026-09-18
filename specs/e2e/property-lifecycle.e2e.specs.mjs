import {test, describe, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {start} from 'bfast-function';

/**
 * The admin's full property journey over real HTTP: create a listing, attach
 * the landlord/broker/agency, set amenities, add the charges that sit
 * alongside rent, upload a WebP image and its thumbnail, read the bytes back,
 * choose payment methods, then move it through moderation.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// A small but genuine WebP header, so the payload is the shape the browser
// would actually produce after canvas conversion.
const WEBP_BYTES = Buffer.concat([
    Buffer.from('RIFF'), Buffer.from([0x1a, 0, 0, 0]),
    Buffer.from('WEBPVP8 '), Buffer.from([0x0e, 0, 0, 0]),
    Buffer.from('homemate-test-image'),
]);

describe('journey: admin property lifecycle (e2e)', () => {
    /** @type {import('node:http').Server} */
    let server;
    let baseUrl;
    let db;
    let token;
    let ids = {};

    async function api(path, {method = 'GET', body, auth = true, raw = false} = {}) {
        const response = await fetch(`${baseUrl}${path}`, {
            method,
            headers: {
                ...(body ? {'content-type': 'application/json'} : {}),
                ...(auth ? {authorization: `Bearer ${token}`} : {}),
            },
            ...(body ? {body: JSON.stringify(body)} : {}),
        });
        if (raw) {
            return {
                status: response.status,
                contentType: response.headers.get('content-type'),
                body: Buffer.from(await response.arrayBuffer()),
            };
        }
        return {status: response.status, body: await response.json().catch(() => null)};
    }

    before(async () => {
        server = await start({
            port: process.env.PORT ?? '0',
            functionsConfig: {
                functionsDirPath: join(repoRoot, 'functions'),
                bfastJsonPath: join(repoRoot, 'bfast.json'),
            },
        });
        if (!server.listening) await once(server, 'listening');
        baseUrl = `http://127.0.0.1:${server.address().port}`;

        db = new pg.Client({connectionString: process.env.DATABASE_URL});
        await db.connect();

        const login = await api('/auth/admin/login', {
            method: 'POST',
            auth: false,
            body: {email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD},
        });
        token = login.body.token;

        const {rows} = await db.query(
            `select code, id from dictionary_items
              where code in ('apartment', 'dar_es_salaam', 'kinondoni', 'masaki', 'parking', 'security')`
        );
        ids = Object.fromEntries(rows.map((r) => [r.code, r.id]));
    });

    after(async () => {
        await db.end();
        await new Promise((resolve) => server.close(resolve));
        setImmediate(() => process.exit(0));
    });

    beforeEach(async () => {
        await db.query(
            `truncate table property_payment_methods, property_media, property_charges, property_amenities,
                            property_parties, properties, users, organizations restart identity cascade`
        );
        await db.query('truncate table audit_log restart identity');
    });

    async function seedPeople() {
        const landlord = await api('/admin/users', {
            method: 'POST',
            body: {fullName: 'Amina Landlord', phoneNumber: '+255714000001', role: 'landlord'},
        });
        const broker = await api('/admin/users', {
            method: 'POST',
            body: {fullName: 'Neema Broker', phoneNumber: '+255714000002', role: 'broker'},
        });
        const org = await api('/admin/organizations', {method: 'POST', body: {name: 'Masaki Realty'}});
        await api(`/admin/organizations/${org.body.id}/status`, {method: 'POST', body: {status: 'active'}});
        const agencyUser = await api('/admin/users', {
            method: 'POST',
            body: {
                fullName: 'Hassan Agency',
                phoneNumber: '+255714000003',
                role: 'agency',
                organizationId: org.body.id,
            },
        });
        return {landlord: landlord.body, broker: broker.body, agencyUser: agencyUser.body, org: org.body};
    }

    test('journey: create a fully specified listing, attribute it, and publish it', async () => {
        const {landlord, broker, agencyUser} = await seedPeople();

        // 1. the listing itself, with lease and payment terms
        const created = await api('/admin/properties', {
            method: 'POST',
            body: {
                title: 'Masaki 3BR Sea-view Apartment',
                description: 'Bright three-bedroom apartment with a sea view.',
                propertyTypeId: ids.apartment,
                listingType: 'rent',
                regionId: ids.dar_es_salaam,
                districtId: ids.kinondoni,
                wardId: ids.masaki,
                addressLine: 'Masaki, Kinondoni',
                latitude: -6.746,
                longitude: 39.2803,
                price: 1500000,
                bedrooms: 3,
                bathrooms: 2,
                sizeSqm: 145,
                furnishing: 'semi_furnished',
                parkingSpaces: 2,
                maxOccupants: 6,
                petsAllowed: true,
                paymentFrequency: 'quarterly',
                depositMonths: 2,
                advanceRentMonths: 3,
                minLeaseMonths: 6,
                maxLeaseMonths: 24,
                noticePeriodDays: 60,
                terms: 'Rent payable quarterly in advance.',
                houseRules: 'No loud music after 10pm.',
            },
        });
        assert.equal(created.status, 201);
        const propertyId = created.body.id;
        assert.match(created.body.reference_code, /^HM-P-\d{6}$/);
        assert.equal(created.body.payment_months, 3);
        assert.equal(Number(created.body.amount_per_instalment), 4500000);
        assert.equal(Number(created.body.deposit_amount), 3000000);

        // 2. attribution
        assert.equal(
            (await api(`/admin/properties/${propertyId}/parties`, {
                method: 'POST',
                body: {userId: landlord.id, role: 'landlord', isPrimary: true},
            })).status,
            201
        );
        await api(`/admin/properties/${propertyId}/parties`, {
            method: 'POST',
            body: {userId: broker.id, role: 'broker', commissionPercentage: 5, isPrimary: true},
        });
        await api(`/admin/properties/${propertyId}/parties`, {
            method: 'POST',
            body: {userId: agencyUser.id, role: 'agency', isPrimary: true},
        });

        // a customer account cannot fill the broker slot
        const wrongSlot = await api('/admin/users', {
            method: 'POST',
            body: {fullName: 'Juma Customer', phoneNumber: '+255714000009', role: 'customer'},
        });
        const refused = await api(`/admin/properties/${propertyId}/parties`, {
            method: 'POST',
            body: {userId: wrongSlot.body.id, role: 'broker'},
        });
        assert.equal(refused.status, 422);

        // 3. amenities
        const amenities = await api(`/admin/properties/${propertyId}/amenities`, {
            method: 'PUT',
            body: {amenityIds: [ids.parking, ids.security]},
        });
        assert.equal(amenities.status, 200);
        assert.equal(amenities.body.items.length, 2);

        // 4. charges alongside rent
        await api(`/admin/properties/${propertyId}/charges`, {
            method: 'POST',
            body: {name: 'Service charge', amount: 120000, frequency: 'monthly'},
        });
        await api(`/admin/properties/${propertyId}/charges`, {
            method: 'POST',
            body: {name: 'Garbage collection', amount: 60000, frequency: 'quarterly'},
        });
        const deposit = await api(`/admin/properties/${propertyId}/charges`, {
            method: 'POST',
            body: {name: 'Key deposit', amount: 50000, frequency: 'one_time', isRefundable: true},
        });
        assert.equal(deposit.status, 201);

        // 5. media: WebP image + WebP thumbnail
        const uploaded = await api(`/admin/properties/${propertyId}/media`, {
            method: 'POST',
            body: {
                image: {base64: WEBP_BYTES.toString('base64'), name: 'front.webp', contentType: 'image/webp'},
                thumbnail: {base64: WEBP_BYTES.toString('base64'), name: 'front-thumb.webp', contentType: 'image/webp'},
                caption: 'Front elevation',
                width: 1600,
                height: 1200,
            },
        });
        assert.equal(uploaded.status, 201);
        const mediaId = uploaded.body.items[0].id;
        assert.equal(uploaded.body.items[0].is_cover, true, 'the first image becomes the cover');

        // a JPEG is refused — conversion is the browser's job
        const jpeg = await api(`/admin/properties/${propertyId}/media`, {
            method: 'POST',
            body: {image: {base64: 'AAAA', name: 'x.jpg', contentType: 'image/jpeg'}},
        });
        assert.equal(jpeg.status, 400);

        // 6. the bytes come back through our API, not a storage URL
        const raw = await api(`/admin/media/${mediaId}/raw`, {raw: true});
        assert.equal(raw.status, 200);
        assert.equal(raw.contentType, 'image/webp');
        assert.deepEqual(raw.body, WEBP_BYTES, 'byte-identical round trip');

        const thumb = await api(`/admin/media/${mediaId}/raw?thumbnail=1`, {raw: true});
        assert.equal(thumb.status, 200);
        assert.equal(thumb.contentType, 'image/webp');

        // and it is closed to anonymous callers
        const anonymous = await fetch(`${baseUrl}/admin/media/${mediaId}/raw`);
        assert.equal(anonymous.status, 401);

        // 7. accepted payment methods
        const methods = await api('/admin/payment-methods?activeOnly=true');
        const chosen = methods.body.items.slice(0, 2).map((m) => m.id);
        const accepted = await api(`/admin/properties/${propertyId}/payment-methods`, {
            method: 'PUT',
            body: {paymentMethodIds: chosen},
        });
        assert.equal(accepted.body.items.length, 2);

        // 8. the detail read returns everything in one call
        const detail = await api(`/admin/properties/${propertyId}`);
        assert.equal(detail.body.parties.length, 3);
        assert.equal(detail.body.amenities.length, 2);
        assert.equal(detail.body.charges.length, 3);
        assert.equal(detail.body.media.length, 1);
        assert.equal(detail.body.paymentMethods.length, 2);
        assert.equal(detail.body.landlord_name, 'Amina Landlord');
        assert.equal(detail.body.broker_name, 'Neema Broker');
        // 1,500,000 rent + 120,000 monthly + 60,000/3 quarterly
        assert.equal(Number(detail.body.total_monthly_cost), 1640000);
        assert.equal(Number(detail.body.one_time_charges_total), 50000);

        // 9. moderation to published
        await api(`/admin/properties/${propertyId}/status`, {method: 'POST', body: {status: 'pending_review'}});
        const approved = await api(`/admin/properties/${propertyId}/status`, {
            method: 'POST',
            body: {status: 'approved'},
        });
        assert.equal(approved.body.status, 'approved');
        assert.equal(approved.body.reviewed_by, process.env.ADMIN_EMAIL);
    });

    test('amenity and facet filters narrow the registry search', async () => {
        const created = await api('/admin/properties', {
            method: 'POST',
            body: {
                title: 'Secure parking flat',
                price: 900000,
                furnishing: 'fully_furnished',
                paymentFrequency: 'annual',
                latitude: -6.75,
                longitude: 39.28,
            },
        });
        await api(`/admin/properties/${created.body.id}/amenities`, {
            method: 'PUT',
            body: {amenityIds: [ids.parking, ids.security]},
        });
        await api('/admin/properties', {
            method: 'POST',
            body: {title: 'Plain studio', price: 400000, furnishing: 'unfurnished'},
        });

        assert.equal((await api(`/admin/properties?amenityIds=${ids.parking}`)).body.pagination.total, 1);
        assert.equal(
            (await api(`/admin/properties?amenityIds=${ids.parking},${ids.security}`)).body.pagination.total,
            1
        );
        assert.equal((await api('/admin/properties?furnishing=fully_furnished')).body.pagination.total, 1);
        assert.equal((await api('/admin/properties?paymentFrequency=annual')).body.pagination.total, 1);
        assert.equal((await api('/admin/properties?furnishing=semi_furnished')).body.pagination.total, 0);
    });

    test('payment methods can be configured, and a bad provider is refused', async () => {
        const list = await api('/admin/payment-methods');
        assert.ok(list.body.items.some((m) => m.code === 'mpesa'));
        assert.ok(list.body.availableProviders.includes('sandbox'));

        const bad = await api('/admin/payment-methods', {
            method: 'POST',
            body: {code: 'test_stripe', name: 'Stripe', kind: 'card', provider: 'stripe'},
        });
        assert.equal(bad.status, 400, 'no adapter is registered for that provider');

        const created = await api('/admin/payment-methods', {
            method: 'POST',
            body: {code: 'test_halopesa', name: 'HaloPesa', kind: 'mobile_money', provider: 'sandbox'},
        });
        assert.equal(created.status, 201);
        assert.equal(created.body.is_active, false);

        const activated = await api(`/admin/payment-methods/${created.body.id}`, {
            method: 'PATCH',
            body: {isActive: true, config: {shortCode: '998877'}},
        });
        assert.equal(activated.body.is_active, true);

        await db.query("delete from payment_methods where code = 'test_halopesa'");
    });

    test('geocoding search validates its input before calling the provider', async () => {
        const tooShort = await api('/admin/geocode?q=ma');
        assert.equal(tooShort.status, 400);

        const badCoords = await api('/admin/geocode/reverse?latitude=abc&longitude=39');
        assert.equal(badCoords.status, 400);
    });
});
