-- Staff portal access.
--
-- Until now the only way into /admin/* was a single, env-predefined admin
-- account (see src/services/admin-access) — a staff row created through
-- "Invite staff" had no password and no way to actually sign in. This adds:
--   * a real, hashed password per backoffice account (staff authenticate by
--     email + password; platform users keep phone-OTP and never get one), and
--   * a per-account ACL of which sidebar sections a non-admin staff member
--     may open (role=admin always has full access and ignores it).
--
-- Portal sign-in for staff also requires kyc_status = 'verified' (enforced in
-- application code) — the same identity-review workflow already built for
-- platform users in 009_kyc_and_payments.sql, reused rather than duplicated.

alter table users
    add column password_hash text,
    add column allowed_routes jsonb;

comment on column users.password_hash is
    'Backoffice staff only (moderator/manager/finance_auditor/admin) — hash of their portal password. Platform users sign in by phone OTP and never have one.';
comment on column users.allowed_routes is
    'Backoffice staff only, non-admin roles: sidebar section keys (e.g. "properties", "payments") this account may open in the portal. Role=admin always has full access and ignores this column.';

-- v_users has an explicit column list; appending here (rather than dropping
-- and recreating) preserves every existing consumer's column order and
-- leaves search_users, which does not select this column, untouched.
create or replace view v_users as
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
    coalesce((
        select sum(s.amount) from payment_splits s
          join payments p on p.id = s.payment_id
         where s.beneficiary_user_id = u.id and s.payout_id is null and p.status = 'successful'
    ), 0) as unpaid_balance,
    u.allowed_routes
from users u
left join organizations o on o.id = u.organization_id;
