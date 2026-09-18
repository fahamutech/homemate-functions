-- Two related holes in the property lifecycle, closed at the database.
--
-- 1. A property could be INSERTed straight into a published state. The
--    transition trigger only fires on UPDATE, so that path skipped review
--    entirely: no submitted_at, no reviewed_by, and the audit log showed a
--    listing that was simply born approved. New properties may now only
--    start as draft or pending_review; reaching any other state has to go
--    through the transition trigger, which stamps and records it.
--
-- 2. The same applies to organizations and users: an account or agency may
--    not be INSERTed directly into a state that is supposed to be reached by
--    a reviewed transition.

create or replace function enforce_initial_property_status() returns trigger
language plpgsql as $$
begin
    if new.status not in ('draft', 'pending_review') then
        raise exception 'A new property must start as draft or pending_review, not %', new.status
            using errcode = 'check_violation',
                  hint = 'Create the listing first, then move it through review.';
    end if;
    return new;
end;
$$;

create trigger properties_enforce_initial_status before insert on properties
    for each row execute function enforce_initial_property_status();

create or replace function enforce_initial_organization_status() returns trigger
language plpgsql as $$
begin
    if new.status <> 'pending' then
        raise exception 'A new organization must start as pending, not %', new.status
            using errcode = 'check_violation',
                  hint = 'Register the organization, then approve or reject it.';
    end if;
    return new;
end;
$$;

create trigger organizations_enforce_initial_status before insert on organizations
    for each row execute function enforce_initial_organization_status();

create or replace function enforce_initial_user_status() returns trigger
language plpgsql as $$
begin
    if new.status not in ('pending', 'active') then
        raise exception 'A new user must start as pending or active, not %', new.status
            using errcode = 'check_violation';
    end if;
    return new;
end;
$$;

create trigger users_enforce_initial_status before insert on users
    for each row execute function enforce_initial_user_status();
