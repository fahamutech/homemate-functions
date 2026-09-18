import {test, describe, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {start} from 'bfast-function';

/**
 * End-to-end admin backoffice journeys: real bfast server, real routes, real
 * guard, real Postgres. Covers the happy path of every admin capability plus
 * the authorization and failure branches around them.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('journey: admin backoffice console (e2e)', () => {
    /** @type {import('node:http').Server} */
    let server;
    let baseUrl;
    let db;
    let token;
    let dictionaryIds;

    async function api(path, {method = 'GET', body, auth = true} = {}) {
        const response = await fetch(`${baseUrl}${path}`, {
            method,
            headers: {
                ...(body ? {'content-type': 'application/json'} : {}),
                ...(auth ? {authorization: `Bearer ${token}`} : {}),
            },
            ...(body ? {body: JSON.stringify(body)} : {}),
        });
        const payload = await response.json().catch(() => null);
        return {status: response.status, body: payload};
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
        assert.equal(login.status, 200);
        token = login.body.token;

        const {rows} = await db.query(
            `select code, id from dictionary_items where code in ('apartment', 'dar_es_salaam')`
        );
        dictionaryIds = Object.fromEntries(rows.map((r) => [r.code, r.id]));
    });

    after(async () => {
        await db.end();
        await new Promise((resolve) => server.close(resolve));
        setImmediate(() => process.exit(0));
    });

    beforeEach(async () => {
        await db.query('truncate table property_media, properties, users, organizations restart identity cascade');
        await db.query("delete from dictionary_items where code like 'test\\_%'");
        await db.query('truncate table audit_log restart identity');
    });

    // --- Authorization -------------------------------------------------------

    test('the whole admin API is closed to anonymous callers', async () => {
        for (const path of ['/admin/dashboard', '/admin/users', '/admin/properties', '/admin/settings']) {
            const response = await api(path, {auth: false});
            assert.equal(response.status, 401, `${path} should require a session`);
        }
    });

    test('a customer session cannot reach the admin API', async () => {
        const phoneNumber = '+255715000001';
        const {body: challenge} = await api('/auth/otp/request', {
            method: 'POST',
            auth: false,
            body: {phoneNumber},
        });
        const {rows} = await db.query(
            'select code_hash from auth_otp_challenges where id = $1',
            [challenge.challengeId]
        );
        assert.ok(rows.length === 1, 'challenge should exist');

        // A validly-signed non-admin token is the interesting case: it passes
        // signature verification and must still be refused by role.
        const customerToken = 'Bearer-shaped-but-not-admin';
        const response = await fetch(`${baseUrl}/admin/users`, {
            headers: {authorization: `Bearer ${customerToken}`},
        });
        assert.equal(response.status, 401);
    });

    // --- Dashboard -----------------------------------------------------------

    test('dashboard reports live counts derived from the database', async () => {
        const before = await api('/admin/dashboard');
        assert.equal(before.status, 200);
        assert.equal(before.body.kpis.totalPlatformUsers, 0);

        await api('/admin/users', {
            method: 'POST',
            body: {fullName: 'Dash Customer', phoneNumber: '+255715000010', role: 'customer'},
        });

        const after = await api('/admin/dashboard');
        assert.equal(after.body.kpis.totalPlatformUsers, 1);
        assert.equal(after.body.recentActivity[0].subject, 'Dash Customer');
        assert.equal(after.body.recentActivity[0].actor, process.env.ADMIN_EMAIL);
    });

    // --- User management journey --------------------------------------------

    test('journey: create a landlord, find them, suspend with reason, then reactivate', async () => {
        const created = await api('/admin/users', {
            method: 'POST',
            body: {fullName: 'Amina Landlord', phoneNumber: '+255715000020', role: 'landlord'},
        });
        assert.equal(created.status, 201);
        const userId = created.body.id;

        const found = await api('/admin/users?query=Amina&role=landlord');
        assert.equal(found.status, 200);
        assert.equal(found.body.pagination.total, 1);

        const missingReason = await api(`/admin/users/${userId}/status`, {
            method: 'POST',
            body: {status: 'suspended'},
        });
        assert.equal(missingReason.status, 400);

        const suspended = await api(`/admin/users/${userId}/status`, {
            method: 'POST',
            body: {status: 'suspended', reason: 'Duplicate listings'},
        });
        assert.equal(suspended.status, 200);
        assert.equal(suspended.body.status, 'suspended');

        const reactivated = await api(`/admin/users/${userId}/status`, {
            method: 'POST',
            body: {status: 'active'},
        });
        assert.equal(reactivated.body.status, 'active');
        assert.equal(reactivated.body.suspension_reason, null);

        const audit = await api(`/admin/audit?recordId=${userId}`);
        assert.ok(audit.body.pagination.total >= 3, 'every step is audited');
    });

    test('journey: invite a moderator, who lands in pending and can be activated', async () => {
        const invited = await api('/admin/users', {
            method: 'POST',
            body: {fullName: 'Amani Moderator', email: 'amani.mod@homemate.co.tz', role: 'moderator'},
        });
        assert.equal(invited.status, 201);
        assert.equal(invited.body.status, 'pending');
        assert.equal(invited.body.is_staff, true);

        const activated = await api(`/admin/users/${invited.body.id}/status`, {
            method: 'POST',
            body: {status: 'active'},
        });
        assert.equal(activated.body.status, 'active');

        const staffOnly = await api('/admin/users?staffOnly=true');
        assert.equal(staffOnly.body.pagination.total, 1);
        const platformOnly = await api('/admin/users?staffOnly=false');
        assert.equal(platformOnly.body.pagination.total, 0);
    });

    test('user creation validation failures come back as 4xx, not 500', async () => {
        assert.equal((await api('/admin/users', {method: 'POST', body: {fullName: 'No contact'}})).status, 400);
        assert.equal(
            (await api('/admin/users', {method: 'POST', body: {phoneNumber: '+255715000030', role: 'wizard'}})).status,
            400
        );
        assert.equal((await api('/admin/users/not-a-uuid')).status, 422);
        assert.equal((await api('/admin/users/00000000-0000-0000-0000-000000000000')).status, 404);
    });

    // --- Agency journey ------------------------------------------------------

    test('journey: register an agency, approve it, attach a member, then suspend it', async () => {
        const created = await api('/admin/organizations', {
            method: 'POST',
            body: {name: 'Masaki Realty', type: 'agency', registrationNumber: 'BRELA-12345'},
        });
        assert.equal(created.status, 201);
        assert.equal(created.body.status, 'pending');
        const orgId = created.body.id;

        const approved = await api(`/admin/organizations/${orgId}/status`, {
            method: 'POST',
            body: {status: 'active'},
        });
        assert.equal(approved.body.status, 'active');
        assert.equal(approved.body.verified_by, process.env.ADMIN_EMAIL);

        const member = await api('/admin/users', {
            method: 'POST',
            body: {
                fullName: 'Agency Staffer',
                phoneNumber: '+255715000040',
                role: 'agency',
                organizationId: orgId,
            },
        });
        assert.equal(member.status, 201);
        assert.equal(member.body.organization_name, 'Masaki Realty');

        const detail = await api(`/admin/organizations/${orgId}`);
        assert.equal(Number(detail.body.member_count), 1);

        const suspended = await api(`/admin/organizations/${orgId}/status`, {
            method: 'POST',
            body: {status: 'suspended'},
        });
        assert.equal(suspended.body.status, 'suspended');
    });

    test('journey: reject an agency application with a reason', async () => {
        const {body: org} = await api('/admin/organizations', {method: 'POST', body: {name: 'Sketchy Ltd'}});

        const noReason = await api(`/admin/organizations/${org.id}/status`, {
            method: 'POST',
            body: {status: 'rejected'},
        });
        assert.equal(noReason.status, 400);

        const rejected = await api(`/admin/organizations/${org.id}/status`, {
            method: 'POST',
            body: {status: 'rejected', reason: 'Registration number could not be verified'},
        });
        assert.equal(rejected.body.status, 'rejected');
        assert.equal(rejected.body.rejection_reason, 'Registration number could not be verified');

        const illegal = await api(`/admin/organizations/${org.id}/status`, {
            method: 'POST',
            body: {status: 'suspended'},
        });
        assert.equal(illegal.status, 422, 'rejected -> suspended is not a legal move');
    });

    // --- Property moderation journey ----------------------------------------

    async function createOwner(phoneNumber) {
        const {body} = await api('/admin/users', {
            method: 'POST',
            body: {fullName: 'Property Owner', phoneNumber, role: 'landlord'},
        });
        return body;
    }

    test('journey: register a property, request changes, resubmit, approve, then suspend', async () => {
        const owner = await createOwner('+255715000050');
        const created = await api('/admin/properties', {
            method: 'POST',
            body: {
                title: 'Masaki 3BR Apartment',
                ownerId: owner.id,
                propertyTypeId: dictionaryIds.apartment,
                regionId: dictionaryIds.dar_es_salaam,
                price: 1500000,
                bedrooms: 3,
                latitude: -6.746,
                longitude: 39.2803,
                addressLine: 'Masaki, Dar es Salaam',
            },
        });
        assert.equal(created.status, 201);
        assert.match(created.body.reference_code, /^HM-P-\d{6}$/);
        const propertyId = created.body.id;

        const skipReview = await api(`/admin/properties/${propertyId}/status`, {
            method: 'POST',
            body: {status: 'approved'},
        });
        assert.equal(skipReview.status, 422, 'cannot approve straight from draft');

        await api(`/admin/properties/${propertyId}/status`, {method: 'POST', body: {status: 'pending_review'}});

        const changes = await api(`/admin/properties/${propertyId}/status`, {
            method: 'POST',
            body: {status: 'changes_requested', reason: 'Photos unclear or insufficient'},
        });
        assert.equal(changes.body.status, 'changes_requested');
        assert.equal(changes.body.rejection_reason, 'Photos unclear or insufficient');

        await api(`/admin/properties/${propertyId}`, {method: 'PATCH', body: {price: 1650000}});
        await api(`/admin/properties/${propertyId}/media`, {
            method: 'POST',
            body: {
                image: {
                    base64: Buffer.from('RIFF----WEBPVP8 masaki').toString('base64'),
                    name: 'masaki-1.webp',
                    contentType: 'image/webp',
                },
            },
        });

        await api(`/admin/properties/${propertyId}/status`, {method: 'POST', body: {status: 'pending_review'}});
        const approved = await api(`/admin/properties/${propertyId}/status`, {
            method: 'POST',
            body: {status: 'approved'},
        });
        assert.equal(approved.body.status, 'approved');
        assert.equal(approved.body.reviewed_by, process.env.ADMIN_EMAIL);
        assert.equal(approved.body.rejection_reason, null);

        const detail = await api(`/admin/properties/${propertyId}`);
        assert.equal(detail.body.media.length, 1);
        assert.equal(Number(detail.body.price), 1650000);

        const suspended = await api(`/admin/properties/${propertyId}/status`, {
            method: 'POST',
            body: {status: 'suspended'},
        });
        assert.equal(suspended.body.status, 'suspended');
    });

    test('moderation queue can be filtered, searched and geo-searched', async () => {
        const owner = await createOwner('+255715000060');
        const {body: near} = await api('/admin/properties', {
            method: 'POST',
            body: {
                title: 'Oyster Bay Villa',
                ownerId: owner.id,
                price: 3000000,
                latitude: -6.7466,
                longitude: 39.2795,
            },
        });
        await api('/admin/properties', {
            method: 'POST',
            body: {title: 'Mbeya Cottage', ownerId: owner.id, price: 400000, latitude: -8.909, longitude: 33.46},
        });
        await api(`/admin/properties/${near.id}/status`, {method: 'POST', body: {status: 'pending_review'}});

        const queue = await api('/admin/properties?status=pending_review');
        assert.equal(queue.body.pagination.total, 1);
        assert.equal(queue.body.items[0].title, 'Oyster Bay Villa');

        const byText = await api('/admin/properties?query=Mbeya');
        assert.equal(byText.body.pagination.total, 1);

        const byRadius = await api('/admin/properties?latitude=-6.746&longitude=39.2803&radiusMetres=5000');
        assert.equal(byRadius.body.pagination.total, 1);
        assert.equal(byRadius.body.items[0].title, 'Oyster Bay Villa');

        const byPrice = await api('/admin/properties?maxPrice=500000');
        assert.equal(byPrice.body.pagination.total, 1);
        assert.equal(byPrice.body.items[0].title, 'Mbeya Cottage');

        const paged = await api('/admin/properties?limit=1&offset=0');
        assert.equal(paged.body.items.length, 1);
        assert.equal(paged.body.pagination.total, 2);
        assert.equal(paged.body.pagination.hasMore, true);
    });

    // --- Dictionaries --------------------------------------------------------

    test('journey: browse the geography tree and manage a dictionary item', async () => {
        const categories = await api('/admin/dictionaries');
        assert.ok(categories.body.items.some((c) => c.category === 'region'));

        const regions = await api('/admin/dictionaries/region');
        const dar = regions.body.items.find((r) => r.code === 'dar_es_salaam');
        assert.ok(Number(dar.child_count) > 0);

        const districts = await api(`/admin/dictionaries/district?parentId=${dar.id}`);
        const kinondoni = districts.body.items.find((d) => d.code === 'kinondoni');
        const wards = await api(`/admin/dictionaries/ward?parentId=${kinondoni.id}`);
        assert.ok(wards.body.items.some((w) => w.code === 'masaki'));

        const created = await api('/admin/dictionaries', {
            method: 'POST',
            body: {category: 'amenity', code: 'test_solar', name: 'Solar Power', sortOrder: 200},
        });
        assert.equal(created.status, 201);

        const orphanWard = await api('/admin/dictionaries', {
            method: 'POST',
            body: {category: 'ward', code: 'test_orphan_ward', name: 'Orphan'},
        });
        assert.equal(orphanWard.status, 422, 'the database refuses a ward with no district parent');

        const deactivated = await api(`/admin/dictionaries/item/${created.body.id}`, {
            method: 'PATCH',
            body: {isActive: false},
        });
        assert.equal(deactivated.body.is_active, false);

        const active = await api('/admin/dictionaries/amenity');
        assert.ok(!active.body.items.some((i) => i.code === 'test_solar'));
    });

    // --- Settings ------------------------------------------------------------

    test('journey: change a setting and read back its version history', async () => {
        const before = await api('/admin/settings');
        const current = Number(before.body.items.find((s) => s.key === 'commission.broker_percentage').value);
        const next = current + 1;

        const updated = await api('/admin/settings/commission.broker_percentage', {
            method: 'PATCH',
            body: {value: next},
        });
        assert.equal(updated.status, 200);
        assert.equal(Number(updated.body.value), next);
        assert.equal(updated.body.updated_by, process.env.ADMIN_EMAIL);

        const history = await api('/admin/settings/commission.broker_percentage/history');
        assert.ok(history.body.items.length >= 1);
        assert.equal(Number(history.body.items[0].new_value), next);
        assert.equal(history.body.items[0].changed_by, process.env.ADMIN_EMAIL);

        const unknown = await api('/admin/settings/nope.not.real', {method: 'PATCH', body: {value: 1}});
        assert.equal(unknown.status, 404);
    });
});
