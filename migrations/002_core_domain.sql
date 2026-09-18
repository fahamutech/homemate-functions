-- Core admin domain: organizations, extended users/roles, property registry,
-- dictionaries (master data), settings and the audit log.
--
-- Design rule for this project: the DATABASE is the source of truth. Anything
-- that can be expressed as a constraint, generated column, trigger, view or
-- function lives here rather than in application code — see 003_triggers.sql
-- and 004_views_functions.sql. The Node layer is deliberately a thin caller.

-- pg_trgm backs the gin_trgm_ops indexes below, used for fuzzy name/title search.
create extension if not exists pg_trgm;
-- postgis backs the geography column/functions used for property location search.
create extension if not exists postgis;

-- ---------------------------------------------------------------------------
-- Enumerated domains
-- ---------------------------------------------------------------------------

create type user_role as enum (
    -- platform users
    'customer',
    'landlord',
    'agency',
    'broker',
    -- backoffice staff
    'moderator',
    'manager',
    'finance_auditor',
    'admin'
);

create type user_status as enum ('pending', 'active', 'suspended', 'deactivated');

create type organization_type as enum ('agency', 'developer', 'institution');
create type organization_status as enum ('pending', 'active', 'suspended', 'rejected');

create type property_status as enum (
    'draft',
    'pending_review',
    'approved',
    'rejected',
    'changes_requested',
    'suspended',
    'archived'
);

create type listing_type as enum ('rent', 'sale');

create type audit_operation as enum ('INSERT', 'UPDATE', 'DELETE');

-- ---------------------------------------------------------------------------
-- Organizations (agencies / developers / institutions)
-- ---------------------------------------------------------------------------

create table organizations (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    type organization_type not null default 'agency',
    registration_number text unique,
    email text,
    phone_number text,
    address_line text,
    status organization_status not null default 'pending',
    rejection_reason text,
    verified_at timestamptz,
    verified_by text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint organizations_name_not_blank check (length(btrim(name)) > 0),
    -- a rejected organization must carry a reason; an active one must not
    constraint organizations_rejection_reason_required
        check ((status = 'rejected') = (rejection_reason is not null))
);

create index idx_organizations_status on organizations (status);
create index idx_organizations_name_trgm on organizations using gin (name gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Users: one table for every human, discriminated by `role`
-- ---------------------------------------------------------------------------

alter table users
    add column email text,
    add column full_name text,
    add column role user_role not null default 'customer',
    add column organization_id uuid references organizations (id) on delete set null,
    add column job_title text,
    add column suspension_reason text,
    add column last_login_at timestamptz;

create unique index users_email_key on users (lower(email)) where email is not null;

-- `status` started life as a text column with a CHECK; promote it to the enum
-- so illegal states are impossible rather than merely discouraged.
alter table users alter column status drop default;
alter table users drop constraint if exists users_status_check;
alter table users alter column status type user_status using status::user_status;
alter table users alter column status set default 'active';

alter table users
    add constraint users_suspension_reason_required
        check ((status = 'suspended') = (suspension_reason is not null));

-- Staff accounts are backoffice logins: they need an email, platform users
-- authenticate by phone. Enforced here so no code path can create a
-- half-formed staff account.
alter table users
    add constraint users_staff_requires_email
        check (role not in ('moderator', 'manager', 'finance_auditor', 'admin') or email is not null);

create index idx_users_role on users (role);
create index idx_users_status on users (status);
create index idx_users_organization on users (organization_id);
create index idx_users_full_name_trgm on users using gin (coalesce(full_name, '') gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Dictionaries (master data): regions/districts/wards, property types, amenities
-- ---------------------------------------------------------------------------

create table dictionary_items (
    id uuid primary key default gen_random_uuid(),
    category text not null,
    code text not null,
    name text not null,
    parent_id uuid references dictionary_items (id) on delete cascade,
    sort_order integer not null default 0,
    is_active boolean not null default true,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint dictionary_items_category_code_key unique (category, code),
    constraint dictionary_items_no_self_parent check (parent_id is null or parent_id <> id)
);

create index idx_dictionary_items_category on dictionary_items (category, sort_order);
create index idx_dictionary_items_parent on dictionary_items (parent_id);

-- ---------------------------------------------------------------------------
-- Property registry
-- ---------------------------------------------------------------------------

create sequence property_reference_seq;

create table properties (
    id uuid primary key default gen_random_uuid(),
    reference_code text not null unique,
    title text not null,
    description text,
    property_type_id uuid references dictionary_items (id),
    listing_type listing_type not null default 'rent',
    owner_id uuid references users (id) on delete set null,
    organization_id uuid references organizations (id) on delete set null,
    price numeric(14, 2),
    currency text not null default 'TZS',
    bedrooms smallint,
    bathrooms smallint,
    size_sqm numeric(10, 2),
    address_line text,
    region_id uuid references dictionary_items (id),
    district_id uuid references dictionary_items (id),
    ward_id uuid references dictionary_items (id),
    location geography(Point, 4326),
    status property_status not null default 'draft',
    rejection_reason text,
    submitted_at timestamptz,
    reviewed_at timestamptz,
    reviewed_by text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint properties_title_not_blank check (length(btrim(title)) > 0),
    constraint properties_price_non_negative check (price is null or price >= 0),
    constraint properties_bedrooms_sane check (bedrooms is null or bedrooms between 0 and 100),
    constraint properties_bathrooms_sane check (bathrooms is null or bathrooms between 0 and 100),
    constraint properties_rejection_reason_required
        check (status not in ('rejected', 'changes_requested') or rejection_reason is not null),
    -- BR-001: nothing reaches the public without the mandatory data set
    constraint properties_publishable_data_complete
        check (
            status <> 'approved'
            or (price is not null and property_type_id is not null and region_id is not null and location is not null)
        ),

    -- full-text search maintained by the database, not the application
    search_vector tsvector generated always as (
        setweight(to_tsvector('simple', coalesce(title, '')), 'A')
        || setweight(to_tsvector('simple', coalesce(reference_code, '')), 'A')
        || setweight(to_tsvector('simple', coalesce(address_line, '')), 'B')
        || setweight(to_tsvector('simple', coalesce(description, '')), 'C')
    ) stored
);

create index idx_properties_status on properties (status);
create index idx_properties_owner on properties (owner_id);
create index idx_properties_organization on properties (organization_id);
create index idx_properties_region on properties (region_id);
create index idx_properties_search_vector on properties using gin (search_vector);
create index idx_properties_title_trgm on properties using gin (title gin_trgm_ops);
-- PostGIS spatial index: radius search is an index scan, not a table scan
create index idx_properties_location on properties using gist (location);

create table property_media (
    id uuid primary key default gen_random_uuid(),
    property_id uuid not null references properties (id) on delete cascade,
    url text not null,
    kind text not null default 'photo',
    position integer not null default 0,
    created_at timestamptz not null default now()
);

create index idx_property_media_property on property_media (property_id, position);

-- ---------------------------------------------------------------------------
-- Platform settings (versioned)
-- ---------------------------------------------------------------------------

create table settings (
    key text primary key,
    value jsonb not null,
    category text not null default 'general',
    description text,
    updated_by text,
    updated_at timestamptz not null default now()
);

create table settings_history (
    id uuid primary key default gen_random_uuid(),
    key text not null,
    old_value jsonb,
    new_value jsonb not null,
    changed_by text,
    changed_at timestamptz not null default now()
);

create index idx_settings_history_key on settings_history (key, changed_at desc);

-- ---------------------------------------------------------------------------
-- Audit log — written by triggers (003), never by the application
-- ---------------------------------------------------------------------------

create table audit_log (
    id bigserial primary key,
    table_name text not null,
    record_id text,
    operation audit_operation not null,
    actor text,
    old_data jsonb,
    new_data jsonb,
    changed_fields text[],
    created_at timestamptz not null default now()
);

create index idx_audit_log_table_record on audit_log (table_name, record_id, created_at desc);
create index idx_audit_log_created_at on audit_log (created_at desc);
create index idx_audit_log_actor on audit_log (actor, created_at desc);
