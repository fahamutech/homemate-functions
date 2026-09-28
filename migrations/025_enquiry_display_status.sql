-- ---------------------------------------------------------------------------
-- The enquiry list says where the money is, not only what the landlord said.
--
-- With viewings and the separate booking step gone, an enquiry carries the
-- customer's whole journey: sent, accepted, paying, verified. The app's
-- Activity tab is a list of enquiries, so each row needs the same
-- payment-aware status the Favourites screen already shows
-- (`enquiry_display_status`, 024) — otherwise a customer who has paid and been
-- verified still sees "Accepted".
--
-- Appended to the view, so every existing column keeps its position; the list
-- function's return type grows by one column, so it is dropped and recreated.
-- ---------------------------------------------------------------------------

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
    i.last_nudged_at,
    i.nudge_count,
    i.checkout_ready_at,
    (select b.id from bookings b
      where b.inquiry_id = i.id and b.status <> 'cancelled'
      order by b.created_at desc limit 1) as booking_id,
    -- appended in 025
    enquiry_display_status(i.id, i.status::text) as display_status
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
    display_status text,
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
