import {test, describe, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {start} from 'bfast-function';

/**
 * The journey HomeMate exists for, end to end over real HTTP: a landlord is
 * verified, their property collects rent from a tenant, the money is split,
 * and each party's share is disbursed — with the platform keeping its
 * commission and every step visible to the operator who has to answer for it.
 *
 * Also covered here: the attention counters that drive the sidebar badges, and
 * the authorization branch on every new surface.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ONE_PIXEL_WEBP = Buffer.from('fake-webp-bytes').toString('base64');

describe('journey: rent collection and disbursement (e2e)', () => {
    /** @type {import('node:http').Server} */
    let server;
    let baseUrl;
    let db;
    let token;
    let dictionaryIds;

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
                cacheControl: response.headers.get('cache-control'),
                buffer: Buffer.from(await response.arrayBuffer()),
            };
        }
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
            `select code, id from dictionary_items where code in ('apartment', 'dar_es_salaam', 'kinondoni')`
        );
        dictionaryIds = Object.fromEntries(rows.map((r) => [r.code, r.id]));
    });

    after(async () => {
        await db.end();
        await new Promise((resolve) => server.close(resolve));
        setImmediate(() => process.exit(0));
    });

    beforeEach(async () => {
        await db.query(`truncate table
            ledger_entries, payment_splits, external_payment_events, payouts, payments,
            kyc_remediations, kyc_documents, property_parties, property_media, properties,
            users, organizations
            restart identity cascade`);
        await db.query("delete from dictionary_items where code like 'test\\_%'");
        await db.query('update dictionary_items set is_active = true where not is_active');
        await db.query('truncate table audit_log restart identity');
    });

    async function createUser(overrides) {
        const created = await api('/admin/users', {method: 'POST', body: overrides});
        assert.equal(created.status, 201, JSON.stringify(created.body));
        return created.body;
    }

    async function createProperty(ownerId) {
        const created = await api('/admin/properties', {
            method: 'POST',
            body: {
                title: 'Masaki 2BR Apartment',
                ownerId,
                price: 1200000,
                propertyTypeId: dictionaryIds.apartment,
                regionId: dictionaryIds.dar_es_salaam,
                districtId: dictionaryIds.kinondoni,
                latitude: -6.7576,
                longitude: 39.2768,
            },
        });
        assert.equal(created.status, 201, JSON.stringify(created.body));
        return created.body;
    }

    test('the full journey: verify identity, collect rent, split it, pay everyone out', async () => {
        // --- 1. The people -----------------------------------------------------
        const landlord = await createUser({
            phoneNumber: '+255754000001',
            fullName: 'Hamisi Mbwana',
            role: 'landlord',
        });
        const broker = await createUser({
            phoneNumber: '+255754000002',
            fullName: 'Zawadi Mtei',
            role: 'broker',
        });
        const tenant = await createUser({
            phoneNumber: '+255754000003',
            fullName: 'Neema Kileo',
            role: 'customer',
        });

        // --- 2. Identity: nothing has been collected yet -----------------------
        let profile = await api(`/admin/users/${landlord.id}/kyc`);
        assert.equal(profile.status, 200);
        assert.equal(profile.body.kyc_status, 'not_started');

        const details = await api(`/admin/users/${landlord.id}/kyc`, {
            method: 'PATCH',
            body: {
                dateOfBirth: '1985-06-30',
                gender: 'male',
                nationalIdNumber: '19850630-11111-00001-01',
                physicalAddress: 'Masaki, Kinondoni, Dar es Salaam',
                bankName: 'CRDB',
                bankAccountNumber: '0150999888777',
                mobileMoneyProvider: 'M-Pesa',
                mobileMoneyNumber: '+255754000001',
            },
        });
        assert.equal(details.status, 200);
        // A `date` column must survive the round trip as the day it was entered.
        assert.equal(details.body.date_of_birth, '1985-06-30');

        const document = await api(`/admin/users/${landlord.id}/kyc/documents`, {
            method: 'POST',
            body: {
                documentType: 'national_id',
                documentNumber: '19850630-11111-00001-01',
                expiresOn: '2032-06-30',
                file: {base64: ONE_PIXEL_WEBP, contentType: 'image/webp', name: 'nida.webp'},
            },
        });
        assert.equal(document.status, 201, JSON.stringify(document.body));
        assert.equal(document.body.status, 'pending');

        // Uploading evidence is what puts the account in front of a reviewer.
        profile = await api(`/admin/users/${landlord.id}/kyc`);
        assert.equal(profile.body.kyc_status, 'in_review');

        // The document is readable only through the API, and never cached.
        const fetched = await api(`/admin/kyc/documents/${document.body.id}/raw`, {raw: true});
        assert.equal(fetched.status, 200);
        assert.equal(fetched.buffer.toString('base64'), ONE_PIXEL_WEBP);
        assert.match(fetched.cacheControl, /no-store/);

        const anonymous = await fetch(`${baseUrl}/admin/kyc/documents/${document.body.id}/raw`);
        assert.equal(anonymous.status, 401);

        // --- 3. Remediation, then verification ---------------------------------
        const remediation = await api(`/admin/users/${landlord.id}/kyc/remediations`, {
            method: 'POST',
            body: {issue: 'ID photo is cropped', requestedAction: 'Re-upload showing all four corners'},
        });
        assert.equal(remediation.status, 201);

        const badReject = await api(`/admin/kyc/documents/${document.body.id}/review`, {
            method: 'POST',
            body: {status: 'rejected'},
        });
        assert.equal(badReject.status, 400, 'a rejection without a reason must be refused');

        await api(`/admin/kyc/remediations/${remediation.body.id}/resolve`, {
            method: 'POST',
            body: {resolutionNote: 'Clean copy received'},
        });
        const verifiedDoc = await api(`/admin/kyc/documents/${document.body.id}/review`, {
            method: 'POST',
            body: {status: 'verified'},
        });
        assert.equal(verifiedDoc.body.status, 'verified');
        assert.equal(verifiedDoc.body.reviewed_by, process.env.ADMIN_EMAIL);

        const verified = await api(`/admin/users/${landlord.id}/kyc/review`, {
            method: 'POST',
            body: {status: 'verified', expiresAt: '2032-06-30'},
        });
        assert.equal(verified.body.kyc_status, 'verified');

        // The broker is paid too, so they need verifying as well.
        await api(`/admin/users/${broker.id}/kyc`, {
            method: 'PATCH',
            body: {mobileMoneyNumber: '+255754000002'},
        });
        await api(`/admin/users/${broker.id}/kyc/review`, {method: 'POST', body: {status: 'verified'}});

        // --- 4. The property and who earns from it -----------------------------
        const property = await createProperty(landlord.id);
        await api(`/admin/properties/${property.id}/parties`, {
            method: 'POST',
            body: {userId: landlord.id, role: 'landlord', isPrimary: true},
        });
        await api(`/admin/properties/${property.id}/parties`, {
            method: 'POST',
            body: {userId: broker.id, role: 'broker', commissionPercentage: 5, isPrimary: true},
        });

        // --- 5. Rent is collected ----------------------------------------------
        const payment = await api('/admin/payments', {
            method: 'POST',
            body: {
                propertyId: property.id,
                payerUserId: tenant.id,
                amount: 1200000,
                purpose: 'rent',
                periodStart: '2026-10-01',
                periodEnd: '2026-10-31',
            },
        });
        assert.equal(payment.status, 201, JSON.stringify(payment.body));
        assert.equal(payment.body.status, 'pending');
        assert.match(payment.body.reference, /^HM-PAY-\d{6}$/);
        assert.equal(payment.body.period_start, '2026-10-01');

        const shares = Object.fromEntries(
            payment.body.splits.map((s) => [s.beneficiary_type, Number(s.amount)])
        );
        assert.equal(shares.platform, 120000); // 10%
        assert.equal(shares.broker, 60000); //  5%
        assert.equal(shares.landlord, 1020000); // the rest
        assert.equal(shares.platform + shares.broker + shares.landlord, 1200000);

        // Nothing is owed while the money has not actually arrived.
        assert.deepEqual((await api('/admin/money/outstanding')).body.items, []);

        // --- 6. The provider confirms ------------------------------------------
        const settled = await api(`/admin/payments/${payment.body.id}/provider-events`, {
            method: 'POST',
            body: {
                provider: 'sandbox',
                status: 'successful',
                providerReference: 'MPESA-CONF-1001',
                rawPayload: {ResultCode: 0, TransactionId: 'MPESA-CONF-1001'},
            },
        });
        assert.equal(settled.body.status, 'successful');
        assert.equal(settled.body.confirmed_by, process.env.ADMIN_EMAIL);

        const ledgerAfterCollection = Object.fromEntries(
            settled.body.ledger.map((e) => [e.account, Number(e.amount)])
        );
        assert.equal(ledgerAfterCollection['cash.collections'], 1200000);
        assert.equal(ledgerAfterCollection['revenue.commission'], 120000);

        // --- 7. Everyone is now owed their share --------------------------------
        const outstanding = await api('/admin/money/outstanding');
        const owed = Object.fromEntries(
            outstanding.body.items.map((row) => [row.beneficiary_type, Number(row.amount_due)])
        );
        assert.equal(owed.landlord, 1020000);
        assert.equal(owed.broker, 60000);

        // --- 8. Disbursement -----------------------------------------------------
        const landlordPayout = await api('/admin/payouts', {
            method: 'POST',
            body: {beneficiaryType: 'landlord', beneficiaryUserId: landlord.id},
        });
        assert.equal(landlordPayout.status, 201, JSON.stringify(landlordPayout.body));
        assert.equal(Number(landlordPayout.body.amount), 1020000);
        assert.equal(landlordPayout.body.status, 'scheduled');
        assert.match(landlordPayout.body.reference, /^HM-PO-\d{6}$/);

        // Claimed money cannot be claimed twice.
        const again = await api('/admin/payouts', {
            method: 'POST',
            body: {beneficiaryType: 'landlord', beneficiaryUserId: landlord.id},
        });
        assert.equal(again.status, 400);

        const skipped = await api(`/admin/payouts/${landlordPayout.body.id}/status`, {
            method: 'POST',
            body: {status: 'paid'},
        });
        assert.equal(skipped.status, 422, 'scheduled -> paid must go through processing');

        await api(`/admin/payouts/${landlordPayout.body.id}/status`, {
            method: 'POST',
            body: {status: 'processing'},
        });
        const paid = await api(`/admin/payouts/${landlordPayout.body.id}/status`, {
            method: 'POST',
            body: {status: 'paid', providerReference: 'MPESA-B2C-7001'},
        });
        assert.equal(paid.body.status, 'paid');
        assert.equal(paid.body.approved_by, process.env.ADMIN_EMAIL);

        const brokerPayout = await api('/admin/payouts', {
            method: 'POST',
            body: {beneficiaryType: 'broker', beneficiaryUserId: broker.id},
        });
        await api(`/admin/payouts/${brokerPayout.body.id}/status`, {
            method: 'POST',
            body: {status: 'processing'},
        });
        await api(`/admin/payouts/${brokerPayout.body.id}/status`, {
            method: 'POST',
            body: {status: 'paid'},
        });

        // --- 9. The books balance -------------------------------------------------
        const summary = await api('/admin/money/summary');
        assert.equal(Number(summary.body.collected), 1200000);
        assert.equal(Number(summary.body.disbursed), 1080000);
        assert.equal(Number(summary.body.platform_revenue), 120000);
        assert.equal(Number(summary.body.owed), 0);

        // HomeMate connects the parties and keeps only its commission: what came
        // in, less what went out, is exactly what the platform earned.
        assert.equal(
            Number(summary.body.collected) - Number(summary.body.disbursed),
            Number(summary.body.platform_revenue)
        );

        const ledger = await api('/admin/ledger?limit=50');
        assert.ok(ledger.body.items.length >= 7);
    });

    test('money owed to an unverified identity is held rather than sent', async () => {
        const landlord = await createUser({
            phoneNumber: '+255754000010',
            fullName: 'Unverified Landlord',
            role: 'landlord',
        });
        await api(`/admin/users/${landlord.id}/kyc`, {
            method: 'PATCH',
            body: {mobileMoneyNumber: '+255754000010'},
        });
        const property = await createProperty(landlord.id);
        const payment = await api('/admin/payments', {
            method: 'POST',
            body: {propertyId: property.id, amount: 1000000},
        });
        await api(`/admin/payments/${payment.body.id}/reconcile`, {
            method: 'POST',
            body: {note: 'Cash received at the office'},
        });

        const payout = await api('/admin/payouts', {
            method: 'POST',
            body: {beneficiaryType: 'landlord', beneficiaryUserId: landlord.id},
        });
        assert.equal(payout.body.status, 'on_hold');
        assert.match(payout.body.hold_reason, /KYC/);

        const attention = await api('/admin/attention');
        assert.equal(attention.body.counts.payoutsBlocked, 1);
    });

    test('a payment cannot be declared successful without evidence', async () => {
        const landlord = await createUser({
            phoneNumber: '+255754000020',
            fullName: 'Landlord',
            role: 'landlord',
        });
        const property = await createProperty(landlord.id);
        const payment = await api('/admin/payments', {
            method: 'POST',
            body: {propertyId: property.id, amount: 500000},
        });

        // There is no endpoint that would do it, and the database refuses the
        // direct route too.
        await assert.rejects(
            db.query("update payments set status = 'successful' where id = $1", [payment.body.id]),
            /provider confirmation or an authorised reconciliation/
        );

        // An unrecognised provider status is not evidence either.
        const queued = await api(`/admin/payments/${payment.body.id}/provider-events`, {
            method: 'POST',
            body: {provider: 'sandbox', status: 'pending_customer_action'},
        });
        assert.equal(queued.body.status, 'pending');
    });

    test('the sidebar badges count what is actually waiting', async () => {
        const quiet = await api('/admin/attention');
        assert.deepEqual(quiet.body.badges, {
            properties: 0,
            agencies: 0,
            users: 0,
            staff: 0,
            payments: 0,
            inquiries: 0,
            viewings: 0,
            bookings: 0,
        });

        const landlord = await createUser({
            phoneNumber: '+255754000030',
            fullName: 'Landlord',
            role: 'landlord',
        });
        const property = await createProperty(landlord.id);
        await api(`/admin/properties/${property.id}/status`, {
            method: 'POST',
            body: {status: 'pending_review'},
        });
        await api('/admin/organizations', {
            method: 'POST',
            body: {name: 'Kariakoo Estates', type: 'agency'},
        });
        await api('/admin/users', {
            method: 'POST',
            body: {
                email: 'moderator@homemate.co.tz',
                phoneNumber: '+255754000031',
                fullName: 'New Moderator',
                role: 'moderator',
                status: 'pending',
            },
        });
        await api('/admin/payments', {
            method: 'POST',
            body: {propertyId: property.id, amount: 300000},
        });

        const busy = await api('/admin/attention');
        assert.equal(busy.body.badges.properties, 1);
        assert.equal(busy.body.badges.agencies, 1);
        assert.equal(busy.body.badges.staff, 1);
        assert.equal(busy.body.badges.payments, 1);
    });

    test('every entity is searchable, including master data', async () => {
        const landlord = await createUser({
            phoneNumber: '+255754000040',
            fullName: 'Searchable Salehe',
            role: 'landlord',
        });
        await api(`/admin/users/${landlord.id}/kyc`, {
            method: 'PATCH',
            body: {nationalIdNumber: 'NIDA-SEARCH-1'},
        });

        assert.equal((await api('/admin/users?query=Salehe')).body.items.length, 1);
        assert.equal((await api('/admin/users?query=NIDA-SEARCH-1')).body.items.length, 1);
        assert.equal((await api('/admin/users?query=+255754000040')).body.items.length, 1);
        assert.equal((await api('/admin/users?kycStatus=verified')).body.items.length, 0);

        const property = await createProperty(landlord.id);
        assert.ok((await api('/admin/properties?query=Masaki')).body.items.length >= 1);

        await api('/admin/organizations', {method: 'POST', body: {name: 'Upanga Realty', type: 'agency'}});
        assert.equal((await api('/admin/organizations?query=Upanga')).body.items.length, 1);

        const payment = await api('/admin/payments', {
            method: 'POST',
            body: {propertyId: property.id, amount: 400000},
        });
        assert.equal(
            (await api(`/admin/payments?query=${payment.body.reference}`)).body.items.length,
            1
        );

        // Master data searches across categories as well as within one.
        const across = await api('/admin/dictionary-items?query=Kinondoni');
        assert.ok(across.body.items.length >= 1);
        const within = await api('/admin/dictionary-items?query=Kinondoni&category=district');
        assert.equal(within.body.items.length, 1);
    });

    test('master data is imported, corrected, archived and deleted', async () => {
        const imported = await api('/admin/dictionary-items/import', {
            method: 'POST',
            body: {
                category: 'region',
                items: [
                    {code: 'test_mbeya', name: 'Mbeya', sortOrder: 90},
                    {code: 'test_mbeya_city', name: 'Mbeya Cty', parentCode: 'test_mbeya', sortOrder: 91},
                ],
            },
        });
        assert.equal(imported.status, 200, JSON.stringify(imported.body));
        assert.equal(imported.body.created, 2);

        // Re-importing a corrected sheet fixes the typo instead of duplicating.
        const corrected = await api('/admin/dictionary-items/import', {
            method: 'POST',
            body: {
                category: 'region',
                items: [{code: 'test_mbeya_city', name: 'Mbeya City', parentCode: 'test_mbeya'}],
            },
        });
        assert.equal(corrected.body.updated, 1);
        assert.equal(corrected.body.created, 0);

        const found = await api('/admin/dictionary-items?query=test_mbeya_city&category=region');
        assert.equal(found.body.items.length, 1);
        assert.equal(found.body.items[0].name, 'Mbeya City');
        const child = found.body.items[0];

        const parent = (await api('/admin/dictionary-items?query=test_mbeya&category=region')).body.items.find(
            (item) => item.code === 'test_mbeya'
        );

        // A parent with children cannot be deleted, only archived.
        const refused = await api(`/admin/dictionaries/item/${parent.id}`, {method: 'DELETE'});
        assert.equal(refused.status, 400);
        assert.match(refused.body.message, /archive it instead/);

        const archived = await api(`/admin/dictionaries/item/${parent.id}/archive`, {method: 'POST'});
        assert.equal(archived.status, 200);
        assert.equal(
            (await api('/admin/dictionary-items?query=test_mbeya&category=region')).body.items.length,
            0
        );

        await api(`/admin/dictionaries/item/${parent.id}/restore`, {method: 'POST'});
        assert.ok(
            (await api('/admin/dictionary-items?query=test_mbeya&category=region')).body.items.length >= 1
        );

        const deleted = await api(`/admin/dictionaries/item/${child.id}`, {method: 'DELETE'});
        assert.equal(deleted.status, 200);
        assert.equal(deleted.body.deleted, true);
    });

    test('every new surface refuses an anonymous caller', async () => {
        for (const path of [
            '/admin/attention',
            '/admin/payments',
            '/admin/payouts',
            '/admin/ledger',
            '/admin/money/summary',
            '/admin/money/outstanding',
            '/admin/dictionary-items',
        ]) {
            const response = await fetch(`${baseUrl}${path}`);
            assert.equal(response.status, 401, `${path} should require a session`);
        }
    });
});
