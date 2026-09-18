-- Read models for KYC, money, and the "what needs attention" counters that
-- drive the sidebar badges.

-- ---------------------------------------------------------------------------
-- Users: KYC-aware view and search
-- ---------------------------------------------------------------------------

drop function if exists search_users(text, user_role, user_status, uuid, boolean, integer, integer);
drop view if exists v_users;

create view v_users as
select
    u.id,
    u.phone_number,
    u.email,
    u.full_name,
    u.role,
    u.status,
    u.job_title,
    u.suspension_reason,
    u.organization_id,
    o.name as organization_name,
    u.last_login_at,
    u.created_at,
    u.updated_at,
    (u.role in ('moderator', 'manager', 'finance_auditor', 'admin')) as is_staff,

    -- identity / KYC
    u.profile_photo_media_id,
    u.date_of_birth,
    u.gender,
    u.nationality,
    u.national_id_number,
    u.tin_number,
    u.physical_address,
    u.postal_address,
    u.emergency_contact_name,
    u.emergency_contact_phone,
    u.next_of_kin_name,
    u.next_of_kin_phone,
    u.bank_name,
    u.bank_account_name,
    u.bank_account_number,
    u.mobile_money_provider,
    u.mobile_money_number,
    u.kyc_status,
    u.kyc_reviewed_at,
    u.kyc_reviewed_by,
    u.kyc_rejection_reason,
    u.kyc_expires_at,
    u.notes,
    (select count(*) from kyc_documents d where d.user_id = u.id) as document_count,
    (select count(*) from kyc_documents d where d.user_id = u.id and d.status = 'pending') as documents_pending,
    (select count(*) from kyc_remediations r where r.user_id = u.id and not r.resolved) as open_remediations,
    (select count(*) from properties p where p.owner_id = u.id) as property_count,
    -- money owed to this person but not yet paid out
    coalesce((
        select sum(s.amount) from payment_splits s
          join payments p on p.id = s.payment_id
         where s.beneficiary_user_id = u.id and s.payout_id is null and p.status = 'successful'
    ), 0) as unpaid_balance
from users u
left join organizations o on o.id = u.organization_id;

create or replace function search_users(
    p_query text default null,
    p_role user_role default null,
    p_status user_status default null,
    p_organization_id uuid default null,
    p_staff_only boolean default null,
    p_kyc_status kyc_status default null,
    p_needs_attention boolean default null,
    p_limit integer default 20,
    p_offset integer default 0
)
returns table (
    id uuid, phone_number text, email text, full_name text, role user_role, status user_status,
    job_title text, suspension_reason text, organization_id uuid, organization_name text,
    last_login_at timestamptz, created_at timestamptz, updated_at timestamptz, is_staff boolean,
    profile_photo_media_id uuid, national_id_number text, kyc_status kyc_status,
    kyc_expires_at date, document_count bigint, documents_pending bigint, open_remediations bigint,
    property_count bigint, unpaid_balance numeric,
    total_count bigint
)
language sql stable as $$
    select
        u.id, u.phone_number, u.email, u.full_name, u.role, u.status, u.job_title,
        u.suspension_reason, u.organization_id, u.organization_name, u.last_login_at,
        u.created_at, u.updated_at, u.is_staff, u.profile_photo_media_id, u.national_id_number,
        u.kyc_status, u.kyc_expires_at, u.document_count, u.documents_pending,
        u.open_remediations, u.property_count, u.unpaid_balance,
        count(*) over () as total_count
    from v_users u
    where (p_query is null or (
              u.full_name ilike '%' || p_query || '%'
              or coalesce(u.email, '') ilike '%' || p_query || '%'
              or coalesce(u.phone_number, '') ilike '%' || p_query || '%'
              or coalesce(u.national_id_number, '') ilike '%' || p_query || '%'
              or coalesce(u.organization_name, '') ilike '%' || p_query || '%'))
      and (p_role is null or u.role = p_role)
      and (p_status is null or u.status = p_status)
      and (p_organization_id is null or u.organization_id = p_organization_id)
      and (p_staff_only is null or u.is_staff = p_staff_only)
      and (p_kyc_status is null or u.kyc_status = p_kyc_status)
      and (p_needs_attention is null or p_needs_attention = false
           or u.documents_pending > 0 or u.open_remediations > 0 or u.kyc_status = 'in_review')
    order by u.created_at desc
    limit greatest(p_limit, 0) offset greatest(p_offset, 0);
$$;

-- ---------------------------------------------------------------------------
-- Money
-- ---------------------------------------------------------------------------

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
    coalesce((select sum(s.amount) from payment_splits s where s.payment_id = p.id), 0) as split_total
from payments p
left join properties prop on prop.id = p.property_id
left join users payer on payer.id = p.payer_user_id
left join payment_methods pm on pm.id = p.payment_method_id;

create view v_payouts as
select
    po.id,
    po.reference,
    po.beneficiary_type,
    po.beneficiary_user_id,
    b.full_name as beneficiary_name,
    b.phone_number as beneficiary_phone,
    b.bank_name,
    b.bank_account_number,
    b.mobile_money_provider,
    b.mobile_money_number,
    b.kyc_status as beneficiary_kyc_status,
    po.amount,
    po.currency,
    po.status,
    po.destination,
    po.provider_reference,
    po.failure_reason,
    po.hold_reason,
    po.scheduled_for,
    po.paid_at,
    po.approved_by,
    po.created_at,
    pm.name as payment_method_name,
    (select count(*) from payment_splits s where s.payout_id = po.id) as split_count
from payouts po
left join users b on b.id = po.beneficiary_user_id
left join payment_methods pm on pm.id = po.payment_method_id;

/*
 * What each beneficiary is owed right now: successful collections whose split
 * has not yet been attached to a payout.
 */
create view v_outstanding_balances as
select
    s.beneficiary_type,
    s.beneficiary_user_id,
    u.full_name as beneficiary_name,
    u.phone_number as beneficiary_phone,
    u.kyc_status as beneficiary_kyc_status,
    u.bank_account_number,
    u.mobile_money_number,
    count(*) as split_count,
    sum(s.amount) as amount_due,
    min(p.confirmed_at) as oldest_collection
from payment_splits s
join payments p on p.id = s.payment_id
left join users u on u.id = s.beneficiary_user_id
where s.payout_id is null
  and p.status = 'successful'
  and s.beneficiary_type <> 'platform'
group by s.beneficiary_type, s.beneficiary_user_id, u.full_name, u.phone_number,
         u.kyc_status, u.bank_account_number, u.mobile_money_number;

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
    property_id uuid, property_reference text, property_title text,
    payer_user_id uuid, payer_name text, payer_phone text, payment_method_name text,
    split_count bigint, provider_event_count bigint, split_total numeric,
    total_count bigint
)
language sql stable as $$
    select
        v.id, v.reference, v.purpose, v.amount, v.currency, v.status, v.provider, v.provider_reference,
        v.period_start, v.period_end, v.failure_reason, v.confirmed_at, v.confirmed_by, v.created_at,
        v.property_id, v.property_reference, v.property_title,
        v.payer_user_id, v.payer_name, v.payer_phone, v.payment_method_name,
        v.split_count, v.provider_event_count, v.split_total,
        count(*) over () as total_count
    from v_payments v
    where (p_query is null or (
              v.reference ilike '%' || p_query || '%'
              or coalesce(v.provider_reference, '') ilike '%' || p_query || '%'
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

create or replace function search_payouts(
    p_query text default null,
    p_status payout_status default null,
    p_beneficiary_type beneficiary_type default null,
    p_beneficiary_user_id uuid default null,
    p_limit integer default 20,
    p_offset integer default 0
)
returns table (
    id uuid, reference text, beneficiary_type beneficiary_type, beneficiary_user_id uuid,
    beneficiary_name text, beneficiary_phone text, beneficiary_kyc_status kyc_status,
    amount numeric, currency text, status payout_status, destination text, provider_reference text,
    failure_reason text, hold_reason text, scheduled_for date, paid_at timestamptz, approved_by text,
    created_at timestamptz, payment_method_name text, split_count bigint,
    total_count bigint
)
language sql stable as $$
    select
        v.id, v.reference, v.beneficiary_type, v.beneficiary_user_id, v.beneficiary_name,
        v.beneficiary_phone, v.beneficiary_kyc_status, v.amount, v.currency, v.status, v.destination,
        v.provider_reference, v.failure_reason, v.hold_reason, v.scheduled_for, v.paid_at,
        v.approved_by, v.created_at, v.payment_method_name, v.split_count,
        count(*) over () as total_count
    from v_payouts v
    where (p_query is null or (
              v.reference ilike '%' || p_query || '%'
              or coalesce(v.beneficiary_name, '') ilike '%' || p_query || '%'
              or coalesce(v.provider_reference, '') ilike '%' || p_query || '%'))
      and (p_status is null or v.status = p_status)
      and (p_beneficiary_type is null or v.beneficiary_type = p_beneficiary_type)
      and (p_beneficiary_user_id is null or v.beneficiary_user_id = p_beneficiary_user_id)
    order by v.created_at desc
    limit greatest(p_limit, 0) offset greatest(p_offset, 0);
$$;

-- Dictionary search, so master data is searchable like everything else.
create or replace function search_dictionary_items(
    p_query text default null,
    p_category text default null,
    p_parent_id uuid default null,
    p_include_inactive boolean default false,
    p_limit integer default 50,
    p_offset integer default 0
)
returns table (
    id uuid, category text, code text, name text, parent_id uuid, parent_name text,
    sort_order integer, is_active boolean, metadata jsonb, child_count bigint, in_use boolean,
    total_count bigint
)
language sql stable as $$
    select
        d.id, d.category, d.code, d.name, d.parent_id, parent.name as parent_name,
        d.sort_order, d.is_active, d.metadata,
        (select count(*) from dictionary_items c where c.parent_id = d.id) as child_count,
        (
            exists (select 1 from dictionary_items c where c.parent_id = d.id)
            or exists (select 1 from properties p
                        where p.property_type_id = d.id or p.region_id = d.id
                           or p.district_id = d.id or p.ward_id = d.id)
            or exists (select 1 from property_amenities a where a.amenity_id = d.id)
        ) as in_use,
        count(*) over () as total_count
    from dictionary_items d
    left join dictionary_items parent on parent.id = d.parent_id
    where (p_category is null or d.category = p_category)
      and (p_parent_id is null or d.parent_id = p_parent_id)
      and (p_include_inactive or d.is_active)
      and (p_query is null or d.name ilike '%' || p_query || '%' or d.code ilike '%' || p_query || '%')
    order by d.category, d.sort_order, d.name
    limit greatest(p_limit, 0) offset greatest(p_offset, 0);
$$;

-- ---------------------------------------------------------------------------
-- "Needs attention" counters — one query behind every sidebar badge
-- ---------------------------------------------------------------------------

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
    (select count(*) from v_outstanding_balances) as beneficiaries_owed;
