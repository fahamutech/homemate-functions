-- ---------------------------------------------------------------------------
-- One road to a home: enquire, get accepted, pay, have the payment verified.
--
-- Two product changes land together because they meet at checkout:
--
--   A. **Viewings are gone, and so is paying without asking.** The customer
--      journey is now enquiry → accepted → payment → verified. A property can
--      only be paid for once the landlord has accepted the customer's enquiry
--      (or a reservation for it is already under way). Viewings no longer
--      appear in any read model; the `property_viewings` table and its rows
--      are kept, untouched, as history — dropping them would destroy records
--      nothing needs to lose.
--
--   B. **The tenant fee.** An agent in this market customarily takes one
--      month's rent for finding a tenant. HomeMate charges a configured share
--      of that month instead (`commission.tenant_fee_percentage`), and keeps a
--      configured share *of the fee* (`commission.platform_percentage`) as the
--      listing commission. The fee is snapshotted onto the booking at checkout
--      so a later change of setting cannot rewrite what someone agreed to pay.
--
-- The arithmetic itself lives in `src/shared/fees.mjs`; this file only stores
-- its inputs and outputs.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Settings
-- ---------------------------------------------------------------------------

insert into settings (key, value, category, description) values
    ('commission.tenant_fee_percentage', '50'::jsonb, 'commission',
     'Tenant fee, as a percentage of one month''s rent, charged once in the first payment. The customer is shown the saving against the usual one-month agent fee.')
on conflict (key) do nothing;

update settings
   set description = 'HomeMate''s share of the tenant fee, as a percentage of the fee. The rest of the fee goes to the broker or agency that listed the property, or to the landlord when they listed it directly. Rent and deposits are never commissioned.'
 where key = 'commission.platform_percentage';

-- Superseded by the two settings above and never read by any code. Left in
-- place they would sit on the portal's settings screen looking authoritative.
delete from settings
 where key in ('commission.broker_percentage', 'commission.agency_split_percentage');

-- ---------------------------------------------------------------------------
-- 2. The fee, snapshotted on the booking
-- ---------------------------------------------------------------------------

alter table bookings
    add column service_fee numeric(14, 2) not null default 0,
    add column service_fee_percentage numeric(5, 2),
    add column platform_fee_percentage numeric(5, 2),
    add constraint bookings_service_fee_sane check (service_fee >= 0 and service_fee <= total_due);

-- Appended columns only: `create or replace view` may add at the end and
-- nowhere else, and every dependent view keeps working unchanged.
create or replace view v_bookings as
select
    b.id,
    b.reference,
    b.status,
    b.monthly_rent,
    b.currency,
    b.deposit_amount,
    b.advance_months,
    b.payment_frequency,
    b.lease_months,
    b.move_in_date,
    b.lease_start_date,
    b.lease_end_date,
    b.total_due,
    b.notes,
    b.cancellation_reason,
    b.confirmed_at,
    b.expires_at,
    b.created_at,
    b.inquiry_id,
    b.viewing_id,
    b.property_id,
    p.reference_code as property_reference,
    p.title as property_title,
    p.address_line as property_address,
    st_y(p.location::geometry) as property_latitude,
    st_x(p.location::geometry) as property_longitude,
    cover.id as cover_media_id,
    b.customer_id,
    c.full_name as customer_name,
    c.phone_number as customer_phone,
    owner.full_name as landlord_name,
    owner.phone_number as landlord_phone,
    coalesce(paid.settled, 0) as amount_paid,
    b.total_due - coalesce(paid.settled, 0) as amount_outstanding,
    coalesce(paid.awaiting, 0) as amount_awaiting_verification,
    paid.payment_count,
    b.service_fee,
    b.service_fee_percentage,
    b.platform_fee_percentage,
    round(b.service_fee * coalesce(b.platform_fee_percentage, 0) / 100, 2) as platform_fee
from bookings b
join properties p on p.id = b.property_id
join users c on c.id = b.customer_id
left join users owner on owner.id = p.owner_id
left join lateral (
    select m.id from property_media m
     where m.property_id = p.id
     order by m.is_cover desc, m.position
     limit 1
) cover on true
left join lateral (
    select
        coalesce(sum(amount) filter (where status = 'successful'), 0) as settled,
        coalesce(sum(amount) filter (where status = 'pending' and customer_declared_paid_at is not null), 0) as awaiting,
        count(*) as payment_count
      from payments where booking_id = b.id
) paid on true;

-- ---------------------------------------------------------------------------
-- 3. Checkout is gated on an accepted enquiry
-- ---------------------------------------------------------------------------

/*
 * The single answer behind every "Pay now" button. There is now exactly one
 * way in: the landlord accepted the customer's enquiry. A reservation already
 * under way also counts, so a customer who closed the app mid-payment can
 * come back to it.
 *
 * `route` says why, and the app puts it above the button:
 *   booking            a reservation exists — continue paying for it
 *   inquiry_accepted   the landlord said yes — pay to secure it
 *   inquiry_pending    still with the landlord — nothing to pay yet
 *   blocked            the landlord declined
 *   no_inquiry         enquire first
 */
create or replace function customer_checkout_eligibility(
    p_customer_id uuid,
    p_property_id uuid
)
returns jsonb
language sql stable as $$
    with prop as (
        select id, status, price from properties where id = p_property_id
    ),
    inquiry as (
        select * from property_inquiries
         where customer_id = p_customer_id and property_id = p_property_id
         order by created_at desc limit 1
    ),
    booking as (
        select * from bookings
         where customer_id = p_customer_id and property_id = p_property_id
           and status in ('pending', 'awaiting_payment', 'confirmed', 'active')
         order by created_at desc limit 1
    ),
    letting as (
        select customer_id from bookings
         where property_id = p_property_id and status in ('confirmed', 'active')
         limit 1
    ),
    hold as (
        select * from v_property_holds
         where property_id = p_property_id and is_live
         limit 1
    )
    select jsonb_build_object(
        'propertyId', p_property_id,
        'available', coalesce(
            (select status from prop) = 'approved'
            and not exists (select 1 from letting where customer_id <> p_customer_id)
        , false),
        'canPay', coalesce(
            (select status from prop) = 'approved'
            and coalesce((select price from prop), 0) > 0
            and not exists (select 1 from letting where customer_id <> p_customer_id)
            and (
                exists (select 1 from booking)
                or (select status from inquiry) = 'accepted'
            )
        , false),
        'route', case
            when exists (select 1 from booking) then 'booking'
            when (select status from inquiry) = 'accepted' then 'inquiry_accepted'
            when (select status from inquiry) = 'rejected' then 'blocked'
            when (select status from inquiry) in ('pending', 'responded') then 'inquiry_pending'
            else 'no_inquiry'
        end,
        'inquiryId', (select id from inquiry),
        'inquiryStatus', (select status from inquiry),
        'bookingId', (select id from booking),
        'heldByMe', coalesce((select customer_id from hold) = p_customer_id, false),
        'heldByOther', coalesce((select customer_id from hold) <> p_customer_id, false),
        'holdSecondsRemaining', (select seconds_remaining from hold),
        'holdId', (select id from hold where customer_id = p_customer_id)
    );
$$;

-- ---------------------------------------------------------------------------
-- 4. Read models without viewings
-- ---------------------------------------------------------------------------

/*
 * The timeline for one customer on one property: enquiry, documents, the
 * landlord's decision, payment, verification, and the lease. Reproduced from
 * 020 with the viewing step removed and the payment step renamed for what it
 * now is — securing the home the landlord accepted you for.
 */
create or replace function customer_property_journey(
    p_customer_id uuid,
    p_property_id uuid
)
returns jsonb
language sql stable as $$
with inquiry as (
    select * from property_inquiries
     where customer_id = p_customer_id and property_id = p_property_id
     order by created_at desc limit 1
),
booking as (
    select * from v_bookings
     where customer_id = p_customer_id and property_id = p_property_id
       and status <> 'cancelled'
     order by created_at desc limit 1
),
kyc as (
    select kyc_status, kyc_reviewed_at from users where id = p_customer_id
),
events as (
    select 1 as ord, 'inquiry_submitted' as key, 'Enquiry Submitted' as title,
           i.created_at as at, 'done' as state,
           'You submitted an enquiry for this property' as detail
      from inquiry i

    union all
    select 2, 'documents',
           case when k.kyc_status = 'verified' then 'Documents Verified' else 'Documents Uploaded' end,
           coalesce(k.kyc_reviewed_at, i.created_at),
           case when k.kyc_status = 'verified' then 'done' else 'current' end,
           case when k.kyc_status = 'verified'
                then 'Your documents were reviewed and approved'
                else 'Your verification documents are being checked' end
      from inquiry i cross join kyc k
     where k.kyc_status <> 'not_started'

    union all
    select 3, 'landlord_decision',
           case i.status
               when 'accepted' then 'Landlord Approved'
               when 'rejected' then 'Enquiry Declined'
               when 'withdrawn' then 'Enquiry Withdrawn'
               else 'Under Review' end,
           coalesce(i.responded_at, i.created_at),
           case when i.status = 'rejected' then 'blocked'
                when i.status in ('accepted', 'withdrawn', 'closed') then 'done'
                else 'current' end,
           case i.status
               when 'accepted' then 'The landlord accepted your application'
               when 'rejected' then coalesce(i.rejection_reason, 'The landlord declined this application')
               when 'withdrawn' then 'You withdrew this enquiry'
               else 'The landlord is reviewing your application' end
      from inquiry i

    union all
    select 5, 'awaiting_payment', 'Awaiting Payment',
           coalesce(i.checkout_ready_at, i.responded_at, i.created_at),
           'current',
           'Pay to secure this home'
      from inquiry i
     where i.status = 'accepted'
       and not exists (select 1 from booking)

    union all
    select 7, 'payment_' || pay.id::text,
           case when pay.status = 'successful' then 'Payment Verified'
                when pay.status = 'failed' then 'Payment Failed'
                when pay.customer_declared_paid_at is not null then 'Payment Being Verified'
                else 'Payment Started' end,
           coalesce(pay.confirmed_at, pay.customer_declared_paid_at, pay.created_at),
           case when pay.status = 'successful' then 'done'
                when pay.status = 'failed' then 'blocked'
                else 'current' end,
           to_char(pay.amount, 'FM999,999,999,990') || ' ' || pay.currency
               || coalesce(' via ' || pay.payment_method_name, '')
               || '. Receipt ' || pay.reference
      from v_customer_payments pay
      join booking b on b.id = pay.booking_id

    union all
    select 8, 'lease_started', 'Lease Started', b.lease_start_date::timestamptz,
           case when b.lease_start_date <= current_date then 'done' else 'upcoming' end,
           'Active tenancy at ' || b.property_title
               || coalesce('. ' || b.lease_months::text || '-month term.', '')
      from booking b
     where b.lease_start_date is not null

    union all
    select 9, 'next_rent', 'Next Rent Due',
           next_rent_due(b.lease_start_date, b.lease_end_date)::timestamptz,
           'upcoming',
           to_char(b.monthly_rent, 'FM999,999,999,990') || ' ' || b.currency || ' monthly rent payment'
      from booking b
     where b.status in ('confirmed', 'active')
       and next_rent_due(b.lease_start_date, b.lease_end_date) is not null

    union all
    select 10, 'renewal', 'Renewal Decision Due',
           (b.lease_end_date - coalesce(prop.notice_period_days, 60))::timestamptz,
           'upcoming',
           'Lease renewal window opens. Review terms or report planned exit.'
      from booking b
      join properties prop on prop.id = b.property_id
     where b.status in ('confirmed', 'active') and b.lease_end_date is not null
)
select coalesce(
    jsonb_agg(jsonb_build_object(
        'key', key,
        'title', title,
        'at', at,
        'state', state,
        'detail', detail
    ) order by at desc, ord desc),
    '[]'::jsonb
) from events where at is not null;
$$;

/*
 * Where an enquiry stands, in the customer's terms, now that it carries the
 * whole journey: the landlord's answer and then the money.
 */
create or replace function enquiry_display_status(p_inquiry_id uuid, p_status text)
returns text
language sql stable as $$
    select case
        when exists (
            select 1 from bookings b
             where b.inquiry_id = p_inquiry_id
               and b.status in ('confirmed', 'active', 'completed')
        ) then 'paid'
        when exists (
            select 1 from bookings b join payments pay on pay.booking_id = b.id
             where b.inquiry_id = p_inquiry_id
               and pay.status = 'pending' and pay.customer_declared_paid_at is not null
        ) then 'awaiting_verification'
        when p_status = 'accepted' then 'awaiting_payment'
        else p_status
    end;
$$;

/*
 * The Favourites tab: active rents, saved homes, recent enquiries. The fourth
 * section (upcoming viewings) is gone. Otherwise reproduced from 022.
 *
 * An accepted enquiry reads "awaiting payment" until its payment is being
 * verified, then "payment being verified", then "paid" once it settles — the
 * enquiry is now the whole journey, so its chip has to follow the money.
 */
create or replace function customer_saved_overview(
    p_customer_id uuid,
    p_section_limit integer default 6
)
returns jsonb
language sql stable as $$
    select jsonb_build_object(
        'activeRentals', coalesce((
            select jsonb_agg(r order by r.next_payment_date nulls last)
              from (
                select id, reference, property_id, property_title, property_address,
                       cover_media_id, monthly_rent, currency, next_payment_date,
                       lease_start_date, lease_end_date, days_remaining, months_remaining,
                       status
                  from v_active_rentals
                 where customer_id = p_customer_id
                 order by next_payment_date nulls last
                 limit p_section_limit
              ) r
        ), '[]'::jsonb),

        'activeRentalCount', (
            select count(*) from v_active_rentals where customer_id = p_customer_id
        ),

        'favorites', coalesce((
            select jsonb_agg(f order by f.saved_at desc)
              from (
                select p.id, p.reference_code, p.title, p.price, p.currency,
                       p.bedrooms, p.bathrooms, p.size_sqm, p.address_line,
                       p.region_name, p.district_name, p.ward_name,
                       p.property_type_name, p.furnishing,
                       p.latitude,
                       p.longitude,
                       (select m.id from property_media m
                         where m.property_id = p.id
                         order by m.is_cover desc, m.position limit 1) as cover_media_id,
                       s.created_at as saved_at
                  from saved_properties s
                  join v_properties p on p.id = s.property_id
                 where s.customer_id = p_customer_id
                 order by s.created_at desc
                 limit p_section_limit
              ) f
        ), '[]'::jsonb),

        'favoriteCount', (
            select count(*) from saved_properties where customer_id = p_customer_id
        ),

        'recentInquiries', coalesce((
            select jsonb_agg(i order by i.created_at desc)
              from (
                select v.id, v.reference, v.status, v.created_at, v.responded_at,
                       v.property_id, v.property_title, v.cover_media_id,
                       v.last_nudged_at,
                       enquiry_display_status(v.id, v.status::text) as display_status
                  from v_inquiries v
                 where v.customer_id = p_customer_id
                 order by v.created_at desc
                 limit p_section_limit
              ) i
        ), '[]'::jsonb),

        'inquiryCount', (
            select count(*) from property_inquiries where customer_id = p_customer_id
        )
    );
$$;


create or replace function customer_activity_summary(p_customer_id uuid)
returns jsonb
language sql stable as $$
    select jsonb_build_object(
        'savedCount', (select count(*) from saved_properties where customer_id = p_customer_id),
        'openInquiries', (select count(*) from property_inquiries
                           where customer_id = p_customer_id and status in ('pending', 'responded')),
        'acceptedInquiries', (select count(*) from property_inquiries
                               where customer_id = p_customer_id and status = 'accepted'),
        'activeBookings', (select count(*) from bookings
                            where customer_id = p_customer_id and status in ('confirmed', 'active')),
        'activeRentals', (select count(*) from v_active_rentals where customer_id = p_customer_id),
        'amountOutstanding', (select coalesce(sum(total_due - amount_paid), 0) from v_bookings
                               where customer_id = p_customer_id and status in ('awaiting_payment', 'confirmed', 'active')),
        'paymentsAwaitingVerification', (select count(*) from payments
                                          where payer_user_id = p_customer_id and status = 'pending'
                                            and customer_declared_paid_at is not null),
        'unreadNotifications', (select count(*) from notifications
                                 where user_id = p_customer_id and read_at is null)
    );
$$;

-- The portal's badges: no viewing requests, and no bookings waiting on a
-- person — payment verification is the only step left, and it badges Payments.
drop view v_attention_counts;
create view v_attention_counts as
select
    (select count(*) from properties where status = 'pending_review') as properties_pending_review,
    (select count(*) from organizations where status = 'pending') as agencies_pending,
    (select count(*) from users where kyc_status in ('pending', 'in_review')
        or exists (select 1 from kyc_documents d where d.user_id = users.id and d.status = 'pending'))
        as users_kyc_pending,
    (select count(*) from users u
       where u.role in ('moderator', 'manager', 'finance_auditor', 'admin') and u.status = 'pending')
        as staff_pending,
    (select count(*) from payments where status = 'pending') as payments_pending,
    (select count(*) from payments where status = 'failed') as payments_failed,
    (select count(*) from payouts where status in ('scheduled', 'processing')) as payouts_due,
    (select count(*) from payouts where status in ('failed', 'on_hold')) as payouts_blocked,
    (select count(*) from kyc_remediations where not resolved) as open_remediations,
    (select count(*) from v_outstanding_balances) as beneficiaries_owed,
    (select count(*) from property_inquiries where status = 'pending') as inquiries_pending,
    (select count(*) from payments
      where status = 'pending' and customer_declared_paid_at is not null) as payments_declared,
    (select count(*) from payments p
      where p.booking_id is not null and p.status = 'pending'
        and not exists (select 1 from payment_instructions i where i.payment_id = p.id))
        as payments_needing_instructions;

-- Nothing reads these any more. The table and its rows stay as history.
drop function if exists search_viewings(text, viewing_status, uuid, uuid, timestamptz, timestamptz, integer, integer);
drop function if exists search_viewings;
drop view if exists v_viewings;
