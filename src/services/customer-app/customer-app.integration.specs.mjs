import {test, describe, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createCustomerAppService} from './service.mjs';
import {createCustomerJourneyService} from './journey.mjs';
import {createMoneyService} from '../admin-console/money.mjs';
import {ErrorCodes} from '../../shared/errors.mjs';

/**
 * What a customer does, against the real database — because the rules being
 * tested are the database's: one open enquiry per property, nothing to pay
 * until the landlord accepts, a reservation that cannot be confirmed before
 * its money arrives, and a payment that a customer's word alone cannot settle.
 */

function expectDomainError(code) {
    return (error) => {
        assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
        return true;
    };
}

describe('customer app (Postgres integration)', () => {
    /** @type {pg.Pool} */
    let pool;
    let app;
    let journey;
    let money;
    let dictionaryIds;
    let landlord;
    let customer;
    let other;
    let propertyId;

    before(async () => {
        pool = new pg.Pool({connectionString: process.env.DATABASE_URL});
        app = createCustomerAppService({pool});
        journey = createCustomerJourneyService({pool});
        money = createMoneyService({pool});
        const {rows} = await pool.query(
            `select code, id from dictionary_items where code in ('apartment', 'dar_es_salaam', 'kinondoni', 'masaki')`
        );
        dictionaryIds = Object.fromEntries(rows.map((r) => [r.code, r.id]));
    });

    after(async () => {
        await pool.end();
    });

    beforeEach(async () => {
        await pool.query(`truncate table
            notifications, customer_preferences, saved_properties, payment_instructions,
            ledger_entries, payment_splits, external_payment_events, payouts, payments,
            lease_agreements, property_holds,
            bookings, property_viewings, property_inquiries,
            kyc_remediations, kyc_documents, property_parties, property_media, properties,
            users, organizations
            restart identity cascade`);
        await pool.query('truncate table audit_log restart identity');

        landlord = await makeUser('+255700001001', 'Baraka Landlord', 'landlord');
        customer = await makeUser('+255700001002', 'Neema Customer', 'customer');
        other = await makeUser('+255700001003', 'Juma Other', 'customer');
        propertyId = await makeProperty();
        await pool.query(
            `update settings set value = '50'::jsonb where key = 'commission.tenant_fee_percentage';
             update settings set value = '10'::jsonb where key = 'commission.platform_percentage';`
        );
    });

    async function makeUser(phone, name, role) {
        const {rows} = await pool.query(
            `insert into users (phone_number, full_name, role, status) values ($1, $2, $3, 'active') returning id`,
            [phone, name, role]
        );
        return rows[0].id;
    }

    async function makeProperty({approve = true, price = 800000} = {}) {
        const {rows} = await pool.query(
            `insert into properties
                 (title, description, owner_id, price, property_type_id, region_id, district_id, ward_id,
                  bedrooms, deposit_months, advance_rent_months, min_lease_months, location, status)
             values ('Masaki 2BR Apartment', 'Bright and airy', $1, $2, $3, $4, $5, $6,
                     2, 2, 0, 12, st_setsrid(st_makepoint(39.2768, -6.7576), 4326)::geography, 'draft')
             returning id`,
            [
                landlord,
                price,
                dictionaryIds.apartment,
                dictionaryIds.dar_es_salaam,
                dictionaryIds.kinondoni,
                dictionaryIds.masaki,
            ]
        );
        const id = rows[0].id;
        await pool.query(
            `insert into property_parties (property_id, user_id, role, is_primary) values ($1, $2, 'landlord', true)`,
            [id, landlord]
        );
        if (approve) {
            await pool.query("update properties set status = 'pending_review' where id = $1", [id]);
            await pool.query("update properties set status = 'approved' where id = $1", [id]);
        }
        return id;
    }

    // --- discovery -----------------------------------------------------------

    describe('discovery', () => {
        test('finds approved listings and never shows one still in moderation', async () => {
            const draftId = await makeProperty({approve: false});

            const results = await app.searchProperties({}, customer);

            assert.equal(results.items.length, 1);
            assert.equal(results.items[0].id, propertyId);
            assert.ok(!results.items.some((item) => item.id === draftId));
        });

        test('narrows by district and ward, which the app filter sheet needs', async () => {
            assert.equal((await app.searchProperties({districtId: dictionaryIds.kinondoni})).items.length, 1);
            assert.equal((await app.searchProperties({wardId: dictionaryIds.masaki})).items.length, 1);
            assert.equal(
                (await app.searchProperties({districtId: dictionaryIds.dar_es_salaam})).items.length,
                0,
                'a region id in the district slot must not match'
            );
        });

        test('finds by text, price and nearby coordinates', async () => {
            assert.equal((await app.searchProperties({query: 'Masaki'})).items.length, 1);
            assert.equal((await app.searchProperties({minPrice: 900000})).items.length, 0);
            assert.equal((await app.searchProperties({maxPrice: 900000})).items.length, 1);
            assert.equal(
                (await app.searchProperties({latitude: -6.7576, longitude: 39.2768, radiusMetres: 500}))
                    .items.length,
                1
            );
            assert.equal(
                (await app.searchProperties({latitude: -3.36, longitude: 36.68, radiusMetres: 500})).items.length,
                0
            );
        });

        test('marks which results this customer has saved', async () => {
            await app.saveProperty(customer, propertyId);

            const mine = await app.searchProperties({}, customer);
            const theirs = await app.searchProperties({}, other);

            assert.equal(mine.items[0].is_saved, true);
            assert.equal(theirs.items[0].is_saved, false);
        });

        test('one call returns the whole property screen', async () => {
            await pool.query(
                `insert into property_media (property_id, url, content_type, is_cover) values ($1, '/k/1', 'image/webp', true)`,
                [propertyId]
            );
            await pool.query(
                `insert into property_amenities (property_id, amenity_id)
                 select $1, id from dictionary_items where category = 'amenity' limit 2`,
                [propertyId]
            );
            await app.saveProperty(customer, propertyId);

            const detail = await app.propertyDetail(propertyId, customer);

            assert.equal(detail.property.reference_code.startsWith('HM-P-'), true);
            assert.equal(detail.media.length, 1);
            assert.equal(detail.amenities.length, 2);
            assert.equal(detail.isSaved, true);
            assert.equal(detail.contact.landlordName, 'Baraka Landlord');
            // Shown before anyone enquires: half a month at 800,000, and the
            // other half kept against the usual month's agent fee.
            assert.deepEqual(
                {amount: detail.serviceFee.amount, saving: detail.serviceFee.saving},
                {amount: 400_000, saving: 400_000}
            );
        });

        test('a property still in moderation is not reachable by direct id', async () => {
            const draftId = await makeProperty({approve: false});
            await assert.rejects(
                app.propertyDetail(draftId, customer),
                expectDomainError(ErrorCodes.NOT_FOUND)
            );
        });
    });

    // --- saving --------------------------------------------------------------

    describe('saved properties', () => {
        test('saves, lists and unsaves, and saving twice is not an error', async () => {
            await app.saveProperty(customer, propertyId, 'Close to work');
            await app.saveProperty(customer, propertyId, 'Actually quite close to work');

            const saved = await app.listSaved(customer);
            assert.equal(saved.items.length, 1);
            assert.equal(saved.items[0].note, 'Actually quite close to work');

            await app.unsaveProperty(customer, propertyId);
            assert.equal((await app.listSaved(customer)).items.length, 0);
        });

        test('one customer never sees another customer’s saved list', async () => {
            await app.saveProperty(customer, propertyId);
            assert.equal((await app.listSaved(other)).items.length, 0);
        });
    });

    // --- inquiries -----------------------------------------------------------

    describe('inquiries', () => {
        test('asks about a property and gets a reference back', async () => {
            const inquiry = await app.createInquiry(customer, {
                propertyId,
                message: 'Is it still available from October?',
                moveInDate: '2026-10-01',
                budgetAmount: 800000,
                occupants: 2,
                contactPreference: 'whatsapp',
            });

            assert.match(inquiry.reference, /^HM-INQ-\d{6}$/);
            assert.equal(inquiry.status, 'pending');
            assert.equal(inquiry.move_in_date, '2026-10-01');
            assert.equal(inquiry.property_title, 'Masaki 2BR Apartment');
        });

        test('refuses a blank message and an unknown contact preference', async () => {
            await assert.rejects(
                app.createInquiry(customer, {propertyId, message: '   '}),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
            await assert.rejects(
                app.createInquiry(customer, {propertyId, message: 'hi', contactPreference: 'carrier-pigeon'}),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
        });

        test('will not open a second enquiry while one is still open', async () => {
            await app.createInquiry(customer, {propertyId, message: 'First ask'});

            await assert.rejects(
                app.createInquiry(customer, {propertyId, message: 'Second ask'}),
                (error) => {
                    assert.equal(error.code, ErrorCodes.CONFLICT);
                    assert.match(error.message, /already have an open enquiry/);
                    return true;
                }
            );
        });

        test('a closed enquiry frees the customer to ask again', async () => {
            const first = await app.createInquiry(customer, {propertyId, message: 'First ask'});
            await app.withdrawInquiry(customer, first.id);

            const second = await app.createInquiry(customer, {propertyId, message: 'Asking again'});
            assert.equal(second.status, 'pending');
        });

        test('cannot ask about a property that is not published', async () => {
            const draftId = await makeProperty({approve: false});
            await assert.rejects(
                app.createInquiry(customer, {propertyId: draftId, message: 'Hello?'}),
                expectDomainError(ErrorCodes.NOT_FOUND)
            );
        });

        test('shows the landlord’s answer once it is given', async () => {
            const inquiry = await app.createInquiry(customer, {propertyId, message: 'Available?'});
            await pool.query(
                `update property_inquiries set status = 'responded', response = 'Yes, from 1 October', responded_by = $2
                  where id = $1`,
                [inquiry.id, landlord]
            );

            const fresh = await app.getInquiry(customer, inquiry.id);
            assert.equal(fresh.status, 'responded');
            assert.equal(fresh.response, 'Yes, from 1 October');
            assert.equal(fresh.responded_by_name, 'Baraka Landlord');
            assert.ok(fresh.responded_at);
        });

        test('a customer cannot read or withdraw someone else’s enquiry', async () => {
            const inquiry = await app.createInquiry(customer, {propertyId, message: 'Mine'});

            await assert.rejects(app.getInquiry(other, inquiry.id), expectDomainError(ErrorCodes.NOT_FOUND));
            await assert.rejects(app.withdrawInquiry(other, inquiry.id), expectDomainError(ErrorCodes.NOT_FOUND));
        });

        test('an already-withdrawn enquiry cannot be withdrawn again', async () => {
            const inquiry = await app.createInquiry(customer, {propertyId, message: 'Mine'});
            await app.withdrawInquiry(customer, inquiry.id);

            await assert.rejects(
                app.withdrawInquiry(customer, inquiry.id),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
        });
    });

    // --- bookings and payment ------------------------------------------------

    describe('paying for an accepted enquiry', () => {
        /** Enquire, be accepted, and start paying — the only road there is. */
        async function reserve(who = customer) {
            const inquiry = await app.createInquiry(who, {propertyId, message: 'Is it still free?'});
            await pool.query("update property_inquiries set status = 'accepted' where id = $1", [inquiry.id]);
            const checkout = await journey.startCheckout(who, propertyId, {moveInDate: '2026-11-01'});
            const payment = await app.getPayment(who, checkout.paymentId);
            return {...checkout, payment};
        }

        async function bookingRow(id) {
            const {rows} = await pool.query('select * from v_bookings where id = $1', [id]);
            return rows[0];
        }

        test('checkout copies the terms, adds the HomeMate fee, and raises the payment', async () => {
            const {bookingId, payment} = await reserve();
            const booking = await bookingRow(bookingId);

            assert.match(booking.reference, /^HM-BK-\d{6}$/);
            assert.equal(booking.status, 'awaiting_payment');
            assert.equal(Number(booking.monthly_rent), 800000);
            // deposit is 2 months; with no advance the first month is due; and
            // the fee is half a month
            assert.equal(Number(booking.deposit_amount), 1600000);
            assert.equal(Number(booking.service_fee), 400000);
            assert.equal(Number(booking.total_due), 2800000);
            assert.equal(Number(booking.amount_outstanding), 2800000);
            assert.equal(payment.customer_state, 'awaiting_instructions');
        });

        test('a later price change does not rewrite what was agreed', async () => {
            const {bookingId} = await reserve();
            await pool.query('update properties set price = 1200000 where id = $1', [propertyId]);

            const fresh = await bookingRow(bookingId);
            assert.equal(Number(fresh.monthly_rent), 800000);
            assert.equal(Number(fresh.total_due), 2800000);
        });

        test('will not start paying for a property that is already let', async () => {
            const {payment} = await reserve();
            await settle(payment.id);
            await pool.query('update property_holds set released_at = now() where released_at is null');

            const inquiry = await app.createInquiry(other, {propertyId, message: 'Still free?'}).catch(() => null);
            if (inquiry) {
                await pool.query("update property_inquiries set status = 'accepted' where id = $1", [inquiry.id]);
            }
            await assert.rejects(
                journey.startCheckout(other, propertyId),
                (error) => /no longer available|cannot be/.test(error.message)
            );
        });

        test('the app is told to wait until an operator supplies the payment details', async () => {
            const {payment} = await reserve();

            await assert.rejects(
                app.declarePaid(customer, payment.id, {reference: 'MPESA-1'}),
                (error) => /details are not ready yet/.test(error.message)
            );
        });

        test('shows the payment details an operator configured, verbatim', async () => {
            const {payment: raised} = await reserve();
            await giveInstructions(raised.id);

            const payment = await app.getPayment(customer, raised.id);
            assert.equal(payment.customer_state, 'awaiting_payment');
            assert.equal(payment.pay_to_account_number, '5566778');
            assert.equal(payment.pay_reference, 'HM-BK-REF');
            assert.equal(payment.pay_to_name, 'HomeMate Africa Ltd');
            assert.match(payment.pay_instructions, /Lipa Namba/);
        });

        test('declaring payment records a claim and settles nothing', async () => {
            const {bookingId, payment} = await reserve();
            await giveInstructions(payment.id);

            const declared = await app.declarePaid(customer, payment.id, {
                reference: 'MPESA-CONF-77',
                note: 'Paid at 10am',
            });

            assert.equal(declared.customer_state, 'awaiting_verification');
            assert.equal(declared.status, 'pending', 'a claim must never settle a payment');
            assert.equal(declared.customer_declared_reference, 'MPESA-CONF-77');

            const fresh = await bookingRow(bookingId);
            assert.equal(Number(fresh.amount_paid), 0);
            assert.equal(Number(fresh.amount_awaiting_verification), 2800000);
        });

        test('a reservation cannot be confirmed on the customer’s word alone', async () => {
            const {bookingId, payment} = await reserve();
            await giveInstructions(payment.id);
            await app.declarePaid(customer, payment.id, {reference: 'MPESA-1'});

            await assert.rejects(
                pool.query("update bookings set status = 'confirmed' where id = $1", [bookingId]),
                /cannot be confirmed yet/
            );
        });

        test('verifying the payment confirms the reservation by itself', async () => {
            const {bookingId, payment} = await reserve();
            await giveInstructions(payment.id);
            await app.declarePaid(customer, payment.id, {reference: 'MPESA-1'});

            await money.reconcilePayment(payment.id, {note: 'Seen on the statement'}, 'finance@homemate.co.tz');

            const fresh = await bookingRow(bookingId);
            assert.equal(fresh.status, 'confirmed');
            assert.equal(Number(fresh.amount_paid), 2800000);
            assert.equal(Number(fresh.amount_outstanding), 0);
            assert.equal((await app.getPayment(customer, payment.id)).customer_state, 'paid');
        });

        test('a payment already settled cannot be declared again', async () => {
            const {payment} = await reserve();
            await settle(payment.id);

            await assert.rejects(
                app.declarePaid(customer, payment.id, {}),
                (error) => /already been confirmed/.test(error.message)
            );
        });

        test('a customer cannot see or act on another customer’s payment', async () => {
            const {payment} = await reserve();
            await giveInstructions(payment.id);

            await assert.rejects(app.getPayment(other, payment.id), expectDomainError(ErrorCodes.NOT_FOUND));
            await assert.rejects(
                app.declarePaid(other, payment.id, {}),
                expectDomainError(ErrorCodes.NOT_FOUND)
            );
        });

        async function giveInstructions(paymentId) {
            await pool.query(
                `insert into payment_instructions
                     (payment_id, display_name, account_name, account_number, payment_reference, instructions, issued_by)
                 values ($1, 'HomeMate Africa Ltd', 'HomeMate Africa', '5566778', 'HM-BK-REF',
                         'Send to Lipa Namba 5566778 and quote the reference.', 'ops@homemate.co.tz')`,
                [paymentId]
            );
        }

        async function settle(paymentId) {
            await giveInstructions(paymentId);
            await money.reconcilePayment(paymentId, {}, 'finance@homemate.co.tz');
        }
    });

    // --- preferences, notifications, summary ---------------------------------

    // --- reference data --------------------------------------------------------

    describe('reference data', () => {
        test('gives the app every picker list in one call', async () => {
            const reference = await app.referenceData();

            for (const key of ['propertyTypes', 'amenities', 'regions', 'districts', 'wards']) {
                assert.ok(Array.isArray(reference[key]), `${key} should be a list`);
                assert.ok(reference[key].length > 0, `${key} should not be empty`);
            }
            assert.ok(reference.propertyTypes.some((type) => type.code === 'apartment'));
        });

        test('places districts under their region, so the picker can cascade', async () => {
            const reference = await app.referenceData();
            const dar = reference.regions.find((region) => region.code === 'dar_es_salaam');
            const kinondoni = reference.districts.find((district) => district.code === 'kinondoni');

            assert.ok(dar);
            assert.equal(kinondoni.parentId, dar.id);
        });

        test('leaves out anything archived, so a filter cannot offer a dead option', async () => {
            const {rows} = await pool.query(
                `select id, code from dictionary_items where category = 'amenity' limit 1`
            );
            const archived = rows[0];
            await pool.query('update dictionary_items set is_active = false where id = $1', [
                archived.id,
            ]);

            try {
                const reference = await app.referenceData();
                assert.ok(!reference.amenities.some((amenity) => amenity.id === archived.id));
            } finally {
                await pool.query('update dictionary_items set is_active = true where id = $1', [
                    archived.id,
                ]);
            }
        });
    });

    describe('profile and activity', () => {
        test('saves and reads back search preferences', async () => {
            const saved = await app.savePreferences(customer, {
                budgetMin: 400000,
                budgetMax: 900000,
                bedroomsMin: 2,
                preferredRegionId: dictionaryIds.dar_es_salaam,
                districtIds: [dictionaryIds.kinondoni],
                furnishing: 'semi_furnished',
                notifyBySms: true,
            });

            assert.equal(Number(saved.budget_max), 900000);
            assert.deepEqual(saved.preferred_district_ids, [dictionaryIds.kinondoni]);

            const reread = await app.getPreferences(customer);
            assert.equal(reread.furnishing, 'semi_furnished');
            assert.equal(reread.notify_by_sms, true);
        });

        test('saving preferences twice updates rather than duplicating', async () => {
            await app.savePreferences(customer, {budgetMax: 900000});
            await app.savePreferences(customer, {budgetMax: 1200000});

            assert.equal(Number((await app.getPreferences(customer)).budget_max), 1200000);
        });

        test('reads notifications and marks them read', async () => {
            await pool.query(
                `insert into notifications (user_id, kind, title, body) values ($1, 'system', 'Welcome', 'Thanks for joining')`,
                [customer]
            );

            const unread = await app.listNotifications(customer, {unreadOnly: true});
            assert.equal(unread.items.length, 1);

            await app.markNotificationRead(customer, unread.items[0].id);
            assert.equal((await app.listNotifications(customer, {unreadOnly: true})).items.length, 0);
        });

        test('a customer cannot mark someone else’s notification read', async () => {
            const {rows} = await pool.query(
                `insert into notifications (user_id, title) values ($1, 'Private') returning id`,
                [customer]
            );
            await assert.rejects(
                app.markNotificationRead(other, rows[0].id),
                expectDomainError(ErrorCodes.NOT_FOUND)
            );
        });

        test('summarises what the customer has in flight', async () => {
            await app.saveProperty(customer, propertyId);
            await app.createInquiry(customer, {propertyId, message: 'Asking'});
            await pool.query(`insert into notifications (user_id, title) values ($1, 'Hello')`, [customer]);

            const summary = await app.activitySummary(customer);

            assert.equal(summary.savedCount, 1);
            assert.equal(summary.openInquiries, 1);
            assert.equal(summary.upcomingViewings, undefined, 'viewings are gone from the journey');
            assert.equal(summary.unreadNotifications, 1);
            assert.equal(summary.activeBookings, 0);
        });

        test('a quiet account summarises to zeroes, not nulls', async () => {
            const summary = await app.activitySummary(other);
            for (const [key, value] of Object.entries(summary)) {
                assert.equal(typeof value, 'number', `${key} should be a number`);
            }
        });
    });
});
