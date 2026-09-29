-- Partner listings and landlord confirmation (partner roles, T04).
--
-- Brokers and landlords list homes from the app with the same wizard the
-- backoffice form mirrors (BRK-030a–g). When a broker lists a home, its
-- landlord confirms it (LND-003) before it can go to review. The moderator
-- review itself is unchanged.

-- ---------------------------------------------------------------------------
-- Who created a listing, so "my listings" is a query and not a guess
-- ---------------------------------------------------------------------------

alter table properties add column created_by_user_id uuid references users (id) on delete set null;
create index idx_properties_created_by_user on properties (created_by_user_id) where created_by_user_id is not null;

-- ---------------------------------------------------------------------------
-- Landlord confirmation on a property party
-- ---------------------------------------------------------------------------

create type party_confirmation_status as enum ('not_required', 'pending', 'confirmed', 'disputed');

alter table property_parties
    add column confirmation_status party_confirmation_status not null default 'not_required',
    add column confirmed_at timestamptz,
    add column dispute_reason text,
    add constraint property_parties_dispute_reason_required
        check ((confirmation_status = 'disputed') = (dispute_reason is not null));

create index idx_property_parties_pending_confirmation on property_parties (user_id)
    where confirmation_status = 'pending';

/*
 * A home a broker lists from the app needs its landlord's say-so. Only
 * listings created in the partner app (created_by_user_id set) ask for it:
 * a listing the backoffice builds has been checked by staff already.
 *
 * Landlord added where a different broker is already a party → pending.
 */
create or replace function require_landlord_confirmation_on_landlord() returns trigger
language plpgsql as $$
begin
    if new.role = 'landlord' and new.confirmation_status = 'not_required'
       and exists (select 1 from properties p where p.id = new.property_id and p.created_by_user_id is not null)
       and exists (select 1 from property_parties b
                    where b.property_id = new.property_id and b.role = 'broker' and b.user_id <> new.user_id)
    then
        new.confirmation_status := 'pending';
    end if;
    return new;
end;
$$;

create trigger property_parties_require_landlord_confirmation before insert on property_parties
    for each row execute function require_landlord_confirmation_on_landlord();

/* Broker added where a different landlord is already a party → that landlord pending. */
create or replace function require_landlord_confirmation_on_broker() returns trigger
language plpgsql as $$
begin
    if new.role = 'broker' then
        update property_parties l
           set confirmation_status = 'pending'
          from properties p
         where p.id = new.property_id
           and p.created_by_user_id is not null
           and l.property_id = new.property_id
           and l.role = 'landlord'
           and l.user_id <> new.user_id
           and l.confirmation_status = 'not_required';
    end if;
    return new;
end;
$$;

create trigger property_parties_require_confirmation_after_broker after insert on property_parties
    for each row execute function require_landlord_confirmation_on_broker();

/* Confirming stamps the time; leaving `disputed` clears the reason. */
create or replace function stamp_party_confirmation() returns trigger
language plpgsql as $$
begin
    if new.confirmation_status is distinct from old.confirmation_status then
        new.confirmed_at := case when new.confirmation_status = 'confirmed' then now() end;
        if new.confirmation_status <> 'disputed' then
            new.dispute_reason := null;
        end if;
    end if;
    return new;
end;
$$;

create trigger property_parties_stamp_confirmation before update of confirmation_status on property_parties
    for each row execute function stamp_party_confirmation();

-- ---------------------------------------------------------------------------
-- The broker slot during drafting
-- ---------------------------------------------------------------------------

/*
 * Replaces the 027 version. An applicant broker may own drafts before HomeMate
 * approves them (T03 canDraftListings), so while a listing is still in the
 * broker's hands (draft / changes requested / rejected) the broker slot takes
 * a broker role that is applied, pending review, action needed or active.
 * Anywhere else it still needs an active one. Landlord and agency slots are
 * unchanged.
 */
create or replace function enforce_property_party_role() returns trigger
language plpgsql as $$
declare
    v_user_role user_role;
    v_property_status property_status;
    v_broker_statuses partner_role_status[];
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

    if new.role = 'broker' then
        select status into v_property_status from properties where id = new.property_id;
        v_broker_statuses := case
            when v_property_status in ('draft', 'changes_requested', 'rejected')
                then array['applied', 'pending_review', 'action_needed', 'active']::partner_role_status[]
            else array['active']::partner_role_status[]
        end;
        if not exists (
            select 1 from user_roles
             where user_id = new.user_id
               and role = 'broker'
               and status = any (v_broker_statuses)
        ) then
            raise exception 'The broker slot needs an account with an active broker role'
                using errcode = 'check_violation';
        end if;
    end if;

    if new.role = 'agency' and v_user_role <> 'agency' then
        raise exception 'The agency slot needs an agency account, got %', v_user_role
            using errcode = 'check_violation';
    end if;

    return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- BR-003: attribution is fixed once money has moved
-- ---------------------------------------------------------------------------

/*
 * The primary broker earns the fee on a property's payments. Once any payment
 * on the property is successful, who that broker is can no longer change —
 * not by reassigning, demoting, or removing them.
 */
create or replace function lock_primary_broker_after_payment() returns trigger
language plpgsql as $$
declare
    v_property uuid := coalesce(new.property_id, old.property_id);
    v_changes_primary boolean;
begin
    v_changes_primary := case tg_op
        when 'INSERT' then new.role = 'broker' and new.is_primary
        when 'DELETE' then old.role = 'broker' and old.is_primary
        else (old.role = 'broker' or new.role = 'broker')
             and (old.is_primary or new.is_primary)
             and (old.user_id, old.role, old.is_primary) is distinct from (new.user_id, new.role, new.is_primary)
    end;

    if v_changes_primary and exists (
        select 1 from payments where property_id = v_property and status = 'successful'
    ) then
        raise exception 'The primary broker cannot change once a payment on this property has succeeded (BR-003)'
            using errcode = 'check_violation';
    end if;

    return coalesce(new, old);
end;
$$;

create trigger property_parties_lock_primary_broker before insert or update or delete on property_parties
    for each row execute function lock_primary_broker_after_payment();

-- ---------------------------------------------------------------------------
-- Submitting a partner listing
-- ---------------------------------------------------------------------------

/*
 * The publish-guard for review: a listing cannot go to review while its
 * primary landlord has not confirmed it (or disputed it), nor while its
 * primary broker is not yet an approved broker.
 */
create or replace function enforce_listing_ready_for_review() returns trigger
language plpgsql as $$
declare
    v_confirmation party_confirmation_status;
begin
    if new.status is distinct from old.status and new.status = 'pending_review' then
        select confirmation_status into v_confirmation
          from property_parties
         where property_id = new.id and role = 'landlord' and is_primary;

        if v_confirmation = 'pending' then
            raise exception 'The landlord has not confirmed this listing yet'
                using errcode = 'check_violation';
        elsif v_confirmation = 'disputed' then
            raise exception 'The landlord disputed this listing'
                using errcode = 'check_violation';
        end if;

        if exists (
            select 1 from property_parties pp
             where pp.property_id = new.id and pp.role = 'broker' and pp.is_primary
               and not exists (select 1 from user_roles ur
                                where ur.user_id = pp.user_id and ur.role = 'broker' and ur.status = 'active')
        ) then
            raise exception 'The broker on this listing is not an approved broker yet'
                using errcode = 'check_violation';
        end if;
    end if;
    return new;
end;
$$;

create trigger properties_enforce_ready_for_review before update of status on properties
    for each row execute function enforce_listing_ready_for_review();

/*
 * Why a partner cannot submit this listing yet, as codes the app turns into
 * sentences (src/services/partner-app/listing-input.mjs). Empty = ready.
 * BR-001's data set, at least one photo, an active partner role, and — for a
 * broker's listing — a landlord who confirmed.
 */
create or replace function partner_listing_submit_blockers(p_property uuid, p_user uuid, p_role user_role)
returns text[]
language plpgsql stable as $$
declare
    v_property properties%rowtype;
    v_landlord property_parties%rowtype;
    v_blockers text[] := '{}';
begin
    select * into v_property from properties where id = p_property;
    if not found then
        return null;
    end if;

    if v_property.status not in ('draft', 'changes_requested') then
        v_blockers := v_blockers || 'wrong_status'::text;
    end if;
    if nullif(btrim(v_property.title), '') is null then v_blockers := v_blockers || 'missing_title'::text; end if;
    if v_property.price is null then v_blockers := v_blockers || 'missing_price'::text; end if;
    if v_property.property_type_id is null then v_blockers := v_blockers || 'missing_property_type'::text; end if;
    if v_property.region_id is null then v_blockers := v_blockers || 'missing_region'::text; end if;
    if v_property.location is null then v_blockers := v_blockers || 'missing_location'::text; end if;
    if not exists (select 1 from property_media where property_id = p_property and kind = 'photo') then
        v_blockers := v_blockers || 'no_photos'::text;
    end if;

    if not exists (select 1 from user_roles where user_id = p_user and role = p_role and status = 'active') then
        v_blockers := v_blockers || 'role_not_active'::text;
    end if;

    select * into v_landlord from property_parties
     where property_id = p_property and role = 'landlord' and is_primary;
    if not found then
        v_blockers := v_blockers || 'no_landlord'::text;
    elsif v_landlord.confirmation_status = 'pending' then
        v_blockers := v_blockers || 'landlord_pending'::text;
    elsif v_landlord.confirmation_status = 'disputed' then
        v_blockers := v_blockers || 'landlord_disputed'::text;
    end if;

    return v_blockers;
end;
$$;
