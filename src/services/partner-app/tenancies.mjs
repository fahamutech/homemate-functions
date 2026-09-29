import {query} from '../../shared/db.mjs';
import {notFound} from '../../shared/errors.mjs';
import {mediaUrl} from './listing-view.mjs';
import {readTenancyStage, readDay} from './enquiry-view.mjs';

/**
 * A landlord's tenancies (T05, LND-030–033): moving in, living here, past.
 * Scoped by landlord_owns_booking / landlord_tenancies (030) to homes where
 * the user is the primary landlord — whether they listed it or a broker did.
 * Starting and ending reuse the backoffice's changeBookingStatus, so the
 * date rules (030), the audit trail and the tenant's notification are the same.
 */
export function createLandlordTenanciesService({pool, customerOps}) {
    async function list(userId, {status} = {}) {
        const stage = readTenancyStage(status);
        const {rows} = await query(pool, 'select * from landlord_tenancies($1, $2)', [userId, stage]);
        return {items: rows.map(toTenancy)};
    }

    async function get(userId, id) {
        const row = await load(userId, id);
        const {rows} = await query(pool, 'select rental_payment_history($1, $2) as items', [id, row.customer_id]);
        return {...toTenancy(row), payments: rows[0].items ?? []};
    }

    async function lease(userId, id) {
        await load(userId, id);
        const {rows} = await query(
            pool,
            `select la.id, la.reference, la.version, la.lease_type, la.document_url, la.notice_period_days,
                    la.terms, la.house_rules, la.accepted_at,
                    b.reference as booking_reference, b.lease_start_date, b.lease_end_date, b.monthly_rent,
                    b.currency, b.deposit_amount, b.lease_months, b.property_title, b.property_address,
                    b.customer_name
               from v_bookings b
               left join lease_agreements la on la.booking_id = b.id
              where b.id = $1`,
            [id]
        );
        const r = rows[0];
        return {
            agreement: r.id
                ? {
                      id: r.id,
                      reference: r.reference,
                      version: r.version,
                      leaseType: r.lease_type,
                      documentUrl: r.document_url,
                      noticePeriodDays: r.notice_period_days,
                      terms: r.terms,
                      houseRules: r.house_rules,
                      acceptedAt: r.accepted_at,
                  }
                : null,
            bookingReference: r.booking_reference,
            leaseStartDate: r.lease_start_date,
            leaseEndDate: r.lease_end_date,
            leaseMonths: r.lease_months,
            monthlyRent: r.monthly_rent,
            currency: r.currency,
            depositAmount: r.deposit_amount,
            propertyTitle: r.property_title,
            propertyAddress: r.property_address,
            tenantName: r.customer_name,
        };
    }

    /** confirmed → active on the day the tenant moved in. */
    async function moveIn(userId, id, {date} = {}) {
        const day = readDay(date, 'date');
        await load(userId, id);
        await customerOps.changeBookingStatus(id, {status: 'active', date: day}, userId);
        return get(userId, id);
    }

    /** active → completed on the day it ended, with an optional reason. */
    async function end(userId, id, {date, reason} = {}) {
        const day = readDay(date, 'date');
        await load(userId, id);
        await customerOps.changeBookingStatus(id, {status: 'completed', date: day, reason}, userId);
        return get(userId, id);
    }

    async function load(userId, id) {
        const {rows} = await query(
            pool,
            'select * from v_tenancies where id = $1 and landlord_owns_booking($2, $1)',
            [id, userId]
        );
        if (rows.length === 0) throw notFound('Tenancy');
        return rows[0];
    }

    return {list, get, lease, moveIn, end};
}

function toTenancy(row) {
    return {
        id: row.id,
        reference: row.reference,
        status: row.status,
        stage: row.stage,
        tenant: {id: row.customer_id, name: row.tenant_name, phone: row.tenant_phone},
        property: {
            id: row.property_id,
            title: row.property_title,
            address: row.property_address,
            reference: row.property_reference,
            coverPhotoUrl: mediaUrl(row.cover_media_id),
        },
        monthlyRent: row.monthly_rent,
        currency: row.currency,
        depositAmount: row.deposit_amount,
        paymentFrequency: row.payment_frequency,
        leaseMonths: row.lease_months,
        leaseStartDate: row.lease_start_date,
        leaseEndDate: row.lease_end_date,
        moveInDate: row.move_in_date,
        endedOn: row.ended_on,
        endReason: row.end_reason,
        amountPaid: row.amount_paid,
        amountOutstanding: row.amount_outstanding,
        nextPaymentDate: row.next_payment_date,
        monthsRemaining: row.months_remaining,
        exitWindowOpensOn: row.exit_window_opens_on,
        agreementReference: row.agreement_reference,
        confirmedAt: row.confirmed_at,
    };
}
