-- Customer authentication for the mobile app.
--
-- The phone number is proved once with an OTP; after that the customer signs
-- in with a PIN they choose. OTP is then reserved for the cases that actually
-- need to re-prove the phone: a forgotten PIN, or a new device.
--
-- Every SMS costs money, so who may ask for one — and how often — is decided
-- in the database rather than in whichever service happens to be asking.

-- ---------------------------------------------------------------------------
-- A. The PIN
-- ---------------------------------------------------------------------------

alter table users
    add column pin_hash text,
    add column pin_set_at timestamptz,
    add column pin_failed_attempts integer not null default 0,
    add column pin_locked_until timestamptz,
    add column phone_verified_at timestamptz,
    add column onboarding_completed_at timestamptz,
    add column preferred_language text not null default 'en',
    add column push_token text;

alter table users
    add constraint users_pin_attempts_non_negative check (pin_failed_attempts >= 0),
    add constraint users_language_known check (preferred_language in ('en', 'sw'));

/*
 * A PIN is only ever stored as a hash, and setting one is what marks the
 * account as having completed the security step. Clearing the failure counter
 * here means a successful reset also lifts a lockout, which is the whole
 * point of being able to reset it.
 */
create or replace function stamp_pin_change() returns trigger
language plpgsql as $$
begin
    if new.pin_hash is distinct from old.pin_hash and new.pin_hash is not null then
        new.pin_set_at := now();
        new.pin_failed_attempts := 0;
        new.pin_locked_until := null;
    end if;
    return new;
end;
$$;

create trigger users_stamp_pin_change before update of pin_hash on users
    for each row execute function stamp_pin_change();

-- ---------------------------------------------------------------------------
-- B. OTP governance
-- ---------------------------------------------------------------------------

alter table auth_otp_challenges
    add column ip_address inet,
    add column user_agent text,
    add column delivery_status text,
    add column sms_count integer;

create index idx_auth_otp_challenges_recent on auth_otp_challenges (phone_number, created_at desc);
create index idx_auth_otp_challenges_ip on auth_otp_challenges (ip_address, created_at desc);

/*
 * Every request for a code, whether it resulted in an SMS or was turned away.
 * Keeping the refusals is what makes a spike visible — a table of successes
 * only cannot tell you that someone tried two hundred times.
 */
create table otp_request_log (
    id bigserial primary key,
    phone_number text,
    ip_address inet,
    purpose text not null,
    outcome text not null,
    reason text,
    created_at timestamptz not null default now(),

    constraint otp_request_log_outcome_known check (outcome in ('sent', 'throttled', 'failed'))
);

create index idx_otp_request_log_phone on otp_request_log (phone_number, created_at desc);
create index idx_otp_request_log_ip on otp_request_log (ip_address, created_at desc);
create index idx_otp_request_log_outcome on otp_request_log (outcome, created_at desc);

insert into settings (key, value, category, description) values
    ('otp.per_phone_per_hour', '5'::jsonb, 'security', 'Codes one phone number may request per hour'),
    ('otp.per_phone_per_day', '10'::jsonb, 'security', 'Codes one phone number may request per day'),
    ('otp.per_ip_per_hour', '20'::jsonb, 'security', 'Codes one IP address may request per hour'),
    ('otp.platform_per_hour', '500'::jsonb, 'security', 'Codes the whole platform may send per hour'),
    ('otp.resend_cooldown_seconds', '60'::jsonb, 'security', 'Wait between codes to the same number'),
    ('otp.ttl_seconds', '300'::jsonb, 'security', 'How long a code stays valid'),
    ('otp.max_attempts', '5'::jsonb, 'security', 'Wrong guesses before a code is locked'),
    ('auth.pin_length', '4'::jsonb, 'security', 'Digits in a customer login PIN'),
    ('auth.pin_max_attempts', '5'::jsonb, 'security', 'Wrong PINs before the account is locked'),
    ('auth.pin_lockout_minutes', '15'::jsonb, 'security', 'How long an account stays locked after too many wrong PINs'),
    ('sms.low_balance_threshold', '200'::jsonb, 'security', 'Warn in the portal when SMS credits fall below this');

/*
 * Whether this request may have a code, decided in one place.
 *
 * Returning the reason and the retry time rather than a bare boolean means the
 * app can tell the customer "try again in 40 seconds" instead of a flat
 * refusal, and the same answer drives the portal's abuse view. The limits are
 * settings rows, so tightening them under attack does not need a deploy.
 */
create or replace function otp_quota_check(
    p_phone text,
    p_ip inet default null,
    p_purpose text default 'login'
)
returns table (allowed boolean, reason text, retry_after_seconds integer)
language plpgsql stable as $$
declare
    v_cooldown integer := coalesce((select value::text::integer from settings where key = 'otp.resend_cooldown_seconds'), 60);
    v_phone_hour integer := coalesce((select value::text::integer from settings where key = 'otp.per_phone_per_hour'), 5);
    v_phone_day integer := coalesce((select value::text::integer from settings where key = 'otp.per_phone_per_day'), 10);
    v_ip_hour integer := coalesce((select value::text::integer from settings where key = 'otp.per_ip_per_hour'), 20);
    v_platform_hour integer := coalesce((select value::text::integer from settings where key = 'otp.platform_per_hour'), 500);
    v_last timestamptz;
    v_count integer;
begin
    -- Only delivered codes count against a quota; a refusal must not deepen
    -- the hole the caller is already in.
    select max(created_at) into v_last
      from otp_request_log
     where phone_number = p_phone and outcome = 'sent';

    if v_last is not null and v_last > now() - make_interval(secs => v_cooldown) then
        return query select
            false,
            'Please wait before asking for another code'::text,
            greatest(1, v_cooldown - extract(epoch from (now() - v_last))::integer);
        return;
    end if;

    select count(*) into v_count
      from otp_request_log
     where phone_number = p_phone and outcome = 'sent' and created_at > now() - interval '1 hour';
    if v_count >= v_phone_hour then
        return query select false, 'Too many codes requested for this number this hour'::text, 3600;
        return;
    end if;

    select count(*) into v_count
      from otp_request_log
     where phone_number = p_phone and outcome = 'sent' and created_at > now() - interval '1 day';
    if v_count >= v_phone_day then
        return query select false, 'Too many codes requested for this number today'::text, 86400;
        return;
    end if;

    if p_ip is not null then
        select count(*) into v_count
          from otp_request_log
         where ip_address = p_ip and outcome = 'sent' and created_at > now() - interval '1 hour';
        if v_count >= v_ip_hour then
            return query select false, 'Too many codes requested from this device this hour'::text, 3600;
            return;
        end if;
    end if;

    -- The backstop: whatever the per-caller limits allow, the platform will
    -- not burn more than this many credits in an hour.
    select count(*) into v_count
      from otp_request_log
     where outcome = 'sent' and created_at > now() - interval '1 hour';
    if v_count >= v_platform_hour then
        return query select false, 'The service is busy — please try again shortly'::text, 3600;
        return;
    end if;

    return query select true, null::text, 0;
end;
$$;

-- What the portal shows about SMS spend and abuse.
create view v_otp_activity as
select
    date_trunc('hour', created_at) as hour,
    count(*) filter (where outcome = 'sent') as sent,
    count(*) filter (where outcome = 'throttled') as throttled,
    count(*) filter (where outcome = 'failed') as failed,
    count(distinct phone_number) as distinct_numbers,
    count(distinct ip_address) as distinct_ips
from otp_request_log
where created_at > now() - interval '7 days'
group by 1;

create view v_otp_top_requesters as
select
    phone_number,
    ip_address,
    count(*) filter (where outcome = 'sent') as sent,
    count(*) filter (where outcome = 'throttled') as throttled,
    max(created_at) as last_seen
from otp_request_log
where created_at > now() - interval '1 day'
group by phone_number, ip_address
having count(*) > 3;
