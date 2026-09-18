-- Identity & Access foundation (FR-IAM-001..003).
--
-- HomeMate entities (ours, canonical) vs. external entities (foreign,
-- mirrored) are kept in separate tables from the very first migration —
-- see IMPLEMENTATION_PLAN.md Section 2.1. `users` and `auth_otp_challenges`
-- are HomeMate entities we own outright. `external_notification_events`
-- is a verbatim record of what the NotificationPort adapter sent/received
-- from whatever SMS/email vendor is wired in later; it is never mutated,
-- only appended to, and domain logic never reads from it directly.

create table if not exists users (
    id uuid primary key default gen_random_uuid(),
    phone_number text not null unique,
    display_name text,
    status text not null default 'active' check (status in ('active', 'suspended')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists auth_otp_challenges (
    id uuid primary key default gen_random_uuid(),
    phone_number text not null,
    purpose text not null default 'login',
    code_hash text not null,
    expires_at timestamptz not null,
    attempts integer not null default 0,
    max_attempts integer not null default 5,
    consumed_at timestamptz,
    created_at timestamptz not null default now()
);

create index if not exists idx_auth_otp_challenges_phone_number
    on auth_otp_challenges (phone_number);

create table if not exists external_notification_events (
    id uuid primary key default gen_random_uuid(),
    otp_challenge_id uuid references auth_otp_challenges (id),
    channel text not null,
    provider text not null,
    external_id text,
    status text not null,
    raw_payload jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create index if not exists idx_external_notification_events_challenge
    on external_notification_events (otp_challenge_id);
