import {query, withActor} from '../../shared/db.mjs';
import {invalid, notFound} from '../../shared/errors.mjs';
import {mediaUrl} from './listing-view.mjs';

/**
 * A landlord confirming (or disputing) a home a broker listed for them
 * (T04, LND-003). Keyed on the party row itself — the landlord is whoever the
 * listing names — so an invited landlord who has only just signed in can
 * answer, without an active landlord role.
 */
export function createLandlordConfirmationsService({pool}) {
    async function list(userId) {
        const {rows} = await query(
            pool,
            `select p.id, p.reference_code, p.title, p.price, p.currency, p.deposit_months, p.advance_rent_months,
                    p.min_lease_months, p.payment_frequency, p.available_from, p.address_line, p.region_name,
                    p.cover_media_id, pp.assigned_at,
                    broker.id as broker_id, broker.full_name as broker_name
               from property_parties pp
               join v_properties p on p.id = pp.property_id
               left join property_parties bp on bp.property_id = pp.property_id and bp.role = 'broker' and bp.is_primary
               left join users broker on broker.id = bp.user_id
              where pp.user_id = $1 and pp.role = 'landlord' and pp.confirmation_status = 'pending'
                and p.status <> 'archived'
              order by pp.assigned_at desc`,
            [userId]
        );
        return {
            items: rows.map((row) => ({
                propertyId: row.id,
                referenceCode: row.reference_code,
                title: row.title,
                addressLine: row.address_line,
                regionName: row.region_name,
                coverPhotoUrl: mediaUrl(row.cover_media_id),
                broker: row.broker_id ? {userId: row.broker_id, name: row.broker_name} : null,
                terms: {
                    price: row.price,
                    currency: row.currency,
                    depositMonths: row.deposit_months,
                    advanceRentMonths: row.advance_rent_months,
                    minLeaseMonths: row.min_lease_months,
                    paymentFrequency: row.payment_frequency,
                    availableFrom: row.available_from,
                },
                requestedAt: row.assigned_at,
            })),
        };
    }

    async function confirm(userId, propertyId) {
        return decide(userId, propertyId, {status: 'confirmed', from: ['pending', 'disputed']});
    }

    async function dispute(userId, propertyId, {reason} = {}) {
        const text = `${reason ?? ''}`.trim();
        if (!text) throw invalid('Say why this listing is wrong');
        return decide(userId, propertyId, {status: 'disputed', reason: text, from: ['pending', 'confirmed']});
    }

    async function decide(userId, propertyId, {status, reason = null, from}) {
        return withActor(pool, userId, async (client) => {
            const {rows} = await client.query(
                `update property_parties
                    set confirmation_status = $3::party_confirmation_status, dispute_reason = $4
                  where property_id = $1 and user_id = $2 and role = 'landlord' and is_primary
                    and confirmation_status = any($5::party_confirmation_status[])
                  returning confirmation_status, confirmed_at, dispute_reason`,
                [propertyId, userId, status, reason, from]
            );
            if (rows.length === 0) throw notFound('A listing waiting for your answer');

            const {rows: context} = await client.query(
                `select p.title, landlord.full_name as landlord_name,
                        (select bp.user_id from property_parties bp
                          where bp.property_id = p.id and bp.role = 'broker' and bp.is_primary) as broker_id
                   from properties p join users landlord on landlord.id = $2
                  where p.id = $1`,
                [propertyId, userId]
            );
            const {title, landlord_name: landlordName, broker_id: brokerId} = context[0];
            const who = landlordName ?? 'The landlord';

            if (status === 'confirmed') {
                await notify(client, brokerId ? [brokerId] : [], propertyId, {
                    title: 'The landlord confirmed your listing',
                    body: `${who} confirmed “${title}”. You can submit it for review.`,
                });
            } else {
                const staff = await client.query(
                    `select id from users
                      where status = 'active'
                        and (role = 'admin'
                             or (role in ('moderator', 'manager', 'finance_auditor')
                                 and coalesce(allowed_routes, '[]'::jsonb) ? 'properties'))`
                );
                await notify(client, [...(brokerId ? [brokerId] : []), ...staff.rows.map((r) => r.id)], propertyId, {
                    title: 'A landlord disputed a listing',
                    body: `${who} disputed “${title}”: ${reason}`,
                });
            }

            return {
                propertyId,
                confirmationStatus: rows[0].confirmation_status,
                confirmedAt: rows[0].confirmed_at,
                disputeReason: rows[0].dispute_reason,
            };
        });
    }

    return {list, confirm, dispute};
}

async function notify(client, userIds, propertyId, {title, body}) {
    if (userIds.length === 0) return;
    await client.query(
        `insert into notifications (user_id, kind, title, body, subject_table, subject_id)
         select unnest($1::uuid[]), 'system', $2, $3, 'properties', $4`,
        [userIds, title, body, propertyId]
    );
}
