-- `profile_photo_media_id` was a uuid pointing at no table — there is no
-- generic media registry: property images live in `property_media` and KYC
-- files carry their own storage keys. The profile photo now follows the same
-- shape as those — the object store holds the bytes, the row holds the key.

drop function if exists search_users(text, user_role, user_status, uuid, boolean, kyc_status, boolean, integer, integer);
drop view if exists v_users;

alter table users
    drop column profile_photo_media_id,
    add column profile_photo_url text,
    add column profile_photo_thumbnail_url text,
    add column profile_photo_content_type text;

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
    u.profile_photo_url,
    u.profile_photo_thumbnail_url,
    u.profile_photo_content_type,
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
    profile_photo_url text, profile_photo_thumbnail_url text, national_id_number text,
    kyc_status kyc_status, kyc_expires_at date, document_count bigint, documents_pending bigint,
    open_remediations bigint, property_count bigint, unpaid_balance numeric,
    total_count bigint
)
language sql stable as $$
    select
        u.id, u.phone_number, u.email, u.full_name, u.role, u.status, u.job_title,
        u.suspension_reason, u.organization_id, u.organization_name, u.last_login_at,
        u.created_at, u.updated_at, u.is_staff, u.profile_photo_url, u.profile_photo_thumbnail_url,
        u.national_id_number, u.kyc_status, u.kyc_expires_at, u.document_count, u.documents_pending,
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
