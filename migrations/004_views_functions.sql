-- Read models. Every admin list screen and the dashboard read from these,
-- so filtering/joining/paging/counting is done once, in SQL, instead of being
-- reimplemented per endpoint.

-- ---------------------------------------------------------------------------
-- Denormalised row shapes
-- ---------------------------------------------------------------------------

create view v_users as
select
    u.id,
    u.phone_number,
    u.email,
    u.full_name,
    u.role,
    u.status,
    u.job_title,
    u.suspension_reason,
    u.organization_id,
    o.name as organization_name,
    u.last_login_at,
    u.created_at,
    u.updated_at,
    (u.role in ('moderator', 'manager', 'finance_auditor', 'admin')) as is_staff
from users u
left join organizations o on o.id = u.organization_id;

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
    p.property_type_id,
    pt.name as property_type_name,
    p.region_id,
    r.name as region_name,
    p.district_id,
    d.name as district_name,
    p.ward_id,
    w.name as ward_name,
    p.owner_id,
    owner.full_name as owner_name,
    owner.phone_number as owner_phone,
    p.organization_id,
    o.name as organization_name,
    st_y(p.location::geometry) as latitude,
    st_x(p.location::geometry) as longitude,
    (select count(*) from property_media m where m.property_id = p.id) as media_count
from properties p
left join dictionary_items pt on pt.id = p.property_type_id
left join dictionary_items r on r.id = p.region_id
left join dictionary_items d on d.id = p.district_id
left join dictionary_items w on w.id = p.ward_id
left join users owner on owner.id = p.owner_id
left join organizations o on o.id = p.organization_id;

create view v_organizations as
select
    o.*,
    (select count(*) from users u where u.organization_id = o.id) as member_count,
    (select count(*) from properties p where p.organization_id = o.id) as property_count
from organizations o;

-- ---------------------------------------------------------------------------
-- Dashboard KPIs — a single round trip, computed by the database
-- ---------------------------------------------------------------------------

create view v_admin_dashboard_kpis as
select
    (select count(*) from users where role in ('customer', 'landlord', 'agency', 'broker')) as total_platform_users,
    (select count(*) from users where role in ('moderator', 'manager', 'finance_auditor', 'admin')) as total_staff_users,
    (select count(*) from users where status = 'suspended') as suspended_users,
    (select count(*) from users
      where created_at >= date_trunc('month', now())
        and role in ('customer', 'landlord', 'agency', 'broker')) as new_users_this_month,
    (select count(*) from users
      where created_at >= date_trunc('month', now()) - interval '1 month'
        and created_at < date_trunc('month', now())
        and role in ('customer', 'landlord', 'agency', 'broker')) as new_users_last_month,
    (select count(*) from properties where status = 'approved') as active_properties,
    (select count(*) from properties where status = 'pending_review') as pending_properties,
    (select count(*) from properties
      where created_at >= date_trunc('month', now())) as new_properties_this_month,
    (select count(*) from properties
      where created_at >= date_trunc('month', now()) - interval '1 month'
        and created_at < date_trunc('month', now())) as new_properties_last_month,
    (select count(*) from organizations where status = 'pending') as pending_organizations,
    (select count(*) from organizations where status = 'active') as active_organizations,
    (select coalesce(sum(price), 0) from properties
      where status = 'approved' and listing_type = 'rent') as active_rent_value;

create view v_recent_audit_activity as
select
    a.id,
    a.table_name,
    a.record_id,
    a.operation,
    a.actor,
    a.changed_fields,
    a.created_at,
    coalesce(
        a.new_data ->> 'title',
        a.new_data ->> 'full_name',
        a.new_data ->> 'name',
        a.old_data ->> 'title',
        a.old_data ->> 'full_name',
        a.old_data ->> 'name',
        a.record_id
    ) as subject,
    coalesce(a.new_data ->> 'status', a.old_data ->> 'status') as status
from audit_log a
order by a.created_at desc;

-- ---------------------------------------------------------------------------
-- Search functions. Each returns a `total_count` window so a list screen gets
-- its page and its pagination total in one query.
-- ---------------------------------------------------------------------------

create or replace function search_users(
    p_query text default null,
    p_role user_role default null,
    p_status user_status default null,
    p_organization_id uuid default null,
    p_staff_only boolean default null,
    p_limit integer default 20,
    p_offset integer default 0
)
returns table (
    id uuid,
    phone_number text,
    email text,
    full_name text,
    role user_role,
    status user_status,
    job_title text,
    suspension_reason text,
    organization_id uuid,
    organization_name text,
    last_login_at timestamptz,
    created_at timestamptz,
    updated_at timestamptz,
    is_staff boolean,
    total_count bigint
)
language sql stable as $$
    select
        u.id, u.phone_number, u.email, u.full_name, u.role, u.status, u.job_title,
        u.suspension_reason, u.organization_id, u.organization_name, u.last_login_at,
        u.created_at, u.updated_at, u.is_staff,
        count(*) over () as total_count
    from v_users u
    where (p_query is null or (
              u.full_name ilike '%' || p_query || '%'
              or u.email ilike '%' || p_query || '%'
              or u.phone_number ilike '%' || p_query || '%'))
      and (p_role is null or u.role = p_role)
      and (p_status is null or u.status = p_status)
      and (p_organization_id is null or u.organization_id = p_organization_id)
      and (p_staff_only is null or u.is_staff = p_staff_only)
    order by u.created_at desc
    limit greatest(p_limit, 0) offset greatest(p_offset, 0);
$$;

create or replace function search_organizations(
    p_query text default null,
    p_status organization_status default null,
    p_type organization_type default null,
    p_limit integer default 20,
    p_offset integer default 0
)
returns table (
    id uuid,
    name text,
    type organization_type,
    registration_number text,
    email text,
    phone_number text,
    address_line text,
    status organization_status,
    rejection_reason text,
    verified_at timestamptz,
    verified_by text,
    created_at timestamptz,
    updated_at timestamptz,
    member_count bigint,
    property_count bigint,
    total_count bigint
)
language sql stable as $$
    select
        o.id, o.name, o.type, o.registration_number, o.email, o.phone_number,
        o.address_line, o.status, o.rejection_reason, o.verified_at, o.verified_by,
        o.created_at, o.updated_at, o.member_count, o.property_count,
        count(*) over () as total_count
    from v_organizations o
    where (p_query is null or (
              o.name ilike '%' || p_query || '%'
              or coalesce(o.registration_number, '') ilike '%' || p_query || '%'
              or coalesce(o.email, '') ilike '%' || p_query || '%'))
      and (p_status is null or o.status = p_status)
      and (p_type is null or o.type = p_type)
    order by o.created_at desc
    limit greatest(p_limit, 0) offset greatest(p_offset, 0);
$$;

-- Property search: text + facets + PostGIS radius, all index-backed.
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
    property_type_name text,
    region_name text,
    district_name text,
    ward_name text,
    owner_id uuid,
    owner_name text,
    organization_id uuid,
    organization_name text,
    latitude double precision,
    longitude double precision,
    media_count bigint,
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
        v.property_type_name, v.region_name, v.district_name, v.ward_name,
        v.owner_id, v.owner_name, v.organization_id, v.organization_name,
        v.latitude, v.longitude, v.media_count,
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

-- Geography tree for cascading Region → District → Ward pickers.
create or replace function dictionary_children(
    p_category text,
    p_parent_id uuid default null,
    p_include_inactive boolean default false
)
returns table (
    id uuid,
    category text,
    code text,
    name text,
    parent_id uuid,
    sort_order integer,
    is_active boolean,
    metadata jsonb,
    child_count bigint
)
language sql stable as $$
    select
        d.id, d.category, d.code, d.name, d.parent_id, d.sort_order, d.is_active, d.metadata,
        (select count(*) from dictionary_items c where c.parent_id = d.id) as child_count
    from dictionary_items d
    where d.category = p_category
      and (p_parent_id is null or d.parent_id = p_parent_id)
      and (p_include_inactive or d.is_active)
    order by d.sort_order, d.name;
$$;
