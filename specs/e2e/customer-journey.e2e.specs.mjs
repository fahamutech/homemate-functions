import {test, describe, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {start} from 'bfast-function';
import {smsPort} from '../../src/services/customer-access/container.mjs';

/**
 * The journey the mobile app walks, end to end over real HTTP: prove a phone
 * once, choose a PIN, find a home, ask about it, arrange a viewing, book it,
 * be told where to pay, say you have paid, and have a human confirm it.
 *
 * The SMS provider here is the sandbox adapter, so the code can be read back
 * the way a real customer reads it off their phone.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PHONE = '+255713000001';

describe('journey: customer app (e2e)', () => {
    /** @type {import('node:http').Server} */
    let server;
    let baseUrl;
    let db;
    let adminToken;
    let dictionaryIds;
    let landlordId;
    let propertyId;

    async function api(path, {method = 'GET', body, token, headers = {}} = {}) {
        const response = await fetch(`${baseUrl}${path}`, {
            method,
            headers: {
                ...(body ? {'content-type': 'application/json'} : {}),
                ...(token ? {authorization: `Bearer ${token}`} : {}),
                ...headers,
            },
            ...(body ? {body: JSON.stringify(body)} : {}),
        });
        const payload = await response.json().catch(() => null);
        return {status: response.status, body: payload, headers: response.headers};
    }

    /** Reads the code the way the customer would — off the message that was sent. */
    function lastCodeFor(phoneNumber) {
        return smsPort.lastMessageTo(phoneNumber)?.params?.code;
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
            body: {email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD},
        });
        adminToken = login.body.token;

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
            otp_request_log, auth_otp_challenges, external_notification_events,
            notifications, customer_preferences, saved_properties, payment_instructions,
            ledger_entries, payment_splits, external_payment_events, payouts, payments,
            bookings, property_viewings, property_inquiries,
            kyc_remediations, kyc_documents, property_parties, property_media, properties,
            users, organizations
            restart identity cascade`);
        await db.query('truncate table audit_log restart identity');
        smsPort.sentMessages.length = 0;

        const {rows} = await db.query(
            `insert into users (phone_number, full_name, role, status)
             values ('+255713000900', 'Baraka Landlord', 'landlord', 'active') returning id`
        );
        landlordId = rows[0].id;

        const {rows: property} = await db.query(
            `insert into properties
                 (title, description, owner_id, price, property_type_id, region_id, district_id,
                  bedrooms, deposit_months, min_lease_months, location, status)
             values ('Masaki 2BR Apartment', 'Bright, quiet, near the sea', $1, 800000, $2, $3, $4,
                     2, 2, 12, st_setsrid(st_makepoint(39.2768, -6.7576), 4326)::geography, 'draft')
             returning id`,
            [landlordId, dictionaryIds.apartment, dictionaryIds.dar_es_salaam, dictionaryIds.kinondoni]
        );
        propertyId = property[0].id;
        await db.query(
            `insert into property_parties (property_id, user_id, role, is_primary) values ($1, $2, 'landlord', true)`,
            [propertyId, landlordId]
        );
        await db.query("update properties set status = 'pending_review' where id = $1", [propertyId]);
        await db.query("update properties set status = 'approved' where id = $1", [propertyId]);
    });

    /** Onboards a customer the way the app does, and returns their session. */
    async function onboard({phoneNumber = PHONE, pin = '4820'} = {}) {
        const requested = await api('/customer/auth/otp/request', {
            method: 'POST',
            body: {phoneNumber},
        });
        assert.equal(requested.status, 200, JSON.stringify(requested.body));

        const verified = await api('/customer/auth/otp/verify', {
            method: 'POST',
            body: {challengeId: requested.body.challengeId, code: lastCodeFor(phoneNumber)},
        });
        assert.equal(verified.status, 200, JSON.stringify(verified.body));

        const session = await api('/customer/auth/pin', {
            method: 'POST',
            body: {verificationToken: verified.body.verificationToken, pin, confirmPin: pin},
        });
        assert.equal(session.status, 200, JSON.stringify(session.body));
        return session.body.token;
    }

    test('the whole journey: verify, set a PIN, enquire, view, book and pay', async () => {
        // --- 1. Onboarding -----------------------------------------------------
        const requested = await api('/customer/auth/otp/request', {
            method: 'POST',
            body: {phoneNumber: PHONE},
        });
        assert.equal(requested.status, 200);
        assert.ok(requested.body.challengeId);
        assert.equal(requested.body.resendAfterSeconds, 60);

        const wrongCode = await api('/customer/auth/otp/verify', {
            method: 'POST',
            body: {challengeId: requested.body.challengeId, code: '000000'},
        });
        assert.equal(wrongCode.status, 422);
        assert.match(wrongCode.body.message, /4 tries left/);

        const verified = await api('/customer/auth/otp/verify', {
            method: 'POST',
            body: {challengeId: requested.body.challengeId, code: lastCodeFor(PHONE)},
        });
        assert.equal(verified.status, 200);
        assert.ok(verified.body.verificationToken);
        assert.equal(verified.body.token, undefined, 'verifying must not sign anyone in');
        assert.equal(verified.body.hasPin, false);

        // A verification token is not a session.
        const tooEarly = await api('/app/me', {token: verified.body.verificationToken});
        assert.equal(tooEarly.status, 403);

        const session = await api('/customer/auth/pin', {
            method: 'POST',
            body: {verificationToken: verified.body.verificationToken, pin: '4820', confirmPin: '4820'},
        });
        assert.equal(session.status, 200);
        const token = session.body.token;

        const profile = await api('/app/me/profile', {
            method: 'POST',
            token,
            body: {fullName: 'Neema Kileo', email: 'neema@example.com', preferredLanguage: 'sw'},
        });
        assert.equal(profile.body.fullName, 'Neema Kileo');
        assert.equal(profile.body.onboardingComplete, true);

        // --- 2. Signing in again costs no SMS ----------------------------------
        const before = smsPort.sentMessages.length;
        const relogin = await api('/customer/auth/login', {
            method: 'POST',
            body: {phoneNumber: PHONE, pin: '4820'},
        });
        assert.equal(relogin.status, 200);
        assert.equal(smsPort.sentMessages.length, before, 'signing in must not send a code');

        // --- 3. Finding a home --------------------------------------------------
        const results = await api('/app/properties?query=Masaki', {token});
        assert.equal(results.status, 200);
        assert.equal(results.body.items.length, 1);
        assert.equal(results.body.items[0].is_saved, false);

        await api(`/app/saved/${propertyId}`, {method: 'PUT', token, body: {note: 'Close to work'}});
        const saved = await api('/app/saved', {token});
        assert.equal(saved.body.items.length, 1);

        const detail = await api(`/app/properties/${propertyId}`, {token});
        assert.equal(detail.body.property.title, 'Masaki 2BR Apartment');
        assert.equal(detail.body.isSaved, true);
        assert.equal(detail.body.contact.landlordName, 'Baraka Landlord');

        // --- 4. Enquiring --------------------------------------------------------
        const inquiry = await api('/app/inquiries', {
            method: 'POST',
            token,
            body: {
                propertyId,
                message: 'Is it available from November?',
                moveInDate: '2026-11-01',
                occupants: 2,
                contactPreference: 'whatsapp',
            },
        });
        assert.equal(inquiry.status, 201, JSON.stringify(inquiry.body));
        assert.match(inquiry.body.reference, /^HM-INQ-\d{6}$/);
        assert.equal(inquiry.body.move_in_date, '2026-11-01');

        const duplicate = await api('/app/inquiries', {
            method: 'POST',
            token,
            body: {propertyId, message: 'Asking again'},
        });
        assert.equal(duplicate.status, 409);

        // The landlord side answers it (the portal's job).
        await db.query(
            `update property_inquiries set status = 'responded', response = 'Yes, from 1 November', responded_by = $2
              where id = $1`,
            [inquiry.body.id, landlordId]
        );
        const answered = await api(`/app/inquiries/${inquiry.body.id}`, {token});
        assert.equal(answered.body.status, 'responded');
        assert.equal(answered.body.response, 'Yes, from 1 November');

        // --- 5. Arranging a viewing ----------------------------------------------
        const when = new Date(Date.now() + 3 * 86400_000).toISOString();
        const viewing = await api('/app/viewings', {
            method: 'POST',
            token,
            body: {propertyId, inquiryId: inquiry.body.id, scheduledFor: when, meetingPoint: 'Main gate'},
        });
        assert.equal(viewing.status, 201, JSON.stringify(viewing.body));
        assert.equal(viewing.body.status, 'requested');
        assert.equal(viewing.body.host_name, 'Baraka Landlord');

        const inThePast = await api('/app/viewings', {
            method: 'POST',
            token,
            body: {propertyId, scheduledFor: new Date(Date.now() - 86400_000).toISOString()},
        });
        assert.equal(inThePast.status, 422);

        await db.query("update property_viewings set status = 'confirmed' where id = $1", [viewing.body.id]);
        const confirmed = await api(`/app/viewings/${viewing.body.id}`, {token});
        assert.equal(confirmed.body.status, 'confirmed');

        // --- 6. Booking ------------------------------------------------------------
        const booking = await api('/app/bookings', {
            method: 'POST',
            token,
            body: {propertyId, inquiryId: inquiry.body.id, viewingId: viewing.body.id, moveInDate: '2026-11-01'},
        });
        assert.equal(booking.status, 201, JSON.stringify(booking.body));
        assert.match(booking.body.reference, /^HM-BK-\d{6}$/);
        assert.equal(booking.body.status, 'awaiting_payment');
        assert.equal(Number(booking.body.total_due), 2400000); // 2 months deposit + 1 month rent
        assert.equal(booking.body.payments.length, 1);

        const paymentId = booking.body.payments[0].id;
        assert.equal(booking.body.payments[0].customer_state, 'awaiting_instructions');

        // Nothing to pay against yet, so the app is told to wait.
        const tooSoon = await api(`/app/payments/${paymentId}/declare`, {method: 'POST', token, body: {}});
        assert.equal(tooSoon.status, 400);
        assert.match(tooSoon.body.message, /not ready yet/);

        // --- 7. The operator supplies where to pay ---------------------------------
        const instructions = await api(`/admin/payments/${paymentId}/instructions`, {
            method: 'PUT',
            token: adminToken,
            body: {
                displayName: 'HomeMate Africa Ltd',
                accountName: 'HomeMate Africa',
                accountNumber: '5566778',
                paymentReference: booking.body.reference,
                instructions: 'Send to Lipa Namba 5566778 and quote the reference.',
            },
        });
        assert.equal(instructions.status, 200, JSON.stringify(instructions.body));

        const payable = await api(`/app/payments/${paymentId}`, {token});
        assert.equal(payable.body.customer_state, 'awaiting_payment');
        assert.equal(payable.body.pay_to_account_number, '5566778');
        assert.equal(payable.body.pay_reference, booking.body.reference);
        assert.match(payable.body.pay_instructions, /Lipa Namba/);

        // --- 8. "I have paid" -------------------------------------------------------
        const declared = await api(`/app/payments/${paymentId}/declare`, {
            method: 'POST',
            token,
            body: {reference: 'MPESA-CONF-77', note: 'Paid at 10am'},
        });
        assert.equal(declared.status, 200);
        assert.equal(declared.body.customer_state, 'awaiting_verification');
        assert.equal(declared.body.status, 'pending', 'a claim must not settle the payment');

        // It is now in the operator's queue.
        const queue = await api('/admin/payment-queue/declared', {token: adminToken});
        assert.equal(queue.body.items.length, 1);
        assert.equal(queue.body.items[0].customer_declared_reference, 'MPESA-CONF-77');

        const attention = await api('/admin/attention', {token: adminToken});
        assert.equal(attention.body.counts.paymentsDeclared, 1);

        // --- 9. A human verifies it ---------------------------------------------------
        const verifiedPayment = await api(`/admin/payments/${paymentId}/reconcile`, {
            method: 'POST',
            token: adminToken,
            body: {note: 'Matched on the M-Pesa statement'},
        });
        assert.equal(verifiedPayment.body.status, 'successful');
        assert.equal(verifiedPayment.body.confirmed_by, process.env.ADMIN_EMAIL);

        const settled = await api(`/app/bookings/${booking.body.id}`, {token});
        assert.equal(Number(settled.body.amount_paid), 2400000);
        assert.equal(Number(settled.body.amount_outstanding), 0);
        assert.equal(settled.body.payments[0].customer_state, 'paid');

        // And only now may the booking be confirmed.
        const confirmedBooking = await api(`/admin/bookings/${booking.body.id}/status`, {
            method: 'POST',
            token: adminToken,
            body: {status: 'confirmed'},
        });
        assert.equal(confirmedBooking.status, 200, JSON.stringify(confirmedBooking.body));
        assert.equal(confirmedBooking.body.status, 'confirmed');

        // --- 10. The customer's own summary -------------------------------------------
        const summary = await api('/app/summary', {token});
        assert.equal(summary.body.savedCount, 1);
        assert.equal(summary.body.activeBookings, 1);
        assert.equal(Number(summary.body.amountOutstanding), 0);
    });

    test('a code cannot be requested again immediately, and the wait is stated', async () => {
        const first = await api('/customer/auth/otp/request', {method: 'POST', body: {phoneNumber: PHONE}});
        assert.equal(first.status, 200);

        const second = await api('/customer/auth/otp/request', {method: 'POST', body: {phoneNumber: PHONE}});
        assert.equal(second.status, 429);
        assert.equal(second.body.error, 'RATE_LIMITED');
        assert.ok(Number(second.headers.get('retry-after')) > 0);

        // One code was sent, not two — the refusal cost no credit.
        assert.equal(smsPort.sentMessages.filter((m) => m.to === PHONE).length, 1);
    });

    test('the hourly per-number limit stops a flood', async () => {
        // Bypass the cooldown so the hourly ceiling itself is what is tested.
        for (let i = 0; i < 5; i += 1) {
            await db.query(
                `insert into otp_request_log (phone_number, purpose, outcome, created_at)
                 values ($1, 'login', 'sent', now() - make_interval(mins => $2))`,
                [PHONE, 5 + i]
            );
        }

        const blocked = await api('/customer/auth/otp/request', {method: 'POST', body: {phoneNumber: PHONE}});
        assert.equal(blocked.status, 429);
        assert.match(blocked.body.message, /this hour/);
        assert.equal(smsPort.sentMessages.length, 0);

        // The refusal is recorded, so the portal can see the attempt.
        const {rows} = await db.query(
            "select count(*)::int as n from otp_request_log where outcome = 'throttled'"
        );
        assert.equal(rows[0].n, 1);
    });

    test('a forgotten PIN is reset by code, and the old PIN stops working', async () => {
        const token = await onboard();
        assert.ok((await api('/app/me', {token})).body.id);

        // Wait out the cooldown the way the app would.
        await db.query("update otp_request_log set created_at = now() - interval '5 minutes'");

        const reset = await api('/customer/auth/otp/request', {
            method: 'POST',
            body: {phoneNumber: PHONE, purpose: 'reset_pin'},
        });
        assert.equal(reset.status, 200);

        const verified = await api('/customer/auth/otp/verify', {
            method: 'POST',
            body: {challengeId: reset.body.challengeId, code: lastCodeFor(PHONE)},
        });
        const newSession = await api('/customer/auth/pin/reset', {
            method: 'POST',
            body: {verificationToken: verified.body.verificationToken, pin: '5731', confirmPin: '5731'},
        });
        assert.equal(newSession.status, 200);

        assert.equal(
            (await api('/customer/auth/login', {method: 'POST', body: {phoneNumber: PHONE, pin: '4820'}})).status,
            401
        );
        assert.equal(
            (await api('/customer/auth/login', {method: 'POST', body: {phoneNumber: PHONE, pin: '5731'}})).status,
            200
        );
    });

    test('a reset for an unregistered number reveals nothing and sends nothing', async () => {
        const response = await api('/customer/auth/otp/request', {
            method: 'POST',
            body: {phoneNumber: '+255713000777', purpose: 'reset_pin'},
        });

        assert.equal(response.status, 200, 'the answer must not differ from a registered number');
        assert.equal(response.body.challengeId, null);
        assert.equal(smsPort.sentMessages.length, 0);
    });

    test('repeated wrong PINs lock the account, and the right PIN still waits', async () => {
        await onboard();

        for (let i = 0; i < 4; i += 1) {
            const attempt = await api('/customer/auth/login', {
                method: 'POST',
                body: {phoneNumber: PHONE, pin: '9999'},
            });
            assert.equal(attempt.status, 401);
        }
        const locked = await api('/customer/auth/login', {
            method: 'POST',
            body: {phoneNumber: PHONE, pin: '9999'},
        });
        assert.equal(locked.status, 429);
        assert.ok(Number(locked.headers.get('retry-after')) > 0);

        const stillLocked = await api('/customer/auth/login', {
            method: 'POST',
            body: {phoneNumber: PHONE, pin: '4820'},
        });
        assert.equal(stillLocked.status, 429);
    });

    test('one customer can reach nothing belonging to another', async () => {
        const mine = await onboard({phoneNumber: PHONE, pin: '4820'});
        const inquiry = await api('/app/inquiries', {
            method: 'POST',
            token: mine,
            body: {propertyId, message: 'Mine alone'},
        });
        const booking = await api('/app/bookings', {method: 'POST', token: mine, body: {propertyId}});

        await db.query("update otp_request_log set created_at = now() - interval '5 minutes'");
        const theirs = await onboard({phoneNumber: '+255713000002', pin: '5731'});

        assert.equal((await api(`/app/inquiries/${inquiry.body.id}`, {token: theirs})).status, 404);
        assert.equal((await api(`/app/bookings/${booking.body.id}`, {token: theirs})).status, 404);
        assert.equal(
            (await api(`/app/payments/${booking.body.payments[0].id}`, {token: theirs})).status,
            404
        );
        assert.equal((await api('/app/saved', {token: theirs})).body.items.length, 0);
    });

    test('every app route refuses an anonymous or admin-only caller', async () => {
        for (const path of [
            '/app/me',
            '/app/properties',
            '/app/saved',
            '/app/inquiries',
            '/app/viewings',
            '/app/bookings',
            '/app/payments',
            '/app/notifications',
            '/app/summary',
        ]) {
            assert.equal((await api(path)).status, 401, `${path} should require a session`);
            // An admin token is signed by the same secret but is not a customer.
            assert.equal((await api(path, {token: adminToken})).status, 403, `${path} should refuse an admin token`);
        }
    });

    test('the app never sees a listing that is still in moderation', async () => {
        const token = await onboard();
        const {rows} = await db.query(
            `insert into properties (title, owner_id, price, property_type_id, region_id, status)
             values ('Unpublished Villa', $1, 5000000, $2, $3, 'pending_review') returning id`,
            [landlordId, dictionaryIds.apartment, dictionaryIds.dar_es_salaam]
        );

        const results = await api('/app/properties?query=Unpublished', {token});
        assert.equal(results.body.items.length, 0);
        assert.equal((await api(`/app/properties/${rows[0].id}`, {token})).status, 404);
        assert.equal(
            (await api('/app/inquiries', {method: 'POST', token, body: {propertyId: rows[0].id, message: 'Hi'}}))
                .status,
            404
        );
    });
});
