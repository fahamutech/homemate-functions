import {withActor, query, toPage, pageParams, nullIfBlank} from '../../shared/db.mjs';
import {notFound, invalid, DomainError, ErrorCodes} from '../../shared/errors.mjs';
import {MOBILE_MONEY_PROVIDERS} from '../partner-app/payout.mjs';
import {loadFeeSettings, tenantFee} from '../../shared/fees.mjs';

/**
 * Everything the mobile app does once someone is signed in: browse, save, ask,
 * and pay once the landlord has said yes.
 *
 * Two rules shape this whole module:
 *
 *   1. A customer may only ever see and change their own records. Every read
 *      and write is scoped by `customerId` taken from the session, never from
 *      the request body, so a guessed id buys nothing.
 *   2. Nothing here settles money. The customer can *claim* they have paid,
 *      which puts the payment in front of a human; only the finance path in
 *      `money.mjs` can mark it successful (BR-005).
 */

const CONTACT_PREFERENCES = ['phone', 'sms', 'whatsapp', 'email', 'in_app'];

export function createCustomerAppService({pool}) {
    // --- discovery -----------------------------------------------------------

    /**
     * The listing search the app's home and results screens use. Only approved
     * properties are visible: a customer must never be shown something still
     * in moderation.
     */
    async function searchProperties(filters = {}, customerId = null) {
        const {limit, offset} = pageParams(filters);
        // Named arguments rather than eighteen positional ones: the function
        // keeps growing, and a silently shifted parameter is a search that
        // quietly returns the wrong homes.
        const {rows} = await query(
            pool,
            `select * from search_properties(
                p_query => $1,
                p_status => 'approved'::property_status,
                p_listing_type => $2::listing_type,
                p_property_type_id => $3,
                p_region_id => $4,
                p_district_id => $5,
                p_ward_id => $6,
                p_min_price => $7,
                p_max_price => $8,
                p_min_bedrooms => $9::smallint,
                p_latitude => $10,
                p_longitude => $11,
                p_radius_metres => $12,
                p_furnishing => $13::furnishing_status,
                p_payment_frequency => $14::rent_payment_frequency,
                p_amenity_ids => $15::uuid[],
                p_min_bathrooms => $16::smallint,
                p_min_size_sqm => $17,
                p_max_size_sqm => $18,
                p_available_by => $19::date,
                p_verified_only => $20,
                p_limit => $21,
                p_offset => $22
            )`,
            [
                nullIfBlank(filters.query),
                nullIfBlank(filters.listingType),
                nullIfBlank(filters.propertyTypeId),
                nullIfBlank(filters.regionId),
                nullIfBlank(filters.districtId),
                nullIfBlank(filters.wardId),
                numberOrNull(filters.minPrice),
                numberOrNull(filters.maxPrice),
                numberOrNull(filters.bedrooms),
                numberOrNull(filters.latitude),
                numberOrNull(filters.longitude),
                numberOrNull(filters.radiusMetres),
                nullIfBlank(filters.furnishing),
                nullIfBlank(filters.paymentFrequency),
                filters.amenityIds?.length ? filters.amenityIds : null,
                numberOrNull(filters.bathrooms),
                numberOrNull(filters.minSizeSqm),
                numberOrNull(filters.maxSizeSqm),
                nullIfBlank(filters.availableBy),
                booleanOrNull(filters.verifiedOnly) ?? false,
                limit,
                offset,
            ]
        );

        const page = toPage(rows, {limit, offset});
        if (!customerId || page.items.length === 0) return page;

        // One extra query marks the hearts, rather than a join that would make
        // the shared search function care about who is asking.
        const {rows: saved} = await query(
            pool,
            'select property_id from saved_properties where customer_id = $1 and property_id = any($2::uuid[])',
            [customerId, page.items.map((item) => item.id)]
        );
        const savedIds = new Set(saved.map((row) => row.property_id));
        return {...page, items: page.items.map((item) => ({...item, is_saved: savedIds.has(item.id)}))};
    }

    /** One call per property screen — see `customer_property_detail` in 014. */
    async function propertyDetail(propertyId, customerId = null) {
        const {rows} = await query(pool, 'select customer_property_detail($1, $2) as detail', [
            propertyId,
            customerId,
        ]);
        const detail = rows[0]?.detail;
        if (!detail?.property) throw notFound('Property');
        if (detail.property.status !== 'approved') throw notFound('Property');

        // The fee this listing will carry at checkout, and what it saves
        // against the usual month's agent fee — shown before anyone enquires,
        // so the first time a customer meets the fee is not at the till.
        const settings = await loadFeeSettings(pool);
        const fee = tenantFee(detail.property.price, settings);
        return {
            ...detail,
            serviceFee: {
                amount: fee.amount,
                percentage: fee.percentage,
                benchmarkAmount: fee.benchmarkAmount,
                benchmarkLabel: "Usual agent fee (one month's rent)",
                saving: fee.saving,
            },
        };
    }

    // --- reference data ------------------------------------------------------

    /**
     * The lists every picker in the app is built from — property types,
     * amenities, and the region/district/ward tree — in one call.
     *
     * One call rather than five: the filter sheet, the search overlay and the
     * onboarding preferences step all need the same four lists at once, and a
     * screen that renders before its chips arrive is a screen that flickers.
     * Archived entries are left out, because a filter must never offer
     * something no listing can match.
     */
    async function referenceData() {
        const {rows} = await query(
            pool,
            `select id, category, code, name, parent_id, sort_order
               from dictionary_items
              where is_active and category in ('property_type', 'amenity', 'region', 'district', 'ward', 'bank')
              order by category, sort_order, name`
        );

        const by = (category) =>
            rows
                .filter((row) => row.category === category)
                .map(({id, code, name, parent_id}) => ({id, code, name, parentId: parent_id}));

        return {
            propertyTypes: by('property_type'),
            amenities: by('amenity'),
            regions: by('region'),
            districts: by('district'),
            wards: by('ward'),
            // The "Getting paid" pickers (T03): a bank's code is what PUT /app/me/payout takes.
            banks: by('bank'),
            mobileMoneyProviders: MOBILE_MONEY_PROVIDERS,
        };
    }

    // --- saved properties ----------------------------------------------------

    async function listSaved(customerId, filters = {}) {
        const {limit, offset} = pageParams(filters);
        const {rows} = await query(
            pool,
            `select s.id as saved_id, s.note, s.created_at as saved_at, p.*, count(*) over () as total_count
               from saved_properties s
               join v_properties p on p.id = s.property_id
              where s.customer_id = $1
              order by s.created_at desc
              limit $2 offset $3`,
            [customerId, limit, offset]
        );
        return toPage(rows, {limit, offset});
    }

    async function saveProperty(customerId, propertyId, note) {
        return withActor(pool, customerId, async (client) => {
            const {rows} = await client.query(
                `insert into saved_properties (customer_id, property_id, note)
                 values ($1, $2, $3)
                 on conflict (customer_id, property_id) do update set note = excluded.note
                 returning id`,
                [customerId, propertyId, nullIfBlank(note)]
            );
            return {id: rows[0].id, propertyId, saved: true};
        });
    }

    async function unsaveProperty(customerId, propertyId) {
        await query(pool, 'delete from saved_properties where customer_id = $1 and property_id = $2', [
            customerId,
            propertyId,
        ]);
        return {propertyId, saved: false};
    }

    // --- inquiries -----------------------------------------------------------

    async function listInquiries(customerId, filters = {}) {
        const {limit, offset} = pageParams(filters);
        const {rows} = await query(pool, 'select * from search_inquiries($1, $2, $3, null, $4, $5)', [
            nullIfBlank(filters.query),
            nullIfBlank(filters.status),
            customerId,
            limit,
            offset,
        ]);
        return toPage(rows, {limit, offset});
    }

    async function getInquiry(customerId, id) {
        const {rows} = await query(pool, 'select * from v_inquiries where id = $1 and customer_id = $2', [
            id,
            customerId,
        ]);
        if (rows.length === 0) throw notFound('Inquiry');
        return rows[0];
    }

    async function createInquiry(customerId, input) {
        const message = nullIfBlank(input.message);
        if (!message) throw invalid('Please say what you would like to ask');
        const propertyId = nullIfBlank(input.propertyId);
        if (!propertyId) throw invalid('propertyId is required');
        const contactPreference = nullIfBlank(input.contactPreference);
        if (contactPreference && !CONTACT_PREFERENCES.includes(contactPreference)) {
            throw invalid(`contactPreference must be one of: ${CONTACT_PREFERENCES.join(', ')}`);
        }

        return withActor(pool, customerId, async (client) => {
            const {rows: property} = await client.query(
                "select id from properties where id = $1 and status = 'approved'",
                [propertyId]
            );
            if (property.length === 0) throw notFound('Property');

            const {rows} = await client.query(
                `insert into property_inquiries
                     (property_id, customer_id, message, move_in_date, budget_amount, occupants,
                      contact_preference, preferred_contact_time)
                 values ($1, $2, $3, $4::date, $5, $6, $7, $8)
                 returning id`,
                [
                    propertyId,
                    customerId,
                    message,
                    nullIfBlank(input.moveInDate),
                    input.budgetAmount === undefined || input.budgetAmount === '' ? null : Number(input.budgetAmount),
                    input.occupants === undefined || input.occupants === '' ? null : Number(input.occupants),
                    contactPreference,
                    nullIfBlank(input.preferredContactTime),
                ]
            );
            return rows[0].id;
        })
            .then((id) => getInquiry(customerId, id))
            .catch((error) => {
                // The partial unique index is the rule; this is what it means.
                if (error.code === ErrorCodes.CONFLICT) {
                    throw new DomainError(
                        ErrorCodes.CONFLICT,
                        'You already have an open enquiry for this property',
                        409
                    );
                }
                throw error;
            });
    }

    async function withdrawInquiry(customerId, id) {
        return withActor(pool, customerId, async (client) => {
            const {rows} = await client.query(
                `update property_inquiries set status = 'withdrawn'
                  where id = $1 and customer_id = $2 and status in ('pending', 'responded')
                  returning id`,
                [id, customerId]
            );
            if (rows.length === 0) {
                const {rows: existing} = await client.query(
                    'select status from property_inquiries where id = $1 and customer_id = $2',
                    [id, customerId]
                );
                if (existing.length === 0) throw notFound('Inquiry');
                throw invalid(`An enquiry that is ${existing[0].status} cannot be withdrawn`);
            }
            return id;
        }).then(() => getInquiry(customerId, id));
    }

    // --- payments ------------------------------------------------------------

    async function listPayments(customerId, filters = {}) {
        const {limit, offset} = pageParams(filters);
        const {rows} = await query(
            pool,
            `select *, count(*) over () as total_count
               from v_customer_payments
              where payer_user_id = $1
                and ($2::text is null or customer_state = $2)
              order by created_at desc
              limit $3 offset $4`,
            [customerId, nullIfBlank(filters.state), limit, offset]
        );
        return toPage(rows, {limit, offset});
    }

    async function getPayment(customerId, id) {
        const {rows} = await query(
            pool,
            'select * from v_customer_payments where id = $1 and payer_user_id = $2',
            [id, customerId]
        );
        if (rows.length === 0) throw notFound('Payment');
        return rows[0];
    }

    /**
     * "I have paid." This records a claim and nothing more — the payment stays
     * `pending` until a finance officer verifies it against the account. The
     * customer sees an honest "we are checking", and the portal gets a queue.
     */
    async function declarePaid(customerId, id, {reference, note} = {}) {
        return withActor(pool, customerId, async (client) => {
            const {rows: payment} = await client.query(
                `select p.id, p.status, p.customer_declared_paid_at, i.id as instruction_id
                   from payments p
                   left join payment_instructions i on i.payment_id = p.id
                  where p.id = $1 and p.payer_user_id = $2`,
                [id, customerId]
            );
            if (payment.length === 0) throw notFound('Payment');
            if (payment[0].status === 'successful') {
                throw invalid('This payment has already been confirmed');
            }
            if (payment[0].status !== 'pending') {
                throw invalid(`A payment that is ${payment[0].status} cannot be declared as paid`);
            }
            if (!payment[0].instruction_id) {
                throw invalid('Payment details are not ready yet — please check back shortly');
            }

            await client.query(
                `update payments
                    set customer_declared_paid_at = coalesce(customer_declared_paid_at, now()),
                        customer_declared_reference = coalesce($2, customer_declared_reference),
                        customer_declared_note = coalesce($3, customer_declared_note)
                  where id = $1`,
                [id, nullIfBlank(reference), nullIfBlank(note)]
            );
            return id;
        }).then(() => getPayment(customerId, id));
    }

    // --- profile, preferences, notifications ---------------------------------

    async function getPreferences(customerId) {
        const {rows} = await query(pool, 'select * from customer_preferences where customer_id = $1', [
            customerId,
        ]);
        return rows[0] ?? {customer_id: customerId};
    }

    async function savePreferences(customerId, input) {
        return withActor(pool, customerId, async (client) => {
            const {rows} = await client.query(
                `insert into customer_preferences
                     (customer_id, budget_min, budget_max, bedrooms_min, preferred_region_id,
                      preferred_district_ids, property_type_ids, amenity_ids, furnishing,
                      move_in_from, notify_new_matches, notify_price_drops, notify_by_sms)
                 values ($1, $2, $3, $4, $5, coalesce($6::uuid[], '{}'), coalesce($7::uuid[], '{}'),
                         coalesce($8::uuid[], '{}'), $9::furnishing_status, $10::date,
                         coalesce($11, true), coalesce($12, true), coalesce($13, false))
                 on conflict (customer_id) do update set
                     budget_min = excluded.budget_min,
                     budget_max = excluded.budget_max,
                     bedrooms_min = excluded.bedrooms_min,
                     preferred_region_id = excluded.preferred_region_id,
                     preferred_district_ids = excluded.preferred_district_ids,
                     property_type_ids = excluded.property_type_ids,
                     amenity_ids = excluded.amenity_ids,
                     furnishing = excluded.furnishing,
                     move_in_from = excluded.move_in_from,
                     notify_new_matches = excluded.notify_new_matches,
                     notify_price_drops = excluded.notify_price_drops,
                     notify_by_sms = excluded.notify_by_sms
                 returning *`,
                [
                    customerId,
                    numberOrNull(input.budgetMin),
                    numberOrNull(input.budgetMax),
                    numberOrNull(input.bedroomsMin),
                    nullIfBlank(input.preferredRegionId),
                    input.districtIds ?? null,
                    input.propertyTypeIds ?? null,
                    input.amenityIds ?? null,
                    nullIfBlank(input.furnishing),
                    nullIfBlank(input.moveInFrom),
                    booleanOrNull(input.notifyNewMatches),
                    booleanOrNull(input.notifyPriceDrops),
                    booleanOrNull(input.notifyBySms),
                ]
            );
            return rows[0];
        });
    }

    async function listNotifications(customerId, filters = {}) {
        const {limit, offset} = pageParams(filters);
        const {rows} = await query(
            pool,
            `select *, count(*) over () as total_count
               from notifications
              where user_id = $1
                and ($2::boolean is not true or read_at is null)
              order by created_at desc
              limit $3 offset $4`,
            [customerId, filters.unreadOnly === true || filters.unreadOnly === 'true', limit, offset]
        );
        return toPage(rows, {limit, offset});
    }

    async function markNotificationRead(customerId, id) {
        const {rows} = await query(
            pool,
            'update notifications set read_at = now() where id = $1 and user_id = $2 returning *',
            [id, customerId]
        );
        if (rows.length === 0) throw notFound('Notification');
        return rows[0];
    }

    async function markAllNotificationsRead(customerId) {
        const {rowCount} = await query(
            pool,
            'update notifications set read_at = now() where user_id = $1 and read_at is null',
            [customerId]
        );
        return {updated: rowCount};
    }

    /** The counts the app's home and profile screens badge with. */
    async function activitySummary(customerId) {
        const {rows} = await query(pool, 'select customer_activity_summary($1) as summary', [customerId]);
        return rows[0].summary;
    }

    return {
        searchProperties,
        propertyDetail,
        listSaved,
        saveProperty,
        unsaveProperty,
        listInquiries,
        getInquiry,
        createInquiry,
        withdrawInquiry,
        listPayments,
        getPayment,
        declarePaid,
        referenceData,
        getPreferences,
        savePreferences,
        listNotifications,
        markNotificationRead,
        markAllNotificationsRead,
        activitySummary,
    };
}

function numberOrNull(value) {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function booleanOrNull(value) {
    if (value === undefined || value === null || value === '') return null;
    return value === true || value === 'true';
}
