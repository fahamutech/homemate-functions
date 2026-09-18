import {withActor, query, nullIfBlank} from '../../shared/db.mjs';
import {notFound, invalid} from '../../shared/errors.mjs';

function numberOrNull(value, field) {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw invalid(`${field} must be a number`);
    return parsed;
}

/**
 * The parts of a property that hang off it: who is attributed to it, which
 * amenities it has, what is charged alongside rent, its media, and which
 * payment methods it accepts.
 *
 * Kept separate from properties.mjs so that file stays about the property
 * record itself; both are composed into one service in container.mjs.
 */
export function createPropertyDetailsService({pool, storagePort}) {
    async function assertPropertyExists(client, propertyId) {
        const {rows} = await client.query('select 1 from properties where id = $1', [propertyId]);
        if (rows.length === 0) throw notFound('Property');
    }

    // --- Parties -------------------------------------------------------------

    async function listParties(propertyId, executor = pool) {
        const {rows} = await query(
            executor,
            `select pp.id, pp.role, pp.commission_percentage, pp.is_primary, pp.notes,
                    pp.assigned_by, pp.assigned_at,
                    u.id as user_id, u.full_name, u.phone_number, u.email, u.role as user_role,
                    o.name as organization_name
               from property_parties pp
               join users u on u.id = pp.user_id
               left join organizations o on o.id = u.organization_id
              where pp.property_id = $1
              order by pp.role, pp.is_primary desc`,
            [propertyId]
        );
        return {items: rows};
    }

    /**
     * Assigning a party is idempotent per (property, user, role) — re-assigning
     * updates the commission/primary flag rather than failing, which is what an
     * admin correcting a mistake expects.
     */
    async function assignParty(propertyId, input, actor) {
        const userId = nullIfBlank(input.userId);
        const role = nullIfBlank(input.role);
        if (!userId) throw invalid('userId is required');
        if (!['landlord', 'broker', 'agency'].includes(role)) {
            throw invalid('role must be one of: landlord, broker, agency');
        }
        const commission = numberOrNull(input.commissionPercentage, 'commissionPercentage');

        return withActor(pool, actor, async (client) => {
            await assertPropertyExists(client, propertyId);
            const {rows} = await client.query(
                `insert into property_parties (property_id, user_id, role, commission_percentage, is_primary, notes, assigned_by)
                 values ($1, $2, $3::property_party_role, $4, coalesce($5, false), $6, $7)
                 on conflict (property_id, user_id, role) do update
                    set commission_percentage = excluded.commission_percentage,
                        is_primary = excluded.is_primary,
                        notes = excluded.notes,
                        assigned_by = excluded.assigned_by
                 returning id`,
                [
                    propertyId,
                    userId,
                    role,
                    commission,
                    input.isPrimary === true || input.isPrimary === 'true',
                    nullIfBlank(input.notes),
                    actor,
                ]
            );

            // Keep the denormalised owner/organization columns in step with the
            // primary landlord/agency so list screens need no extra joins.
            if (role === 'landlord') {
                await client.query('update properties set owner_id = $2 where id = $1 and owner_id is null', [propertyId, userId]);
            }
            if (role === 'agency') {
                await client.query(
                    `update properties p
                        set organization_id = u.organization_id
                       from users u
                      where p.id = $1 and u.id = $2 and p.organization_id is null`,
                    [propertyId, userId]
                );
            }

            return {id: rows[0].id, ...(await listParties(propertyId, client))};
        });
    }

    async function removeParty(propertyId, partyId, actor) {
        return withActor(pool, actor, async (client) => {
            const {rows} = await client.query(
                'delete from property_parties where id = $1 and property_id = $2 returning id',
                [partyId, propertyId]
            );
            if (rows.length === 0) throw notFound('Party assignment');
            return listParties(propertyId, client);
        });
    }

    // --- Amenities -----------------------------------------------------------

    async function listAmenities(propertyId, executor = pool) {
        const {rows} = await query(
            executor,
            `select d.id, d.code, d.name
               from property_amenities pa join dictionary_items d on d.id = pa.amenity_id
              where pa.property_id = $1
              order by d.sort_order, d.name`,
            [propertyId]
        );
        return {items: rows};
    }

    /** Replaces the whole set — the UI edits amenities as a checklist. */
    async function setAmenities(propertyId, amenityIds, actor) {
        if (!Array.isArray(amenityIds)) throw invalid('amenityIds must be an array');

        return withActor(pool, actor, async (client) => {
            await assertPropertyExists(client, propertyId);
            await client.query('delete from property_amenities where property_id = $1', [propertyId]);
            if (amenityIds.length > 0) {
                await client.query(
                    `insert into property_amenities (property_id, amenity_id)
                     select $1, unnest($2::uuid[])`,
                    [propertyId, amenityIds]
                );
            }
            return listAmenities(propertyId, client);
        });
    }

    // --- Charges -------------------------------------------------------------

    async function listCharges(propertyId, executor = pool) {
        const {rows} = await query(
            executor,
            `select id, name, amount, currency, frequency, is_mandatory, is_refundable, notes, sort_order,
                    charge_monthly_equivalent(amount, frequency) as monthly_equivalent
               from property_charges where property_id = $1 order by sort_order, name`,
            [propertyId]
        );
        return {items: rows};
    }

    async function addCharge(propertyId, input, actor) {
        const name = nullIfBlank(input.name);
        if (!name) throw invalid('name is required');
        const amount = numberOrNull(input.amount, 'amount');
        if (amount === null) throw invalid('amount is required');

        return withActor(pool, actor, async (client) => {
            await assertPropertyExists(client, propertyId);
            await client.query(
                `insert into property_charges (property_id, name, amount, currency, frequency, is_mandatory, is_refundable, notes, sort_order)
                 values ($1, $2, $3, coalesce($4, 'TZS'), coalesce($5::charge_frequency, 'monthly'),
                         coalesce($6, true), coalesce($7, false), $8, coalesce($9, 0))`,
                [
                    propertyId,
                    name,
                    amount,
                    nullIfBlank(input.currency),
                    nullIfBlank(input.frequency),
                    input.isMandatory === undefined ? null : input.isMandatory === true || input.isMandatory === 'true',
                    input.isRefundable === undefined ? null : input.isRefundable === true || input.isRefundable === 'true',
                    nullIfBlank(input.notes),
                    numberOrNull(input.sortOrder, 'sortOrder'),
                ]
            );
            return listCharges(propertyId, client);
        });
    }

    async function removeCharge(propertyId, chargeId, actor) {
        return withActor(pool, actor, async (client) => {
            const {rows} = await client.query(
                'delete from property_charges where id = $1 and property_id = $2 returning id',
                [chargeId, propertyId]
            );
            if (rows.length === 0) throw notFound('Charge');
            return listCharges(propertyId, client);
        });
    }

    // --- Media ---------------------------------------------------------------

    async function listMedia(propertyId, executor = pool) {
        const {rows} = await query(
            executor,
            `select id, url, thumbnail_url, kind, content_type, size_bytes, width, height,
                    caption, is_cover, position
               from property_media where property_id = $1 order by is_cover desc, position, created_at`,
            [propertyId]
        );
        return {items: rows};
    }

    /**
     * Stores an already-WebP image plus its thumbnail. Conversion happens in
     * the browser (see the portal's image pipeline) so the server never needs
     * an image-processing dependency; this only validates and persists.
     */
    async function addImage(propertyId, {image, thumbnail, caption, isCover, width, height}, actor) {
        if (!image?.body?.length) throw invalid('An image file is required');
        if (image.contentType !== 'image/webp') {
            throw invalid('Images must be converted to WebP before upload');
        }
        if (thumbnail && thumbnail.contentType !== 'image/webp') {
            throw invalid('Thumbnails must be WebP');
        }

        return withActor(pool, actor, async (client) => {
            await assertPropertyExists(client, propertyId);

            const storedImage = await storagePort.put({
                name: image.name ?? `property-${propertyId}.webp`,
                contentType: 'image/webp',
                body: image.body,
            });
            const storedThumbnail = thumbnail
                ? await storagePort.put({
                    name: thumbnail.name ?? `property-${propertyId}-thumb.webp`,
                    contentType: 'image/webp',
                    body: thumbnail.body,
                })
                : null;

            const {rows} = await client.query(
                `insert into property_media
                     (property_id, url, thumbnail_url, kind, content_type, size_bytes, width, height, caption, is_cover, position)
                 values ($1, $2, $3, 'photo', 'image/webp', $4, $5, $6, $7, coalesce($8, false),
                         coalesce((select max(position) + 1 from property_media where property_id = $1), 0))
                 returning id`,
                [
                    propertyId,
                    storedImage.key,
                    storedThumbnail?.key ?? null,
                    image.body.length,
                    numberOrNull(width, 'width'),
                    numberOrNull(height, 'height'),
                    nullIfBlank(caption),
                    isCover === true || isCover === 'true',
                ]
            );

            return {id: rows[0].id, ...(await listMedia(propertyId, client))};
        });
    }

    async function setCoverImage(propertyId, mediaId, actor) {
        return withActor(pool, actor, async (client) => {
            const {rows} = await client.query(
                'update property_media set is_cover = true where id = $1 and property_id = $2 returning id',
                [mediaId, propertyId]
            );
            if (rows.length === 0) throw notFound('Image');
            return listMedia(propertyId, client);
        });
    }

    async function removeImage(propertyId, mediaId, actor) {
        return withActor(pool, actor, async (client) => {
            const {rows} = await client.query(
                'delete from property_media where id = $1 and property_id = $2 returning id',
                [mediaId, propertyId]
            );
            if (rows.length === 0) throw notFound('Image');
            return listMedia(propertyId, client);
        });
    }

    /**
     * Streams an image back through our own API. Storage requires a token, so
     * the browser must never be handed a raw storage URL — this is the only
     * read path for property images.
     */
    async function readImage(mediaId, {thumbnail = false} = {}) {
        const {rows} = await query(
            pool,
            'select url, thumbnail_url, content_type from property_media where id = $1',
            [mediaId]
        );
        if (rows.length === 0) throw notFound('Image');
        const key = thumbnail ? (rows[0].thumbnail_url ?? rows[0].url) : rows[0].url;
        const object = await storagePort.get(key);
        return {body: object.body, contentType: object.contentType ?? rows[0].content_type};
    }

    // --- Accepted payment methods -------------------------------------------

    async function listPaymentMethods(propertyId, executor = pool) {
        const {rows} = await query(
            executor,
            `select pm.id, pm.code, pm.name, pm.kind, pm.is_active
               from property_payment_methods ppm join payment_methods pm on pm.id = ppm.payment_method_id
              where ppm.property_id = $1 order by pm.sort_order`,
            [propertyId]
        );
        return {items: rows};
    }

    async function setPaymentMethods(propertyId, paymentMethodIds, actor) {
        if (!Array.isArray(paymentMethodIds)) throw invalid('paymentMethodIds must be an array');

        return withActor(pool, actor, async (client) => {
            await assertPropertyExists(client, propertyId);
            await client.query('delete from property_payment_methods where property_id = $1', [propertyId]);
            if (paymentMethodIds.length > 0) {
                await client.query(
                    `insert into property_payment_methods (property_id, payment_method_id)
                     select $1, unnest($2::uuid[])`,
                    [propertyId, paymentMethodIds]
                );
            }
            return listPaymentMethods(propertyId, client);
        });
    }

    return {
        listParties, assignParty, removeParty,
        listAmenities, setAmenities,
        listCharges, addCharge, removeCharge,
        listMedia, addImage, setCoverImage, removeImage, readImage,
        listPaymentMethods, setPaymentMethods,
    };
}
