-- ---------------------------------------------------------------------------
-- Push notifications (FCM) for what lands in the in-app inbox.
--
-- Every notification is a push candidate: the inbox row (034) is the source of
-- truth, and the push is a best-effort copy of it on the person's phones. So
-- there is no second queue — each notification carries its own push state,
-- and src/services/notifications/push-outbox.mjs sends it after commit.
--
-- The trigger below `pg_notify`s on every new notification. Notifications are
-- written by a dozen triggers and services; listening for the commit means
-- none of them has to remember to ask for a push.
-- ---------------------------------------------------------------------------

/*
 * One row per app install. A token belongs to whoever signed in on that phone
 * last — registering it again under another account moves it — and is
 * disabled, not deleted, when FCM says it is dead, so the history stays.
 */
create table push_devices (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users (id) on delete cascade,
    token text not null unique,
    platform text not null,
    app_version text,
    created_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    disabled_at timestamptz,
    disabled_reason text,

    constraint push_devices_platform_known check (platform in ('android', 'ios', 'web'))
);

create index idx_push_devices_user on push_devices (user_id) where disabled_at is null;

alter table notifications
    add column push_status text not null default 'queued',
    add column push_attempts integer not null default 0,
    add column push_next_attempt_at timestamptz not null default now(),
    add column push_claimed_at timestamptz,
    add column pushed_at timestamptz,
    add constraint notifications_push_status_known
        check (push_status in ('queued', 'sending', 'sent', 'skipped', 'failed'));

-- What was already in the inbox is not news; nobody should be buzzed for it.
update notifications set push_status = 'skipped';

create index idx_notifications_push_due on notifications (push_next_attempt_at)
    where push_status in ('queued', 'sending');

/* Each attempt to reach one phone — what the push sweep did and what FCM said. */
create table push_deliveries (
    id uuid primary key default gen_random_uuid(),
    notification_id uuid not null references notifications (id) on delete cascade,
    device_id uuid not null references push_devices (id) on delete cascade,
    status text not null,
    provider text not null,
    message_id text,
    error text,
    created_at timestamptz not null default now(),

    constraint push_deliveries_status_known check (status in ('sent', 'failed', 'invalid_token'))
);

create index idx_push_deliveries_notification on push_deliveries (notification_id);

create or replace function announce_notification() returns trigger
language plpgsql as $$
begin
    -- Delivered at commit, and not at all on rollback.
    perform pg_notify('homemate_push', new.id::text);
    return new;
end;
$$;

create trigger notifications_announce after insert on notifications
    for each row execute function announce_notification();
