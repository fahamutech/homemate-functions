-- The app's filter sheet (CUS-002b) and location picker (CUS-002c) narrow by
-- district and ward, which `search_properties` could not do — it stopped at
-- region. Rather than give the app a near-identical search of its own, the
-- shared function grows two parameters and both callers benefit.
--
-- The old signature is dropped first: appending defaulted parameters would
-- otherwise leave two overloads, and an eighteen-argument call would match
-- both and fail as ambiguous.

drop function if exists search_properties(
    text, property_status, listing_type, uuid, uuid, uuid, uuid, numeric, numeric, smallint,
    double precision, double precision, integer, furnishing_status, rent_payment_frequency,
    uuid[], integer, integer
);

create function search_properties(
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
    p_offset integer default 0,
    p_district_id uuid default null,
    p_ward_id uuid default null
)
returns table (
    id uuid, reference_code text, title text, listing_type listing_type, status property_status,
    price numeric, currency text, bedrooms smallint, bathrooms smallint, size_sqm numeric,
    address_line text, rejection_reason text, submitted_at timestamptz, reviewed_at timestamptz,
    reviewed_by text, created_at timestamptz, updated_at timestamptz, furnishing furnishing_status,
    payment_frequency rent_payment_frequency, payment_months smallint, total_monthly_cost numeric,
    deposit_amount numeric, amount_per_instalment numeric, property_type_name text,
    region_name text, district_name text, ward_name text, owner_id uuid, owner_name text,
    landlord_name text, broker_name text, organization_id uuid, organization_name text,
    latitude double precision, longitude double precision, media_count bigint,
    amenity_count bigint, cover_media_id uuid, cover_thumbnail_url text,
    distance_metres double precision, total_count bigint
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
      -- new: the app filters below region
      and (p_district_id is null or v.district_id = p_district_id)
      and (p_ward_id is null or v.ward_id = p_ward_id)
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
