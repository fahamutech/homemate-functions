import {invalid} from '../../shared/errors.mjs';
import {firstPayment, tenantFee} from '../../shared/fees.mjs';
import {mediaUrl} from './listing-view.mjs';

/** The partner app's enquiry tabs (BRK-040) → inquiry statuses. */
const INQUIRY_TABS = {
    new: ['pending'],
    replied: ['responded'],
    accepted: ['accepted'],
    closed: ['rejected', 'withdrawn', 'closed'],
};

export function readInquiryFilter(tab) {
    const value = `${tab ?? ''}`.trim();
    if (!value) return null;
    if (!INQUIRY_TABS[value]) throw invalid(`status must be one of: ${Object.keys(INQUIRY_TABS).join(', ')}`);
    return INQUIRY_TABS[value];
}

/**
 * A v_partner_inquiries row for the partner app. The customer's phone is only
 * for whoever answers the enquiry (partner_can_answer_inquiry, 030).
 */
export function toPartnerInquiry(row, {canAnswer}) {
    return {
        id: row.id,
        reference: row.reference,
        status: row.status,
        displayStatus: row.display_status,
        message: row.message,
        moveInDate: row.move_in_date,
        occupants: row.occupants,
        budgetAmount: row.budget_amount,
        contactPreference: row.contact_preference,
        preferredContactTime: row.preferred_contact_time,
        response: row.response,
        rejectionReason: row.rejection_reason,
        respondedAt: row.responded_at,
        createdAt: row.created_at,
        bookingId: row.booking_id,
        property: {
            id: row.property_id,
            title: row.property_title,
            reference: row.property_reference,
            coverPhotoUrl: mediaUrl(row.cover_media_id),
        },
        customer: {
            id: row.customer_id,
            name: row.customer_name,
            idVerified: Boolean(row.customer_id_verified),
            phone: canAnswer ? row.customer_phone : null,
        },
        canAnswer,
    };
}

const round2 = (value) => Math.round(value * 100) / 100;

/**
 * What this partner stands to earn from the enquiry (BRK-042), from fees.mjs:
 * the tenant fee less HomeMate's share goes to the listing broker, or to the
 * landlord when nobody brokered the home. Rent always goes to the landlord.
 * A booking's agreed fee replaces the listing-price estimate once it exists.
 */
export function earningPreview({role, rent, settings, hasBroker, booking = null}) {
    let monthlyRent;
    let fee;
    let platformAmount;
    if (booking) {
        monthlyRent = Number(booking.monthly_rent);
        fee = Number(booking.service_fee);
        platformAmount = round2((fee * Number(booking.platform_fee_percentage ?? settings.platformPercentage)) / 100);
    } else {
        monthlyRent = Number(rent);
        const computed = tenantFee(rent, settings);
        fee = computed.amount;
        platformAmount = computed.platformAmount;
    }
    const agentShare = round2(fee - platformAmount);
    const earnsFee = role === 'broker' ? hasBroker : !hasBroker;

    return {
        basis: booking ? 'booking' : 'listing_price',
        monthlyRent,
        tenantFee: fee,
        platformAmount,
        yourShare: earnsFee ? agentShare : 0,
        rentGoesTo: 'landlord',
    };
}

/**
 * BRK-042 "What the customer pays": what the booking charged once there is
 * one, else the checkout formula on the listing's terms.
 */
export function paymentPreview({booking = null, terms = null, settings}) {
    if (booking) {
        const deposit = Number(booking.deposit_amount ?? 0);
        const fee = Number(booking.service_fee ?? 0);
        const total = Number(booking.total_due);
        const advanceMonths = Number(booking.advance_months ?? 0);
        const firstRent = round2(total - deposit - fee);
        return {
            basis: 'booking',
            firstRent,
            deposit,
            advance: advanceMonths > 0 ? firstRent : 0,
            tenantFee: fee,
            tenantFeePercentage: Number(booking.service_fee_percentage ?? 0),
            total,
        };
    }
    const payment = firstPayment(
        {rent: terms?.price, depositMonths: terms?.deposit_months, advanceMonths: terms?.advance_rent_months},
        settings
    );
    return {
        basis: 'listing_price',
        firstRent: payment.firstRent,
        deposit: payment.deposit,
        advance: payment.advance,
        tenantFee: payment.fee.amount,
        tenantFeePercentage: payment.fee.percentage,
        total: payment.total,
    };
}

const TENANCY_STAGES = ['current', 'moving_in', 'past'];

export function readTenancyStage(stage) {
    const value = `${stage ?? ''}`.trim();
    if (!value) return null;
    if (!TENANCY_STAGES.includes(value)) throw invalid(`status must be one of: ${TENANCY_STAGES.join(', ')}`);
    return value;
}

/** A required calendar day, YYYY-MM-DD. */
export function readDay(value, field) {
    const text = `${value ?? ''}`.trim();
    const parsed = new Date(`${text}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
        throw invalid(`${field} must be a day like 2026-10-01`);
    }
    return text;
}
