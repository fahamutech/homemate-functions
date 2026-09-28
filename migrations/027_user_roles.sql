-- Multi-role accounts (partner roles, T01).
--
-- One person, one phone number, one PIN — and possibly several roles: a
-- customer who is also a broker and a landlord. `users.role` stays as it is
-- for staff and as the legacy "primary role"; what a phone-and-PIN account may
-- *act as* now lives in `user_roles`, one row per role, each with its own
-- lifecycle (a broker application can be pending while the customer role is
-- long active).
--
-- Agency is out of scope: the enum value and `users.role = 'agency'` keep
-- working exactly as before and never appear in `user_roles`.

create type partner_role_status as enum (
    'invited',          -- named by a broker as the landlord of a listing, not yet signed up
    'applied',          -- started an application
    'pending_review',   -- submitted, waiting for a moderator
    'active',
    'action_needed',    -- a moderator asked for something to be fixed
    'rejected',
    'suspended'
);

create table user_roles (
    user_id uuid not null references users (id) on delete cascade,
    role user_role not null,
    status partner_role_status not null,
    applied_at timestamptz,
    submitted_at timestamptz,
    activated_at timestamptz,
    reviewed_at timestamptz,
    reviewed_by text,
    rejection_reason text,
    agreement_version text,
    agreement_accepted_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    primary key (user_id, role),

    -- Staff keep using users.role; agency is not a partner role.
    constraint user_roles_platform_role check (role in ('customer', 'broker', 'landlord')),
    constraint user_roles_rejection_reason_required
        check ((status = 'rejected') = (rejection_reason is not null))
);

create index idx_user_roles_role_status on user_roles (role, status);

-- The role the app last opened in, so the next sign-in lands there (ROL-001).
alter table users add column last_active_role user_role;

-- ---------------------------------------------------------------------------
-- Keeping user_roles whole
-- ---------------------------------------------------------------------------

/*
 * Grants the roles implied by an account's legacy `users.role`: every
 * non-staff account is a customer, and a broker or landlord account also
 * holds that role, active. Never downgrades — a role that already has a row
 * (say, one an admin suspended) is left alone.
 */
create or replace function grant_legacy_user_roles(p_user uuid, p_role user_role) returns void
language sql as $$
    insert into user_roles (user_id, role, status, activated_at)
    select distinct p_user, granted.role, 'active'::partner_role_status, now()
      from (values ('customer'::user_role), (p_role)) as granted (role)
     where p_role not in ('moderator', 'manager', 'finance_auditor', 'admin')
       and granted.role in ('customer', 'broker', 'landlord')
    on conflict (user_id, role) do nothing;
$$;

/* Backfill for accounts created before 027. Idempotent; returns rows added. */
create or replace function backfill_user_roles() returns integer
language plpgsql as $$
declare
    v_before integer;
    v_after integer;
begin
    select count(*) into v_before from user_roles;
    perform grant_legacy_user_roles(u.id, u.role) from users u;
    select count(*) into v_after from user_roles;
    return v_after - v_before;
end;
$$;

select backfill_user_roles();

create or replace function sync_user_roles_from_legacy_role() returns trigger
language plpgsql as $$
begin
    perform grant_legacy_user_roles(new.id, new.role);
    return new;
end;
$$;

-- A platform user created without a user_roles row gets customer (active),
-- plus their legacy broker/landlord role; the backoffice promoting a user to
-- broker or landlord through users.role does the same.
create trigger users_sync_user_roles after insert or update of role on users
    for each row execute function sync_user_roles_from_legacy_role();

create trigger user_roles_set_updated_at before update on user_roles
    for each row execute function set_updated_at();

-- Audit after the backfill, so the migration does not write one row per user.
create trigger user_roles_audit after insert or update or delete on user_roles
    for each row execute function audit_row_change();

-- ---------------------------------------------------------------------------
-- Reading roles
-- ---------------------------------------------------------------------------

/* The roles an account may act in right now: customer, broker, landlord. */
create or replace function user_active_roles(p_user uuid) returns user_role[]
language sql stable as $$
    select coalesce(
               array_agg(role order by array_position(array['customer', 'broker', 'landlord']::user_role[], role)),
               '{}'::user_role[]
           )
      from user_roles
     where user_id = p_user
       and status = 'active';
$$;

-- ---------------------------------------------------------------------------
-- Property parties read partner roles from user_roles
-- ---------------------------------------------------------------------------

/*
 * Replaces the 006 version. The broker slot needs an *active* broker role;
 * the landlord slot accepts a landlord role that is invited, applied, pending
 * review or active, because a broker may list for a landlord they invited
 * (T04). An agency account still fills the landlord and agency slots through
 * users.role, unchanged.
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

    if new.role = 'landlord' and v_user_role <> 'agency' and not exists (
        select 1 from user_roles
         where user_id = new.user_id
           and role = 'landlord'
           and status in ('invited', 'applied', 'pending_review', 'active')
    ) then
        raise exception 'The landlord slot needs an account with a landlord role (invited, applied, pending review or active)'
            using errcode = 'check_violation';
    end if;

    if new.role = 'broker' and not exists (
        select 1 from user_roles
         where user_id = new.user_id
           and role = 'broker'
           and status = 'active'
    ) then
        raise exception 'The broker slot needs an account with an active broker role'
            using errcode = 'check_violation';
    end if;

    if new.role = 'agency' and v_user_role <> 'agency' then
        raise exception 'The agency slot needs an agency account, got %', v_user_role
            using errcode = 'check_violation';
    end if;

    return new;
end;
$$;
