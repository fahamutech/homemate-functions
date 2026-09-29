-- Partner enquiries and landlord tenancies (partner roles, T05).
--
-- Brokers answer enquiries on the homes they listed; landlords answer on the
-- homes they listed themselves and can read — not answer — the rest
-- (BRK-040–042). Landlords see their tenancies and start and end them
-- (LND-030–033), which until now only the backoffice could do.

-- How and when a tenancy ended (the landlord's or the backoffice's "End tenancy").
alter table bookings
    add column ended_on date,
    add column end_reason text,
    add constraint bookings_ended_after_start
        check (ended_on is null or lease_start_date is null or ended_on >= lease_start_date);

-- ---------------------------------------------------------------------------
-- Who answers an enquiry
-- ---------------------------------------------------------------------------

/*
 * The listing broker answers. When nobody brokered the home, its landlord
 * does. Everyone else — including a landlord whose home a broker listed —
 * may at most read.
 */
create or replace function partner_can_answer_inquiry(p_user uuid, p_property uuid) returns boolean
language sql stable as $$
    select case
        when exists (select 1 from property_parties
                      where property_id = p_property and role = 'broker' and is_primary)
            then exists (select 1 from property_parties
                          where property_id = p_property and role = 'broker' and is_primary and user_id = p_user)
        else exists (select 1 from property_parties
                      where property_id = p_property and role = 'landlord' and is_primary and user_id = p_user)
    end;
$$;

/*
 * v_inquiries plus who is on the listing and whether the customer's identity
 * is verified. The partner service scopes rows to the caller's own listings
 * and hides the phone from anyone who cannot answer.
 */
create or replace view v_partner_inquiries as
select
    v.*,
    (select pp.user_id from property_parties pp
      where pp.property_id = v.property_id and pp.role = 'broker' and pp.is_primary) as broker_user_id,
    (select pp.user_id from property_parties pp
      where pp.property_id = v.property_id and pp.role = 'landlord' and pp.is_primary) as landlord_user_id,
    (c.kyc_status = 'verified') as customer_id_verified
from v_inquiries v
join users c on c.id = v.customer_id;

/*
 * The BRK-042 tracker for one enquiry: received → decision → payment →
 * verified → moved in → ended, each 'done' | 'current' | 'upcoming' |
 * 'blocked'. Payment verification confirms the booking (021), so "verified"
 * follows the money, not a person.
 */
create or replace function partner_inquiry_journey(p_inquiry uuid) returns jsonb
language sql stable as $$
with inquiry as (
    select * from property_inquiries where id = p_inquiry
),
booking as (
    select b.* from bookings b join inquiry i on b.inquiry_id = i.id
     where b.status not in ('cancelled', 'expired')
     order by b.created_at desc limit 1
),
declared as (
    select max(pay.customer_declared_paid_at) as at
      from payments pay join booking b on pay.booking_id = b.id
     where pay.status = 'pending' and pay.customer_declared_paid_at is not null
),
steps as (
    select 1 as ord, 'enquiry_received' as key, 'Enquiry received' as title, i.created_at as at, 'done' as state
      from inquiry i
    union all
    select 2, 'decision',
           case i.status
               when 'accepted' then 'Accepted'
               when 'rejected' then 'Declined'
               when 'withdrawn' then 'Withdrawn by the customer'
               when 'closed' then 'Closed'
               when 'responded' then 'Replied'
               else 'Waiting for your answer' end,
           i.responded_at,
           case when i.status in ('pending', 'responded') then 'current'
                when i.status in ('rejected', 'withdrawn', 'closed') then 'blocked'
                else 'done' end
      from inquiry i
    union all
    select 3, 'awaiting_payment', 'Customer to pay',
           coalesce(i.checkout_ready_at, i.responded_at),
           case when i.status <> 'accepted' then 'upcoming'
                when exists (select 1 from booking b where b.status in ('confirmed', 'active', 'completed')) then 'done'
                when exists (select 1 from declared d where d.at is not null) then 'done'
                else 'current' end
      from inquiry i
    union all
    select 4, 'payment_verified', 'Payment verified',
           (select b.confirmed_at from booking b),
           case when exists (select 1 from booking b where b.status in ('confirmed', 'active', 'completed')) then 'done'
                when exists (select 1 from declared d where d.at is not null) then 'current'
                else 'upcoming' end
      from inquiry i
    union all
    select 5, 'moved_in', 'Moved in',
           (select b.move_in_date::timestamptz from booking b where b.status in ('active', 'completed')),
           case when exists (select 1 from booking b where b.status in ('active', 'completed')) then 'done'
                when exists (select 1 from booking b where b.status = 'confirmed') then 'current'
                else 'upcoming' end
      from inquiry i
    union all
    select 6, 'ended', 'Tenancy ended',
           (select b.ended_on::timestamptz from booking b where b.status = 'completed'),
           case when exists (select 1 from booking b where b.status = 'completed') then 'done' else 'upcoming' end
      from inquiry i
)
select coalesce(
    jsonb_agg(jsonb_build_object('key', key, 'title', title, 'at', at, 'state', state) order by ord),
    '[]'::jsonb
) from steps;
$$;

-- ---------------------------------------------------------------------------
-- Tenancies: starting and ending, for the backoffice and the landlord alike
-- ---------------------------------------------------------------------------

/*
 * Moving in happens no earlier than a week before the lease starts, and on a
 * known day; a tenancy ends on a known day. Enforced here so the portal's
 * Rentals page and the landlord's app obey the same rule.
 */
create or replace function enforce_tenancy_dates() returns trigger
language plpgsql as $$
begin
    if new.status is not distinct from old.status then
        return new;
    end if;

    if new.status = 'active' then
        if new.move_in_date is null then
            raise exception 'Say which day the tenant moved in'
                using errcode = 'check_violation';
        end if;
        if new.lease_start_date is not null and new.move_in_date < new.lease_start_date - 7 then
            raise exception 'The move-in date can be at most 7 days before the lease starts (%)', new.lease_start_date
                using errcode = 'check_violation';
        end if;
    end if;

    if new.status = 'completed' and new.ended_on is null then
        raise exception 'Say which day the tenancy ended'
            using errcode = 'check_violation';
    end if;

    return new;
end;
$$;

create trigger bookings_enforce_tenancy_dates before update of status on bookings
    for each row execute function enforce_tenancy_dates();

/* True when the user is the primary landlord (or, failing that, the owner) of the booking's home. */
create or replace function landlord_owns_booking(p_user uuid, p_booking uuid) returns boolean
language sql stable as $$
    select exists (
        select 1 from bookings b
         where b.id = p_booking
           and (exists (select 1 from property_parties pp
                         where pp.property_id = b.property_id and pp.role = 'landlord'
                           and pp.is_primary and pp.user_id = p_user)
                or (not exists (select 1 from property_parties pp
                                 where pp.property_id = b.property_id and pp.role = 'landlord' and pp.is_primary)
                    and exists (select 1 from properties p where p.id = b.property_id and p.owner_id = p_user)))
    );
$$;

/*
 * A tenancy as its landlord sees it: v_active_rentals' columns for moving-in,
 * current and past tenancies, with the tenant and how the tenancy ended.
 */
create or replace view v_tenancies as
select
    b.id,
    b.reference,
    b.status,
    case b.status when 'confirmed' then 'moving_in' when 'active' then 'current' else 'past' end as stage,
    b.customer_id,
    b.customer_name as tenant_name,
    b.customer_phone as tenant_phone,
    b.property_id,
    b.property_title,
    b.property_address,
    b.property_reference,
    b.cover_media_id,
    b.monthly_rent,
    b.currency,
    b.deposit_amount,
    b.payment_frequency,
    b.lease_months,
    b.lease_start_date,
    b.lease_end_date,
    b.move_in_date,
    b.total_due,
    b.amount_paid,
    b.amount_outstanding,
    b.confirmed_at,
    bk.ended_on,
    bk.end_reason,
    prop.notice_period_days,
    case when b.status in ('confirmed', 'active') then next_rent_due(b.lease_start_date, b.lease_end_date) end
        as next_payment_date,
    case when b.status in ('confirmed', 'active') and b.lease_end_date is not null
         then greatest((extract(year from age(b.lease_end_date, current_date))::integer * 12)
                       + extract(month from age(b.lease_end_date, current_date))::integer, 0)
    end as months_remaining,
    case when b.lease_end_date is null or prop.notice_period_days is null then null
         else (b.lease_end_date - prop.notice_period_days)
    end as exit_window_opens_on,
    la.id as agreement_id,
    la.reference as agreement_reference,
    coalesce(
        (select pp.user_id from property_parties pp
          where pp.property_id = b.property_id and pp.role = 'landlord' and pp.is_primary),
        prop.owner_id
    ) as landlord_user_id
from v_bookings b
join bookings bk on bk.id = b.id
join properties prop on prop.id = b.property_id
left join lease_agreements la on la.booking_id = b.id
where b.status in ('confirmed', 'active', 'completed');

/* One landlord's tenancies, optionally by stage: moving_in | current | past. */
create or replace function landlord_tenancies(p_user uuid, p_stage text default null)
returns setof v_tenancies
language sql stable as $$
    select * from v_tenancies
     where landlord_user_id = p_user
       and (p_stage is null or stage = p_stage)
     order by case stage when 'moving_in' then 0 when 'current' then 1 else 2 end,
              coalesce(next_payment_date, lease_start_date) nulls last;
$$;
