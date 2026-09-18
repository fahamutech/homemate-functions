-- Read models for the enriched property. `v_properties` is replaced so that a
-- single row carries everything a list or detail screen needs: parties,
-- amenity/charge/media rollups, cover image and the derived monthly cost.

drop function if exists search_properties(
    text, property_status, listing_type, uuid, uuid, uuid, uuid,
    numeric, numeric, smallint, double precision, double precision, integer, integer, integer
);
drop view if exists v_properties;

create view v_properties as
select
    p.id,
    p.reference_code,
    p.title,
    p.description,
    p.listing_type,
    p.status,
    p.price,
    p.currency,
    p.bedrooms,
    p.bathrooms,
    p.size_sqm,
    p.address_line,
    p.rejection_reason,
    p.submitted_at,
    p.reviewed_at,
    p.reviewed_by,
    p.created_at,
    p.updated_at,

    -- lease & payment terms
    p.furnishing,
    p.floor_number,
    p.total_floors,
    p.year_built,
    p.parking_spaces,
    p.max_occupants,
    p.pets_allowed,
    p.smoking_allowed,
    p.available_from,
    p.min_lease_months,
    p.max_lease_months,
    p.payment_frequency,
    p.custom_payment_months,
    payment_frequency_months(p.payment_frequency, p.custom_payment_months) as payment_months,
    p.deposit_months,
    p.advance_rent_months,
    p.notice_period_days,
    p.terms,
    p.house_rules,

    -- classification & geography
    p.property_type_id,
    pt.name as property_type_name,
    p.region_id,
    r.name as region_name,
    p.district_id,
    d.name as district_name,
    p.ward_id,
    w.name as ward_name,
    st_y(p.location::geometry) as latitude,
    st_x(p.location::geometry) as longitude,

    -- ownership / attribution
    p.owner_id,
    owner.full_name as owner_name,
    owner.phone_number as owner_phone,
    p.organization_id,
    o.name as organization_name,
    (select u.full_name from property_parties pp join users u on u.id = pp.user_id
      where pp.property_id = p.id and pp.role = 'landlord' order by pp.is_primary desc limit 1) as landlord_name,
    (select u.full_name from property_parties pp join users u on u.id = pp.user_id
      where pp.property_id = p.id and pp.role = 'broker' order by pp.is_primary desc limit 1) as broker_name,
    (select u.full_name from property_parties pp join users u on u.id = pp.user_id
      where pp.property_id = p.id and pp.role = 'agency' order by pp.is_primary desc limit 1) as agency_contact_name,

    -- rollups
    (select count(*) from property_media m where m.property_id = p.id) as media_count,
    (select count(*) from property_amenities a where a.property_id = p.id) as amenity_count,
    (select m.url from property_media m where m.property_id = p.id and m.is_cover limit 1) as cover_url,
    (select m.thumbnail_url from property_media m where m.property_id = p.id and m.is_cover limit 1) as cover_thumbnail_url,
    (select m.id from property_media m where m.property_id = p.id and m.is_cover limit 1) as cover_media_id,

    -- derived cost: rent plus the monthly-equivalent of every mandatory charge
    coalesce(p.price, 0) + coalesce((
        select sum(charge_monthly_equivalent(c.amount, c.frequency))
          from property_charges c
         where c.property_id = p.id and c.is_mandatory
    ), 0) as total_monthly_cost,
    coalesce((
        select sum(c.amount) from property_charges c
         where c.property_id = p.id and c.frequency = 'one_time'
    ), 0) as one_time_charges_total,
    round(coalesce(p.price, 0) * p.deposit_months, 2) as deposit_amount,
    round(coalesce(p.price, 0) * payment_frequency_months(p.payment_frequency, p.custom_payment_months), 2)
        as amount_per_instalment
from properties p
left join dictionary_items pt on pt.id = p.property_type_id
left join dictionary_items r on r.id = p.region_id
left join dictionary_items d on d.id = p.district_id
left join dictionary_items w on w.id = p.ward_id
left join users owner on owner.id = p.owner_id
left join organizations o on o.id = p.organization_id;

-- Property search: text + facets + PostGIS radius, plus the new facets
-- (amenities, furnishing, payment frequency).
create or replace function search_properties(
    p_query text default null,
    p_status property_status default null,
    p_listing_type listing_type default null,
    p_property_type_id uuid default null,
    p_region_id uuid default null,
    p_organization_id uuid default null,
    p_owner_id uuid default null,
    p_min_price numeric default null,
    p_max_price numeric default null,
    p_min_bedrooms smallint default null,
    p_latitude double precision default null,
    p_longitude double precision default null,
    p_radius_metres integer default null,
    p_furnishing furnishing_status default null,
    p_payment_frequency rent_payment_frequency default null,
    p_amenity_ids uuid[] default null,
    p_limit integer default 20,
    p_offset integer default 0
)
returns table (
    id uuid,
    reference_code text,
    title text,
    listing_type listing_type,
    status property_status,
    price numeric,
    currency text,
    bedrooms smallint,
    bathrooms smallint,
    size_sqm numeric,
    address_line text,
    rejection_reason text,
    submitted_at timestamptz,
    reviewed_at timestamptz,
    reviewed_by text,
    created_at timestamptz,
    updated_at timestamptz,
    furnishing furnishing_status,
    payment_frequency rent_payment_frequency,
    payment_months smallint,
    total_monthly_cost numeric,
    deposit_amount numeric,
    amount_per_instalment numeric,
    property_type_name text,
    region_name text,
    district_name text,
    ward_name text,
    owner_id uuid,
    owner_name text,
    landlord_name text,
    broker_name text,
    organization_id uuid,
    organization_name text,
    latitude double precision,
    longitude double precision,
    media_count bigint,
    amenity_count bigint,
    cover_media_id uuid,
    cover_thumbnail_url text,
    distance_metres double precision,
    total_count bigint
)
language sql stable as $$
    with origin as (
        select case
            when p_latitude is not null and p_longitude is not null
            then st_setsrid(st_makepoint(p_longitude, p_latitude), 4326)::geography
        end as point
    )
    select
        v.id, v.reference_code, v.title, v.listing_type, v.status, v.price, v.currency,
        v.bedrooms, v.bathrooms, v.size_sqm, v.address_line, v.rejection_reason,
        v.submitted_at, v.reviewed_at, v.reviewed_by, v.created_at, v.updated_at,
        v.furnishing, v.payment_frequency, v.payment_months, v.total_monthly_cost,
        v.deposit_amount, v.amount_per_instalment,
        v.property_type_name, v.region_name, v.district_name, v.ward_name,
        v.owner_id, v.owner_name, v.landlord_name, v.broker_name,
        v.organization_id, v.organization_name,
        v.latitude, v.longitude, v.media_count, v.amenity_count,
        v.cover_media_id, v.cover_thumbnail_url,
        case when o.point is not null and p.location is not null
             then st_distance(p.location, o.point) end as distance_metres,
        count(*) over () as total_count
    from v_properties v
    join properties p on p.id = v.id
    cross join origin o
    where (p_query is null or p.search_vector @@ plainto_tsquery('simple', p_query)
                           or p.title ilike '%' || p_query || '%'
                           or p.reference_code ilike '%' || p_query || '%')
      and (p_status is null or v.status = p_status)
      and (p_listing_type is null or v.listing_type = p_listing_type)
      and (p_property_type_id is null or v.property_type_id = p_property_type_id)
      and (p_region_id is null or v.region_id = p_region_id)
      and (p_organization_id is null or v.organization_id = p_organization_id)
      and (p_owner_id is null or v.owner_id = p_owner_id)
      and (p_min_price is null or v.price >= p_min_price)
      and (p_max_price is null or v.price <= p_max_price)
      and (p_min_bedrooms is null or v.bedrooms >= p_min_bedrooms)
      and (p_furnishing is null or v.furnishing = p_furnishing)
      and (p_payment_frequency is null or v.payment_frequency = p_payment_frequency)
      and (
            p_amenity_ids is null
            or cardinality(p_amenity_ids) = 0
            -- every requested amenity must be present, not just any of them
            or not exists (
                select 1 from unnest(p_amenity_ids) as required(amenity_id)
                 where not exists (
                     select 1 from property_amenities pa
                      where pa.property_id = v.id and pa.amenity_id = required.amenity_id
                 )
            )
          )
      and (
            o.point is null
            or p_radius_metres is null
            or (p.location is not null and st_dwithin(p.location, o.point, p_radius_metres))
          )
    order by
        case when o.point is not null and p.location is not null then st_distance(p.location, o.point) end asc nulls last,
        v.created_at desc
    limit greatest(p_limit, 0) offset greatest(p_offset, 0);
$$;

-- ---------------------------------------------------------------------------
-- Seed payment methods (provider-agnostic; `provider` selects the adapter)
-- ---------------------------------------------------------------------------

insert into payment_methods (code, name, kind, provider, is_active, sort_order, instructions) values
    ('mpesa', 'M-Pesa', 'mobile_money', 'sandbox', true, 10, 'Pay via Vodacom M-Pesa using the Lipa Namba shown at checkout.'),
    ('tigopesa', 'Mixx by Yas (Tigo Pesa)', 'mobile_money', 'sandbox', true, 20, 'Pay via Mixx by Yas using the Lipa Namba shown at checkout.'),
    ('airtelmoney', 'Airtel Money', 'mobile_money', 'sandbox', true, 30, 'Pay via Airtel Money using the Lipa Namba shown at checkout.'),
    ('bank_transfer', 'Bank transfer', 'bank_transfer', 'manual', true, 40, 'Transfer to the HomeMate collection account and upload the reference.'),
    ('cash', 'Cash', 'cash', 'manual', false, 50, 'Recorded manually by an operations officer after receipt.');

insert into settings (key, value, category, description) values
    ('payments.default_method', '"mpesa"'::jsonb, 'payments', 'Payment method offered first at checkout'),
    ('payments.provider', '"sandbox"'::jsonb, 'payments', 'Active PaymentPort adapter (sandbox until a licensed provider is contracted)'),
    ('payments.currency', '"TZS"'::jsonb, 'payments', 'Currency payments are collected in'),
    ('payments.reference_prefix', '"HM"'::jsonb, 'payments', 'Prefix applied to generated payment references'),
    ('storage.provider', '"zebra"'::jsonb, 'storage', 'Active StoragePort adapter'),
    ('storage.max_image_mb', '5'::jsonb, 'storage', 'Largest single image accepted from the browser (post-WebP conversion)');
