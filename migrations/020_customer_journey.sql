-- The rest of the customer's journey: reserving a property while you pay for
-- it, nudging a landlord who has gone quiet, the timeline that explains where
-- you are, and the tenancy you end up with.
--
-- As everywhere else in this schema, the rules live here rather than in the
-- application: a hold is exclusive because an index says so, a nudge has a
-- cooldown because a function says so, and a timeline is assembled by a query
-- rather than by whichever client happens to be asking.

-- ---------------------------------------------------------------------------
-- A. Property holds — one person pays at a time
-- ---------------------------------------------------------------------------

/*
 * The bus-ticket rule. While a customer is inside the payment flow the
 * property is theirs for ten minutes; anyone else is told it is being paid for
 * and how long they have to wait. Without this, two people settle for the same
 * home and one of them has to be refunded by hand.
 *
 * A hold is advisory about *starting* a payment, not about settlement —
 * `bookings_one_active_per_property` remains the hard guarantee that a
 * property is let once.
 */
create table property_holds (
    id uuid primary key default gen_random_uuid(),
    reference text not null unique,
    property_id uuid not null references properties (id) on delete cascade,
    customer_id uuid not null references users (id) on delete cascade,
    booking_id uuid references bookings (id) on delete set null,
    payment_id uuid references payments (id) on delete set null,
    reason text not null default 'checkout',
    expires_at timestamptz not null,
    released_at timestamptz,
    release_reason text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint property_holds_expiry_after_start check (expires_at > created_at),
    constraint property_holds_reason_known
        check (reason in ('checkout', 'manual', 'reservation'))
);

create index idx_property_holds_property on property_holds (property_id, expires_at desc);
create index idx_property_holds_customer on property_holds (customer_id, created_at desc);
create index idx_property_holds_live on property_holds (expires_at) where released_at is null;

/*
 * At most one unreleased hold per property. The predicate cannot mention
 * now() — an index predicate must be immutable — so expiry is swept by
 * `acquire_property_hold` before it inserts. That keeps the exclusivity
 * guarantee in the index rather than in a racing SELECT-then-INSERT.
 */
create unique index property_holds_one_live_per_property
    on property_holds (property_id)
    where released_at is null;

create trigger property_holds_set_updated_at before update on property_holds
    for each row execute function set_updated_at();
create trigger property_holds_audit after insert or update or delete on property_holds
    for each row execute function audit_row_change();

create sequence property_hold_reference_seq;

create or replace function assign_property_hold_reference() returns trigger
language plpgsql as $$
begin
    if new.reference is null or length(btrim(new.reference)) = 0 then
        new.reference := 'HM-HLD-' || lpad(nextval('property_hold_reference_seq')::text, 6, '0');
    end if;
    return new;
end;
$$;

create trigger property_holds_assign_reference before insert on property_holds
    for each row execute function assign_property_hold_reference();

/*
 * Sweeps holds whose ten minutes are up. Called before every acquire so a
 * lapsed hold never blocks the next customer, and safe to call from a
 * scheduled job as well.
 */
create or replace function expire_property_holds() returns integer
language sql as $$
    with expired as (
        update property_holds
           set released_at = now(),
               release_reason = coalesce(release_reason, 'expired')
         where released_at is null
           and expires_at <= now()
        returning id
    )
    select count(*)::integer from expired;
$$;

/*
 * Take the property for `p_minutes`, or explain who has it.
 *
 * Re-entrant for the customer who already holds it: reopening the checkout
 * screen extends their own window rather than failing, which is what someone
 * switching apps to read an M-Pesa message actually does.
 */
create or replace function acquire_property_hold(
    p_property_id uuid,
    p_customer_id uuid,
    p_minutes integer default 10,
    p_booking_id uuid default null,
    p_payment_id uuid default null,
    p_reason text default 'checkout'
)
returns property_holds
language plpgsql as $$
declare
    v_minutes integer := greatest(least(coalesce(p_minutes, 10), 60), 1);
    v_existing property_holds;
    v_hold property_holds;
    v_status property_status;
begin
    perform expire_property_holds();

    select status into v_status from properties where id = p_property_id;
    if not found then
        raise exception 'Property not found' using errcode = 'no_data_found';
    end if;
    if v_status <> 'approved' then
        raise exception 'This property is not available to book'
            using errcode = 'check_violation';
    end if;

    if exists (select 1 from bookings
                where property_id = p_property_id
                  and status in ('confirmed', 'active')
                  and customer_id <> p_customer_id) then
        raise exception 'This property has already been let'
            using errcode = 'check_violation',
                  hint = 'Someone completed payment for it.';
    end if;

    -- Serialise concurrent acquires on the same property. Two customers
    -- reaching checkout in the same millisecond both land here; the second
    -- waits, then sees the first one's hold.
    perform pg_advisory_xact_lock(hashtext('property_hold:' || p_property_id::text));

    select * into v_existing
      from property_holds
     where property_id = p_property_id and released_at is null
     limit 1;

    if found and v_existing.customer_id <> p_customer_id then
        raise exception 'Someone is paying for this property right now'
            using errcode = 'lock_not_available',
                  hint = 'It becomes available again in '
                         || greatest(ceil(extract(epoch from (v_existing.expires_at - now())) / 60), 1)::text
                         || ' minute(s).';
    end if;

    if found then
        update property_holds
           set expires_at = now() + make_interval(mins => v_minutes),
               booking_id = coalesce(p_booking_id, booking_id),
               payment_id = coalesce(p_payment_id, payment_id)
         where id = v_existing.id
        returning * into v_hold;
        return v_hold;
    end if;

    insert into property_holds (property_id, customer_id, booking_id, payment_id, reason, expires_at)
    values (p_property_id, p_customer_id, p_booking_id, p_payment_id,
            coalesce(p_reason, 'checkout'), now() + make_interval(mins => v_minutes))
    returning * into v_hold;

    return v_hold;
end;
$$;

create or replace function release_property_hold(
    p_hold_id uuid,
    p_customer_id uuid,
    p_reason text default 'released'
)
returns boolean
language plpgsql as $$
declare
    v_count integer;
begin
    update property_holds
       set released_at = now(), release_reason = p_reason
     where id = p_hold_id
       and customer_id = p_customer_id
       and released_at is null;
    get diagnostics v_count = row_count;
    return v_count > 0;
end;
$$;

/*
 * A hold as the app renders it: who has it, and how long is left. The seconds
 * are computed here so the phone never has to reconcile its own clock with
 * the server's.
 */
create or replace view v_property_holds as
select
    h.id,
    h.reference,
    h.property_id,
    h.customer_id,
    h.booking_id,
    h.payment_id,
    h.reason,
    h.expires_at,
    h.released_at,
    h.created_at,
    p.title as property_title,
    greatest(ceil(extract(epoch from (h.expires_at - now())))::integer, 0) as seconds_remaining,
    (h.released_at is null and h.expires_at > now()) as is_live
from property_holds h
join properties p on p.id = h.property_id;

-- ---------------------------------------------------------------------------
-- B. Nudging a quiet landlord — CUS-007e
-- ---------------------------------------------------------------------------

alter table property_inquiries
    add column last_nudged_at timestamptz,
    add column nudge_count smallint not null default 0,
    add column checkout_ready_at timestamptz;

comment on column property_inquiries.checkout_ready_at is
    'When the landlord accepted and the customer could start paying.';

/*
 * The read model gains the same three facts. `create or replace view` only
 * permits appending, which is exactly what this is — every existing column
 * keeps its name, type and position, so `search_inquiries` below and the
 * portal's reads carry on unchanged.
 */
create or replace view v_inquiries as
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
    exists (select 1 from bookings b where b.inquiry_id = i.id and b.status <> 'cancelled') as has_booking,
    -- appended in 020
    i.last_nudged_at,
    i.nudge_count,
    i.checkout_ready_at,
    (select b.id from bookings b
      where b.inquiry_id = i.id and b.status <> 'cancelled'
      order by b.created_at desc limit 1) as booking_id
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

/*
 * The list needs the nudge state too — a row that says "Awaiting Payment" or
 * "Reminder sent yesterday" cannot be rendered from a status alone. The return
 * type changes, so this is a drop rather than a replace.
 */
drop function if exists search_inquiries(text, inquiry_status, uuid, uuid, integer, integer);

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
    budget_amount numeric, occupants smallint, contact_preference text,
    preferred_contact_time text, response text, responded_at timestamptz,
    rejection_reason text, created_at timestamptz, updated_at timestamptz,
    property_id uuid, property_reference text, property_title text,
    property_price numeric, property_currency text, property_address text,
    cover_media_id uuid, customer_id uuid, customer_name text, customer_phone text,
    responded_by_name text, owner_id uuid, owner_name text,
    has_viewing boolean, has_booking boolean,
    last_nudged_at timestamptz, nudge_count smallint, checkout_ready_at timestamptz,
    booking_id uuid,
    total_count bigint
)
language sql stable as $$
    select v.*, count(*) over () as total_count
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

/*
 * One nudge a day. The cooldown is here rather than in the app because the
 * app is not the only thing that can call the endpoint, and because a landlord
 * poked eleven times stops reading any of them.
 */
create or replace function nudge_inquiry(
    p_inquiry_id uuid,
    p_customer_id uuid,
    p_cooldown_hours integer default 24
)
returns property_inquiries
language plpgsql as $$
declare
    v_inquiry property_inquiries;
    v_owner uuid;
    v_title text;
    v_customer text;
begin
    select * into v_inquiry
      from property_inquiries
     where id = p_inquiry_id and customer_id = p_customer_id
     for update;

    if not found then
        raise exception 'Enquiry not found' using errcode = 'no_data_found';
    end if;

    if v_inquiry.status not in ('pending', 'responded') then
        raise exception 'This enquiry is no longer waiting for a reply'
            using errcode = 'check_violation';
    end if;

    if v_inquiry.last_nudged_at is not null
       and v_inquiry.last_nudged_at > now() - make_interval(hours => greatest(p_cooldown_hours, 1)) then
        raise exception 'You have already sent a reminder recently'
            using errcode = 'check_violation',
                  hint = 'You can send another in '
                         || greatest(ceil(extract(epoch from (
                                v_inquiry.last_nudged_at
                                + make_interval(hours => greatest(p_cooldown_hours, 1)) - now())) / 3600), 1)::text
                         || ' hour(s).';
    end if;

    update property_inquiries
       set last_nudged_at = now(), nudge_count = nudge_count + 1
     where id = p_inquiry_id
    returning * into v_inquiry;

    select p.owner_id, p.title into v_owner, v_title
      from properties p where p.id = v_inquiry.property_id;
    select u.full_name into v_customer from users u where u.id = p_customer_id;

    if v_owner is not null then
        insert into notifications (user_id, kind, title, body, subject_table, subject_id)
        values (
            v_owner,
            'inquiry_response',
            'Reminder: an enquiry is waiting',
            coalesce(v_customer, 'A customer') || ' is still waiting to hear about '
                || coalesce(v_title, 'your property') || '.',
            'property_inquiries',
            p_inquiry_id
        );
    end if;

    return v_inquiry;
end;
$$;

/*
 * Accepting an enquiry is what opens the payment door, so the stamp belongs
 * to the transition rather than to whoever remembers to set it.
 */
create or replace function stamp_inquiry_checkout_ready() returns trigger
language plpgsql as $$
begin
    if new.status = 'accepted' and old.status is distinct from 'accepted' then
        new.checkout_ready_at := coalesce(new.checkout_ready_at, now());
    end if;
    return new;
end;
$$;

create trigger property_inquiries_stamp_checkout_ready
    before update of status on property_inquiries
    for each row execute function stamp_inquiry_checkout_ready();

-- ---------------------------------------------------------------------------
-- C. The journey timeline — CUS-007d/e, CUS-013b
-- ---------------------------------------------------------------------------

/*
 * The next date rent falls due on a monthly lease, or null once the lease has
 * run out. Kept as a function because three different reads want the same
 * answer and none of them should re-derive it. Stable rather than immutable:
 * it reads `current_date`.
 */
create or replace function next_rent_due(p_start date, p_end date)
returns date
language sql stable as $$
    select case
        when p_start is null then null
        when p_end is not null and p_end <= current_date then null
        else least(
            coalesce(p_end, 'infinity'::date),
            (p_start + make_interval(months =>
                greatest(
                    (extract(year from age(current_date, p_start))::integer * 12)
                    + extract(month from age(current_date, p_start))::integer + 1,
                    0
                )))::date
        )
    end;
$$;

/*
 * Every dated thing that has happened to one customer on one property, in one
 * ordered list: enquiry, documents, landlord decision, viewing, reservation,
 * payments, lease, and what is still to come.
 *
 * `state` is 'done' | 'current' | 'upcoming' | 'blocked' — the app draws the
 * dot from that and never has to work out which step it is on.
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
    -- the enquiry itself
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
    -- the landlord's decision, or the fact that it is still outstanding
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
    -- viewings, which may exist with or without an enquiry
    select 4, 'viewing_' || v.id::text,
           case v.status
               when 'completed' then 'Viewing Completed'
               when 'cancelled' then 'Viewing Cancelled'
               when 'confirmed' then 'Viewing Confirmed'
               else 'Viewing Requested' end,
           v.scheduled_for,
           case when v.status = 'completed' then 'done'
                when v.status in ('cancelled', 'no_show') then 'blocked'
                when v.scheduled_for > now() then 'upcoming'
                else 'current' end,
           case when v.host_name is not null
                then 'In-person viewing with ' || v.host_name
                else 'In-person viewing of this property' end
      from v_viewings v
     where v.customer_id = p_customer_id and v.property_id = p_property_id

    union all
    -- payment becomes the next thing to do the moment the enquiry is accepted
    select 5, 'awaiting_payment', 'Awaiting Payment',
           coalesce(i.checkout_ready_at, i.responded_at, i.created_at),
           'current',
           'Complete payment to secure your reservation'
      from inquiry i
     where i.status = 'accepted'
       and not exists (select 1 from booking)

    union all
    select 6, 'reservation', 'Reservation Confirmed', b.created_at,
           case when b.status in ('confirmed', 'active', 'completed') then 'done' else 'current' end,
           'Property reserved. Hold reference ' || b.reference
      from booking b

    union all
    select 7, 'payment_' || pay.id::text,
           case when pay.status = 'successful' then 'Payment Confirmed'
                when pay.status = 'failed' then 'Payment Failed'
                when pay.customer_declared_paid_at is not null then 'Payment Being Checked'
                else 'Payment Due' end,
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

-- ---------------------------------------------------------------------------
-- D. Lease agreements — CUS-012c
-- ---------------------------------------------------------------------------

create table lease_agreements (
    id uuid primary key default gen_random_uuid(),
    reference text not null unique,
    booking_id uuid not null references bookings (id) on delete cascade,
    version text not null default 'v1.0',
    lease_type text not null default 'fixed_term',
    document_url text,
    document_media_id uuid,
    notice_period_days smallint not null default 90,
    terms text,
    house_rules text,
    accepted_at timestamptz,
    accepted_ip text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint lease_agreements_type_known
        check (lease_type in ('fixed_term', 'periodic', 'month_to_month')),
    constraint lease_agreements_notice_sane check (notice_period_days between 0 and 365)
);

-- One live agreement per booking; a revision replaces it rather than racing it.
create unique index lease_agreements_one_per_booking on lease_agreements (booking_id);

create trigger lease_agreements_set_updated_at before update on lease_agreements
    for each row execute function set_updated_at();
create trigger lease_agreements_audit after insert or update or delete on lease_agreements
    for each row execute function audit_row_change();

create sequence lease_agreement_reference_seq;

create or replace function assign_lease_agreement_reference() returns trigger
language plpgsql as $$
begin
    if new.reference is null or length(btrim(new.reference)) = 0 then
        new.reference := 'HM-LSE-' || lpad(nextval('lease_agreement_reference_seq')::text, 6, '0');
    end if;
    return new;
end;
$$;

create trigger lease_agreements_assign_reference before insert on lease_agreements
    for each row execute function assign_lease_agreement_reference();

-- ---------------------------------------------------------------------------
-- E. Active rentals — CUS-012a/b
-- ---------------------------------------------------------------------------

/*
 * A tenancy, as the tenant sees it: what they pay, when it is next due, how
 * much lease is left, and the paperwork behind it. Derived from the booking
 * rather than stored, so a lease that ends today stops being "active" without
 * anybody running a job.
 */
create or replace view v_active_rentals as
select
    b.id,
    b.reference,
    b.status,
    b.customer_id,
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
    b.landlord_name,
    b.landlord_phone,
    prop.notice_period_days,
    next_rent_due(b.lease_start_date, b.lease_end_date) as next_payment_date,
    case
        when b.lease_end_date is null then null
        else greatest((b.lease_end_date - current_date), 0)
    end as days_remaining,
    case
        when b.lease_end_date is null then null
        else greatest(
            (extract(year from age(b.lease_end_date, current_date))::integer * 12)
            + extract(month from age(b.lease_end_date, current_date))::integer, 0)
    end as months_remaining,
    case
        when b.lease_end_date is null or prop.notice_period_days is null then null
        else (b.lease_end_date - prop.notice_period_days)
    end as exit_window_opens_on,
    la.id as agreement_id,
    la.reference as agreement_reference,
    la.version as agreement_version,
    la.lease_type,
    la.document_url as agreement_document_url,
    la.accepted_at as agreement_accepted_at
from v_bookings b
join properties prop on prop.id = b.property_id
left join lease_agreements la on la.booking_id = b.id
where b.status in ('confirmed', 'active');

create or replace function search_active_rentals(
    p_customer_id uuid,
    p_limit integer default 20,
    p_offset integer default 0
)
returns table (
    id uuid, reference text, status booking_status, customer_id uuid, property_id uuid,
    property_title text, property_address text, property_reference text, cover_media_id uuid,
    monthly_rent numeric, currency text, deposit_amount numeric,
    payment_frequency rent_payment_frequency, lease_months smallint,
    lease_start_date date, lease_end_date date, move_in_date date,
    total_due numeric, amount_paid numeric, amount_outstanding numeric,
    landlord_name text, landlord_phone text, notice_period_days smallint,
    next_payment_date date, days_remaining integer, months_remaining integer,
    exit_window_opens_on date, agreement_id uuid, agreement_reference text,
    agreement_version text, lease_type text, agreement_document_url text,
    agreement_accepted_at timestamptz,
    total_count bigint
)
language sql stable as $$
    select v.*, count(*) over () as total_count
      from v_active_rentals v
     where v.customer_id = p_customer_id
     order by v.next_payment_date nulls last, v.lease_start_date desc
     limit greatest(p_limit, 0) offset greatest(p_offset, 0);
$$;

/*
 * The rent ledger for one tenancy: what has been paid, what is being checked,
 * and what is still to come. Used by the payment history on CUS-012b.
 */
create or replace function rental_payment_history(
    p_booking_id uuid,
    p_customer_id uuid,
    p_limit integer default 24
)
returns jsonb
language sql stable as $$
    select coalesce(jsonb_agg(row order by created_at desc), '[]'::jsonb)
      from (
        select
            p.id,
            p.reference,
            p.amount,
            p.currency,
            p.status,
            p.customer_state,
            p.purpose,
            p.period_start,
            p.period_end,
            p.confirmed_at,
            p.customer_declared_paid_at,
            p.payment_method_name,
            p.created_at
          from v_customer_payments p
          join bookings b on b.id = p.booking_id
         where p.booking_id = p_booking_id
           and b.customer_id = p_customer_id
         order by p.created_at desc
         limit greatest(p_limit, 1)
      ) as row;
$$;

-- ---------------------------------------------------------------------------
-- F. The Favourites screen, in one call — CUS-013a
-- ---------------------------------------------------------------------------

/*
 * Four sections, one round trip. The screen is the first thing a returning
 * customer opens; assembling it out of four requests on a Tanzanian mobile
 * connection is four chances to show a spinner.
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
                       -- what the chip on the row says
                       case
                           when v.status = 'accepted' then 'awaiting_payment'
                           else v.status::text
                       end as display_status
                  from v_inquiries v
                 where v.customer_id = p_customer_id
                 order by v.created_at desc
                 limit p_section_limit
              ) i
        ), '[]'::jsonb),

        'inquiryCount', (
            select count(*) from property_inquiries where customer_id = p_customer_id
        ),

        'upcomingBookings', coalesce((
            select jsonb_agg(v order by v.scheduled_for)
              from (
                select id, reference, status, scheduled_for, property_id,
                       property_title, property_address, cover_media_id, host_name
                  from v_viewings
                 where customer_id = p_customer_id
                   and status in ('requested', 'confirmed', 'rescheduled')
                   and scheduled_for >= now() - interval '2 hours'
                 order by scheduled_for
                 limit p_section_limit
              ) v
        ), '[]'::jsonb),

        'upcomingBookingCount', (
            select count(*) from property_viewings
             where customer_id = p_customer_id
               and status in ('requested', 'confirmed', 'rescheduled')
               and scheduled_for >= now() - interval '2 hours'
        )
    );
$$;

-- ---------------------------------------------------------------------------
-- G. Can this customer pay for this property yet?
-- ---------------------------------------------------------------------------

/*
 * The single answer behind every "Pay now" button in the app. It exists so the
 * three routes into payment — an accepted enquiry, a completed viewing, and
 * paying outright with neither — cannot disagree about who is allowed.
 *
 * `route` explains *why* it is allowed, which is what the app puts above the
 * button.
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
    viewing as (
        select * from property_viewings
         where customer_id = p_customer_id and property_id = p_property_id
           and status = 'completed'
         order by scheduled_for desc limit 1
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
        -- coalesced, because an id that matches no property must read as "no"
        -- rather than as JSON null — the app turns this straight into a
        -- disabled button.
        'available', coalesce(
            (select status from prop) = 'approved'
            and not exists (select 1 from letting where customer_id <> p_customer_id)
        , false),
        -- an enquiry is a courtesy, not a gate: someone who knows what they
        -- want may pay outright (item 4 of the brief)
        'canPay', coalesce(
            (select status from prop) = 'approved'
            and coalesce((select price from prop), 0) > 0
            and not exists (select 1 from letting where customer_id <> p_customer_id)
            and coalesce((select status from inquiry) <> 'rejected', true)
        , false),
        'route', case
            when exists (select 1 from booking) then 'booking'
            when (select status from inquiry) = 'accepted' then 'inquiry_accepted'
            when exists (select 1 from viewing) then 'viewing_completed'
            when (select status from inquiry) = 'rejected' then 'blocked'
            when exists (select 1 from inquiry) then 'inquiry_pending'
            else 'direct'
        end,
        'inquiryId', (select id from inquiry),
        'inquiryStatus', (select status from inquiry),
        'viewingId', (select id from viewing),
        'bookingId', (select id from booking),
        'heldByMe', coalesce((select customer_id from hold) = p_customer_id, false),
        'heldByOther', coalesce((select customer_id from hold) <> p_customer_id, false),
        'holdSecondsRemaining', (select seconds_remaining from hold),
        'holdId', (select id from hold where customer_id = p_customer_id)
    );
$$;

-- ---------------------------------------------------------------------------
-- H. The summary gains what the new screens need
-- ---------------------------------------------------------------------------

create or replace function customer_activity_summary(p_customer_id uuid)
returns jsonb
language sql stable as $$
    select jsonb_build_object(
        'savedCount', (select count(*) from saved_properties where customer_id = p_customer_id),
        'openInquiries', (select count(*) from property_inquiries
                           where customer_id = p_customer_id and status in ('pending', 'responded')),
        'acceptedInquiries', (select count(*) from property_inquiries
                               where customer_id = p_customer_id and status = 'accepted'),
        'upcomingViewings', (select count(*) from property_viewings
                              where customer_id = p_customer_id and status in ('requested', 'confirmed')
                                and scheduled_for > now()),
        'activeBookings', (select count(*) from bookings
                            where customer_id = p_customer_id and status in ('confirmed', 'active')),
        'activeRentals', (select count(*) from v_active_rentals where customer_id = p_customer_id),
        'amountOutstanding', (select coalesce(sum(total_due - amount_paid), 0) from v_bookings
                               where customer_id = p_customer_id and status in ('awaiting_payment', 'confirmed', 'active')),
        'paymentsAwaitingVerification', (select count(*) from payments
                                          where payer_user_id = p_customer_id and status = 'pending'
                                            and customer_declared_paid_at is not null),
        -- Every value here is a count, deliberately: these are badges. The
        -- date rent is next due is a fact about one tenancy, so it belongs to
        -- `customer_saved_overview` and the rental rows, where it is rendered.
        'unreadNotifications', (select count(*) from notifications
                                 where user_id = p_customer_id and read_at is null)
    );
$$;
