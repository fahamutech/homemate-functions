-- Partner onboarding (partner roles, T03).
--
-- A signed-in customer applies to become a broker or a landlord (BRK-002a–e,
-- LND-002a–d): details → identity → (landlords: ownership) → getting paid →
-- agreement → submit, then a moderator decides. The application is the
-- person's `user_roles` row from 027; the evidence is the person's own KYC
-- fields and documents from 009 — identity belongs to the person, not the
-- role, so a verified customer is not asked again.

-- ---------------------------------------------------------------------------
-- Getting paid: which method the person chose, and the wallet's owner name
-- ---------------------------------------------------------------------------

alter table users
    add column payout_method text,
    add column mobile_money_account_name text,
    add constraint users_payout_method_known
        check (payout_method is null or payout_method in ('mobile_money', 'bank'));

-- Banks a payout may go to. Codes are what users.bank_name stores.
insert into dictionary_items (category, code, name, sort_order) values
    ('bank', 'crdb', 'CRDB Bank', 10),
    ('bank', 'nmb', 'NMB Bank', 20),
    ('bank', 'nbc', 'NBC Bank', 30),
    ('bank', 'stanbic', 'Stanbic Bank', 40),
    ('bank', 'absa', 'Absa Bank Tanzania', 50),
    ('bank', 'equity', 'Equity Bank', 60),
    ('bank', 'exim', 'Exim Bank', 70),
    ('bank', 'dtb', 'Diamond Trust Bank', 80),
    ('bank', 'azania', 'Azania Bank', 90),
    ('bank', 'akiba', 'Akiba Commercial Bank', 100),
    ('bank', 'tcb', 'Tanzania Commercial Bank', 110),
    ('bank', 'standard_chartered', 'Standard Chartered', 120)
on conflict (category, code) do nothing;

-- The partner agreement each role must accept. Bumping a version reopens the
-- agreement step for anyone who accepted an older one.
insert into settings (key, value, category, description) values
    ('partner.agreement_version.broker', '"v1.0"'::jsonb, 'partners', 'Current broker agreement version applicants must accept'),
    ('partner.agreement_version.landlord', '"v1.0"'::jsonb, 'partners', 'Current landlord agreement version applicants must accept')
on conflict (key) do nothing;

create or replace function partner_agreement_version(p_role user_role) returns text
language sql stable as $$
    select value #>> '{}' from settings where key = 'partner.agreement_version.' || p_role::text;
$$;

-- ---------------------------------------------------------------------------
-- Stamping the lifecycle of a role
-- ---------------------------------------------------------------------------

/*
 * Who did what, when, on a user_roles row — so no service writes these by
 * hand. Applying, submitting and activation stamp their own time; a
 * moderator's decision on a submitted application stamps the reviewer; and
 * leaving `rejected` clears the old reason (a reapplication starts clean).
 */
create or replace function stamp_user_role_lifecycle() returns trigger
language plpgsql as $$
begin
    if tg_op = 'UPDATE' and new.status is not distinct from old.status then
        return new;
    end if;

    if new.status = 'applied' and new.applied_at is null then
        new.applied_at := now();
    end if;
    if new.status = 'pending_review' then
        new.submitted_at := now();
    end if;
    -- Becoming active (an update) always restamps; an insert keeps a given time.
    if new.status = 'active' and (tg_op = 'UPDATE' or new.activated_at is null) then
        new.activated_at := now();
    end if;

    if tg_op = 'UPDATE' and old.status = 'pending_review'
       and new.status in ('active', 'action_needed', 'rejected') then
        new.reviewed_at := now();
        new.reviewed_by := coalesce(current_actor(), new.reviewed_by);
    end if;

    if tg_op = 'UPDATE' and old.status = 'rejected' and new.status <> 'rejected' then
        new.rejection_reason := null;
    end if;

    return new;
end;
$$;

create trigger user_roles_stamp_lifecycle before insert or update of status on user_roles
    for each row execute function stamp_user_role_lifecycle();

/*
 * Approving a partner is also a look at the person's identity. When the
 * moderator verified an ID document and a selfie as part of that review, the
 * person is verified too; otherwise their KYC status is left alone.
 */
create or replace function verify_person_on_partner_approval() returns trigger
language plpgsql as $$
begin
    if new.status = 'active' and old.status = 'pending_review'
       and exists (select 1 from kyc_documents d
                    where d.user_id = new.user_id and d.status = 'verified'
                      and d.document_type in ('national_id', 'passport', 'drivers_licence', 'voters_id'))
       and exists (select 1 from kyc_documents d
                    where d.user_id = new.user_id and d.status = 'verified' and d.document_type = 'selfie')
    then
        update users set kyc_status = 'verified' where id = new.user_id and kyc_status <> 'verified';
    end if;
    return new;
end;
$$;

create trigger user_roles_verify_person_on_approval after update of status on user_roles
    for each row execute function verify_person_on_partner_approval();

-- ---------------------------------------------------------------------------
-- Step state
-- ---------------------------------------------------------------------------

/*
 * The one answer to "how far is this application?", for the app and the
 * backoffice alike. Evidence that was rejected does not count; a person
 * whose KYC is already verified has the identity step done.
 *
 * {role, status, steps: {details, identity, [ownership], payout, agreement},
 *  missingSteps, complete, identityVerified, agreementVersion,
 *  currentAgreementVersion, canDraftListings, canSubmitListings,
 *  appliedAt, submittedAt, activatedAt, reviewedAt, rejectionReason}
 */
create or replace function partner_application_state(p_user uuid, p_role user_role) returns jsonb
language plpgsql stable as $$
declare
    v_user users%rowtype;
    v_role user_roles%rowtype;
    v_current_version text := partner_agreement_version(p_role);
    v_steps jsonb;
    v_missing text[];
begin
    if p_role not in ('broker', 'landlord') then
        raise exception 'Only broker and landlord are applied for, got %', p_role
            using errcode = 'check_violation';
    end if;

    select * into v_user from users where id = p_user;
    if not found then
        return null;
    end if;
    select * into v_role from user_roles where user_id = p_user and role = p_role;

    v_steps := jsonb_build_object(
        'details',
            nullif(btrim(v_user.full_name), '') is not null
            and v_user.date_of_birth is not null
            and nullif(btrim(v_user.national_id_number), '') is not null
            and nullif(btrim(v_user.physical_address), '') is not null,
        'identity',
            v_user.kyc_status = 'verified'
            or (exists (select 1 from kyc_documents d
                         where d.user_id = p_user and d.status <> 'rejected'
                           and d.document_type in ('national_id', 'passport', 'drivers_licence', 'voters_id'))
                and exists (select 1 from kyc_documents d
                             where d.user_id = p_user and d.status <> 'rejected' and d.document_type = 'selfie')),
        'payout',
            case v_user.payout_method
                when 'mobile_money' then v_user.mobile_money_provider is not null and v_user.mobile_money_number is not null
                when 'bank' then v_user.bank_name is not null and v_user.bank_account_name is not null
                                 and v_user.bank_account_number is not null
                else false
            end,
        'agreement',
            v_role.agreement_accepted_at is not null and v_role.agreement_version = v_current_version
    );

    if p_role = 'landlord' then
        v_steps := v_steps || jsonb_build_object(
            'ownership',
            exists (select 1 from kyc_documents d
                     where d.user_id = p_user and d.status <> 'rejected'
                       and d.document_type in ('title_deed', 'utility_bill'))
        );
    end if;

    select coalesce(array_agg(step order by ordinal), '{}') into v_missing
      from unnest(array['details', 'identity', 'ownership', 'payout', 'agreement']) with ordinality as s (step, ordinal)
     where v_steps ? step and not (v_steps ->> step)::boolean;

    return jsonb_build_object(
        'role', p_role,
        'status', v_role.status,
        'steps', v_steps,
        'missingSteps', to_jsonb(v_missing),
        'complete', cardinality(v_missing) = 0,
        'identityVerified', v_user.kyc_status = 'verified',
        'agreementVersion', v_role.agreement_version,
        'currentAgreementVersion', v_current_version,
        'canDraftListings', coalesce(v_role.status in ('applied', 'pending_review', 'action_needed', 'active'), false),
        'canSubmitListings', coalesce(v_role.status = 'active', false),
        'appliedAt', v_role.applied_at,
        'submittedAt', v_role.submitted_at,
        'activatedAt', v_role.activated_at,
        'reviewedAt', v_role.reviewed_at,
        'rejectionReason', v_role.rejection_reason
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- The backoffice badge for the partner applications queue
-- ---------------------------------------------------------------------------

create or replace view v_attention_counts as
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
        as payments_needing_instructions,
    (select count(*) from user_roles
      where role in ('broker', 'landlord') and status = 'pending_review') as partner_applications_pending;
