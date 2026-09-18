-- Full rental-ERP property model: party attribution (landlord / broker /
-- agency), amenities, the charges that sit alongside rent, lease and payment
-- terms, and richer media. Informed by the BRD/SRS (BR-002 property-vs-
-- listing, BR-003 immutable attribution) and by short/long-let marketplace
-- conventions (house rules, occupancy, min/max stay, deposits, notice).
--
-- As everywhere in this schema: rules that can be expressed as constraints or
-- triggers are, so they hold for every writer.

-- ---------------------------------------------------------------------------
-- Enumerated domains
-- ---------------------------------------------------------------------------

create type rent_payment_frequency as enum (
    'monthly',
    'quarterly',
    'semi_annual',
    'annual',
    'custom'
);

create type furnishing_status as enum ('unfurnished', 'semi_furnished', 'fully_furnished');

create type property_party_role as enum ('landlord', 'broker', 'agency');

create type charge_frequency as enum (
    'one_time',
    'monthly',
    'quarterly',
    'semi_annual',
    'annual',
    'per_use'
);

-- ---------------------------------------------------------------------------
-- Property: lease terms, payment terms and physical detail
-- ---------------------------------------------------------------------------

alter table properties
    add column furnishing furnishing_status not null default 'unfurnished',
    add column floor_number smallint,
    add column total_floors smallint,
    add column year_built smallint,
    add column parking_spaces smallint not null default 0,
    add column max_occupants smallint,
    add column pets_allowed boolean not null default false,
    add column smoking_allowed boolean not null default false,
    add column available_from date,
    add column min_lease_months smallint not null default 1,
    add column max_lease_months smallint,
    add column payment_frequency rent_payment_frequency not null default 'monthly',
    add column custom_payment_months smallint,
    add column deposit_months numeric(4, 1) not null default 0,
    add column advance_rent_months numeric(4, 1) not null default 0,
    add column notice_period_days smallint not null default 30,
    add column terms text,
    add column house_rules text;

alter table properties
    add constraint properties_custom_frequency_needs_months
        check ((payment_frequency = 'custom') = (custom_payment_months is not null)),
    add constraint properties_custom_months_sane
        check (custom_payment_months is null or custom_payment_months between 1 and 60),
    add constraint properties_lease_range_sane
        check (max_lease_months is null or max_lease_months >= min_lease_months),
    add constraint properties_min_lease_positive check (min_lease_months >= 1),
    add constraint properties_deposit_sane check (deposit_months >= 0 and deposit_months <= 24),
    add constraint properties_advance_sane check (advance_rent_months >= 0 and advance_rent_months <= 24),
    add constraint properties_floor_sane
        check (floor_number is null or total_floors is null or floor_number <= total_floors),
    add constraint properties_year_built_sane
        check (year_built is null or year_built between 1800 and extract(year from now())::smallint + 5);

-- How many months of rent each payment covers — used to derive the amount due
-- per instalment without every caller re-implementing the mapping.
create or replace function payment_frequency_months(
    p_frequency rent_payment_frequency,
    p_custom_months smallint default null
) returns smallint
language sql immutable as $$
    select case p_frequency
        when 'monthly' then 1::smallint
        when 'quarterly' then 3::smallint
        when 'semi_annual' then 6::smallint
        when 'annual' then 12::smallint
        when 'custom' then coalesce(p_custom_months, 1::smallint)
    end;
$$;

-- ---------------------------------------------------------------------------
-- Party attribution: who owns it, who sourced it, which agency manages it
-- ---------------------------------------------------------------------------

create table property_parties (
    id uuid primary key default gen_random_uuid(),
    property_id uuid not null references properties (id) on delete cascade,
    user_id uuid not null references users (id) on delete restrict,
    role property_party_role not null,
    commission_percentage numeric(5, 2),
    is_primary boolean not null default false,
    notes text,
    assigned_by text,
    assigned_at timestamptz not null default now(),

    constraint property_parties_unique unique (property_id, user_id, role),
    constraint property_parties_commission_sane
        check (commission_percentage is null or commission_percentage between 0 and 100)
);

create index idx_property_parties_property on property_parties (property_id);
create index idx_property_parties_user on property_parties (user_id);

-- Only one primary party per role per property.
create unique index property_parties_one_primary_per_role
    on property_parties (property_id, role) where is_primary;

/*
 * A party's platform role must match the slot they fill: a "landlord" party
 * has to be a landlord user, a "broker" party a broker, an "agency" party an
 * agency user. Without this an admin could quietly attribute a listing to a
 * customer account.
 */
create or replace function enforce_property_party_role() returns trigger
language plpgsql as $$
declare
    v_user_role user_role;
begin
    select role into v_user_role from users where id = new.user_id;

    if v_user_role is null then
        raise exception 'Unknown user %', new.user_id using errcode = 'foreign_key_violation';
    end if;

    if new.role = 'landlord' and v_user_role not in ('landlord', 'agency') then
        raise exception 'The landlord slot needs a landlord (or agency) account, got %', v_user_role
            using errcode = 'check_violation';
    end if;

    if new.role = 'broker' and v_user_role <> 'broker' then
        raise exception 'The broker slot needs a broker account, got %', v_user_role
            using errcode = 'check_violation';
    end if;

    if new.role = 'agency' and v_user_role <> 'agency' then
        raise exception 'The agency slot needs an agency account, got %', v_user_role
            using errcode = 'check_violation';
    end if;

    return new;
end;
$$;

create trigger property_parties_enforce_role before insert or update on property_parties
    for each row execute function enforce_property_party_role();

create trigger property_parties_audit after insert or update or delete on property_parties
    for each row execute function audit_row_change();

-- ---------------------------------------------------------------------------
-- Amenities
-- ---------------------------------------------------------------------------

create table property_amenities (
    property_id uuid not null references properties (id) on delete cascade,
    amenity_id uuid not null references dictionary_items (id) on delete restrict,
    primary key (property_id, amenity_id)
);

create index idx_property_amenities_amenity on property_amenities (amenity_id);

create or replace function enforce_amenity_category() returns trigger
language plpgsql as $$
declare
    v_category text;
begin
    select category into v_category from dictionary_items where id = new.amenity_id;
    if v_category is distinct from 'amenity' then
        raise exception 'Only dictionary items in the "amenity" category can be attached, got %', v_category
            using errcode = 'check_violation';
    end if;
    return new;
end;
$$;

create trigger property_amenities_enforce_category before insert or update on property_amenities
    for each row execute function enforce_amenity_category();

-- ---------------------------------------------------------------------------
-- Charges that sit alongside rent (service charge, water, garbage, deposit…)
-- ---------------------------------------------------------------------------

create table property_charges (
    id uuid primary key default gen_random_uuid(),
    property_id uuid not null references properties (id) on delete cascade,
    name text not null,
    amount numeric(14, 2) not null,
    currency text not null default 'TZS',
    frequency charge_frequency not null default 'monthly',
    is_mandatory boolean not null default true,
    is_refundable boolean not null default false,
    notes text,
    sort_order integer not null default 0,
    created_at timestamptz not null default now(),

    constraint property_charges_name_not_blank check (length(btrim(name)) > 0),
    constraint property_charges_amount_non_negative check (amount >= 0)
);

create index idx_property_charges_property on property_charges (property_id, sort_order);

create trigger property_charges_audit after insert or update or delete on property_charges
    for each row execute function audit_row_change();

-- Monthly-equivalent of a charge, so "total monthly cost" is computed one way.
create or replace function charge_monthly_equivalent(
    p_amount numeric,
    p_frequency charge_frequency
) returns numeric
language sql immutable as $$
    select case p_frequency
        when 'monthly' then p_amount
        when 'quarterly' then p_amount / 3
        when 'semi_annual' then p_amount / 6
        when 'annual' then p_amount / 12
        else 0  -- one_time and per_use are not part of the recurring monthly cost
    end;
$$;

-- ---------------------------------------------------------------------------
-- Media: originals plus their thumbnails, both produced as WebP by the client
-- ---------------------------------------------------------------------------

alter table property_media
    add column thumbnail_url text,
    add column content_type text not null default 'image/webp',
    add column size_bytes bigint,
    add column width integer,
    add column height integer,
    add column caption text,
    add column is_cover boolean not null default false;

create unique index property_media_one_cover
    on property_media (property_id) where is_cover;

/*
 * Setting a new cover clears the previous one, instead of failing on the
 * unique index and making every caller do a two-step dance.
 */
create or replace function enforce_single_cover_image() returns trigger
language plpgsql as $$
begin
    if new.is_cover then
        update property_media
           set is_cover = false
         where property_id = new.property_id
           and id <> new.id
           and is_cover;
    end if;
    return new;
end;
$$;

create trigger property_media_enforce_single_cover before insert or update of is_cover on property_media
    for each row execute function enforce_single_cover_image();

-- The first image uploaded for a property becomes its cover automatically.
create or replace function default_first_image_to_cover() returns trigger
language plpgsql as $$
begin
    if not exists (select 1 from property_media where property_id = new.property_id and id <> new.id) then
        new.is_cover := true;
    end if;
    return new;
end;
$$;

create trigger property_media_default_cover before insert on property_media
    for each row execute function default_first_image_to_cover();

-- ---------------------------------------------------------------------------
-- Payment methods (provider-agnostic; the adapter is chosen by `provider`)
-- ---------------------------------------------------------------------------

create type payment_method_kind as enum ('mobile_money', 'bank_transfer', 'card', 'cash', 'cheque');

create table payment_methods (
    id uuid primary key default gen_random_uuid(),
    code text not null unique,
    name text not null,
    kind payment_method_kind not null,
    provider text not null default 'sandbox',
    is_active boolean not null default false,
    instructions text,
    config jsonb not null default '{}'::jsonb,
    sort_order integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint payment_methods_name_not_blank check (length(btrim(name)) > 0)
);

create index idx_payment_methods_active on payment_methods (is_active, sort_order);

create trigger payment_methods_set_updated_at before update on payment_methods
    for each row execute function set_updated_at();

create trigger payment_methods_audit after insert or update or delete on payment_methods
    for each row execute function audit_row_change();

-- Which payment methods a specific property accepts (empty = all active ones).
create table property_payment_methods (
    property_id uuid not null references properties (id) on delete cascade,
    payment_method_id uuid not null references payment_methods (id) on delete cascade,
    primary key (property_id, payment_method_id)
);
