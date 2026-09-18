-- Two domains:
--   A. KYC — the identity evidence an enterprise platform must hold on the
--      people who transact, plus the review/remediation workflow around it.
--   B. Money — rent collected from a tenant, split between landlord, broker
--      and agency, with HomeMate keeping its commission. HomeMate connects
--      the parties, so every shilling must be traceable from the payment that
--      brought it in to the payout that sent it on.

-- ===========================================================================
-- A. KYC
-- ===========================================================================

create type kyc_status as enum ('not_started', 'pending', 'in_review', 'verified', 'rejected', 'expired');
create type kyc_document_type as enum (
    'national_id',      -- NIDA
    'passport',
    'drivers_licence',
    'voters_id',
    'tin_certificate',
    'business_licence', -- BRELA
    'title_deed',
    'utility_bill',
    'bank_statement',
    'selfie',
    'other'
);
create type kyc_document_status as enum ('pending', 'verified', 'rejected');

alter table users
    add column profile_photo_media_id uuid,
    add column date_of_birth date,
    add column gender text,
    add column nationality text default 'TZ',
    add column national_id_number text,
    add column tin_number text,
    add column physical_address text,
    add column postal_address text,
    add column emergency_contact_name text,
    add column emergency_contact_phone text,
    add column next_of_kin_name text,
    add column next_of_kin_phone text,
    add column bank_name text,
    add column bank_account_name text,
    add column bank_account_number text,
    add column mobile_money_provider text,
    add column mobile_money_number text,
    add column kyc_status kyc_status not null default 'not_started',
    add column kyc_reviewed_at timestamptz,
    add column kyc_reviewed_by text,
    add column kyc_rejection_reason text,
    add column kyc_expires_at date,
    add column notes text;

alter table users
    add constraint users_kyc_rejection_reason_required
        check ((kyc_status = 'rejected') = (kyc_rejection_reason is not null)),
    add constraint users_dob_sane
        check (date_of_birth is null or date_of_birth < current_date),
    add constraint users_gender_known
        check (gender is null or gender in ('female', 'male', 'other', 'undisclosed'));

create index idx_users_kyc_status on users (kyc_status);

/*
 * KYC documents. The file lives in object storage (StoragePort); this row is
 * the record of it, its review outcome, and — for an ID — the number and
 * expiry an operator checked it against.
 */
create table kyc_documents (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users (id) on delete cascade,
    document_type kyc_document_type not null,
    status kyc_document_status not null default 'pending',
    storage_key text not null,
    thumbnail_key text,
    content_type text not null,
    size_bytes bigint,
    original_filename text,
    document_number text,
    issued_on date,
    expires_on date,
    rejection_reason text,
    reviewed_at timestamptz,
    reviewed_by text,
    uploaded_by text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint kyc_documents_rejection_reason_required
        check ((status = 'rejected') = (rejection_reason is not null)),
    constraint kyc_documents_expiry_after_issue
        check (expires_on is null or issued_on is null or expires_on > issued_on)
);

create index idx_kyc_documents_user on kyc_documents (user_id, created_at desc);
create index idx_kyc_documents_status on kyc_documents (status);

create trigger kyc_documents_set_updated_at before update on kyc_documents
    for each row execute function set_updated_at();
create trigger kyc_documents_audit after insert or update or delete on kyc_documents
    for each row execute function audit_row_change();

-- Stamp who reviewed a document, and keep the reason tidy.
create or replace function stamp_kyc_document_review() returns trigger
language plpgsql as $$
begin
    if new.status is distinct from old.status and new.status in ('verified', 'rejected') then
        new.reviewed_at := now();
        new.reviewed_by := coalesce(current_actor(), new.reviewed_by);
    end if;
    if new.status <> 'rejected' then
        new.rejection_reason := null;
    end if;
    return new;
end;
$$;

create trigger kyc_documents_stamp_review before update of status on kyc_documents
    for each row execute function stamp_kyc_document_review();

-- Same for the account-level KYC decision.
create or replace function stamp_user_kyc_review() returns trigger
language plpgsql as $$
begin
    if new.kyc_status is distinct from old.kyc_status and new.kyc_status in ('verified', 'rejected') then
        new.kyc_reviewed_at := now();
        new.kyc_reviewed_by := coalesce(current_actor(), new.kyc_reviewed_by);
    end if;
    if new.kyc_status <> 'rejected' then
        new.kyc_rejection_reason := null;
    end if;
    return new;
end;
$$;

create trigger users_stamp_kyc_review before update of kyc_status on users
    for each row execute function stamp_user_kyc_review();

-- Remediation: what an operator asked the user to fix, and whether it is done.
create table kyc_remediations (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users (id) on delete cascade,
    kyc_document_id uuid references kyc_documents (id) on delete set null,
    issue text not null,
    requested_action text not null,
    resolved boolean not null default false,
    resolved_at timestamptz,
    resolved_by text,
    resolution_note text,
    raised_by text,
    created_at timestamptz not null default now(),

    constraint kyc_remediations_issue_not_blank check (length(btrim(issue)) > 0)
);

create index idx_kyc_remediations_user on kyc_remediations (user_id, resolved, created_at desc);

create trigger kyc_remediations_audit after insert or update or delete on kyc_remediations
    for each row execute function audit_row_change();

create or replace function stamp_kyc_remediation_resolution() returns trigger
language plpgsql as $$
begin
    if new.resolved and not old.resolved then
        new.resolved_at := now();
        new.resolved_by := coalesce(current_actor(), new.resolved_by);
    elsif not new.resolved then
        new.resolved_at := null;
        new.resolved_by := null;
    end if;
    return new;
end;
$$;

create trigger kyc_remediations_stamp_resolution before update on kyc_remediations
    for each row execute function stamp_kyc_remediation_resolution();

-- ===========================================================================
-- B. Money: collection → split → disbursement
-- ===========================================================================

create type payment_purpose as enum ('rent', 'deposit', 'advance_rent', 'service_charge', 'other');
create type payment_status as enum ('pending', 'successful', 'failed', 'reversed', 'refunded', 'partially_refunded');
create type payout_status as enum ('scheduled', 'processing', 'paid', 'failed', 'cancelled', 'on_hold');
create type ledger_direction as enum ('credit', 'debit');
create type beneficiary_type as enum ('landlord', 'broker', 'agency', 'platform');

/*
 * A payment is money coming IN from a tenant. Per BR-005 it opens as pending
 * and only a trusted provider confirmation (or an authorised reconciliation)
 * may move it to successful — enforced by a trigger below, not by trust.
 */
create table payments (
    id uuid primary key default gen_random_uuid(),
    reference text not null unique,
    property_id uuid references properties (id) on delete set null,
    payer_user_id uuid references users (id) on delete set null,
    payment_method_id uuid references payment_methods (id),
    purpose payment_purpose not null default 'rent',
    amount numeric(14, 2) not null,
    currency text not null default 'TZS',
    status payment_status not null default 'pending',
    provider text,
    provider_reference text,
    period_start date,
    period_end date,
    failure_reason text,
    confirmed_at timestamptz,
    confirmed_by text,
    reconciled_at timestamptz,
    notes text,
    created_by text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint payments_amount_positive check (amount > 0),
    constraint payments_failure_reason_required
        check ((status in ('failed', 'reversed')) = (failure_reason is not null)),
    constraint payments_period_sane check (period_end is null or period_start is null or period_end >= period_start)
);

create index idx_payments_status on payments (status, created_at desc);
create index idx_payments_property on payments (property_id);
create index idx_payments_payer on payments (payer_user_id);

create trigger payments_set_updated_at before update on payments
    for each row execute function set_updated_at();
create trigger payments_audit after insert or update or delete on payments
    for each row execute function audit_row_change();

-- Verbatim provider callbacks. External entity — never mutated, never read by
-- domain logic directly (IMPLEMENTATION_PLAN.md Section 2.1).
create table external_payment_events (
    id uuid primary key default gen_random_uuid(),
    payment_id uuid references payments (id) on delete set null,
    reference text,
    provider text not null,
    provider_reference text,
    status text,
    raw_payload jsonb not null default '{}'::jsonb,
    received_at timestamptz not null default now()
);

create index idx_external_payment_events_payment on external_payment_events (payment_id, received_at desc);

/*
 * Payment lifecycle. A payment may not simply be declared successful: the
 * move to `successful` requires a provider confirmation to exist for it (an
 * external event) or an explicit authorised reconciliation. This is BR-005
 * expressed where it cannot be bypassed.
 */
create or replace function enforce_payment_status_transition() returns trigger
language plpgsql as $$
declare
    v_allowed payment_status[];
    v_has_provider_evidence boolean;
begin
    if new.status = old.status then
        return new;
    end if;

    v_allowed := case old.status
        when 'pending'             then array['successful', 'failed']::payment_status[]
        when 'successful'          then array['reversed', 'refunded', 'partially_refunded']::payment_status[]
        when 'failed'              then array['pending']::payment_status[]
        when 'reversed'            then array[]::payment_status[]
        when 'refunded'            then array[]::payment_status[]
        when 'partially_refunded'  then array['refunded']::payment_status[]
    end;

    if not (new.status = any (v_allowed)) then
        raise exception 'Illegal payment status transition: % -> %', old.status, new.status
            using errcode = 'check_violation';
    end if;

    if new.status = 'successful' then
        select exists (
            select 1 from external_payment_events e
             where e.payment_id = new.id and lower(e.status) in ('successful', 'success', 'completed', 'paid')
        ) into v_has_provider_evidence;

        if not v_has_provider_evidence and new.reconciled_at is null then
            raise exception 'A payment can only be marked successful by a provider confirmation or an authorised reconciliation'
                using errcode = 'check_violation';
        end if;

        new.confirmed_at := now();
        new.confirmed_by := coalesce(current_actor(), new.confirmed_by);
    end if;

    return new;
end;
$$;

create trigger payments_enforce_status_transition before update of status on payments
    for each row execute function enforce_payment_status_transition();

/*
 * How a successful payment is split. One row per beneficiary; the rows for a
 * payment must add up to the payment amount, which a deferred constraint
 * trigger checks at commit.
 */
create table payment_splits (
    id uuid primary key default gen_random_uuid(),
    payment_id uuid not null references payments (id) on delete cascade,
    beneficiary_type beneficiary_type not null,
    beneficiary_user_id uuid references users (id) on delete set null,
    amount numeric(14, 2) not null,
    percentage numeric(5, 2),
    payout_id uuid,
    created_at timestamptz not null default now(),

    constraint payment_splits_amount_non_negative check (amount >= 0),
    constraint payment_splits_beneficiary_present
        check (beneficiary_type = 'platform' or beneficiary_user_id is not null)
);

create index idx_payment_splits_payment on payment_splits (payment_id);
create index idx_payment_splits_beneficiary on payment_splits (beneficiary_user_id);
create index idx_payment_splits_unpaid on payment_splits (payout_id) where payout_id is null;

create trigger payment_splits_audit after insert or update or delete on payment_splits
    for each row execute function audit_row_change();

create or replace function assert_splits_balance() returns trigger
language plpgsql as $$
declare
    v_payment_id uuid := coalesce(new.payment_id, old.payment_id);
    v_amount numeric;
    v_split_total numeric;
begin
    select amount into v_amount from payments where id = v_payment_id;
    if v_amount is null then
        return null;  -- payment was deleted in the same transaction
    end if;

    select coalesce(sum(amount), 0) into v_split_total from payment_splits where payment_id = v_payment_id;

    if v_split_total <> 0 and v_split_total <> v_amount then
        raise exception 'Payment splits (%) must add up to the payment amount (%)', v_split_total, v_amount
            using errcode = 'check_violation';
    end if;
    return null;
end;
$$;

create constraint trigger payment_splits_balance
    after insert or update or delete on payment_splits
    deferrable initially deferred
    for each row execute function assert_splits_balance();

/*
 * A payout is money going OUT to a beneficiary. It gathers the splits owed to
 * them; marking it paid stamps who released it.
 */
create table payouts (
    id uuid primary key default gen_random_uuid(),
    reference text not null unique,
    beneficiary_type beneficiary_type not null,
    beneficiary_user_id uuid references users (id) on delete set null,
    amount numeric(14, 2) not null,
    currency text not null default 'TZS',
    status payout_status not null default 'scheduled',
    payment_method_id uuid references payment_methods (id),
    destination text,
    provider_reference text,
    failure_reason text,
    hold_reason text,
    scheduled_for date,
    paid_at timestamptz,
    approved_by text,
    created_by text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint payouts_amount_positive check (amount > 0),
    constraint payouts_failure_reason_required check ((status = 'failed') = (failure_reason is not null)),
    constraint payouts_hold_reason_required check ((status = 'on_hold') = (hold_reason is not null))
);

create index idx_payouts_status on payouts (status, created_at desc);
create index idx_payouts_beneficiary on payouts (beneficiary_user_id);

create trigger payouts_set_updated_at before update on payouts
    for each row execute function set_updated_at();
create trigger payouts_audit after insert or update or delete on payouts
    for each row execute function audit_row_change();

alter table payment_splits
    add constraint payment_splits_payout_fk foreign key (payout_id) references payouts (id) on delete set null;

create or replace function enforce_payout_status_transition() returns trigger
language plpgsql as $$
declare
    v_allowed payout_status[];
begin
    if new.status = old.status then
        return new;
    end if;

    v_allowed := case old.status
        when 'scheduled'  then array['processing', 'on_hold', 'cancelled']::payout_status[]
        when 'processing' then array['paid', 'failed', 'on_hold']::payout_status[]
        when 'on_hold'    then array['scheduled', 'cancelled']::payout_status[]
        when 'failed'     then array['scheduled', 'cancelled']::payout_status[]
        when 'paid'       then array[]::payout_status[]
        when 'cancelled'  then array[]::payout_status[]
    end;

    if not (new.status = any (v_allowed)) then
        raise exception 'Illegal payout status transition: % -> %', old.status, new.status
            using errcode = 'check_violation';
    end if;

    if new.status = 'paid' then
        new.paid_at := now();
        new.approved_by := coalesce(current_actor(), new.approved_by);
    end if;
    if new.status <> 'failed' then
        new.failure_reason := null;
    end if;
    if new.status <> 'on_hold' then
        new.hold_reason := null;
    end if;

    return new;
end;
$$;

create trigger payouts_enforce_status_transition before update of status on payouts
    for each row execute function enforce_payout_status_transition();

/*
 * Append-only double-entry ledger (BR-010: no destructive edits; corrections
 * are compensating entries). Written by triggers so every confirmed payment
 * and released payout lands here without anyone remembering to do it.
 */
create table ledger_entries (
    id bigserial primary key,
    entry_date timestamptz not null default now(),
    account text not null,
    direction ledger_direction not null,
    amount numeric(14, 2) not null,
    currency text not null default 'TZS',
    payment_id uuid references payments (id) on delete set null,
    payout_id uuid references payouts (id) on delete set null,
    beneficiary_user_id uuid references users (id) on delete set null,
    description text,
    created_at timestamptz not null default now(),

    constraint ledger_entries_amount_positive check (amount > 0)
);

create index idx_ledger_entries_account on ledger_entries (account, entry_date desc);
create index idx_ledger_entries_payment on ledger_entries (payment_id);
create index idx_ledger_entries_beneficiary on ledger_entries (beneficiary_user_id, entry_date desc);

-- The ledger is append-only.
create or replace function reject_ledger_mutation() returns trigger
language plpgsql as $$
begin
    raise exception 'The ledger is append-only — post a compensating entry instead of % ing one', lower(tg_op)
        using errcode = 'check_violation';
end;
$$;

create trigger ledger_entries_no_update before update or delete on ledger_entries
    for each row execute function reject_ledger_mutation();

-- A confirmed payment posts its collection and its splits to the ledger.
create or replace function post_payment_to_ledger() returns trigger
language plpgsql as $$
begin
    if new.status = 'successful' and old.status is distinct from 'successful' then
        insert into ledger_entries (account, direction, amount, currency, payment_id, description)
        values ('cash.collections', 'debit', new.amount, new.currency, new.id,
                format('Payment %s received', new.reference));

        insert into ledger_entries (account, direction, amount, currency, payment_id, beneficiary_user_id, description)
        select
            case s.beneficiary_type
                when 'platform' then 'revenue.commission'
                else 'liability.payable.' || s.beneficiary_type::text
            end,
            'credit', s.amount, new.currency, new.id, s.beneficiary_user_id,
            format('%s share of payment %s', initcap(s.beneficiary_type::text), new.reference)
        from payment_splits s
        where s.payment_id = new.id;
    end if;
    return new;
end;
$$;

create trigger payments_post_to_ledger after update of status on payments
    for each row execute function post_payment_to_ledger();

-- A released payout discharges the liability.
create or replace function post_payout_to_ledger() returns trigger
language plpgsql as $$
begin
    if new.status = 'paid' and old.status is distinct from 'paid' then
        insert into ledger_entries (account, direction, amount, currency, payout_id, beneficiary_user_id, description)
        values ('liability.payable.' || new.beneficiary_type::text, 'debit', new.amount, new.currency,
                new.id, new.beneficiary_user_id, format('Payout %s released', new.reference));

        insert into ledger_entries (account, direction, amount, currency, payout_id, description)
        values ('cash.disbursements', 'credit', new.amount, new.currency, new.id,
                format('Payout %s released', new.reference));
    end if;
    return new;
end;
$$;

create trigger payouts_post_to_ledger after update of status on payouts
    for each row execute function post_payout_to_ledger();

-- Human-readable references: HM-PAY-000001 / HM-PO-000001
create sequence payment_reference_seq;
create sequence payout_reference_seq;

create or replace function assign_payment_reference() returns trigger
language plpgsql as $$
begin
    if new.reference is null or length(btrim(new.reference)) = 0 then
        new.reference := 'HM-PAY-' || lpad(nextval('payment_reference_seq')::text, 6, '0');
    end if;
    return new;
end;
$$;

create trigger payments_assign_reference before insert on payments
    for each row execute function assign_payment_reference();

create or replace function assign_payout_reference() returns trigger
language plpgsql as $$
begin
    if new.reference is null or length(btrim(new.reference)) = 0 then
        new.reference := 'HM-PO-' || lpad(nextval('payout_reference_seq')::text, 6, '0');
    end if;
    return new;
end;
$$;

create trigger payouts_assign_reference before insert on payouts
    for each row execute function assign_payout_reference();

-- Commission defaults, configurable per BR-004.
insert into settings (key, value, category, description) values
    ('commission.platform_percentage', '10'::jsonb, 'commission', 'Share of collected rent HomeMate retains'),
    ('payouts.minimum_amount', '10000'::jsonb, 'payments', 'Smallest balance that may be paid out'),
    ('payouts.schedule_days', '7'::jsonb, 'payments', 'Days after collection that a payout becomes due');
