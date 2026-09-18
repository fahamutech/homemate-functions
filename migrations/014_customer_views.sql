-- Read models for the customer app and the portal screens that answer it.
-- The app makes one call per screen; the shaping is done here so a phone on a
-- slow connection is not assembling a page out of five round trips.

-- ---------------------------------------------------------------------------
-- A. Inquiries
-- ---------------------------------------------------------------------------

create view v_inquiries as
select
    i.id,
    i.reference,
    i.status,
    i.message,
    i.move_in_date,
    i.budget_amount,
    i.occupants,
    i.contact_preference,
    i.preferred_contact_time,
    i.response,
    i.responded_at,
    i.rejection_reason,
    i.created_at,
    i.updated_at,
    i.property_id,
    p.reference_code as property_reference,
    p.title as property_title,
    p.price as property_price,
    p.currency as property_currency,
    p.address_line as property_address,
    cover.id as cover_media_id,
    i.customer_id,
    c.full_name as customer_name,
    c.phone_number as customer_phone,
    responder.full_name as responded_by_name,
    owner.id as owner_id,
    owner.full_name as owner_name,
    exists (select 1 from property_viewings v where v.inquiry_id = i.id and v.status <> 'cancelled') as has_viewing,
    exists (select 1 from bookings b where b.inquiry_id = i.id and b.status <> 'cancelled') as has_booking
from property_inquiries i
join properties p on p.id = i.property_id
join users c on c.id = i.customer_id
left join users responder on responder.id = i.responded_by
left join users owner on owner.id = p.owner_id
left join lateral (
    select m.id from property_media m
     where m.property_id = p.id
     order by m.is_cover desc, m.position
     limit 1
) cover on true;

create or replace function search_inquiries(
    p_query text default null,
    p_status inquiry_status default null,
    p_customer_id uuid default null,
    p_property_id uuid default null,
    p_limit integer default 20,
    p_offset integer default 0
)
returns table (
    id uuid, reference text, status inquiry_status, message text, move_in_date date,
    budget_amount numeric, occupants smallint, contact_preference text, response text,
    responded_at timestamptz, rejection_reason text, created_at timestamptz,
    property_id uuid, property_reference text, property_title text, property_price numeric,
    property_currency text, property_address text, cover_media_id uuid,
    customer_id uuid, customer_name text, customer_phone text, responded_by_name text,
    owner_name text, has_viewing boolean, has_booking boolean,
    total_count bigint
)
language sql stable as $$
    select
        v.id, v.reference, v.status, v.message, v.move_in_date, v.budget_amount, v.occupants,
        v.contact_preference, v.response, v.responded_at, v.rejection_reason, v.created_at,
        v.property_id, v.property_reference, v.property_title, v.property_price,
        v.property_currency, v.property_address, v.cover_media_id,
        v.customer_id, v.customer_name, v.customer_phone, v.responded_by_name,
        v.owner_name, v.has_viewing, v.has_booking,
        count(*) over () as total_count
    from v_inquiries v
    where (p_query is null or (
              v.reference ilike '%' || p_query || '%'
              or v.property_title ilike '%' || p_query || '%'
              or coalesce(v.customer_name, '') ilike '%' || p_query || '%'
              or v.message ilike '%' || p_query || '%'))
      and (p_status is null or v.status = p_status)
      and (p_customer_id is null or v.customer_id = p_customer_id)
      and (p_property_id is null or v.property_id = p_property_id)
    order by v.created_at desc
    limit greatest(p_limit, 0) offset greatest(p_offset, 0);
$$;

-- ---------------------------------------------------------------------------
-- B. Viewings
-- ---------------------------------------------------------------------------

create view v_viewings as
select
    v.id,
    v.reference,
    v.status,
    v.scheduled_for,
    v.duration_minutes,
    v.meeting_point,
    v.customer_note,
    v.host_note,
    v.cancellation_reason,
    v.confirmed_at,
    v.completed_at,
    v.created_at,
    v.inquiry_id,
    v.property_id,
    p.reference_code as property_reference,
    p.title as property_title,
    p.address_line as property_address,
    st_y(p.location::geometry) as property_latitude,
    st_x(p.location::geometry) as property_longitude,
    cover.id as cover_media_id,
    v.customer_id,
    c.full_name as customer_name,
    c.phone_number as customer_phone,
    v.host_id,
    h.full_name as host_name,
    h.phone_number as host_phone,
    (v.scheduled_for > now()) as is_upcoming
from property_viewings v
join properties p on p.id = v.property_id
join users c on c.id = v.customer_id
left join users h on h.id = v.host_id
left join lateral (
    select m.id from property_media m
     where m.property_id = p.id
     order by m.is_cover desc, m.position
     limit 1
) cover on true;

create or replace function search_viewings(
    p_query text default null,
    p_status viewing_status default null,
    p_customer_id uuid default null,
    p_property_id uuid default null,
    p_upcoming_only boolean default null,
    p_limit integer default 20,
    p_offset integer default 0
)
returns table (
    id uuid, reference text, status viewing_status, scheduled_for timestamptz,
    duration_minutes smallint, meeting_point text, customer_note text, host_note text,
    cancellation_reason text, confirmed_at timestamptz, created_at timestamptz,
    inquiry_id uuid, property_id uuid, property_reference text, property_title text,
    property_address text, property_latitude double precision, property_longitude double precision,
    cover_media_id uuid, customer_id uuid, customer_name text, customer_phone text,
    host_id uuid, host_name text, host_phone text, is_upcoming boolean,
    total_count bigint
)
language sql stable as $$
    select
        v.id, v.reference, v.status, v.scheduled_for, v.duration_minutes, v.meeting_point,
        v.customer_note, v.host_note, v.cancellation_reason, v.confirmed_at, v.created_at,
        v.inquiry_id, v.property_id, v.property_reference, v.property_title, v.property_address,
        v.property_latitude, v.property_longitude, v.cover_media_id,
        v.customer_id, v.customer_name, v.customer_phone, v.host_id, v.host_name, v.host_phone,
        v.is_upcoming,
        count(*) over () as total_count
    from v_viewings v
    where (p_query is null or (
              v.reference ilike '%' || p_query || '%'
              or v.property_title ilike '%' || p_query || '%'
              or coalesce(v.customer_name, '') ilike '%' || p_query || '%'))
      and (p_status is null or v.status = p_status)
      and (p_customer_id is null or v.customer_id = p_customer_id)
      and (p_property_id is null or v.property_id = p_property_id)
      and (p_upcoming_only is null or p_upcoming_only = false or v.is_upcoming)
    order by v.scheduled_for desc
    limit greatest(p_limit, 0) offset greatest(p_offset, 0);
$$;

-- ---------------------------------------------------------------------------
-- C. Bookings, with what is still owed on them
-- ---------------------------------------------------------------------------

create view v_bookings as
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
    paid.payment_count
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

create or replace function search_bookings(
    p_query text default null,
    p_status booking_status default null,
    p_customer_id uuid default null,
    p_property_id uuid default null,
    p_limit integer default 20,
    p_offset integer default 0
)
returns table (
    id uuid, reference text, status booking_status, monthly_rent numeric, currency text,
    deposit_amount numeric, advance_months numeric, payment_frequency rent_payment_frequency,
    lease_months smallint, move_in_date date, lease_start_date date, lease_end_date date,
    total_due numeric, notes text, cancellation_reason text, confirmed_at timestamptz,
    expires_at timestamptz, created_at timestamptz, inquiry_id uuid, viewing_id uuid,
    property_id uuid, property_reference text, property_title text, property_address text,
    property_latitude double precision, property_longitude double precision, cover_media_id uuid,
    customer_id uuid, customer_name text, customer_phone text,
    landlord_name text, landlord_phone text,
    amount_paid numeric, amount_outstanding numeric, amount_awaiting_verification numeric,
    payment_count bigint,
    total_count bigint
)
language sql stable as $$
    select
        v.id, v.reference, v.status, v.monthly_rent, v.currency, v.deposit_amount,
        v.advance_months, v.payment_frequency, v.lease_months, v.move_in_date,
        v.lease_start_date, v.lease_end_date, v.total_due, v.notes, v.cancellation_reason,
        v.confirmed_at, v.expires_at, v.created_at, v.inquiry_id, v.viewing_id,
        v.property_id, v.property_reference, v.property_title, v.property_address,
        v.property_latitude, v.property_longitude, v.cover_media_id,
        v.customer_id, v.customer_name, v.customer_phone, v.landlord_name, v.landlord_phone,
        v.amount_paid, v.amount_outstanding, v.amount_awaiting_verification, v.payment_count,
        count(*) over () as total_count
    from v_bookings v
    where (p_query is null or (
              v.reference ilike '%' || p_query || '%'
              or v.property_title ilike '%' || p_query || '%'
              or coalesce(v.customer_name, '') ilike '%' || p_query || '%'))
      and (p_status is null or v.status = p_status)
      and (p_customer_id is null or v.customer_id = p_customer_id)
      and (p_property_id is null or v.property_id = p_property_id)
    order by v.created_at desc
    limit greatest(p_limit, 0) offset greatest(p_offset, 0);
$$;

-- ---------------------------------------------------------------------------
-- D. Payments as the customer sees them, with how to pay
-- ---------------------------------------------------------------------------

create view v_customer_payments as
select
    p.id,
    p.reference,
    p.purpose,
    p.amount,
    p.currency,
    p.status,
    p.period_start,
    p.period_end,
    p.failure_reason,
    p.confirmed_at,
    p.customer_declared_paid_at,
    p.customer_declared_reference,
    p.created_at,
    p.payer_user_id,
    p.booking_id,
    b.reference as booking_reference,
    p.property_id,
    prop.reference_code as property_reference,
    prop.title as property_title,
    pi.id as instruction_id,
    pi.display_name as pay_to_name,
    pi.account_name as pay_to_account_name,
    pi.account_number as pay_to_account_number,
    pi.payment_reference as pay_reference,
    pi.instructions as pay_instructions,
    pi.expires_at as instruction_expires_at,
    pm.name as payment_method_name,
    pm.kind as payment_method_kind,
    -- what the app puts on the button
    case
        when p.status = 'successful' then 'paid'
        when p.status = 'failed' then 'failed'
        when p.customer_declared_paid_at is not null then 'awaiting_verification'
        when pi.id is null then 'awaiting_instructions'
        else 'awaiting_payment'
    end as customer_state
from payments p
left join bookings b on b.id = p.booking_id
left join properties prop on prop.id = p.property_id
left join payment_instructions pi on pi.payment_id = p.id
left join payment_methods pm on pm.id = coalesce(pi.payment_method_id, p.payment_method_id);

-- ---------------------------------------------------------------------------
-- E. Property detail, shaped for one app screen (CUS-005)
-- ---------------------------------------------------------------------------

/*
 * Everything the property page shows, in one row plus three arrays. The app is
 * on a phone: five round trips to render one screen is five chances to fail on
 * a weak connection.
 */
create or replace function customer_property_detail(p_property_id uuid, p_customer_id uuid default null)
returns jsonb
language sql stable as $$
    select jsonb_build_object(
        'property', to_jsonb(v) - 'search_vector',
        'media', coalesce((
            select jsonb_agg(jsonb_build_object(
                'id', m.id, 'kind', m.kind, 'caption', m.caption,
                'isCover', m.is_cover, 'position', m.position
            ) order by m.is_cover desc, m.position)
            from property_media m where m.property_id = p_property_id
        ), '[]'::jsonb),
        'amenities', coalesce((
            select jsonb_agg(jsonb_build_object('id', d.id, 'code', d.code, 'name', d.name) order by d.sort_order, d.name)
            from property_amenities a join dictionary_items d on d.id = a.amenity_id
            where a.property_id = p_property_id
        ), '[]'::jsonb),
        'charges', coalesce((
            select jsonb_agg(jsonb_build_object(
                'id', c.id, 'name', c.name, 'amount', c.amount,
                'frequency', c.frequency, 'isMandatory', c.is_mandatory,
                'isRefundable', c.is_refundable
            ) order by c.name)
            from property_charges c where c.property_id = p_property_id
        ), '[]'::jsonb),
        'paymentMethods', coalesce((
            select jsonb_agg(jsonb_build_object('id', pm.id, 'code', pm.code, 'name', pm.name, 'kind', pm.kind))
            from property_payment_methods ppm join payment_methods pm on pm.id = ppm.payment_method_id
            where ppm.property_id = p_property_id and pm.is_active
        ), '[]'::jsonb),
        'contact', (
            select jsonb_build_object(
                'landlordName', lu.full_name,
                'brokerName', bu.full_name,
                'agencyName', o.name
            )
            from properties pr
            left join property_parties lp on lp.property_id = pr.id and lp.role = 'landlord' and lp.is_primary
            left join users lu on lu.id = lp.user_id
            left join property_parties bp on bp.property_id = pr.id and bp.role = 'broker' and bp.is_primary
            left join users bu on bu.id = bp.user_id
            left join organizations o on o.id = (
                select u2.organization_id from property_parties ap
                  join users u2 on u2.id = ap.user_id
                 where ap.property_id = pr.id and ap.role = 'agency' and ap.is_primary
                 limit 1
            )
            where pr.id = p_property_id
        ),
        'isSaved', coalesce((
            select true from saved_properties s
             where s.property_id = p_property_id and s.customer_id = p_customer_id
        ), false),
        'myInquiry', (
            select jsonb_build_object('id', i.id, 'reference', i.reference, 'status', i.status)
              from property_inquiries i
             where i.property_id = p_property_id and i.customer_id = p_customer_id
             order by i.created_at desc limit 1
        )
    )
    from v_properties v
    where v.id = p_property_id;
$$;

-- ---------------------------------------------------------------------------
-- F. The app's home screen and the customer's own activity
-- ---------------------------------------------------------------------------

create or replace function customer_activity_summary(p_customer_id uuid)
returns jsonb
language sql stable as $$
    select jsonb_build_object(
        'savedCount', (select count(*) from saved_properties where customer_id = p_customer_id),
        'openInquiries', (select count(*) from property_inquiries
                           where customer_id = p_customer_id and status in ('pending', 'responded')),
        'upcomingViewings', (select count(*) from property_viewings
                              where customer_id = p_customer_id and status in ('requested', 'confirmed')
                                and scheduled_for > now()),
        'activeBookings', (select count(*) from bookings
                            where customer_id = p_customer_id and status in ('confirmed', 'active')),
        'amountOutstanding', (select coalesce(sum(total_due - amount_paid), 0) from v_bookings
                               where customer_id = p_customer_id and status in ('awaiting_payment', 'confirmed', 'active')),
        'paymentsAwaitingVerification', (select count(*) from payments
                                          where payer_user_id = p_customer_id and status = 'pending'
                                            and customer_declared_paid_at is not null),
        'unreadNotifications', (select count(*) from notifications
                                 where user_id = p_customer_id and read_at is null)
    );
$$;

-- ---------------------------------------------------------------------------
-- G. What the portal must now attend to
-- ---------------------------------------------------------------------------

drop view if exists v_attention_counts;

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
    -- customer-facing work
    (select count(*) from property_inquiries where status = 'pending') as inquiries_pending,
    (select count(*) from property_viewings where status = 'requested') as viewings_requested,
    (select count(*) from bookings where status in ('pending', 'awaiting_payment')) as bookings_pending,
    (select count(*) from payments
      where status = 'pending' and customer_declared_paid_at is not null) as payments_declared,
    (select count(*) from payments p
      where p.booking_id is not null and p.status = 'pending'
        and not exists (select 1 from payment_instructions i where i.payment_id = p.id))
        as payments_needing_instructions;
