import {query, withActor} from '../../shared/db.mjs';
import {DomainError, ErrorCodes, invalid, notFound} from '../../shared/errors.mjs';
import {PARTNER_ROLES} from '../../shared/roles.mjs';
import {maskPhone} from '../../shared/phone.mjs';
import {firstPayment, loadFeeSettings, partnerEarningPreview} from '../../shared/fees.mjs';
import {insertProperty, patchProperty} from '../admin-console/properties.mjs';
import {upsertParty, replaceAmenities, insertCharge, storeImage} from '../admin-console/property-details.mjs';
import {readListingInput, describeSubmitBlockers} from './listing-input.mjs';
import {toPartnerListing, mediaUrl, moneyPreview, EDITABLE_STATUSES} from './listing-view.mjs';

const PROPERTY_STATUSES = ['draft', 'pending_review', 'approved', 'rejected', 'changes_requested', 'suspended', 'archived'];

/**
 * Brokers and landlords listing homes from the app (T04, BRK-020/021/030/031).
 *
 * Every write goes through the backoffice's own writers (insertProperty,
 * patchProperty, upsertParty, replaceAmenities, insertCharge, storeImage), so
 * a listing made on a phone is the same record a moderator would have made.
 * What this service adds is who may do what:
 *
 *   - a listing is visible to its primary broker (acting as broker) and its
 *     primary landlord (acting as landlord), and to nobody else here;
 *   - only the partner who created it edits, submits or archives it, and only
 *     while it is a draft or has changes requested;
 *   - a broker attaches the landlord, who must then confirm (029).
 */
export function createPartnerListingsService({pool, storagePort, notificationPort, properties, webBaseUrl}) {
    const webBase = (webBaseUrl ?? process.env.PUBLIC_WEB_URL ?? 'https://homemate.co.tz').replace(/\/$/, '');

    async function list(userId, role, {status} = {}) {
        readRole(role);
        const wanted = status ? `${status}`.trim() : null;
        if (wanted && !PROPERTY_STATUSES.includes(wanted)) {
            throw invalid(`status must be one of: ${PROPERTY_STATUSES.join(', ')}`);
        }
        const {rows} = await query(
            pool,
            `select p.id, p.reference_code, p.title, p.status, p.price, p.currency, p.rejection_reason,
                    p.submitted_at, p.reviewed_at, p.created_at, p.updated_at, p.created_by_user_id,
                    (select m.id from property_media m where m.property_id = p.id and m.is_cover limit 1) as cover_media_id,
                    (select count(*)::int from property_inquiries i
                      where i.property_id = p.id and i.status in ('pending', 'responded', 'accepted')) as open_enquiries,
                    landlord.confirmation_status as landlord_confirmation,
                    creator.full_name as creator_name
               from properties p
               left join property_parties landlord
                      on landlord.property_id = p.id and landlord.role = 'landlord' and landlord.is_primary
               left join users creator on creator.id = p.created_by_user_id
              where exists (select 1 from property_parties me
                             where me.property_id = p.id and me.user_id = $1
                               and me.role = $2::property_party_role and me.is_primary)
                and (case when $3::property_status is null then p.status <> 'archived' else p.status = $3 end)
              order by p.updated_at desc`,
            [userId, role, wanted]
        );
        return {
            items: rows.map((row) => ({
                id: row.id,
                referenceCode: row.reference_code,
                title: row.title,
                status: row.status,
                price: row.price,
                currency: row.currency,
                coverPhotoUrl: mediaUrl(row.cover_media_id),
                openEnquiries: row.open_enquiries,
                landlordConfirmation: row.landlord_confirmation ?? null,
                confirmed: ['confirmed', 'not_required'].includes(row.landlord_confirmation),
                listedBy: {you: row.created_by_user_id === userId, name: row.creator_name},
                rejectionReason: row.rejection_reason,
                submittedAt: row.submitted_at,
                reviewedAt: row.reviewed_at,
                updatedAt: row.updated_at,
            })),
        };
    }

    async function get(userId, role, id) {
        readRole(role);
        const access = await loadAccess(pool, userId, role, id);
        const record = await properties.getById(id);
        const {rows: parties} = await query(
            pool,
            `select pp.role, pp.user_id, pp.confirmation_status, pp.confirmed_at, pp.dispute_reason,
                    u.full_name, u.phone_number
               from property_parties pp join users u on u.id = pp.user_id
              where pp.property_id = $1 and pp.is_primary and pp.role in ('landlord', 'broker')`,
            [id]
        );
        const party = (partyRole) => parties.find((p) => p.role === partyRole) ?? null;
        const landlord = party('landlord');
        const broker = party('broker');

        const {media, amenities, charges, parties: _parties, paymentMethods: _methods, ...row} = record;
        const view = toPartnerListing(row, {userId, createdBy: access.createdBy});
        const blockers = view.editable ? await submitBlockers(pool, id, userId, role) : [];
        const payment = firstPayment(
            {rent: row.price, depositMonths: row.deposit_months, advanceMonths: row.advance_rent_months},
            await loadFeeSettings(pool)
        );

        return {
            ...view,
            photos: media.map((m) => ({
                id: m.id,
                isCover: m.is_cover,
                position: m.position,
                caption: m.caption,
                url: mediaUrl(m.id),
                thumbnailUrl: mediaUrl(m.id, {thumbnail: true}),
            })),
            amenities: amenities.map(({id: amenityId, code, name}) => ({id: amenityId, code, name})),
            charges: charges.map((c) => ({
                id: c.id,
                name: c.name,
                amount: c.amount,
                currency: c.currency,
                frequency: c.frequency,
                isMandatory: c.is_mandatory,
                isRefundable: c.is_refundable,
                notes: c.notes,
            })),
            landlord: landlord && {
                userId: landlord.user_id,
                name: landlord.full_name,
                phone: maskPhone(landlord.phone_number),
                confirmationStatus: landlord.confirmation_status,
                confirmedAt: landlord.confirmed_at,
                disputeReason: landlord.dispute_reason,
            },
            broker: broker && {userId: broker.user_id, name: broker.full_name},
            listedBy: {you: access.createdBy === userId, name: access.creatorName},
            submitBlockers: blockers,
            canSubmit: view.editable && blockers.length === 0,
            moneyPreview: moneyPreview(payment, partnerEarningPreview(payment, {viewer: role, brokered: Boolean(broker)})),
        };
    }

    async function create(userId, role, input = {}) {
        readRole(role);
        const {property, ...lists} = readListingInput(input);

        const {id, attached} = await withActor(pool, userId, async (client) => {
            const propertyId = await insertProperty(client, property);
            await client.query('update properties set created_by_user_id = $2 where id = $1', [propertyId, userId]);
            await upsertParty(client, propertyId, {userId, role, isPrimary: true}, userId);
            const applied = await applyLists(client, {propertyId, userId, role, lists});
            return {id: propertyId, attached: applied.attached};
        });
        await tellLandlord(attached);
        return get(userId, role, id);
    }

    async function update(userId, role, id, input = {}) {
        readRole(role);
        const {property, ...lists} = readListingInput(input);

        const {attached} = await withActor(pool, userId, async (client) => {
            await loadEditable(client, userId, role, id);
            if (Object.keys(property).length > 0) await patchProperty(client, id, property);
            return applyLists(client, {propertyId: id, userId, role, lists});
        });
        await tellLandlord(attached);
        return get(userId, role, id);
    }

    async function addPhoto(userId, role, id, upload = {}) {
        readRole(role);
        await withActor(pool, userId, async (client) => {
            await loadEditable(client, userId, role, id);
            await storeImage(client, storagePort, id, upload);
        });
        return get(userId, role, id);
    }

    async function removePhoto(userId, role, id, mediaId) {
        readRole(role);
        await withActor(pool, userId, async (client) => {
            await loadEditable(client, userId, role, id);
            const {rows} = await client.query(
                'delete from property_media where id = $1 and property_id = $2 returning is_cover',
                [mediaId, id]
            );
            if (rows.length === 0) throw notFound('Photo');
            if (rows[0].is_cover) {
                await client.query(
                    `update property_media set is_cover = true
                      where id = (select id from property_media where property_id = $1 order by position, created_at limit 1)`,
                    [id]
                );
            }
        });
        return get(userId, role, id);
    }

    async function submit(userId, role, id) {
        readRole(role);
        await withActor(pool, userId, async (client) => {
            const access = await loadAccess(client, userId, role, id, {lock: true});
            assertCreator(access, userId);
            const blockers = await submitBlockers(client, id, userId, role);
            if (blockers.length > 0) {
                throw new DomainError(
                    ErrorCodes.VALIDATION_FAILED,
                    blockers.map((b) => b.message).join(' '),
                    422,
                    {reasons: blockers}
                );
            }
            await client.query(`update properties set status = 'pending_review' where id = $1`, [id]);
        });
        return get(userId, role, id);
    }

    async function archive(userId, role, id) {
        readRole(role);
        await withActor(pool, userId, async (client) => {
            const access = await loadAccess(client, userId, role, id, {lock: true});
            assertCreator(access, userId);
            await client.query(`update properties set status = 'archived' where id = $1`, [id]);
        });
        return get(userId, role, id);
    }

    // --- internals -----------------------------------------------------------

    /** Amenities, charges, photo order and (brokers only) the landlord. */
    async function applyLists(client, {propertyId, userId, role, lists}) {
        if (lists.amenityIds !== undefined) await replaceAmenities(client, propertyId, lists.amenityIds);

        if (lists.charges !== undefined) {
            await client.query('delete from property_charges where property_id = $1', [propertyId]);
            for (const [index, charge] of lists.charges.entries()) {
                await insertCharge(client, propertyId, {sortOrder: index, ...charge});
            }
        }

        if (lists.photoOrder !== undefined) await reorderPhotos(client, propertyId, lists.photoOrder);

        let attached = null;
        if (lists.landlordUserId !== undefined) {
            if (role !== 'broker') {
                throw new DomainError(ErrorCodes.FORBIDDEN, 'Only a broker attaches a landlord to a listing', 403);
            }
            attached = await attachLandlord(client, {propertyId, brokerId: userId, landlordId: lists.landlordUserId});
        }
        return {attached};
    }

    async function reorderPhotos(client, propertyId, order) {
        const {rows} = await client.query('select id from property_media where property_id = $1', [propertyId]);
        const existing = rows.map((r) => r.id).sort();
        if (order.length !== existing.length || [...order].sort().some((id, i) => id !== existing[i])) {
            throw invalid('photoOrder must list every photo of this listing exactly once');
        }
        for (const [position, mediaId] of order.entries()) {
            await client.query(
                'update property_media set position = $3, is_cover = ($3 = 0) where id = $1 and property_id = $2',
                [mediaId, propertyId, position]
            );
        }
    }

    /** Replaces the primary landlord; the 029 trigger makes the new one `pending`. */
    async function attachLandlord(client, {propertyId, brokerId, landlordId}) {
        const {rows: current} = await client.query(
            `select user_id from property_parties where property_id = $1 and role = 'landlord' and is_primary`,
            [propertyId]
        );
        if (current[0]?.user_id === landlordId) return null;

        await client.query(`delete from property_parties where property_id = $1 and role = 'landlord'`, [propertyId]);
        await client.query('update properties set owner_id = null where id = $1', [propertyId]);
        if (!landlordId) return null;

        await upsertParty(client, propertyId, {userId: landlordId, role: 'landlord', isPrimary: true}, brokerId);
        const {rows} = await client.query(
            `select pp.confirmation_status, landlord.phone_number, landlord.id as landlord_id,
                    broker.full_name as broker_name, p.title
               from property_parties pp
               join users landlord on landlord.id = pp.user_id
               join properties p on p.id = pp.property_id
               join users broker on broker.id = $2
              where pp.property_id = $1 and pp.role = 'landlord' and pp.is_primary`,
            [propertyId, brokerId]
        );
        const party = rows[0];
        if (party.confirmation_status !== 'pending') return null;

        await client.query(
            `insert into notifications (user_id, kind, title, body, subject_table, subject_id)
             values ($1, 'system', 'Confirm a listing of your home', $2, 'properties', $3)`,
            [
                party.landlord_id,
                `${party.broker_name ?? 'A broker'} listed “${party.title}” on HomeMate. Confirm it is your home, or dispute it.`,
                propertyId,
            ]
        );
        return {propertyId, phoneNumber: party.phone_number, brokerName: party.broker_name, title: party.title};
    }

    /** SMS after commit: a provider outage must not undo the attachment. */
    async function tellLandlord(attached) {
        if (!attached) return;
        try {
            await notificationPort.send({
                to: attached.phoneNumber,
                template: 'landlord-confirm-listing',
                params: {
                    broker: attached.brokerName,
                    title: attached.title,
                    link: `homemate://landlord/confirm/${attached.propertyId}`,
                    webLink: `${webBase}/landlord/confirm/${attached.propertyId}`,
                    reference: attached.propertyId,
                },
            });
        } catch (error) {
            console.error('landlord confirmation SMS failed', error);
        }
    }

    async function loadEditable(client, userId, role, id) {
        const access = await loadAccess(client, userId, role, id, {lock: true});
        assertCreator(access, userId);
        if (!EDITABLE_STATUSES.includes(access.status)) {
            throw new DomainError(
                ErrorCodes.CONFLICT,
                access.status === 'pending_review'
                    ? 'This listing is being reviewed — you can edit it if changes are requested'
                    : `A listing that is ${access.status.replace('_', ' ')} cannot be edited`,
                409
            );
        }
        return access;
    }

    return {list, get, create, update, addPhoto, removePhoto, submit, archive};
}

function readRole(role) {
    if (!PARTNER_ROLES.includes(role)) throw invalid(`role must be one of: ${PARTNER_ROLES.join(', ')}`);
}

/**
 * The listing, if this user is its primary party in this role — otherwise
 * "not found", so one broker cannot even learn that another's listing exists.
 */
async function loadAccess(db, userId, role, id, {lock = false} = {}) {
    const {rows} = await query(
        db,
        `select p.status, p.created_by_user_id, creator.full_name as creator_name
           from properties p
           left join users creator on creator.id = p.created_by_user_id
          where p.id = $1
            and exists (select 1 from property_parties me
                         where me.property_id = p.id and me.user_id = $2
                           and me.role = $3::property_party_role and me.is_primary)
          ${lock ? 'for update of p' : ''}`,
        [id, userId, role]
    );
    if (rows.length === 0) throw notFound('Listing');
    return {status: rows[0].status, createdBy: rows[0].created_by_user_id, creatorName: rows[0].creator_name};
}

function assertCreator(access, userId) {
    if (access.createdBy !== userId) {
        throw new DomainError(ErrorCodes.FORBIDDEN, 'Only the partner who listed this home can change it', 403);
    }
}

async function submitBlockers(db, id, userId, role) {
    const {rows} = await query(db, 'select partner_listing_submit_blockers($1, $2, $3::user_role) as codes', [id, userId, role]);
    return describeSubmitBlockers(rows[0]?.codes ?? []);
}
