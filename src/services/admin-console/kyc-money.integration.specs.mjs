import {test, describe, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createKycService} from './kyc.mjs';
import {createMoneyService} from './money.mjs';
import {createUsersService} from './users.mjs';
import {createDictionariesService} from './dictionaries.mjs';
import {createInsightsService} from './insights.mjs';
import {createMemoryStorageAdapter} from '../storage/adapters/memory-storage.adapter.mjs';
import {ErrorCodes} from '../../shared/errors.mjs';

/**
 * KYC, money and the attention counters, against the real database — because
 * the rules being tested here (a payment may not be declared successful, the
 * splits must balance, the ledger cannot be edited) are enforced by triggers.
 * Asserting them through a mock would only prove the mock agrees with itself.
 */

const ACTOR = 'admin@homemate.co.tz';

function expectDomainError(code) {
    return (error) => {
        assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
        return true;
    };
}

describe('kyc and money (Postgres integration)', () => {
    /** @type {pg.Pool} */
    let pool;
    let kyc;
    let money;
    let users;
    let dictionaries;
    let insights;
    let dictionaryIds;

    before(async () => {
        pool = new pg.Pool({connectionString: process.env.DATABASE_URL});
        kyc = createKycService({pool, storagePort: createMemoryStorageAdapter()});
        money = createMoneyService({pool});
        users = createUsersService({pool});
        dictionaries = createDictionariesService({pool});
        insights = createInsightsService({pool});

        const {rows} = await pool.query(
            `select code, id from dictionary_items where code in ('apartment', 'dar_es_salaam', 'kinondoni')`
        );
        dictionaryIds = Object.fromEntries(rows.map((r) => [r.code, r.id]));
    });

    after(async () => {
        await pool.end();
    });

    beforeEach(async () => {
        await pool.query(`truncate table
            ledger_entries, payment_splits, external_payment_events, payouts, payments,
            kyc_remediations, kyc_documents, property_parties, property_media, properties,
            users, organizations
            restart identity cascade`);
        await pool.query("delete from dictionary_items where code like 'test\\_%'");
        await pool.query('update dictionary_items set is_active = true where not is_active');
        await pool.query('truncate table audit_log restart identity');
    });

    async function makeUser(overrides = {}) {
        return users.create(
            {
                phoneNumber: overrides.phoneNumber ?? `+2557${Math.floor(Math.random() * 100000000)}`,
                fullName: overrides.fullName ?? 'Test Person',
                role: overrides.role ?? 'landlord',
                ...overrides,
            },
            ACTOR
        );
    }

    async function makeProperty({ownerId, monthlyRent = 1000000}) {
        const {rows} = await pool.query(
            `insert into properties (title, owner_id, price, property_type_id, region_id, district_id, status)
             values ($1, $2, $3, $4, $5, $6, 'draft')
             returning id`,
            [
                'Test Property',
                ownerId,
                monthlyRent,
                dictionaryIds.apartment,
                dictionaryIds.dar_es_salaam,
                dictionaryIds.kinondoni,
            ]
        );
        return rows[0].id;
    }

    // --- KYC -----------------------------------------------------------------

    describe('kyc', () => {
        test('records identity details and returns them with the profile', async () => {
            const user = await makeUser({fullName: 'Asha Mollel'});

            const updated = await kyc.updateProfile(
                user.id,
                {
                    dateOfBirth: '1990-04-12',
                    gender: 'female',
                    nationalIdNumber: '19900412-12345-00001-23',
                    tinNumber: '123-456-789',
                    physicalAddress: 'Masaki, Kinondoni',
                    bankName: 'CRDB',
                    bankAccountNumber: '0150123456789',
                    mobileMoneyProvider: 'M-Pesa',
                    mobileMoneyNumber: '+255754000111',
                },
                ACTOR
            );

            assert.equal(updated.national_id_number, '19900412-12345-00001-23');
            assert.equal(updated.gender, 'female');

            const profile = await kyc.getProfile(user.id);
            assert.equal(profile.bank_name, 'CRDB');
            assert.deepEqual(profile.documents, []);
            assert.deepEqual(profile.remediations, []);
        });

        test('rejects a gender the database does not know', async () => {
            const user = await makeUser();
            await assert.rejects(
                kyc.updateProfile(user.id, {gender: 'yes'}, ACTOR),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
        });

        test('uploading a document puts an untouched account into review', async () => {
            const user = await makeUser();
            assert.equal((await kyc.getProfile(user.id)).kyc_status, 'not_started');

            const document = await kyc.addDocument(
                user.id,
                {
                    documentType: 'national_id',
                    documentNumber: '19900412-12345-00001-23',
                    expiresOn: '2032-01-01',
                    file: {name: 'nida.webp', contentType: 'image/webp', body: Buffer.from('front')},
                    thumbnail: {name: 'nida-thumb.webp', contentType: 'image/webp', body: Buffer.from('t')},
                },
                ACTOR
            );

            assert.equal(document.status, 'pending');
            assert.equal(document.has_thumbnail, true);
            assert.equal(document.uploaded_by, ACTOR);

            const profile = await kyc.getProfile(user.id);
            assert.equal(profile.kyc_status, 'in_review');
            assert.equal(Number(profile.documents_pending), 1);
        });

        test('reads a stored document back through the port, not by URL', async () => {
            const user = await makeUser();
            const document = await kyc.addDocument(
                user.id,
                {
                    documentType: 'passport',
                    file: {name: 'p.webp', contentType: 'image/webp', body: Buffer.from('passport-bytes')},
                },
                ACTOR
            );

            const content = await kyc.documentContent(document.id);
            assert.equal(content.body.toString(), 'passport-bytes');
            assert.equal(content.contentType, 'image/webp');
        });

        test('rejecting a document needs a reason and stamps the reviewer', async () => {
            const user = await makeUser();
            const document = await kyc.addDocument(
                user.id,
                {documentType: 'utility_bill', file: {contentType: 'image/webp', body: Buffer.from('x')}},
                ACTOR
            );

            await assert.rejects(
                kyc.reviewDocument(document.id, {status: 'rejected'}, ACTOR),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );

            const rejected = await kyc.reviewDocument(
                document.id,
                {status: 'rejected', rejectionReason: 'Photo is unreadable'},
                ACTOR
            );
            assert.equal(rejected.status, 'rejected');
            assert.equal(rejected.rejection_reason, 'Photo is unreadable');
            assert.equal(rejected.reviewed_by, ACTOR);
            assert.ok(rejected.reviewed_at);
        });

        test('verifying a document clears any earlier rejection reason', async () => {
            const user = await makeUser();
            const document = await kyc.addDocument(
                user.id,
                {documentType: 'selfie', file: {contentType: 'image/webp', body: Buffer.from('x')}},
                ACTOR
            );
            await kyc.reviewDocument(document.id, {status: 'rejected', rejectionReason: 'Blurry'}, ACTOR);
            const verified = await kyc.reviewDocument(document.id, {status: 'verified'}, ACTOR);

            assert.equal(verified.status, 'verified');
            assert.equal(verified.rejection_reason, null);
        });

        test('the account decision needs a reason to reject and stamps who decided', async () => {
            const user = await makeUser();

            await assert.rejects(
                kyc.reviewUser(user.id, {status: 'rejected'}, ACTOR),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );

            const verified = await kyc.reviewUser(
                user.id,
                {status: 'verified', expiresAt: '2030-01-01'},
                ACTOR
            );
            assert.equal(verified.kyc_status, 'verified');
            assert.equal(verified.kyc_reviewed_by, ACTOR);
            assert.equal(verified.kyc_expires_at, '2030-01-01');
        });

        test('remediation is raised, listed and resolved once', async () => {
            const user = await makeUser();
            const remediation = await kyc.openRemediation(
                user.id,
                {issue: 'National ID has expired', requestedAction: 'Upload a renewed NIDA card'},
                ACTOR
            );
            assert.equal(remediation.resolved, false);
            assert.equal(remediation.raised_by, ACTOR);

            let profile = await kyc.getProfile(user.id);
            assert.equal(Number(profile.open_remediations), 1);

            const resolved = await kyc.resolveRemediation(
                remediation.id,
                {resolutionNote: 'New card received and verified'},
                ACTOR
            );
            assert.equal(resolved.resolved, true);
            assert.equal(resolved.resolved_by, ACTOR);

            await assert.rejects(
                kyc.resolveRemediation(remediation.id, {}, ACTOR),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );

            profile = await kyc.getProfile(user.id);
            assert.equal(Number(profile.open_remediations), 0);
        });

        test('remediation needs both the issue and the requested action', async () => {
            const user = await makeUser();
            await assert.rejects(
                kyc.openRemediation(user.id, {issue: 'Something is wrong'}, ACTOR),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
        });

        test('a profile photo round-trips through the storage port', async () => {
            const user = await makeUser();
            await kyc.setProfilePhoto(
                user.id,
                {file: {name: 'me.webp', contentType: 'image/webp', body: Buffer.from('face')}},
                ACTOR
            );
            const photo = await kyc.profilePhotoContent(user.id);
            assert.equal(photo.body.toString(), 'face');
        });

        test('asking for a photo that was never uploaded is a 404, not a crash', async () => {
            const user = await makeUser();
            await assert.rejects(kyc.profilePhotoContent(user.id), expectDomainError(ErrorCodes.NOT_FOUND));
        });

        test('users are searchable by national id and filterable by kyc status', async () => {
            const asha = await makeUser({fullName: 'Asha Mollel'});
            await makeUser({fullName: 'Juma Said'});
            await kyc.updateProfile(asha.id, {nationalIdNumber: 'NIDA-777'}, ACTOR);
            await kyc.reviewUser(asha.id, {status: 'verified'}, ACTOR);

            const byId = await users.search({query: 'NIDA-777'});
            assert.equal(byId.items.length, 1);
            assert.equal(byId.items[0].full_name, 'Asha Mollel');

            const verified = await users.search({kycStatus: 'verified'});
            assert.equal(verified.items.length, 1);

            const attention = await users.search({needsAttention: true});
            assert.equal(attention.items.length, 0);
        });

        test('needsAttention finds accounts in review and those with open asks', async () => {
            const user = await makeUser();
            await kyc.addDocument(
                user.id,
                {documentType: 'national_id', file: {contentType: 'image/webp', body: Buffer.from('x')}},
                ACTOR
            );

            const attention = await users.search({needsAttention: true});
            assert.equal(attention.items.length, 1);
            assert.equal(Number(attention.items[0].documents_pending), 1);
        });
    });

    // --- Money ---------------------------------------------------------------

    describe('collection', () => {
        test('rent recorded by hand is the landlord’s whole — commission comes only from the tenant fee', async () => {
            const landlord = await makeUser({role: 'landlord', fullName: 'Landlord'});
            const broker = await makeUser({role: 'broker', fullName: 'Broker'});
            const tenant = await makeUser({role: 'customer', fullName: 'Tenant'});
            const propertyId = await makeProperty({ownerId: landlord.id});

            await pool.query(
                `insert into property_parties (property_id, user_id, role, commission_percentage, is_primary)
                 values ($1, $2, 'landlord', null, true), ($1, $3, 'broker', 5, true)`,
                [propertyId, landlord.id, broker.id]
            );

            const payment = await money.recordPayment(
                {propertyId, payerUserId: tenant.id, amount: 1000000, purpose: 'rent'},
                ACTOR
            );

            assert.equal(payment.status, 'pending');
            assert.match(payment.reference, /^HM-PAY-\d{6}$/);

            const byType = Object.fromEntries(
                payment.splits.map((s) => [s.beneficiary_type, Number(s.amount)])
            );
            assert.equal(byType.platform, undefined, 'HomeMate takes nothing from rent');
            assert.equal(byType.broker, undefined, 'nor does the broker');
            assert.equal(byType.landlord, 1000000);
            assert.equal(
                payment.splits.reduce((sum, s) => sum + Number(s.amount), 0),
                1000000
            );
        });

        test('refuses a payment for a property with no landlord', async () => {
            const {rows} = await pool.query(
                `insert into properties (title, price, property_type_id, region_id, status)
                 values ('Orphan', 500000, $1, $2, 'draft') returning id`,
                [dictionaryIds.apartment, dictionaryIds.dar_es_salaam]
            );

            await assert.rejects(
                money.recordPayment({propertyId: rows[0].id, amount: 500000}, ACTOR),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
        });

        test('refuses explicit splits that do not add up to the payment', async () => {
            const landlord = await makeUser();
            const propertyId = await makeProperty({ownerId: landlord.id});

            await assert.rejects(
                money.recordPayment(
                    {
                        propertyId,
                        amount: 1000000,
                        splits: [
                            {beneficiaryType: 'landlord', beneficiaryUserId: landlord.id, amount: 400000},
                            {beneficiaryType: 'platform', amount: 100000},
                        ],
                    },
                    ACTOR
                ),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
        });

        test('a payment cannot be willed into being successful', async () => {
            const landlord = await makeUser();
            const propertyId = await makeProperty({ownerId: landlord.id});
            const payment = await money.recordPayment({propertyId, amount: 1000000}, ACTOR);

            await assert.rejects(
                pool.query("update payments set status = 'successful' where id = $1", [payment.id]),
                /provider confirmation or an authorised reconciliation/
            );
        });

        test('a provider confirmation settles the payment and posts the ledger', async () => {
            const landlord = await makeUser();
            const propertyId = await makeProperty({ownerId: landlord.id});
            const payment = await money.recordPayment({propertyId, amount: 1000000}, ACTOR);

            const settled = await money.recordProviderEvent(
                payment.id,
                {
                    provider: 'sandbox',
                    status: 'successful',
                    providerReference: 'MPESA-9981',
                    rawPayload: {resultCode: 0},
                },
                ACTOR
            );

            assert.equal(settled.status, 'successful');
            assert.equal(settled.provider_reference, 'MPESA-9981');
            assert.equal(settled.confirmed_by, ACTOR);
            assert.equal(settled.providerEvents.length, 1);

            const accounts = Object.fromEntries(settled.ledger.map((e) => [e.account, Number(e.amount)]));
            assert.equal(accounts['cash.collections'], 1000000);
            assert.equal(accounts['revenue.commission'], undefined);
            assert.equal(accounts['liability.payable.landlord'], 1000000);
        });

        test('a provider failure records the reason and leaves nothing payable', async () => {
            const landlord = await makeUser();
            const propertyId = await makeProperty({ownerId: landlord.id});
            const payment = await money.recordPayment({propertyId, amount: 1000000}, ACTOR);

            const failed = await money.recordProviderEvent(
                payment.id,
                {provider: 'sandbox', status: 'failed', failureReason: 'Insufficient balance'},
                ACTOR
            );

            assert.equal(failed.status, 'failed');
            assert.equal(failed.failure_reason, 'Insufficient balance');
            assert.deepEqual((await money.outstandingBalances()).items, []);
        });

        test('an unrecognised provider status is not treated as evidence', async () => {
            const landlord = await makeUser();
            const propertyId = await makeProperty({ownerId: landlord.id});
            const payment = await money.recordPayment({propertyId, amount: 1000000}, ACTOR);

            const still = await money.recordProviderEvent(
                payment.id,
                {provider: 'sandbox', status: 'queued'},
                ACTOR
            );
            assert.equal(still.status, 'pending');
            assert.equal(still.providerEvents.length, 1);
        });

        test('cash is settled by reconciliation, and only while pending', async () => {
            const landlord = await makeUser();
            const propertyId = await makeProperty({ownerId: landlord.id});
            const payment = await money.recordPayment({propertyId, amount: 1000000}, ACTOR);

            const reconciled = await money.reconcilePayment(
                payment.id,
                {note: 'Counted at the Masaki office'},
                ACTOR
            );
            assert.equal(reconciled.status, 'successful');
            assert.ok(reconciled.reconciled_at);

            await assert.rejects(
                money.reconcilePayment(payment.id, {}, ACTOR),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
        });

        test('the ledger cannot be edited', async () => {
            const landlord = await makeUser();
            const propertyId = await makeProperty({ownerId: landlord.id});
            const payment = await money.recordPayment({propertyId, amount: 1000000}, ACTOR);
            await money.reconcilePayment(payment.id, {}, ACTOR);

            await assert.rejects(
                pool.query('update ledger_entries set amount = 1 where payment_id = $1', [payment.id]),
                /append-only/
            );
            await assert.rejects(
                pool.query('delete from ledger_entries where payment_id = $1', [payment.id]),
                /append-only/
            );
        });

        test('payments are searchable by reference, payer and property', async () => {
            const landlord = await makeUser({fullName: 'Landlord'});
            const tenant = await makeUser({role: 'customer', fullName: 'Neema Kileo'});
            const propertyId = await makeProperty({ownerId: landlord.id});
            const payment = await money.recordPayment(
                {propertyId, payerUserId: tenant.id, amount: 1000000},
                ACTOR
            );

            assert.equal((await money.searchPayments({query: payment.reference})).items.length, 1);
            assert.equal((await money.searchPayments({query: 'Neema'})).items.length, 1);
            assert.equal((await money.searchPayments({query: 'Test Property'})).items.length, 1);
            assert.equal((await money.searchPayments({status: 'successful'})).items.length, 0);
        });
    });

    describe('disbursement', () => {
        async function collectedRent({amount = 1000000, verifyLandlord = true} = {}) {
            const landlord = await makeUser({role: 'landlord', fullName: 'Landlord'});
            await kyc.updateProfile(landlord.id, {mobileMoneyNumber: '+255754000111'}, ACTOR);
            if (verifyLandlord) await kyc.reviewUser(landlord.id, {status: 'verified'}, ACTOR);
            const propertyId = await makeProperty({ownerId: landlord.id});
            const payment = await money.recordPayment({propertyId, amount}, ACTOR);
            await money.reconcilePayment(payment.id, {}, ACTOR);
            return {landlord, propertyId, payment};
        }

        test('shows what each beneficiary is owed after collection', async () => {
            const {landlord} = await collectedRent();

            const {items} = await money.outstandingBalances();
            assert.equal(items.length, 1);
            assert.equal(items[0].beneficiary_user_id, landlord.id);
            assert.equal(Number(items[0].amount_due), 1000000);
        });

        test('a payout claims the splits and its amount is their sum', async () => {
            const {landlord} = await collectedRent();

            const payout = await money.createPayout(
                {beneficiaryType: 'landlord', beneficiaryUserId: landlord.id},
                ACTOR
            );

            assert.match(payout.reference, /^HM-PO-\d{6}$/);
            assert.equal(Number(payout.amount), 1000000);
            assert.equal(payout.status, 'scheduled');
            assert.equal(payout.destination, '+255754000111');
            assert.equal(payout.splits.length, 1);

            // Claimed money is no longer outstanding, so it cannot be paid twice.
            assert.deepEqual((await money.outstandingBalances()).items, []);
            await assert.rejects(
                money.createPayout({beneficiaryType: 'landlord', beneficiaryUserId: landlord.id}, ACTOR),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
        });

        test('money owed to an unverified identity is held, not sent', async () => {
            const {landlord} = await collectedRent({verifyLandlord: false});

            const payout = await money.createPayout(
                {beneficiaryType: 'landlord', beneficiaryUserId: landlord.id},
                ACTOR
            );

            assert.equal(payout.status, 'on_hold');
            assert.match(payout.hold_reason, /KYC/);
        });

        test('releasing a payout goes through processing and posts the ledger', async () => {
            const {landlord} = await collectedRent();
            const payout = await money.createPayout(
                {beneficiaryType: 'landlord', beneficiaryUserId: landlord.id},
                ACTOR
            );

            await assert.rejects(
                money.changePayoutStatus(payout.id, {status: 'paid'}, ACTOR),
                expectDomainError(ErrorCodes.ILLEGAL_TRANSITION)
            );

            await money.changePayoutStatus(payout.id, {status: 'processing'}, ACTOR);
            const paid = await money.changePayoutStatus(
                payout.id,
                {status: 'paid', providerReference: 'MPESA-B2C-42'},
                ACTOR
            );

            assert.equal(paid.status, 'paid');
            assert.equal(paid.approved_by, ACTOR);
            assert.ok(paid.paid_at);

            const accounts = Object.fromEntries(paid.ledger.map((e) => [e.account, Number(e.amount)]));
            assert.equal(accounts['liability.payable.landlord'], 1000000);
            assert.equal(accounts['cash.disbursements'], 1000000);
        });

        test('cancelling a payout makes the money payable again', async () => {
            const {landlord} = await collectedRent();
            const payout = await money.createPayout(
                {beneficiaryType: 'landlord', beneficiaryUserId: landlord.id},
                ACTOR
            );

            await money.changePayoutStatus(payout.id, {status: 'cancelled'}, ACTOR);

            const {items} = await money.outstandingBalances();
            assert.equal(items.length, 1);
            assert.equal(Number(items[0].amount_due), 1000000);
        });

        test('a failed payout carries a reason and can be rescheduled', async () => {
            const {landlord} = await collectedRent();
            const payout = await money.createPayout(
                {beneficiaryType: 'landlord', beneficiaryUserId: landlord.id},
                ACTOR
            );
            await money.changePayoutStatus(payout.id, {status: 'processing'}, ACTOR);

            await assert.rejects(
                money.changePayoutStatus(payout.id, {status: 'failed'}, ACTOR),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );

            const failed = await money.changePayoutStatus(
                payout.id,
                {status: 'failed', reason: 'Wrong mobile number'},
                ACTOR
            );
            assert.equal(failed.failure_reason, 'Wrong mobile number');

            const rescheduled = await money.changePayoutStatus(payout.id, {status: 'scheduled'}, ACTOR);
            assert.equal(rescheduled.status, 'scheduled');
            assert.equal(rescheduled.failure_reason, null);
        });

        test('a paid payout is final', async () => {
            const {landlord} = await collectedRent();
            const payout = await money.createPayout(
                {beneficiaryType: 'landlord', beneficiaryUserId: landlord.id},
                ACTOR
            );
            await money.changePayoutStatus(payout.id, {status: 'processing'}, ACTOR);
            await money.changePayoutStatus(payout.id, {status: 'paid'}, ACTOR);

            await assert.rejects(
                money.changePayoutStatus(payout.id, {status: 'cancelled'}, ACTOR),
                expectDomainError(ErrorCodes.ILLEGAL_TRANSITION)
            );
        });

        test('refuses to pay a beneficiary with nothing outstanding', async () => {
            const landlord = await makeUser();
            await assert.rejects(
                money.createPayout({beneficiaryType: 'landlord', beneficiaryUserId: landlord.id}, ACTOR),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
        });

        test('summarises the whole money position from the database', async () => {
            const {landlord} = await collectedRent();
            const payout = await money.createPayout(
                {beneficiaryType: 'landlord', beneficiaryUserId: landlord.id},
                ACTOR
            );
            await money.changePayoutStatus(payout.id, {status: 'processing'}, ACTOR);
            await money.changePayoutStatus(payout.id, {status: 'paid'}, ACTOR);

            const summary = await money.summary();
            assert.equal(Number(summary.collected), 1000000);
            assert.equal(Number(summary.disbursed), 1000000);
            assert.equal(Number(summary.platform_revenue), 0);
            assert.equal(Number(summary.owed), 0);
        });

        test('payouts are searchable by reference and beneficiary name', async () => {
            const {landlord} = await collectedRent();
            const payout = await money.createPayout(
                {beneficiaryType: 'landlord', beneficiaryUserId: landlord.id},
                ACTOR
            );

            assert.equal((await money.searchPayouts({query: payout.reference})).items.length, 1);
            assert.equal((await money.searchPayouts({query: 'Landlord'})).items.length, 1);
            assert.equal((await money.searchPayouts({status: 'paid'})).items.length, 0);
        });
    });

    // --- Dictionaries --------------------------------------------------------

    describe('dictionaries', () => {
        test('imports a sheet, resolving parents by code', async () => {
            const result = await dictionaries.importItems(
                {
                    category: 'region',
                    items: [
                        {code: 'test_mbeya', name: 'Mbeya', sortOrder: 1},
                        {code: 'test_mbeya_city', name: 'Mbeya City', parentCode: 'test_mbeya', sortOrder: 2},
                    ],
                },
                ACTOR
            );

            assert.equal(result.created, 2);
            assert.equal(result.updated, 0);

            const {items} = await dictionaries.list({category: 'region', query: 'Mbeya City'});
            assert.equal(items.length, 1);
            assert.equal(items[0].parent_name, 'Mbeya');
        });

        test('re-importing a corrected sheet updates rather than duplicates', async () => {
            await dictionaries.importItems(
                {category: 'amenity', items: [{code: 'test_wifi', name: 'Wifi'}]},
                ACTOR
            );
            const second = await dictionaries.importItems(
                {category: 'amenity', items: [{code: 'test_wifi', name: 'Wi-Fi'}]},
                ACTOR
            );

            assert.equal(second.created, 0);
            assert.equal(second.updated, 1);

            const {items} = await dictionaries.list({category: 'amenity', query: 'Wi-Fi'});
            assert.equal(items.length, 1);
            assert.equal(items[0].name, 'Wi-Fi');
        });

        test('an unknown parent code fails the whole import', async () => {
            await assert.rejects(
                dictionaries.importItems(
                    {
                        category: 'region',
                        items: [{code: 'test_orphan', name: 'Orphan', parentCode: 'test_nowhere'}],
                    },
                    ACTOR
                ),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );

            const {items} = await dictionaries.list({category: 'region', query: 'Orphan'});
            assert.equal(items.length, 0);
        });

        test('a row missing a code fails the import and leaves nothing behind', async () => {
            await assert.rejects(
                dictionaries.importItems(
                    {
                        category: 'amenity',
                        items: [{code: 'test_pool', name: 'Plunge Pool'}, {name: 'No code'}],
                    },
                    ACTOR
                ),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
            assert.equal((await dictionaries.list({category: 'amenity', query: 'test_pool'})).items.length, 0);
        });

        test('deactivateMissing retires codes absent from the new sheet', async () => {
            await dictionaries.importItems(
                {category: 'amenity', items: [{code: 'test_a', name: 'A'}, {code: 'test_b', name: 'B'}]},
                ACTOR
            );
            const result = await dictionaries.importItems(
                {category: 'amenity', items: [{code: 'test_a', name: 'A'}], deactivateMissing: true},
                ACTOR
            );

            assert.ok(result.deactivated >= 1);
            const active = await dictionaries.list({category: 'amenity', query: 'test_b'});
            assert.equal(active.items.length, 0);
            const all = await dictionaries.list({category: 'amenity', query: 'test_b', includeInactive: true});
            assert.equal(all.items.length, 1);
        });

        test('archiving hides an item and its children, restoring brings it back', async () => {
            await dictionaries.importItems(
                {
                    category: 'region',
                    items: [
                        {code: 'test_iringa', name: 'Iringa'},
                        {code: 'test_iringa_dc', name: 'Iringa DC', parentCode: 'test_iringa'},
                    ],
                },
                ACTOR
            );
            const {items} = await dictionaries.list({category: 'region', query: 'test_iringa'});
            const parent = items.find((item) => item.code === 'test_iringa');

            await dictionaries.archive(parent.id, ACTOR);

            const visible = await dictionaries.list({category: 'region', query: 'test_iringa'});
            assert.equal(visible.items.length, 0);

            await dictionaries.restore(parent.id, ACTOR);
            const back = await dictionaries.list({category: 'region', query: 'test_iringa'});
            assert.equal(back.items.length, 1);
        });

        test('deletes an unused item but refuses one that is in use', async () => {
            await dictionaries.importItems(
                {
                    category: 'region',
                    items: [
                        {code: 'test_songwe', name: 'Songwe'},
                        {code: 'test_songwe_dc', name: 'Songwe DC', parentCode: 'test_songwe'},
                    ],
                },
                ACTOR
            );
            const {items} = await dictionaries.list({category: 'region', query: 'test_songwe'});
            const parent = items.find((i) => i.code === 'test_songwe');
            const child = items.find((i) => i.code === 'test_songwe_dc');

            await assert.rejects(
                dictionaries.remove(parent.id, ACTOR),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );

            const removed = await dictionaries.remove(child.id, ACTOR);
            assert.equal(removed.deleted, true);
        });

        test('dictionary items are searchable by name and by code', async () => {
            const byName = await dictionaries.list({query: 'Kinondoni'});
            assert.ok(byName.items.length >= 1);
            const byCode = await dictionaries.list({query: 'kinondoni'});
            assert.ok(byCode.items.length >= 1);
        });
    });

    // --- Attention counters --------------------------------------------------

    describe('attention counters', () => {
        test('a quiet platform shows nothing needing attention', async () => {
            const {badges} = await insights.attention();
            assert.deepEqual(badges, {
                properties: 0,
                agencies: 0,
                users: 0,
                staff: 0,
                payments: 0,
                inquiries: 0,
                partners: 0,
            });
        });

        test('counts pending review, kyc, staff invitations and money', async () => {
            const landlord = await makeUser();
            const propertyId = await makeProperty({ownerId: landlord.id});
            await pool.query("update properties set status = 'pending_review' where id = $1", [propertyId]);
            await pool.query(
                `insert into organizations (name, type, status) values ('Pending Agency', 'agency', 'pending')`
            );
            await makeUser({role: 'moderator', email: 'mod@homemate.co.tz', status: 'pending'});
            await kyc.addDocument(
                landlord.id,
                {documentType: 'national_id', file: {contentType: 'image/webp', body: Buffer.from('x')}},
                ACTOR
            );
            await money.recordPayment({propertyId, amount: 1000000}, ACTOR);

            const {badges, counts} = await insights.attention();
            assert.equal(badges.properties, 1);
            assert.equal(badges.agencies, 1);
            assert.equal(badges.staff, 1);
            assert.equal(counts.paymentsPending, 1);
            assert.ok(badges.users >= 1);
            assert.ok(badges.payments >= 1);
        });

        test('a beneficiary owed money is surfaced for finance', async () => {
            const landlord = await makeUser();
            await kyc.reviewUser(landlord.id, {status: 'verified'}, ACTOR);
            const propertyId = await makeProperty({ownerId: landlord.id});
            const payment = await money.recordPayment({propertyId, amount: 1000000}, ACTOR);
            await money.reconcilePayment(payment.id, {}, ACTOR);

            const {counts} = await insights.attention();
            assert.equal(counts.beneficiariesOwed, 1);
            assert.equal(counts.paymentsPending, 0);
        });
    });
});
