-- What a customer actually does in the app: ask about a place, arrange to see
-- it, book it, pay for it, and keep track of all of that.
--
-- These reuse the existing property/user/payment tables rather than shadowing
-- them: an inquiry points at a property and a customer, a booking becomes the
-- thing a payment is for, and settlement stays on the rails built in 009.

create type inquiry_status as enum ('pending', 'responded', 'accepted', 'rejected', 'withdrawn', 'closed');
create type viewing_status as enum ('requested', 'confirmed', 'rescheduled', 'completed', 'cancelled', 'no_show');
create type booking_status as enum ('pending', 'awaiting_payment', 'confirmed', 'active', 'completed', 'cancelled', 'expired');
create type notification_kind as enum (
    'inquiry_response', 'viewing_confirmed', 'viewing_reminder', 'booking_update',
    'payment_due', 'payment_received', 'kyc_update', 'system'
);

-- ---------------------------------------------------------------------------
-- A. Inquiries — CUS-007a..f
-- ---------------------------------------------------------------------------

create table property_inquiries (
    id uuid primary key default gen_random_uuid(),
    reference text not null unique,
    property_id uuid not null references properties (id) on delete cascade,
    customer_id uuid not null references users (id) on delete cascade,
    status inquiry_status not null default 'pending',
    message text not null,
    -- what the customer said they want, captured on the inquiry form
    move_in_date date,
    budget_amount numeric(14, 2),
    occupants smallint,
    contact_preference text,
    preferred_contact_time text,
    response text,
    responded_at timestamptz,
    responded_by uuid references users (id) on delete set null,
    rejection_reason text,
    closed_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint property_inquiries_message_not_blank check (length(btrim(message)) > 0),
    constraint property_inquiries_rejection_reason_required
        check ((status = 'rejected') = (rejection_reason is not null)),
    constraint property_inquiries_occupants_sane check (occupants is null or occupants between 1 and 30),
    constraint property_inquiries_budget_non_negative check (budget_amount is null or budget_amount >= 0),
    constraint property_inquiries_contact_preference_known
        check (contact_preference is null or contact_preference in ('phone', 'sms', 'whatsapp', 'email', 'in_app'))
);

create index idx_property_inquiries_customer on property_inquiries (customer_id, created_at desc);
create index idx_property_inquiries_property on property_inquiries (property_id, created_at desc);
create index idx_property_inquiries_status on property_inquiries (status, created_at desc);

-- One open inquiry per customer per property: asking twice is a follow-up on
-- the same conversation, not a second thread for an agent to answer twice.
create unique index property_inquiries_one_open_per_customer
    on property_inquiries (property_id, customer_id)
    where status in ('pending', 'responded');

create trigger property_inquiries_set_updated_at before update on property_inquiries
    for each row execute function set_updated_at();
create trigger property_inquiries_audit after insert or update or delete on property_inquiries
    for each row execute function audit_row_change();

create sequence inquiry_reference_seq;

create or replace function assign_inquiry_reference() returns trigger
language plpgsql as $$
begin
    if new.reference is null or length(btrim(new.reference)) = 0 then
        new.reference := 'HM-INQ-' || lpad(nextval('inquiry_reference_seq')::text, 6, '0');
    end if;
    return new;
end;
$$;

create trigger property_inquiries_assign_reference before insert on property_inquiries
    for each row execute function assign_inquiry_reference();

/*
 * An answer is what moves an inquiry on, so the stamp belongs to the write
 * that carries it rather than to whoever remembers to set it.
 */
create or replace function stamp_inquiry_response() returns trigger
language plpgsql as $$
begin
    if new.status is distinct from old.status
       and new.status in ('responded', 'accepted', 'rejected') then
        new.responded_at := coalesce(new.responded_at, now());
    end if;
    if new.status in ('closed', 'withdrawn') then
        new.closed_at := coalesce(new.closed_at, now());
    end if;
    if new.status <> 'rejected' then
        new.rejection_reason := null;
    end if;
    return new;
end;
$$;

create trigger property_inquiries_stamp_response before update of status on property_inquiries
    for each row execute function stamp_inquiry_response();

-- ---------------------------------------------------------------------------
-- B. Viewings — CUS-009a/b, CUS-010a..d
-- ---------------------------------------------------------------------------

create table property_viewings (
    id uuid primary key default gen_random_uuid(),
    reference text not null unique,
    property_id uuid not null references properties (id) on delete cascade,
    customer_id uuid not null references users (id) on delete cascade,
    inquiry_id uuid references property_inquiries (id) on delete set null,
    status viewing_status not null default 'requested',
    scheduled_for timestamptz not null,
    duration_minutes smallint not null default 30,
    host_id uuid references users (id) on delete set null,
    meeting_point text,
    customer_note text,
    host_note text,
    cancellation_reason text,
    confirmed_at timestamptz,
    completed_at timestamptz,
    cancelled_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint property_viewings_duration_sane check (duration_minutes between 15 and 240),
    constraint property_viewings_cancellation_reason_required
        check ((status = 'cancelled') = (cancellation_reason is not null))
);

create index idx_property_viewings_customer on property_viewings (customer_id, scheduled_for desc);
create index idx_property_viewings_property on property_viewings (property_id, scheduled_for desc);
create index idx_property_viewings_upcoming on property_viewings (scheduled_for) where status in ('requested', 'confirmed');

create trigger property_viewings_set_updated_at before update on property_viewings
    for each row execute function set_updated_at();
create trigger property_viewings_audit after insert or update or delete on property_viewings
    for each row execute function audit_row_change();

create sequence viewing_reference_seq;

create or replace function assign_viewing_reference() returns trigger
language plpgsql as $$
begin
    if new.reference is null or length(btrim(new.reference)) = 0 then
        new.reference := 'HM-VW-' || lpad(nextval('viewing_reference_seq')::text, 6, '0');
    end if;
    return new;
end;
$$;

create trigger property_viewings_assign_reference before insert on property_viewings
    for each row execute function assign_viewing_reference();

-- A viewing may not be booked for a time that has already passed.
create or replace function enforce_viewing_in_future() returns trigger
language plpgsql as $$
begin
    if tg_op = 'INSERT' and new.scheduled_for < now() then
        raise exception 'A viewing cannot be scheduled in the past'
            using errcode = 'check_violation',
                  hint = 'Pick a date and time from today onwards.';
    end if;
    return new;
end;
$$;

create trigger property_viewings_enforce_future before insert on property_viewings
    for each row execute function enforce_viewing_in_future();

create or replace function enforce_viewing_status_transition() returns trigger
language plpgsql as $$
declare
    v_allowed viewing_status[];
begin
    if new.status = old.status then
        return new;
    end if;

    v_allowed := case old.status
        when 'requested'   then array['confirmed', 'rescheduled', 'cancelled']::viewing_status[]
        when 'confirmed'   then array['completed', 'rescheduled', 'cancelled', 'no_show']::viewing_status[]
        when 'rescheduled' then array['confirmed', 'cancelled']::viewing_status[]
        when 'completed'   then array[]::viewing_status[]
        when 'cancelled'   then array[]::viewing_status[]
        when 'no_show'     then array[]::viewing_status[]
    end;

    if not (new.status = any (v_allowed)) then
        raise exception 'Illegal viewing status transition: % -> %', old.status, new.status
            using errcode = 'check_violation';
    end if;

    if new.status = 'confirmed' then new.confirmed_at := now(); end if;
    if new.status = 'completed' then new.completed_at := now(); end if;
    if new.status = 'cancelled' then new.cancelled_at := now(); end if;
    if new.status <> 'cancelled' then new.cancellation_reason := null; end if;

    return new;
end;
$$;

create trigger property_viewings_enforce_status before update of status on property_viewings
    for each row execute function enforce_viewing_status_transition();

-- ---------------------------------------------------------------------------
-- C. Bookings — CUS-010, CUS-011, CUS-012
-- ---------------------------------------------------------------------------

create table bookings (
    id uuid primary key default gen_random_uuid(),
    reference text not null unique,
    property_id uuid not null references properties (id) on delete restrict,
    customer_id uuid not null references users (id) on delete restrict,
    inquiry_id uuid references property_inquiries (id) on delete set null,
    viewing_id uuid references property_viewings (id) on delete set null,
    status booking_status not null default 'pending',
    -- the terms agreed, copied from the property at booking time so a later
    -- price change cannot rewrite what someone agreed to
    monthly_rent numeric(14, 2) not null,
    currency text not null default 'TZS',
    deposit_amount numeric(14, 2) not null default 0,
    advance_months numeric(4, 1) not null default 0,
    payment_frequency rent_payment_frequency not null default 'monthly',
    lease_months smallint,
    move_in_date date,
    lease_start_date date,
    lease_end_date date,
    total_due numeric(14, 2) not null,
    notes text,
    cancellation_reason text,
    confirmed_at timestamptz,
    cancelled_at timestamptz,
    expires_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint bookings_rent_positive check (monthly_rent > 0),
    constraint bookings_total_non_negative check (total_due >= 0),
    constraint bookings_deposit_non_negative check (deposit_amount >= 0),
    constraint bookings_lease_sane check (lease_months is null or lease_months between 1 and 120),
    constraint bookings_lease_range_sane
        check (lease_end_date is null or lease_start_date is null or lease_end_date > lease_start_date),
    constraint bookings_cancellation_reason_required
        check ((status = 'cancelled') = (cancellation_reason is not null))
);

create index idx_bookings_customer on bookings (customer_id, created_at desc);
create index idx_bookings_property on bookings (property_id, created_at desc);
create index idx_bookings_status on bookings (status, created_at desc);

-- A property can only be actively let to one customer at a time.
create unique index bookings_one_active_per_property
    on bookings (property_id)
    where status in ('confirmed', 'active');

create trigger bookings_set_updated_at before update on bookings
    for each row execute function set_updated_at();
create trigger bookings_audit after insert or update or delete on bookings
    for each row execute function audit_row_change();

create sequence booking_reference_seq;

create or replace function assign_booking_reference() returns trigger
language plpgsql as $$
begin
    if new.reference is null or length(btrim(new.reference)) = 0 then
        new.reference := 'HM-BK-' || lpad(nextval('booking_reference_seq')::text, 6, '0');
    end if;
    return new;
end;
$$;

create trigger bookings_assign_reference before insert on bookings
    for each row execute function assign_booking_reference();

create or replace function enforce_booking_status_transition() returns trigger
language plpgsql as $$
declare
    v_allowed booking_status[];
begin
    if new.status = old.status then
        return new;
    end if;

    v_allowed := case old.status
        when 'pending'          then array['awaiting_payment', 'cancelled', 'expired']::booking_status[]
        when 'awaiting_payment' then array['confirmed', 'cancelled', 'expired']::booking_status[]
        when 'confirmed'        then array['active', 'cancelled']::booking_status[]
        when 'active'           then array['completed', 'cancelled']::booking_status[]
        when 'completed'        then array[]::booking_status[]
        when 'cancelled'        then array[]::booking_status[]
        when 'expired'          then array['pending']::booking_status[]
    end;

    if not (new.status = any (v_allowed)) then
        raise exception 'Illegal booking status transition: % -> %', old.status, new.status
            using errcode = 'check_violation';
    end if;

    if new.status = 'confirmed' then new.confirmed_at := now(); end if;
    if new.status = 'cancelled' then new.cancelled_at := now(); end if;
    if new.status <> 'cancelled' then new.cancellation_reason := null; end if;

    return new;
end;
$$;

create trigger bookings_enforce_status before update of status on bookings
    for each row execute function enforce_booking_status_transition();

/*
 * A booking may only be confirmed once its money is actually in. Confirming
 * is what takes the property off the market, so letting it happen on a
 * customer's word alone would be the same mistake BR-005 exists to prevent.
 */
create or replace function enforce_booking_paid_before_confirm() returns trigger
language plpgsql as $$
declare
    v_settled numeric;
begin
    if new.status = 'confirmed' and old.status is distinct from 'confirmed' then
        select coalesce(sum(amount), 0) into v_settled
          from payments
         where booking_id = new.id and status = 'successful';

        if v_settled < new.total_due then
            raise exception 'This booking has % of % settled, so it cannot be confirmed yet', v_settled, new.total_due
                using errcode = 'check_violation',
                      hint = 'Verify the payment first; confirming follows settlement.';
        end if;
    end if;
    return new;
end;
$$;

-- Attached after `payments.booking_id` exists, below.

-- ---------------------------------------------------------------------------
-- D. Payments the customer can act on — CUS-014, CUS-015, CUS-016
-- ---------------------------------------------------------------------------

alter table payments
    add column booking_id uuid references bookings (id) on delete set null,
    -- the customer's own claim that they have paid; it settles nothing
    add column customer_declared_paid_at timestamptz,
    add column customer_declared_reference text,
    add column customer_declared_note text;

create index idx_payments_booking on payments (booking_id);
create index idx_payments_awaiting_verification on payments (customer_declared_paid_at)
    where customer_declared_paid_at is not null;

create trigger bookings_enforce_paid_before_confirm before update of status on bookings
    for each row execute function enforce_booking_paid_before_confirm();

/*
 * How to pay: the account number, the reference to quote, the name that will
 * appear. An operator fills this in from the portal and the app displays it
 * verbatim — the platform is not moving this money, it is telling the customer
 * where to send it, so the wording has to be exactly what was configured.
 */
create table payment_instructions (
    id uuid primary key default gen_random_uuid(),
    payment_id uuid not null references payments (id) on delete cascade,
    payment_method_id uuid references payment_methods (id),
    display_name text not null,
    account_name text,
    account_number text not null,
    payment_reference text not null,
    instructions text,
    amount numeric(14, 2),
    currency text not null default 'TZS',
    expires_at timestamptz,
    issued_by text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint payment_instructions_account_not_blank check (length(btrim(account_number)) > 0),
    constraint payment_instructions_reference_not_blank check (length(btrim(payment_reference)) > 0)
);

-- One live instruction per payment: two sets of numbers is how money gets
-- sent to the wrong place.
create unique index payment_instructions_one_per_payment on payment_instructions (payment_id);

create trigger payment_instructions_set_updated_at before update on payment_instructions
    for each row execute function set_updated_at();
create trigger payment_instructions_audit after insert or update or delete on payment_instructions
    for each row execute function audit_row_change();

-- ---------------------------------------------------------------------------
-- E. Saved properties, preferences, notifications — CUS-008b, CUS-013, CUS-020
-- ---------------------------------------------------------------------------

create table saved_properties (
    id uuid primary key default gen_random_uuid(),
    customer_id uuid not null references users (id) on delete cascade,
    property_id uuid not null references properties (id) on delete cascade,
    note text,
    created_at timestamptz not null default now(),

    constraint saved_properties_unique unique (customer_id, property_id)
);

create index idx_saved_properties_customer on saved_properties (customer_id, created_at desc);

create table customer_preferences (
    customer_id uuid primary key references users (id) on delete cascade,
    budget_min numeric(14, 2),
    budget_max numeric(14, 2),
    bedrooms_min smallint,
    preferred_region_id uuid references dictionary_items (id) on delete set null,
    preferred_district_ids uuid[] not null default '{}',
    property_type_ids uuid[] not null default '{}',
    amenity_ids uuid[] not null default '{}',
    furnishing furnishing_status,
    move_in_from date,
    notify_new_matches boolean not null default true,
    notify_price_drops boolean not null default true,
    notify_by_sms boolean not null default false,
    updated_at timestamptz not null default now(),

    constraint customer_preferences_budget_sane
        check (budget_max is null or budget_min is null or budget_max >= budget_min)
);

create trigger customer_preferences_set_updated_at before update on customer_preferences
    for each row execute function set_updated_at();

create table notifications (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users (id) on delete cascade,
    kind notification_kind not null default 'system',
    title text not null,
    body text,
    -- what to open when it is tapped
    subject_table text,
    subject_id uuid,
    read_at timestamptz,
    created_at timestamptz not null default now(),

    constraint notifications_title_not_blank check (length(btrim(title)) > 0)
);

create index idx_notifications_user on notifications (user_id, created_at desc);
create index idx_notifications_unread on notifications (user_id) where read_at is null;
