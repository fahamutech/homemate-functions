import {withActor, query, toPage, pageParams, nullIfBlank, updateById} from '../../shared/db.mjs';
import {notFound, invalid} from '../../shared/errors.mjs';

const UPDATABLE_FIELDS = [
    'title', 'description', 'property_type_id', 'listing_type', 'owner_id', 'organization_id',
    'price', 'currency', 'bedrooms', 'bathrooms', 'size_sqm', 'address_line',
    'region_id', 'district_id', 'ward_id',
    // lease & payment terms
    'furnishing', 'floor_number', 'total_floors', 'year_built', 'parking_spaces', 'max_occupants',
    'pets_allowed', 'smoking_allowed', 'available_from', 'min_lease_months', 'max_lease_months',
    'payment_frequency', 'custom_payment_months', 'deposit_months', 'advance_rent_months',
    'notice_period_days', 'terms', 'house_rules',
];

/**
 * Maps the API's camelCase body onto the table's snake_case columns for the
 * lease/terms block. Declared once and reused by create and update so the two
 * can never drift apart.
 */
function termsColumns(input) {
    const bool = (value) => (value === undefined ? undefined : value === true || value === 'true');
    const num = (value, field) => (value === undefined ? undefined : numberOrUndefined(value, field));

    return {
        furnishing: nullIfBlank(input.furnishing) ?? undefined,
        floor_number: num(input.floorNumber, 'floorNumber'),
        total_floors: num(input.totalFloors, 'totalFloors'),
        year_built: num(input.yearBuilt, 'yearBuilt'),
        parking_spaces: num(input.parkingSpaces, 'parkingSpaces'),
        max_occupants: num(input.maxOccupants, 'maxOccupants'),
        pets_allowed: bool(input.petsAllowed),
        smoking_allowed: bool(input.smokingAllowed),
        available_from: nullIfBlank(input.availableFrom) ?? undefined,
        min_lease_months: num(input.minLeaseMonths, 'minLeaseMonths'),
        max_lease_months: num(input.maxLeaseMonths, 'maxLeaseMonths'),
        payment_frequency: nullIfBlank(input.paymentFrequency) ?? undefined,
        custom_payment_months: num(input.customPaymentMonths, 'customPaymentMonths'),
        deposit_months: num(input.depositMonths, 'depositMonths'),
        advance_rent_months: num(input.advanceRentMonths, 'advanceRentMonths'),
        notice_period_days: num(input.noticePeriodDays, 'noticePeriodDays'),
        terms: input.terms === undefined ? undefined : nullIfBlank(input.terms),
        house_rules: input.houseRules === undefined ? undefined : nullIfBlank(input.houseRules),
    };
}

function numberOrUndefined(value, field = 'value') {
    if (value === undefined || value === null || value === '') return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw invalid(`${field} must be a number, got "${value}"`);
    return parsed;
}

/**
 * Property registry + moderation queue. Search (text, facets and PostGIS
 * radius) is a single SQL function; approval/rejection is a status transition
 * the database validates and stamps.
 */
export function createPropertiesService({pool}) {
    async function search(filters = {}) {
        const {limit, offset} = pageParams(filters);
        const amenityIds = filters.amenityIds
            ? (Array.isArray(filters.amenityIds) ? filters.amenityIds : String(filters.amenityIds).split(','))
                .map((id) => id.trim())
                .filter(Boolean)
            : null;

        const {rows} = await query(
            pool,
            'select * from search_properties($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)',
            [
                nullIfBlank(filters.query),
                nullIfBlank(filters.status),
                nullIfBlank(filters.listingType),
                nullIfBlank(filters.propertyTypeId),
                nullIfBlank(filters.regionId),
                nullIfBlank(filters.organizationId),
                nullIfBlank(filters.ownerId),
                numberOrUndefined(filters.minPrice) ?? null,
                numberOrUndefined(filters.maxPrice) ?? null,
                numberOrUndefined(filters.minBedrooms) ?? null,
                numberOrUndefined(filters.latitude) ?? null,
                numberOrUndefined(filters.longitude) ?? null,
                numberOrUndefined(filters.radiusMetres) ?? null,
                nullIfBlank(filters.furnishing),
                nullIfBlank(filters.paymentFrequency),
                amenityIds && amenityIds.length > 0 ? amenityIds : null,
                limit,
                offset,
            ]
        );
        return toPage(rows, {limit, offset});
    }

    /**
     * The complete property: the record plus everything attached to it. One
     * call, because the detail screen needs all of it and round-tripping six
     * endpoints would just move the joining into the browser.
     */
    async function getById(id) {
        const {rows} = await query(pool, 'select * from v_properties where id = $1', [id]);
        if (rows.length === 0) throw notFound('Property');

        const [media, amenities, charges, parties, paymentMethods] = await Promise.all([
            query(pool, `select id, url, thumbnail_url, kind, content_type, size_bytes, width, height,
                                caption, is_cover, position
                           from property_media where property_id = $1
                          order by is_cover desc, position, created_at`, [id]),
            query(pool, `select d.id, d.code, d.name from property_amenities pa
                           join dictionary_items d on d.id = pa.amenity_id
                          where pa.property_id = $1 order by d.sort_order, d.name`, [id]),
            query(pool, `select id, name, amount, currency, frequency, is_mandatory, is_refundable, notes,
                                charge_monthly_equivalent(amount, frequency) as monthly_equivalent
                           from property_charges where property_id = $1 order by sort_order, name`, [id]),
            query(pool, `select pp.id, pp.role, pp.commission_percentage, pp.is_primary, pp.assigned_by,
                                pp.assigned_at, u.id as user_id, u.full_name, u.phone_number, u.email,
                                u.role as user_role
                           from property_parties pp join users u on u.id = pp.user_id
                          where pp.property_id = $1 order by pp.role, pp.is_primary desc`, [id]),
            query(pool, `select pm.id, pm.code, pm.name, pm.kind, pm.is_active
                           from property_payment_methods ppm join payment_methods pm on pm.id = ppm.payment_method_id
                          where ppm.property_id = $1 order by pm.sort_order`, [id]),
        ]);

        return {
            ...rows[0],
            media: media.rows,
            amenities: amenities.rows,
            charges: charges.rows,
            parties: parties.rows,
            paymentMethods: paymentMethods.rows,
        };
    }

    async function create(input, actor) {
        const title = nullIfBlank(input.title);
        if (!title) throw invalid('title is required');

        const latitude = numberOrUndefined(input.latitude);
        const longitude = numberOrUndefined(input.longitude);
        if ((latitude === undefined) !== (longitude === undefined)) {
            throw invalid('latitude and longitude must be provided together');
        }

        return withActor(pool, actor, async (client) => {
            const {rows} = await client.query(
                `insert into properties (
                     title, description, property_type_id, listing_type, owner_id, organization_id,
                     price, currency, bedrooms, bathrooms, size_sqm, address_line,
                     region_id, district_id, ward_id, location, status
                 ) values (
                     $1, $2, $3, coalesce($4::listing_type, 'rent'), $5, $6,
                     $7, coalesce($8, 'TZS'), $9, $10, $11, $12,
                     $13, $14, $15,
                     case when $16::double precision is not null
                          then st_setsrid(st_makepoint($17::double precision, $16::double precision), 4326)::geography
                     end,
                     coalesce($18::property_status, 'draft')
                 )
                 returning id`,
                [
                    title,
                    nullIfBlank(input.description),
                    nullIfBlank(input.propertyTypeId),
                    nullIfBlank(input.listingType),
                    nullIfBlank(input.ownerId),
                    nullIfBlank(input.organizationId),
                    numberOrUndefined(input.price) ?? null,
                    nullIfBlank(input.currency),
                    numberOrUndefined(input.bedrooms) ?? null,
                    numberOrUndefined(input.bathrooms) ?? null,
                    numberOrUndefined(input.sizeSqm) ?? null,
                    nullIfBlank(input.addressLine),
                    nullIfBlank(input.regionId),
                    nullIfBlank(input.districtId),
                    nullIfBlank(input.wardId),
                    latitude ?? null,
                    longitude ?? null,
                    nullIfBlank(input.status),
                ]
            );

            // The lease/terms block is optional at creation; apply whatever was
            // supplied through the same mapping update() uses.
            const terms = termsColumns(input);
            if (Object.values(terms).some((value) => value !== undefined)) {
                await updateById(client, {
                    table: 'properties',
                    id: rows[0].id,
                    allowed: UPDATABLE_FIELDS,
                    returning: 'id',
                    patch: terms,
                });
            }

            const {rows: created} = await client.query('select * from v_properties where id = $1', [rows[0].id]);
            return created[0];
        });
    }

    async function update(id, patch, actor) {
        const latitude = numberOrUndefined(patch.latitude);
        const longitude = numberOrUndefined(patch.longitude);
        if ((latitude === undefined) !== (longitude === undefined)) {
            throw invalid('latitude and longitude must be provided together');
        }

        return withActor(pool, actor, async (client) => {
            const updated = await updateById(client, {
                table: 'properties',
                id,
                allowed: UPDATABLE_FIELDS,
                returning: 'id',
                patch: {
                    title: nullIfBlank(patch.title) ?? undefined,
                    description: patch.description === undefined ? undefined : nullIfBlank(patch.description),
                    property_type_id:
                        patch.propertyTypeId === undefined ? undefined : nullIfBlank(patch.propertyTypeId),
                    listing_type: nullIfBlank(patch.listingType) ?? undefined,
                    owner_id: patch.ownerId === undefined ? undefined : nullIfBlank(patch.ownerId),
                    organization_id:
                        patch.organizationId === undefined ? undefined : nullIfBlank(patch.organizationId),
                    price: numberOrUndefined(patch.price),
                    currency: nullIfBlank(patch.currency) ?? undefined,
                    bedrooms: numberOrUndefined(patch.bedrooms),
                    bathrooms: numberOrUndefined(patch.bathrooms),
                    size_sqm: numberOrUndefined(patch.sizeSqm),
                    address_line: patch.addressLine === undefined ? undefined : nullIfBlank(patch.addressLine),
                    region_id: patch.regionId === undefined ? undefined : nullIfBlank(patch.regionId),
                    district_id: patch.districtId === undefined ? undefined : nullIfBlank(patch.districtId),
                    ward_id: patch.wardId === undefined ? undefined : nullIfBlank(patch.wardId),
                    ...termsColumns(patch),
                },
            });
            if (!updated) throw notFound('Property');

            if (latitude !== undefined && longitude !== undefined) {
                await client.query(
                    `update properties
                        set location = st_setsrid(st_makepoint($2, $3), 4326)::geography
                      where id = $1`,
                    [id, longitude, latitude]
                );
            }

            const {rows} = await client.query('select * from v_properties where id = $1', [id]);
            return rows[0];
        });
    }

    /**
     * Moderation decisions: submit / approve / reject / request changes /
     * suspend / archive are all just status transitions.
     */
    async function changeStatus(id, {status, reason}, actor) {
        const nextStatus = nullIfBlank(status);
        if (!nextStatus) throw invalid('status is required');
        if (['rejected', 'changes_requested'].includes(nextStatus) && !nullIfBlank(reason)) {
            throw invalid('A reason is required when rejecting or requesting changes');
        }

        return withActor(pool, actor, async (client) => {
            const {rows} = await client.query(
                `update properties
                    set status = $2::property_status,
                        rejection_reason = case when $2 in ('rejected', 'changes_requested') then $3 else null end
                  where id = $1
                  returning id`,
                [id, nextStatus, nullIfBlank(reason)]
            );
            if (rows.length === 0) throw notFound('Property');
            const {rows: updated} = await client.query('select * from v_properties where id = $1', [id]);
            return updated[0];
        });
    }

    return {search, getById, create, update, changeStatus};
}
