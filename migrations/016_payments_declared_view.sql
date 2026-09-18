-- `v_payments` was written before a customer could say "I have paid" (013), so
-- the backoffice payments list could not show that a claim is waiting. The
-- dedicated queue could, but an operator looking at the ordinary list saw a
-- plain pending payment with no hint that someone is waiting on them.

drop function if exists search_payments(text, payment_status, payment_purpose, uuid, uuid, date, date, integer, integer);
drop view if exists v_payments;

create view v_payments as
select
    p.id,
    p.reference,
    p.purpose,
    p.amount,
    p.currency,
    p.status,
    p.provider,
    p.provider_reference,
    p.period_start,
    p.period_end,
    p.failure_reason,
    p.confirmed_at,
    p.confirmed_by,
    p.reconciled_at,
    p.notes,
    p.created_at,
    p.booking_id,
    b.reference as booking_reference,
    p.customer_declared_paid_at,
    p.customer_declared_reference,
    p.customer_declared_note,
    p.property_id,
    prop.reference_code as property_reference,
    prop.title as property_title,
    p.payer_user_id,
    payer.full_name as payer_name,
    payer.phone_number as payer_phone,
    p.payment_method_id,
    pm.name as payment_method_name,
    (select count(*) from payment_splits s where s.payment_id = p.id) as split_count,
    (select count(*) from external_payment_events e where e.payment_id = p.id) as provider_event_count,
    coalesce((select sum(s.amount) from payment_splits s where s.payment_id = p.id), 0) as split_total,
    exists (select 1 from payment_instructions i where i.payment_id = p.id) as has_instructions
from payments p
left join bookings b on b.id = p.booking_id
left join properties prop on prop.id = p.property_id
left join users payer on payer.id = p.payer_user_id
left join payment_methods pm on pm.id = p.payment_method_id;

create or replace function search_payments(
    p_query text default null,
    p_status payment_status default null,
    p_purpose payment_purpose default null,
    p_property_id uuid default null,
    p_payer_user_id uuid default null,
    p_from date default null,
    p_to date default null,
    p_limit integer default 20,
    p_offset integer default 0
)
returns table (
    id uuid, reference text, purpose payment_purpose, amount numeric, currency text,
    status payment_status, provider text, provider_reference text, period_start date, period_end date,
    failure_reason text, confirmed_at timestamptz, confirmed_by text, created_at timestamptz,
    booking_id uuid, booking_reference text,
    customer_declared_paid_at timestamptz, customer_declared_reference text,
    property_id uuid, property_reference text, property_title text,
    payer_user_id uuid, payer_name text, payer_phone text, payment_method_name text,
    split_count bigint, provider_event_count bigint, split_total numeric, has_instructions boolean,
    total_count bigint
)
language sql stable as $$
    select
        v.id, v.reference, v.purpose, v.amount, v.currency, v.status, v.provider, v.provider_reference,
        v.period_start, v.period_end, v.failure_reason, v.confirmed_at, v.confirmed_by, v.created_at,
        v.booking_id, v.booking_reference,
        v.customer_declared_paid_at, v.customer_declared_reference,
        v.property_id, v.property_reference, v.property_title,
        v.payer_user_id, v.payer_name, v.payer_phone, v.payment_method_name,
        v.split_count, v.provider_event_count, v.split_total, v.has_instructions,
        count(*) over () as total_count
    from v_payments v
    where (p_query is null or (
              v.reference ilike '%' || p_query || '%'
              or coalesce(v.provider_reference, '') ilike '%' || p_query || '%'
              or coalesce(v.customer_declared_reference, '') ilike '%' || p_query || '%'
              or coalesce(v.payer_name, '') ilike '%' || p_query || '%'
              or coalesce(v.property_title, '') ilike '%' || p_query || '%'
              or coalesce(v.property_reference, '') ilike '%' || p_query || '%'))
      and (p_status is null or v.status = p_status)
      and (p_purpose is null or v.purpose = p_purpose)
      and (p_property_id is null or v.property_id = p_property_id)
      and (p_payer_user_id is null or v.payer_user_id = p_payer_user_id)
      and (p_from is null or v.created_at >= p_from)
      and (p_to is null or v.created_at < (p_to + 1))
    order by v.created_at desc
    limit greatest(p_limit, 0) offset greatest(p_offset, 0);
$$;
