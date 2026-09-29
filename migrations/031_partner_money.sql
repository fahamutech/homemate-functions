-- Partner money and home summaries (partner roles, T06).
--
-- A broker sees what the tenant fee earned them (BRK-050–052); a landlord
-- sees rent and deposit coming to them, plus the fee share on homes they
-- listed themselves (LND-040/041). Both home screens open with counts and a
-- "Needs you" list (BRK-010, LND-010). Nothing here creates money: payouts
-- are still released by finance in the portal.

-- ---------------------------------------------------------------------------
-- What each split is for
-- ---------------------------------------------------------------------------

/*
 * checkoutSplits (src/shared/fees.mjs) writes one row per beneficiary: the
 * platform's and the agent's rows are shares of the tenant fee; the landlord's
 * row is everything else — on a checkout payment the deposit and first rent
 * (and, on a home nobody brokered, the fee share too), on a rent payment
 * recorded by hand the rent.
 */
alter table payment_splits
    add column component text,
    add constraint payment_splits_component_known
        check (component is null or component in ('fee_share', 'rent_and_deposit', 'rent', 'deposit', 'other'));

create or replace function payment_split_component(p_beneficiary beneficiary_type, p_payment uuid) returns text
language sql stable as $$
    select case
        when p_beneficiary <> 'landlord' then 'fee_share'
        when p.booking_id is not null then 'rent_and_deposit'
        when p.purpose in ('rent', 'advance_rent') then 'rent'
        when p.purpose = 'deposit' then 'deposit'
        else 'other'
    end
      from payments p where p.id = p_payment;
$$;

update payment_splits set component = payment_split_component(beneficiary_type, payment_id) where component is null;

create or replace function set_payment_split_component() returns trigger
language plpgsql as $$
begin
    if new.component is null then
        new.component := payment_split_component(new.beneficiary_type, new.payment_id);
    end if;
    return new;
end;
$$;

create trigger payment_splits_set_component before insert on payment_splits
    for each row execute function set_payment_split_component();

-- ---------------------------------------------------------------------------
-- A partner's earnings
-- ---------------------------------------------------------------------------

/*
 * One row per split to a person (never the platform's): what it is for, the
 * payment and home behind it, and the payout that claimed it. The state a
 * partner sees is derived from payment_status and payout_status by
 * earningState() in src/services/partner-app/earning-view.mjs.
 */
create or replace view v_partner_earnings as
select
    s.id,
    s.beneficiary_type,
    s.beneficiary_user_id,
    s.amount,
    s.percentage,
    s.component,
    p.currency,
    p.id as payment_id,
    p.reference as payment_reference,
    p.status as payment_status,
    p.purpose as payment_purpose,
    p.amount as payment_amount,
    p.created_at as payment_created_at,
    p.customer_declared_paid_at,
    p.confirmed_at as payment_confirmed_at,
    p.booking_id,
    prop.id as property_id,
    prop.title as property_title,
    (select m.id from property_media m where m.property_id = prop.id and m.is_cover limit 1) as cover_media_id,
    tenant.full_name as tenant_name,
    po.id as payout_id,
    po.reference as payout_reference,
    po.status as payout_status,
    po.hold_reason,
    po.failure_reason as payout_failure_reason,
    po.created_at as payout_created_at,
    po.paid_at as payout_paid_at
from payment_splits s
join payments p on p.id = s.payment_id
left join properties prop on prop.id = p.property_id
left join bookings b on b.id = p.booking_id
left join users tenant on tenant.id = coalesce(b.customer_id, p.payer_user_id)
left join payouts po on po.id = s.payout_id
where s.beneficiary_type <> 'platform';

-- ---------------------------------------------------------------------------
-- Home summaries
-- ---------------------------------------------------------------------------

/*
 * Payments on this person's splits a partner should hear about: being
 * checked (the tenant says they paid) or verified in the last week.
 */
create or replace function partner_payment_items(p_user uuid, p_type beneficiary_type) returns jsonb
language sql stable as $$
    select coalesce(jsonb_agg(item order by at desc), '[]'::jsonb) from (
        select jsonb_build_object(
                   'kind', case when e.payment_status = 'successful' then 'payment_verified' else 'payment_checking' end,
                   'title', case when e.payment_status = 'successful' then 'Payment verified' else 'Payment being checked' end,
                   'subtitle', coalesce(e.property_title, e.payment_reference),
                   'targetId', e.id
               ) as item,
               coalesce(e.payment_confirmed_at, e.customer_declared_paid_at) as at
          from v_partner_earnings e
         where e.beneficiary_user_id = p_user and e.beneficiary_type = p_type
           and ((e.payment_status = 'pending' and e.customer_declared_paid_at is not null)
                or (e.payment_status = 'successful' and e.payment_confirmed_at > now() - interval '7 days'))
    ) items;
$$;

create or replace function broker_summary(p_user uuid) returns jsonb
language sql stable as $$
    select jsonb_build_object(
        'counts', jsonb_build_object(
            'liveListings', (
                select count(*) from properties p
                  join property_parties pp on pp.property_id = p.id and pp.role = 'broker' and pp.is_primary
                 where pp.user_id = p_user and p.status = 'approved'),
            'openEnquiries', (
                select count(*) from v_partner_inquiries v
                 where v.broker_user_id = p_user and v.status in ('pending', 'responded')),
            'earnedThisMonth', (
                select coalesce(sum(e.amount), 0) from v_partner_earnings e
                 where e.beneficiary_user_id = p_user and e.beneficiary_type = 'broker'
                   and e.payment_status = 'successful'
                   and e.payment_confirmed_at >= date_trunc('month', now()))
        ),
        'needsYou',
            coalesce((
                select jsonb_agg(jsonb_build_object(
                           'kind', 'enquiry', 'title', 'New enquiry',
                           'subtitle', v.property_title || ' — ' || v.customer_name, 'targetId', v.id)
                           order by v.created_at)
                  from v_partner_inquiries v
                 where v.broker_user_id = p_user and v.status = 'pending'
            ), '[]'::jsonb)
            || coalesce((
                select jsonb_agg(jsonb_build_object(
                           'kind', 'listing_changes', 'title', 'Changes requested',
                           'subtitle', p.title, 'targetId', p.id)
                           order by p.reviewed_at)
                  from properties p
                  join property_parties pp on pp.property_id = p.id and pp.role = 'broker' and pp.is_primary
                 where pp.user_id = p_user and p.status = 'changes_requested'
            ), '[]'::jsonb)
            || partner_payment_items(p_user, 'broker')
    );
$$;

create or replace function landlord_summary(p_user uuid) returns jsonb
language sql stable as $$
    select jsonb_build_object(
        'counts', jsonb_build_object(
            'homes', (
                select count(*) from properties p
                  join property_parties pp on pp.property_id = p.id and pp.role = 'landlord' and pp.is_primary
                 where pp.user_id = p_user and p.status <> 'archived'),
            'let', (
                select count(distinct t.property_id) from v_tenancies t
                 where t.landlord_user_id = p_user and t.stage in ('moving_in', 'current')),
            'paidThisMonth', (
                select coalesce(sum(e.amount), 0) from v_partner_earnings e
                 where e.beneficiary_user_id = p_user and e.beneficiary_type = 'landlord'
                   and e.payment_status = 'successful'
                   and e.payment_confirmed_at >= date_trunc('month', now()))
        ),
        'needsYou',
            coalesce((
                select jsonb_agg(jsonb_build_object(
                           'kind', 'enquiry', 'title', 'New enquiry',
                           'subtitle', v.property_title || ' — ' || v.customer_name, 'targetId', v.id)
                           order by v.created_at)
                  from v_partner_inquiries v
                 where v.landlord_user_id = p_user and v.status = 'pending'
                   and partner_can_answer_inquiry(p_user, v.property_id)
            ), '[]'::jsonb)
            || coalesce((
                select jsonb_agg(jsonb_build_object(
                           'kind', 'confirm_listing', 'title', 'Confirm a listing of your home',
                           'subtitle', p.title, 'targetId', p.id)
                           order by pp.assigned_at)
                  from property_parties pp join properties p on p.id = pp.property_id
                 where pp.user_id = p_user and pp.role = 'landlord' and pp.is_primary
                   and pp.confirmation_status = 'pending' and p.status <> 'archived'
            ), '[]'::jsonb)
            || coalesce((
                select jsonb_agg(jsonb_build_object(
                           'kind', 'listing_changes', 'title', 'Changes requested',
                           'subtitle', p.title, 'targetId', p.id)
                           order by p.reviewed_at)
                  from properties p
                 where p.created_by_user_id = p_user and p.status = 'changes_requested'
                   and exists (select 1 from property_parties pp
                                where pp.property_id = p.id and pp.user_id = p_user
                                  and pp.role = 'landlord' and pp.is_primary)
            ), '[]'::jsonb)
            || coalesce((
                select jsonb_agg(jsonb_build_object(
                           'kind', 'move_in', 'title', 'Tenant moving in',
                           'subtitle', t.property_title || ' — ' || t.tenant_name, 'targetId', t.id)
                           order by t.lease_start_date)
                  from v_tenancies t
                 where t.landlord_user_id = p_user and t.stage = 'moving_in'
                   and (t.lease_start_date is null or t.lease_start_date <= current_date + 7)
            ), '[]'::jsonb)
            || partner_payment_items(p_user, 'landlord')
    );
$$;
