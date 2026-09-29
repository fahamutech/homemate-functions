import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {readInquiryFilter, toPartnerInquiry, earningPreview, readTenancyStage, readDay, paymentPreview} from './enquiry-view.mjs';

describe('readInquiryFilter', () => {
    test('the app’s tabs map onto inquiry statuses', () => {
        assert.deepEqual(readInquiryFilter('new'), ['pending']);
        assert.deepEqual(readInquiryFilter('replied'), ['responded']);
        assert.deepEqual(readInquiryFilter('accepted'), ['accepted']);
        assert.deepEqual(readInquiryFilter('closed'), ['rejected', 'withdrawn', 'closed']);
        assert.equal(readInquiryFilter(undefined), null);
        assert.equal(readInquiryFilter(''), null);
    });

    test('anything else is refused', () => {
        assert.throws(() => readInquiryFilter('pending'), (error) => error.code === 'VALIDATION_FAILED');
    });
});

describe('toPartnerInquiry', () => {
    const row = {
        id: 'i-1',
        reference: 'INQ-1',
        status: 'pending',
        display_status: 'pending',
        message: 'Is it free?',
        move_in_date: '2026-10-01',
        occupants: 2,
        budget_amount: '800000.00',
        contact_preference: 'whatsapp',
        preferred_contact_time: 'evening',
        response: null,
        rejection_reason: null,
        responded_at: null,
        created_at: 'c',
        property_id: 'p-1',
        property_title: 'Masaki 2BR',
        property_reference: 'HM-P-1',
        cover_media_id: 'm-1',
        customer_id: 'u-9',
        customer_name: 'Neema',
        customer_phone: '+255712345678',
        customer_id_verified: true,
        booking_id: null,
    };

    test('the answering partner sees the phone and may answer', () => {
        const view = toPartnerInquiry(row, {canAnswer: true});
        assert.equal(view.customer.phone, '+255712345678');
        assert.equal(view.customer.name, 'Neema');
        assert.equal(view.customer.idVerified, true);
        assert.equal(view.canAnswer, true);
        assert.equal(view.moveInDate, '2026-10-01');
        assert.equal(view.preferredContactTime, 'evening');
        assert.equal(view.displayStatus, 'pending');
        assert.equal(view.property.coverPhotoUrl, '/app/media/m-1/raw');
    });

    test('anyone else reads it without the phone', () => {
        const view = toPartnerInquiry(row, {canAnswer: false});
        assert.equal(view.customer.phone, null);
        assert.equal(view.canAnswer, false);
    });
});

describe('earningPreview', () => {
    const settings = {tenantFeePercentage: 50, platformPercentage: 10};

    test('a broker earns the fee less HomeMate’s share; rent goes to the landlord', () => {
        assert.deepEqual(earningPreview({role: 'broker', rent: 1000000, settings, hasBroker: true}), {
            basis: 'listing_price',
            monthlyRent: 1000000,
            tenantFee: 500000,
            platformAmount: 50000,
            yourShare: 450000,
            rentGoesTo: 'landlord',
        });
    });

    test('a landlord who listed themselves keeps that share too', () => {
        assert.equal(earningPreview({role: 'landlord', rent: 1000000, settings, hasBroker: false}).yourShare, 450000);
    });

    test('a landlord whose home a broker listed earns no part of the fee', () => {
        assert.equal(earningPreview({role: 'landlord', rent: 1000000, settings, hasBroker: true}).yourShare, 0);
    });

    test('once booked, the booking’s agreed fee is what counts', () => {
        const preview = earningPreview({
            role: 'broker',
            rent: 1000000,
            settings,
            hasBroker: true,
            booking: {monthly_rent: '900000.00', service_fee: '450000.00', platform_fee_percentage: '20.00'},
        });
        assert.deepEqual(preview, {
            basis: 'booking',
            monthlyRent: 900000,
            tenantFee: 450000,
            platformAmount: 90000,
            yourShare: 360000,
            rentGoesTo: 'landlord',
        });
    });
});

describe('readTenancyStage and readDay', () => {
    test('stages are current, moving_in and past', () => {
        assert.equal(readTenancyStage('current'), 'current');
        assert.equal(readTenancyStage(undefined), null);
        assert.throws(() => readTenancyStage('active'), (error) => error.code === 'VALIDATION_FAILED');
    });

    test('a day is YYYY-MM-DD and required', () => {
        assert.equal(readDay(' 2026-10-01 ', 'date'), '2026-10-01');
        for (const bad of [undefined, '', '01/10/2026', '2026-13-01']) {
            assert.throws(() => readDay(bad, 'date'), (error) => error.code === 'VALIDATION_FAILED' && /date/.test(error.message));
        }
    });
});

describe('paymentPreview', () => {
    const settings = {tenantFeePercentage: 50, platformPercentage: 10};

    test('before a booking: the checkout formula on the listing terms', () => {
        assert.deepEqual(paymentPreview({terms: {price: '800000', deposit_months: '2', advance_rent_months: '0'}, settings}), {
            basis: 'listing_price',
            firstRent: 800000,
            deposit: 1600000,
            advance: 0,
            tenantFee: 400000,
            tenantFeePercentage: 50,
            total: 2800000,
        });
    });

    test('with a booking: what it actually charged, whatever the settings say now', () => {
        const booking = {deposit_amount: '800000', service_fee: '300000', service_fee_percentage: '37.5', advance_months: 3, total_due: '3500000'};
        assert.deepEqual(paymentPreview({booking, settings}), {
            basis: 'booking',
            firstRent: 2400000,
            deposit: 800000,
            advance: 2400000,
            tenantFee: 300000,
            tenantFeePercentage: 37.5,
            total: 3500000,
        });
    });
});
