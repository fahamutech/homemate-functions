-- Backoffice support for partner roles (partner roles, T08).
--
-- Staff suspend and reactivate a person's broker or landlord role, pick
-- people for a listing by their T01 roles, see who listed a home and whether
-- its landlord confirmed it, and see which tenancy moves a landlord made.

-- Why a partner role was suspended; cleared on reactivation.
alter table user_roles
    add column suspension_reason text,
    add constraint user_roles_suspension_reason_only_when_suspended
        check (suspension_reason is null or status = 'suspended');

create or replace function clear_user_role_suspension_reason() returns trigger
language plpgsql as $$
begin
    if new.status <> 'suspended' then
        new.suspension_reason := null;
    end if;
    return new;
end;
$$;

create trigger user_roles_clear_suspension_reason before update of status on user_roles
    for each row execute function clear_user_role_suspension_reason();

/*
 * Who listed a home — the broker or landlord who created it in the app, or
 * the backoffice — and where its primary landlord's confirmation stands (029).
 */
create or replace view v_property_listing_meta as
select
    p.id as property_id,
    case
        when p.created_by_user_id is null then 'backoffice'
        when exists (select 1 from property_parties b
                      where b.property_id = p.id and b.role = 'broker' and b.is_primary
                        and b.user_id = p.created_by_user_id) then 'broker'
        else 'landlord'
    end as listed_by_kind,
    p.created_by_user_id as listed_by_user_id,
    creator.full_name as listed_by_name,
    coalesce(l.confirmation_status, 'not_required') as landlord_confirmation_status,
    l.dispute_reason as landlord_dispute_reason,
    l.confirmed_at as landlord_confirmed_at
from properties p
left join users creator on creator.id = p.created_by_user_id
left join property_parties l on l.property_id = p.id and l.role = 'landlord' and l.is_primary;

/*
 * A booking's status changes as the audit log recorded them, with who made
 * each one — and whether that was the home's landlord (T05) rather than staff.
 */
create or replace function booking_status_history(p_booking uuid) returns jsonb
language sql stable as $$
    select coalesce(jsonb_agg(jsonb_build_object(
               'status', a.new_data ->> 'status',
               'at', a.created_at,
               'actor', a.actor,
               -- staff actors are emails; only a user id can be the landlord
               'by_landlord', case
                   when a.actor ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                       then landlord_owns_booking(a.actor::uuid, p_booking)
                   else false
               end
           ) order by a.id), '[]'::jsonb)
      from audit_log a
     where a.table_name = 'bookings'
       and a.record_id = p_booking::text
       and (a.operation = 'INSERT' or 'status' = any (a.changed_fields));
$$;
