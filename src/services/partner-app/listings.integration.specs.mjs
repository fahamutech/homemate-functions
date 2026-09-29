import {test, describe, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createPartnerListingsService} from './listings.mjs';
import {createLandlordDirectoryService} from './landlords.mjs';
import {createLandlordConfirmationsService} from './confirmations.mjs';
import {createPropertiesService} from '../admin-console/properties.mjs';
import {createPropertyDetailsService} from '../admin-console/property-details.mjs';
import {createMoneyService} from '../admin-console/money.mjs';
import {createCustomerAppService} from '../customer-app/service.mjs';
import {createMemoryStorageAdapter} from '../storage/adapters/memory-storage.adapter.mjs';
import {createSandboxNotificationAdapter} from '../identity-access/adapters/sandbox-notification.adapter.mjs';
import {createSandboxPaymentAdapter} from '../payments/adapters/sandbox-payment.adapter.mjs';
import {ErrorCodes} from '../../shared/errors.mjs';

/**
 * Partner listings (T04, migration 029) against a real database: a broker
 * lists a home from the app, the landlord confirms it, the moderator approves
 * it, and customers find it. Plus the landlord's own listings, disputes,
 * privacy between brokers, the edit lock after submit and the BR-003 lock.
 */

const MODERATOR = 'moderator@homemate.co.tz';
const BROKER_PHONE = '+255713700001';
const LANDLORD_PHONE = '+255713700002';

function expectDomainError(code, pattern) {
    return (error) => {
        assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
        if (pattern) assert.match(error.message, pattern);
        return true;
    };
}

const webp = (label = 'photo') => ({
    image: {name: `${label}.webp`, contentType: 'image/webp', body: Buffer.from(`RIFF----WEBPVP8 ${label}`)},
});

describe('partner listings (Postgres integration)', () => {
    /** @type {pg.Pool} */
    let pool;
    let sms;
    let listings;
    let landlords;
    let confirmations;
    let properties;
    let details;
    let money;
    let customerApp;
    let dictionaryIds;

    before(async () => {
        pool = new pg.Pool({connectionString: process.env.DATABASE_URL});
        sms = createSandboxNotificationAdapter();
        const storagePort = createMemoryStorageAdapter();
        properties = createPropertiesService({pool});
        details = createPropertyDetailsService({pool, storagePort});
        listings = createPartnerListingsService({pool, storagePort, notificationPort: sms, properties});
        landlords = createLandlordDirectoryService({pool});
        confirmations = createLandlordConfirmationsService({pool});
        money = createMoneyService({pool, paymentPorts: {sandbox: createSandboxPaymentAdapter()}});
        customerApp = createCustomerAppService({pool});

        const {rows} = await pool.query(
            `select code, id from dictionary_items where code in ('apartment', 'dar_es_salaam', 'parking', 'security')`
        );
        dictionaryIds = Object.fromEntries(rows.map((r) => [r.code, r.id]));
    });

    after(async () => {
        await pool.end();
    });

    beforeEach(async () => {
        await pool.query(
            `truncate table notifications, ledger_entries, payment_splits, external_payment_events, payouts, payments,
                            property_inquiries, property_payment_methods, property_media, property_charges,
                            property_amenities, property_parties, properties, users, organizations
             restart identity cascade`
        );
        await pool.query('truncate table audit_log restart identity');
        sms.sentMessages.length = 0;
    });

    async function user(phone, {role = 'customer', fullName = 'Someone', email = null, allowedRoutes = null} = {}) {
        const {rows} = await pool.query(
            `insert into users (phone_number, full_name, role, status, email, allowed_routes)
             values ($1, $2, $3, 'active', $4, $5::jsonb) returning id`,
            [phone, fullName, role, email, allowedRoutes ? JSON.stringify(allowedRoutes) : null]
        );
        return rows[0].id;
    }

    /** An approved broker (legacy role grants an active broker role, 027). */
    const broker = (phone = BROKER_PHONE, fullName = 'Juma Broker') => user(phone, {role: 'broker', fullName});
    /** An approved landlord. */
    const landlord = (phone = LANDLORD_PHONE, fullName = 'Amina Mwinyi') => user(phone, {role: 'landlord', fullName});

    const basics = (overrides = {}) => ({
        title: 'Masaki 2BR Apartment',
        description: 'Bright, quiet, near the sea',
        propertyTypeId: dictionaryIds.apartment,
        bedrooms: 2,
        bathrooms: 1,
        price: 900000,
        regionId: dictionaryIds.dar_es_salaam,
        addressLine: 'Masaki, Dar es Salaam',
        latitude: -6.7576,
        longitude: 39.2768,
        depositMonths: 2,
        minLeaseMonths: 6,
        ...overrides,
    });

    /** A broker's complete listing with a photo and a landlord, not yet confirmed. */
    async function brokerListing(brokerId, landlordId) {
        const draft = await listings.create(brokerId, 'broker', basics());
        await listings.addPhoto(brokerId, 'broker', draft.id, webp());
        return listings.update(brokerId, 'broker', draft.id, {landlordUserId: landlordId});
    }

    async function partyOf(propertyId, role) {
        const {rows} = await pool.query(
            'select * from property_parties where property_id = $1 and role = $2 and is_primary',
            [propertyId, role]
        );
        return rows[0] ?? null;
    }

    describe('the broker journey', () => {
        test('draft → photo → submit blocked until the landlord confirms → confirm → submit → approve → customers find it', async () => {
            const brokerId = await broker();
            const landlordId = await landlord();

            const draft = await listings.create(brokerId, 'broker', basics());
            assert.equal(draft.status, 'draft');
            assert.equal(draft.editable, true);
            assert.equal(draft.broker.userId, brokerId);
            assert.equal(draft.listedBy.you, true);
            assert.equal((await partyOf(draft.id, 'broker')).is_primary, true);
            const {rows: created} = await pool.query('select created_by_user_id from properties where id = $1', [draft.id]);
            assert.equal(created[0].created_by_user_id, brokerId);
            assert.deepEqual(draft.submitBlockers.map((b) => b.code), ['no_photos', 'no_landlord']);

            await listings.addPhoto(brokerId, 'broker', draft.id, webp());
            const attached = await listings.update(brokerId, 'broker', draft.id, {landlordUserId: landlordId});
            assert.equal(attached.landlord.userId, landlordId);
            assert.equal(attached.landlord.confirmationStatus, 'pending');
            assert.equal(attached.canSubmit, false);
            assert.deepEqual(attached.submitBlockers.map((b) => b.code), ['landlord_pending']);

            // The landlord is told, with the app link and a web fallback.
            const text = sms.lastMessageTo(LANDLORD_PHONE);
            assert.equal(text.template, 'landlord-confirm-listing');
            assert.equal(text.params.link, `homemate://landlord/confirm/${draft.id}`);
            assert.match(text.params.webLink, new RegExp(`/landlord/confirm/${draft.id}$`));

            await assert.rejects(listings.submit(brokerId, 'broker', draft.id), (error) => {
                assert.equal(error.status, 422);
                assert.deepEqual(error.details.reasons.map((r) => r.code), ['landlord_pending']);
                return true;
            });

            const waiting = await confirmations.list(landlordId);
            assert.equal(waiting.items.length, 1);
            assert.equal(waiting.items[0].propertyId, draft.id);
            assert.equal(waiting.items[0].broker.name, 'Juma Broker');
            assert.equal(Number(waiting.items[0].terms.price), 900000);
            assert.equal(Number(waiting.items[0].terms.depositMonths), 2);

            const confirmed = await confirmations.confirm(landlordId, draft.id);
            assert.equal(confirmed.confirmationStatus, 'confirmed');
            assert.ok((await partyOf(draft.id, 'landlord')).confirmed_at);
            assert.equal((await confirmations.list(landlordId)).items.length, 0);

            const submitted = await listings.submit(brokerId, 'broker', draft.id);
            assert.equal(submitted.status, 'pending_review');
            assert.ok(submitted.statusHistory.submittedAt);
            assert.equal(submitted.editable, false);

            await properties.changeStatus(draft.id, {status: 'approved'}, MODERATOR);
            const found = await customerApp.searchProperties({});
            assert.ok(found.items.some((item) => item.id === draft.id), 'the approved listing is searchable');
        });

        test('the landlord role sees the broker’s listing as listed by the broker', async () => {
            const brokerId = await broker();
            const landlordId = await landlord();
            const listing = await brokerListing(brokerId, landlordId);

            const mine = await listings.list(landlordId, 'landlord', {});
            assert.equal(mine.items.length, 1);
            assert.equal(mine.items[0].id, listing.id);
            assert.deepEqual(mine.items[0].listedBy, {you: false, name: 'Juma Broker'});
            assert.equal(mine.items[0].landlordConfirmation, 'pending');
            assert.equal(mine.items[0].confirmed, false);
        });

        test('my listings: status, cover photo, rent and open enquiries, filterable', async () => {
            const brokerId = await broker();
            const landlordId = await landlord();
            const listing = await brokerListing(brokerId, landlordId);
            await listings.create(brokerId, 'broker', basics({title: 'Another'}));

            const customer = await user('+255713700050');
            await pool.query(
                `insert into property_inquiries (reference, property_id, customer_id, status, message)
                 values ('INQ-1', $1, $2, 'pending', 'Is it free?')`,
                [listing.id, customer]
            );

            const all = await listings.list(brokerId, 'broker', {});
            assert.equal(all.items.length, 2);
            const item = all.items.find((i) => i.id === listing.id);
            assert.equal(item.status, 'draft');
            assert.equal(Number(item.price), 900000);
            assert.match(item.coverPhotoUrl, /^\/app\/media\/[0-9a-f-]+\/raw$/);
            assert.equal(item.openEnquiries, 1);
            assert.deepEqual(item.listedBy, {you: true, name: 'Juma Broker'});

            assert.equal((await listings.list(brokerId, 'broker', {status: 'pending_review'})).items.length, 0);
            assert.equal((await listings.list(brokerId, 'broker', {status: 'draft'})).items.length, 2);
            await assert.rejects(listings.list(brokerId, 'broker', {status: 'bogus'}), expectDomainError(ErrorCodes.VALIDATION_FAILED));
        });

        test('amenities, charges, terms and photo order are written through the wizard', async () => {
            const brokerId = await broker();
            const draft = await listings.create(brokerId, 'broker', basics());
            const first = await listings.addPhoto(brokerId, 'broker', draft.id, webp('a'));
            const second = await listings.addPhoto(brokerId, 'broker', draft.id, webp('b'));
            const [a, b] = second.photos.map((p) => p.id);
            assert.ok(first.photos[0].isCover, 'the first photo is the cover');

            const edited = await listings.update(brokerId, 'broker', draft.id, {
                amenityIds: [dictionaryIds.parking, dictionaryIds.security],
                charges: [{name: 'Water', amount: 20000}, {name: 'Security', amount: 30000}],
                photoOrder: [b, a],
                paymentFrequency: 'quarterly',
                houseRules: 'No parties',
                status: 'approved',
            });

            assert.deepEqual(edited.amenities.map((x) => x.code).sort(), ['parking', 'security']);
            assert.deepEqual(edited.charges.map((c) => c.name).sort(), ['Security', 'Water']);
            assert.deepEqual(edited.photos.map((p) => p.id), [b, a]);
            assert.equal(edited.photos[0].isCover, true);
            assert.equal(edited.paymentFrequency, 'quarterly');
            assert.equal(edited.houseRules, 'No parties');
            assert.equal(edited.status, 'draft', 'status is not the partner’s to set');

            const again = await listings.update(brokerId, 'broker', draft.id, {charges: [{name: 'Water', amount: 25000}]});
            assert.deepEqual(again.charges.map((c) => [c.name, Number(c.amount)]), [['Water', 25000]]);
            assert.equal(again.amenities.length, 2, 'a list left out is left alone');

            const removed = await listings.removePhoto(brokerId, 'broker', draft.id, b);
            assert.deepEqual(removed.photos.map((p) => p.id), [a]);
            assert.equal(removed.photos[0].isCover, true, 'the next photo becomes the cover');
        });

        test('a photo order must list exactly this listing’s photos', async () => {
            const brokerId = await broker();
            const draft = await listings.create(brokerId, 'broker', basics());
            await listings.addPhoto(brokerId, 'broker', draft.id, webp());
            await assert.rejects(
                listings.update(brokerId, 'broker', draft.id, {photoOrder: ['00000000-0000-0000-0000-000000000000']}),
                expectDomainError(ErrorCodes.VALIDATION_FAILED, /photo/)
            );
        });

        test('photos must be WebP', async () => {
            const brokerId = await broker();
            const draft = await listings.create(brokerId, 'broker', basics());
            await assert.rejects(
                listings.addPhoto(brokerId, 'broker', draft.id, {image: {contentType: 'image/jpeg', body: Buffer.from('x')}}),
                expectDomainError(ErrorCodes.VALIDATION_FAILED, /WebP/)
            );
        });

        test('only a user with a landlord role can be attached as the landlord', async () => {
            const brokerId = await broker();
            const customer = await user('+255713700060');
            const draft = await listings.create(brokerId, 'broker', basics());
            await assert.rejects(
                listings.update(brokerId, 'broker', draft.id, {landlordUserId: customer}),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
        });

        test('re-attaching a different landlord replaces the first', async () => {
            const brokerId = await broker();
            const first = await landlord();
            const second = await landlord('+255713700003', 'Second Landlord');
            const draft = await listings.create(brokerId, 'broker', basics());
            await listings.update(brokerId, 'broker', draft.id, {landlordUserId: first});
            const replaced = await listings.update(brokerId, 'broker', draft.id, {landlordUserId: second});
            assert.equal(replaced.landlord.userId, second);
            const {rows} = await pool.query(`select user_id from property_parties where property_id = $1 and role = 'landlord'`, [draft.id]);
            assert.deepEqual(rows.map((r) => r.user_id), [second]);
        });

        test('an applicant broker can draft but not submit (T03 canSubmitListings)', async () => {
            const applicant = await user('+255713700070', {fullName: 'New Broker'});
            await pool.query(`insert into user_roles (user_id, role, status) values ($1, 'broker', 'pending_review')`, [applicant]);
            const landlordId = await landlord();

            const draft = await listings.create(applicant, 'broker', basics());
            await listings.addPhoto(applicant, 'broker', draft.id, webp());
            await listings.update(applicant, 'broker', draft.id, {landlordUserId: landlordId});
            await confirmations.confirm(landlordId, draft.id);

            await assert.rejects(listings.submit(applicant, 'broker', draft.id), (error) => {
                assert.deepEqual(error.details.reasons.map((r) => r.code), ['role_not_active']);
                return true;
            });

            await pool.query(`update user_roles set status = 'active' where user_id = $1 and role = 'broker'`, [applicant]);
            assert.equal((await listings.submit(applicant, 'broker', draft.id)).status, 'pending_review');
        });

        test('a draft missing BR-001 data reports every gap', async () => {
            const brokerId = await broker();
            const draft = await listings.create(brokerId, 'broker', {title: 'Just a title'});
            await assert.rejects(listings.submit(brokerId, 'broker', draft.id), (error) => {
                assert.deepEqual(error.details.reasons.map((r) => r.code), [
                    'missing_price', 'missing_property_type', 'missing_region', 'missing_location', 'no_photos', 'no_landlord',
                ]);
                return true;
            });
        });
    });

    describe('the money preview on rent & terms (BRK-030c)', () => {
        test('what the tenant pays to move in, and what the viewer earns — from the checkout formula', async () => {
            await pool.query(`update settings set value = case key when 'commission.tenant_fee_percentage' then '50'::jsonb else '10'::jsonb end
                               where key in ('commission.tenant_fee_percentage', 'commission.platform_percentage')`);
            const brokerId = await broker();
            const draft = await listings.create(brokerId, 'broker', basics({price: 800000, depositMonths: 2}));
            assert.deepEqual(draft.moneyPreview, {
                rent: 800000,
                deposit: 1600000,
                advance: 0,
                firstRent: 800000,
                tenantFee: 400000,
                tenantFeePercentage: 50,
                saving: 400000,
                total: 2800000,
                youEarn: {feeShare: 360000, rentAndDeposit: 0, total: 360000},
            });

            const updated = await listings.update(brokerId, 'broker', draft.id, {price: 1000000, advanceRentMonths: 3});
            assert.equal(updated.moneyPreview.firstRent, 3000000);
            assert.equal(updated.moneyPreview.total, 2000000 + 3000000 + 500000);
        });

        test('a landlord listing their own home gets rent, deposit and the fee share', async () => {
            await pool.query(`update settings set value = case key when 'commission.tenant_fee_percentage' then '50'::jsonb else '10'::jsonb end
                               where key in ('commission.tenant_fee_percentage', 'commission.platform_percentage')`);
            const landlordId = await landlord();
            const draft = await listings.create(landlordId, 'landlord', basics({price: 800000, depositMonths: 2}));
            assert.deepEqual(draft.moneyPreview.youEarn, {feeShare: 360000, rentAndDeposit: 2400000, total: 2760000});
        });
    });

    describe('the landlord', () => {
        test('a landlord’s own listing needs no confirmation', async () => {
            const landlordId = await landlord();
            const draft = await listings.create(landlordId, 'landlord', basics());
            assert.equal(draft.landlord.userId, landlordId);
            assert.equal(draft.landlord.confirmationStatus, 'not_required');
            assert.equal(draft.broker, null);
            await listings.addPhoto(landlordId, 'landlord', draft.id, webp());

            const submitted = await listings.submit(landlordId, 'landlord', draft.id);
            assert.equal(submitted.status, 'pending_review');
            assert.equal(sms.sentMessages.length, 0);
        });

        test('a landlord cannot attach a landlord', async () => {
            const landlordId = await landlord();
            const other = await landlord('+255713700003', 'Other');
            const draft = await listings.create(landlordId, 'landlord', basics());
            await assert.rejects(
                listings.update(landlordId, 'landlord', draft.id, {landlordUserId: other}),
                expectDomainError(ErrorCodes.FORBIDDEN)
            );
        });

        test('a dispute blocks submission and tells the broker and staff', async () => {
            const brokerId = await broker();
            const landlordId = await landlord();
            const admin = await user('+255713700090', {role: 'admin', email: 'a@homemate.co.tz'});
            const listing = await brokerListing(brokerId, landlordId);

            await assert.rejects(confirmations.dispute(landlordId, listing.id, {reason: ' '}), expectDomainError(ErrorCodes.VALIDATION_FAILED));
            const disputed = await confirmations.dispute(landlordId, listing.id, {reason: 'This is not my house'});
            assert.equal(disputed.confirmationStatus, 'disputed');

            await assert.rejects(listings.submit(brokerId, 'broker', listing.id), (error) => {
                assert.deepEqual(error.details.reasons.map((r) => r.code), ['landlord_disputed']);
                return true;
            });
            // And the database refuses it even if the service were skipped.
            await assert.rejects(properties.changeStatus(listing.id, {status: 'pending_review'}, MODERATOR), expectDomainError(ErrorCodes.VALIDATION_FAILED, /disputed/));

            const {rows} = await pool.query('select user_id, body from notifications order by created_at');
            const told = rows.map((r) => r.user_id);
            assert.ok(told.includes(brokerId));
            assert.ok(told.includes(admin));
            assert.ok(rows.some((r) => r.body.includes('This is not my house')));

            const detail = await listings.get(brokerId, 'broker', listing.id);
            assert.equal(detail.landlord.disputeReason, 'This is not my house');
        });

        test('a landlord can only confirm listings that name them', async () => {
            const brokerId = await broker();
            const landlordId = await landlord();
            const stranger = await landlord('+255713700004', 'Stranger');
            const listing = await brokerListing(brokerId, landlordId);
            await assert.rejects(confirmations.confirm(stranger, listing.id), expectDomainError(ErrorCodes.NOT_FOUND));
        });
    });

    describe('privacy and locks', () => {
        test('a broker cannot see or touch another broker’s listings (FR-BRK-003)', async () => {
            const mine = await broker();
            const theirs = await broker('+255713700005', 'Other Broker');
            const listing = await listings.create(theirs, 'broker', basics());

            assert.equal((await listings.list(mine, 'broker', {})).items.length, 0);
            for (const attempt of [
                () => listings.get(mine, 'broker', listing.id),
                () => listings.update(mine, 'broker', listing.id, {title: 'Mine now'}),
                () => listings.addPhoto(mine, 'broker', listing.id, webp()),
                () => listings.submit(mine, 'broker', listing.id),
                () => listings.archive(mine, 'broker', listing.id),
            ]) {
                await assert.rejects(attempt(), expectDomainError(ErrorCodes.NOT_FOUND));
            }
        });

        test('editing is refused after submit, and allowed again when changes are requested', async () => {
            const landlordId = await landlord();
            const draft = await listings.create(landlordId, 'landlord', basics());
            await listings.addPhoto(landlordId, 'landlord', draft.id, webp());
            await listings.submit(landlordId, 'landlord', draft.id);

            await assert.rejects(listings.update(landlordId, 'landlord', draft.id, {title: 'Changed'}), expectDomainError(ErrorCodes.CONFLICT));
            await assert.rejects(listings.addPhoto(landlordId, 'landlord', draft.id, webp()), expectDomainError(ErrorCodes.CONFLICT));

            await properties.changeStatus(draft.id, {status: 'changes_requested', reason: 'Add a kitchen photo'}, MODERATOR);
            const back = await listings.get(landlordId, 'landlord', draft.id);
            assert.equal(back.editable, true);
            assert.equal(back.statusHistory.rejectionReason, 'Add a kitchen photo');
            assert.ok(back.statusHistory.reviewedAt);
            await listings.update(landlordId, 'landlord', draft.id, {title: 'With kitchen'});
            assert.equal((await listings.submit(landlordId, 'landlord', draft.id)).status, 'pending_review');
        });

        test('only the party that created a listing edits it', async () => {
            const brokerId = await broker();
            const landlordId = await landlord();
            const listing = await brokerListing(brokerId, landlordId);
            await assert.rejects(
                listings.update(landlordId, 'landlord', listing.id, {title: 'The landlord renames it'}),
                expectDomainError(ErrorCodes.FORBIDDEN)
            );
        });

        test('archiving takes a listing off the list', async () => {
            const landlordId = await landlord();
            const draft = await listings.create(landlordId, 'landlord', basics());
            const archived = await listings.archive(landlordId, 'landlord', draft.id);
            assert.equal(archived.status, 'archived');
            assert.equal((await listings.list(landlordId, 'landlord', {})).items.length, 0);
            assert.equal((await listings.list(landlordId, 'landlord', {status: 'archived'})).items.length, 1);
        });

        test('BR-003: the primary broker is fixed once a payment succeeded', async () => {
            const brokerId = await broker();
            const landlordId = await landlord();
            const other = await broker('+255713700006', 'Other Broker');
            const listing = await brokerListing(brokerId, landlordId);
            await confirmations.confirm(landlordId, listing.id);

            // Before any money: the backoffice may still correct the broker.
            await details.assignParty(listing.id, {userId: other, role: 'broker', isPrimary: false}, MODERATOR);

            const payment = await money.recordPayment({propertyId: listing.id, amount: 900000}, MODERATOR);
            await money.recordProviderEvent(payment.id, {provider: 'sandbox', status: 'successful', providerReference: 'X1'}, MODERATOR);

            const {rows: brokerParty} = await pool.query(
                `select id from property_parties where property_id = $1 and role = 'broker' and is_primary`,
                [listing.id]
            );
            await assert.rejects(
                details.removeParty(listing.id, brokerParty[0].id, MODERATOR),
                expectDomainError(ErrorCodes.VALIDATION_FAILED, /BR-003/)
            );
            await assert.rejects(
                pool.query(`update property_parties set is_primary = false where id = $1`, [brokerParty[0].id]),
                /BR-003/
            );
            await assert.rejects(
                details.assignParty(listing.id, {userId: other, role: 'broker', isPrimary: true}, MODERATOR),
                expectDomainError(ErrorCodes.VALIDATION_FAILED, /BR-003/)
            );
            // A non-primary broker can still come and go.
            const {rows: secondary} = await pool.query(
                `select id from property_parties where property_id = $1 and user_id = $2`,
                [listing.id, other]
            );
            await details.removeParty(listing.id, secondary[0].id, MODERATOR);
        });

        test('backoffice listings keep working without landlord confirmation', async () => {
            const brokerId = await broker();
            const landlordId = await landlord();
            const property = await properties.create(basics(), MODERATOR);
            await details.assignParty(property.id, {userId: landlordId, role: 'landlord', isPrimary: true}, MODERATOR);
            await details.assignParty(property.id, {userId: brokerId, role: 'broker', isPrimary: true}, MODERATOR);
            assert.equal((await partyOf(property.id, 'landlord')).confirmation_status, 'not_required');
            await properties.changeStatus(property.id, {status: 'pending_review'}, MODERATOR);
        });
    });

    describe('finding and inviting landlords', () => {
        test('lookup shows a masked card for a landlord, and nothing more for anyone else', async () => {
            const landlordId = await landlord(LANDLORD_PHONE, 'Amina Mwinyi');
            await user('+255713700080', {fullName: 'Plain Customer'});
            await listings.create(landlordId, 'landlord', basics());

            const found = await landlords.lookup('0713700002');
            assert.deepEqual(found, {
                found: true,
                landlord: {userId: landlordId, name: 'Amina M.', phone: '+255 71* *** 002', homes: 1, status: 'active'},
            });

            for (const phone of ['+255713700080', '+255713700099']) {
                assert.deepEqual(await landlords.lookup(phone), {found: false});
            }
            await assert.rejects(landlords.lookup('12345'), expectDomainError(ErrorCodes.VALIDATION_FAILED));
        });

        test('a rejected landlord role does not show up', async () => {
            const someone = await user('+255713700081');
            await pool.query(
                `insert into user_roles (user_id, role, status, rejection_reason) values ($1, 'landlord', 'rejected', 'No')`,
                [someone]
            );
            assert.deepEqual(await landlords.lookup('+255713700081'), {found: false});
        });

        test('invite creates the person when new, and an invited landlord can be attached', async () => {
            const brokerId = await broker();
            const invited = await landlords.invite(brokerId, {fullName: 'Mzee Hamisi', phone: '0713700010'});
            assert.equal(invited.landlord.status, 'invited');
            assert.equal(invited.landlord.name, 'Mzee H.');

            const {rows} = await pool.query(
                `select u.full_name, ur.status::text from users u join user_roles ur on ur.user_id = u.id and ur.role = 'landlord'
                  where u.phone_number = '+255713700010'`
            );
            assert.deepEqual(rows[0], {full_name: 'Mzee Hamisi', status: 'invited'});

            const draft = await listings.create(brokerId, 'broker', basics());
            const attached = await listings.update(brokerId, 'broker', draft.id, {landlordUserId: invited.landlord.userId});
            assert.equal(attached.landlord.confirmationStatus, 'pending');
        });

        test('invite reuses an existing customer without renaming them', async () => {
            const brokerId = await broker();
            const existing = await user('+255713700011', {fullName: 'Real Name'});
            const invited = await landlords.invite(brokerId, {fullName: 'Whatever The Broker Typed', phone: '+255713700011'});
            assert.equal(invited.landlord.userId, existing);
            const {rows} = await pool.query('select full_name from users where id = $1', [existing]);
            assert.equal(rows[0].full_name, 'Real Name');
        });

        test('invite leaves an existing landlord role as it is', async () => {
            const brokerId = await broker();
            const landlordId = await landlord();
            const invited = await landlords.invite(brokerId, {fullName: 'X', phone: LANDLORD_PHONE});
            assert.equal(invited.landlord.userId, landlordId);
            assert.equal(invited.landlord.status, 'active');
        });

        test('invite needs a name and a Tanzanian mobile number, and refuses a rejected landlord', async () => {
            const brokerId = await broker();
            await assert.rejects(landlords.invite(brokerId, {fullName: '', phone: '0713700012'}), expectDomainError(ErrorCodes.VALIDATION_FAILED));
            await assert.rejects(landlords.invite(brokerId, {fullName: 'X', phone: '123'}), expectDomainError(ErrorCodes.VALIDATION_FAILED));
            const someone = await user('+255713700013');
            await pool.query(
                `insert into user_roles (user_id, role, status, rejection_reason) values ($1, 'landlord', 'rejected', 'No')`,
                [someone]
            );
            await assert.rejects(landlords.invite(brokerId, {fullName: 'X', phone: '+255713700013'}), expectDomainError(ErrorCodes.CONFLICT));
        });
    });
});
