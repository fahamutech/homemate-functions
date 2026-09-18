-- Database-enforced behaviour. Everything here would otherwise have to be
-- duplicated in every code path that touches these tables — putting it in the
-- database means a psql session, a migration or a future service all get the
-- same guarantees for free.

-- ---------------------------------------------------------------------------
-- Who is acting? Set per transaction by the app:  set local homemate.actor = '…'
-- ---------------------------------------------------------------------------

create or replace function current_actor() returns text
language sql stable as $$
    select nullif(current_setting('homemate.actor', true), '');
$$;

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------

create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

create trigger organizations_set_updated_at before update on organizations
    for each row execute function set_updated_at();
create trigger users_set_updated_at before update on users
    for each row execute function set_updated_at();
create trigger dictionary_items_set_updated_at before update on dictionary_items
    for each row execute function set_updated_at();
create trigger properties_set_updated_at before update on properties
    for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Generic row auditing
-- ---------------------------------------------------------------------------

create or replace function audit_row_change() returns trigger
language plpgsql as $$
declare
    v_old jsonb;
    v_new jsonb;
    v_changed text[];
    v_record_id text;
begin
    if tg_op = 'INSERT' then
        v_new := to_jsonb(new);
        v_record_id := v_new ->> 'id';
    elsif tg_op = 'DELETE' then
        v_old := to_jsonb(old);
        v_record_id := v_old ->> 'id';
    else
        v_old := to_jsonb(old);
        v_new := to_jsonb(new);
        v_record_id := v_new ->> 'id';
        select array_agg(key order by key) into v_changed
        from jsonb_each(v_new)
        where key not in ('updated_at', 'search_vector')
          and v_new -> key is distinct from v_old -> key;

        -- nothing of substance changed: don't write a noise row
        if v_changed is null then
            return new;
        end if;
    end if;

    insert into audit_log (table_name, record_id, operation, actor, old_data, new_data, changed_fields)
    values (tg_table_name, v_record_id, tg_op::audit_operation, current_actor(), v_old, v_new, v_changed);

    return coalesce(new, old);
end;
$$;

create trigger organizations_audit after insert or update or delete on organizations
    for each row execute function audit_row_change();
create trigger users_audit after insert or update or delete on users
    for each row execute function audit_row_change();
create trigger properties_audit after insert or update or delete on properties
    for each row execute function audit_row_change();
create trigger dictionary_items_audit after insert or update or delete on dictionary_items
    for each row execute function audit_row_change();
create trigger settings_audit after insert or update or delete on settings
    for each row execute function audit_row_change();

-- ---------------------------------------------------------------------------
-- Human-readable property reference codes (HM-P-000001)
-- ---------------------------------------------------------------------------

create or replace function assign_property_reference_code() returns trigger
language plpgsql as $$
begin
    if new.reference_code is null or length(btrim(new.reference_code)) = 0 then
        new.reference_code := 'HM-P-' || lpad(nextval('property_reference_seq')::text, 6, '0');
    end if;
    return new;
end;
$$;

create trigger properties_assign_reference_code before insert on properties
    for each row execute function assign_property_reference_code();

-- ---------------------------------------------------------------------------
-- Property lifecycle: only legal transitions, with review metadata stamped
-- automatically so no caller can "approve" without leaving a trace.
-- ---------------------------------------------------------------------------

create or replace function enforce_property_status_transition() returns trigger
language plpgsql as $$
declare
    v_allowed property_status[];
begin
    if new.status = old.status then
        return new;
    end if;

    v_allowed := case old.status
        when 'draft'             then array['pending_review', 'archived']::property_status[]
        when 'pending_review'    then array['approved', 'rejected', 'changes_requested', 'archived']::property_status[]
        when 'changes_requested' then array['pending_review', 'archived']::property_status[]
        when 'rejected'          then array['pending_review', 'archived']::property_status[]
        when 'approved'          then array['suspended', 'archived']::property_status[]
        when 'suspended'         then array['approved', 'archived']::property_status[]
        when 'archived'          then array[]::property_status[]
    end;

    if not (new.status = any (v_allowed)) then
        raise exception 'Illegal property status transition: % -> %', old.status, new.status
            using errcode = 'check_violation';
    end if;

    if new.status = 'pending_review' then
        new.submitted_at := now();
    end if;

    if new.status in ('approved', 'rejected', 'changes_requested', 'suspended') then
        new.reviewed_at := now();
        new.reviewed_by := coalesce(current_actor(), new.reviewed_by);
    end if;

    -- leaving a rejection state clears the stale reason
    if new.status not in ('rejected', 'changes_requested') then
        new.rejection_reason := null;
    end if;

    return new;
end;
$$;

create trigger properties_enforce_status_transition before update of status on properties
    for each row execute function enforce_property_status_transition();

-- ---------------------------------------------------------------------------
-- Organization lifecycle
-- ---------------------------------------------------------------------------

create or replace function enforce_organization_status_transition() returns trigger
language plpgsql as $$
declare
    v_allowed organization_status[];
begin
    if new.status = old.status then
        return new;
    end if;

    v_allowed := case old.status
        when 'pending'   then array['active', 'rejected']::organization_status[]
        when 'active'    then array['suspended']::organization_status[]
        when 'suspended' then array['active']::organization_status[]
        when 'rejected'  then array['pending']::organization_status[]
    end;

    if not (new.status = any (v_allowed)) then
        raise exception 'Illegal organization status transition: % -> %', old.status, new.status
            using errcode = 'check_violation';
    end if;

    if new.status = 'active' then
        new.verified_at := now();
        new.verified_by := coalesce(current_actor(), new.verified_by);
        new.rejection_reason := null;
    end if;

    return new;
end;
$$;

create trigger organizations_enforce_status_transition before update of status on organizations
    for each row execute function enforce_organization_status_transition();

-- ---------------------------------------------------------------------------
-- User lifecycle
-- ---------------------------------------------------------------------------

create or replace function enforce_user_status_transition() returns trigger
language plpgsql as $$
declare
    v_allowed user_status[];
begin
    if new.status = old.status then
        return new;
    end if;

    v_allowed := case old.status
        when 'pending'      then array['active', 'deactivated']::user_status[]
        when 'active'       then array['suspended', 'deactivated']::user_status[]
        when 'suspended'    then array['active', 'deactivated']::user_status[]
        when 'deactivated'  then array['active']::user_status[]
    end;

    if not (new.status = any (v_allowed)) then
        raise exception 'Illegal user status transition: % -> %', old.status, new.status
            using errcode = 'check_violation';
    end if;

    if new.status <> 'suspended' then
        new.suspension_reason := null;
    end if;

    return new;
end;
$$;

create trigger users_enforce_status_transition before update of status on users
    for each row execute function enforce_user_status_transition();

-- ---------------------------------------------------------------------------
-- Staff/platform separation: an agency-scoped role must belong to an org,
-- and staff roles must not be scoped to a tenant organization.
-- ---------------------------------------------------------------------------

create or replace function enforce_user_role_scope() returns trigger
language plpgsql as $$
begin
    if new.role in ('moderator', 'manager', 'finance_auditor', 'admin') and new.organization_id is not null then
        raise exception 'Backoffice staff (%) cannot be scoped to an organization', new.role
            using errcode = 'check_violation';
    end if;

    if new.role = 'agency' and new.organization_id is null then
        raise exception 'An agency user must belong to an organization'
            using errcode = 'check_violation';
    end if;

    return new;
end;
$$;

create trigger users_enforce_role_scope before insert or update of role, organization_id on users
    for each row execute function enforce_user_role_scope();

-- ---------------------------------------------------------------------------
-- Settings versioning
-- ---------------------------------------------------------------------------

create or replace function record_setting_history() returns trigger
language plpgsql as $$
begin
    if tg_op = 'UPDATE' and new.value is not distinct from old.value then
        return new;
    end if;

    new.updated_at := now();
    new.updated_by := coalesce(current_actor(), new.updated_by);

    insert into settings_history (key, old_value, new_value, changed_by)
    values (new.key, case when tg_op = 'UPDATE' then old.value end, new.value, current_actor());

    return new;
end;
$$;

create trigger settings_record_history before insert or update on settings
    for each row execute function record_setting_history();

-- ---------------------------------------------------------------------------
-- Dictionary integrity: a ward must hang off a district, a district off a
-- region. Keeps the geography tree from being wired up incorrectly.
-- ---------------------------------------------------------------------------

create or replace function enforce_dictionary_hierarchy() returns trigger
language plpgsql as $$
declare
    v_parent_category text;
    v_required_parent text;
begin
    v_required_parent := case new.category
        when 'district' then 'region'
        when 'ward' then 'district'
        else null
    end;

    if v_required_parent is null then
        return new;
    end if;

    if new.parent_id is null then
        raise exception 'A % must have a % parent', new.category, v_required_parent
            using errcode = 'check_violation';
    end if;

    select category into v_parent_category from dictionary_items where id = new.parent_id;

    if v_parent_category is distinct from v_required_parent then
        raise exception 'A % must have a % parent, got %', new.category, v_required_parent, v_parent_category
            using errcode = 'check_violation';
    end if;

    return new;
end;
$$;

create trigger dictionary_items_enforce_hierarchy before insert or update on dictionary_items
    for each row execute function enforce_dictionary_hierarchy();
