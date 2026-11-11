-- ---------------------------------------------------------------------------
-- Every important event lands in the app's notification inbox, and a very few
-- — money reaching someone — also go out by SMS.
--
-- Three things live here:
--
--   A. An audience on each notification. One account holds several roles, and
--      "New enquiry" means the broker's enquiry screen to a broker and nothing
--      at all to the same person browsing as a customer. The audience is
--      worked out from what the notification is about, so the dozen places
--      that already insert notifications keep working untouched.
--
--   B. Triggers for the events nobody was told about: an enquiry arriving, a
--      payment verified or refused, a payout sent, a listing decided, an
--      identity check finished. In the database rather than the services
--      because each of these has more than one road in (a provider callback
--      and a finance officer both settle a payment), and a trigger cannot be
--      forgotten by the next road someone adds.
--
--   C. An SMS outbox. A trigger cannot call a vendor, and a vendor outage must
--      not undo a verified payment, so the text is queued in the same
--      transaction and sent after commit by src/services/notifications.
--      SMS costs money, so it is kept to the payment receipt and the payout.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- A. Audience
-- ---------------------------------------------------------------------------

-- Null means "this account": identity checks, role decisions, anything that is
-- about the person rather than one of their roles. It shows in every inbox.
alter table notifications
    add column audience text,
    add constraint notifications_audience_known
        check (audience is null or audience in ('customer', 'broker', 'landlord'));

create index idx_notifications_user_audience on notifications (user_id, audience, created_at desc);

/** The partner role this person holds on this home, if any. */
create or replace function partner_audience_on_property(p_user uuid, p_property uuid) returns text
language sql stable as $$
    select case
        when exists (select 1 from property_parties
                      where property_id = p_property and user_id = p_user and role = 'broker' and is_primary)
            then 'broker'
        when exists (select 1 from property_parties
                      where property_id = p_property and user_id = p_user and role = 'landlord' and is_primary)
            then 'landlord'
        when exists (select 1 from properties where id = p_property and owner_id = p_user)
            then 'landlord'
    end;
$$;

/*
 * Which inbox a notification belongs in, from what it points at. The person
 * an enquiry, booking or payment belongs to reads it as a customer; anyone
 * else on it is there as the home's broker or landlord.
 */
create or replace function notification_audience(p_user uuid, p_table text, p_id uuid) returns text
language sql stable as $$
    select case p_table
        when 'property_inquiries' then (
            select case when i.customer_id = p_user then 'customer'
                        else partner_audience_on_property(p_user, i.property_id) end
              from property_inquiries i where i.id = p_id)
        when 'bookings' then (
            select case when b.customer_id = p_user then 'customer'
                        else partner_audience_on_property(p_user, b.property_id) end
              from bookings b where b.id = p_id)
        when 'payments' then (
            select case when p.payer_user_id = p_user then 'customer'
                        else partner_audience_on_property(p_user, p.property_id) end
              from payments p where p.id = p_id)
        when 'properties' then partner_audience_on_property(p_user, p_id)
        when 'payment_splits' then (
            select case when s.beneficiary_type in ('broker', 'landlord') then s.beneficiary_type::text end
              from payment_splits s where s.id = p_id and s.beneficiary_user_id = p_user)
        when 'payouts' then (
            select case when o.beneficiary_type in ('broker', 'landlord') then o.beneficiary_type::text end
              from payouts o where o.id = p_id and o.beneficiary_user_id = p_user)
    end;
$$;

create or replace function set_notification_audience() returns trigger
language plpgsql as $$
begin
    if new.audience is null and new.subject_table is not null and new.subject_id is not null then
        new.audience := notification_audience(new.user_id, new.subject_table, new.subject_id);
    end if;
    return new;
end;
$$;

create trigger notifications_set_audience before insert on notifications
    for each row execute function set_notification_audience();

update notifications
   set audience = notification_audience(user_id, subject_table, subject_id)
 where audience is null and subject_table is not null and subject_id is not null;

/** One notification. Returns nothing and does nothing for a missing person. */
create or replace function notify_user(
    p_user uuid,
    p_kind notification_kind,
    p_title text,
    p_body text,
    p_subject_table text,
    p_subject_id uuid,
    p_audience text default null
) returns void
language sql as $$
    insert into notifications (user_id, kind, title, body, subject_table, subject_id, audience)
    select p_user, p_kind, p_title, nullif(btrim(p_body), ''), p_subject_table, p_subject_id, p_audience
     where p_user is not null;
$$;

/** "TZS 1,500,000" — the way the app and the SMS both write money. */
create or replace function format_money(p_amount numeric, p_currency text) returns text
language sql immutable as $$
    select coalesce(p_currency, 'TZS') || ' ' || case
        when p_amount = trunc(p_amount) then to_char(p_amount, 'FM999,999,999,990')
        else to_char(p_amount, 'FM999,999,999,990.00')
    end;
$$;

-- ---------------------------------------------------------------------------
-- C. SMS outbox (before B, which writes to it)
-- ---------------------------------------------------------------------------

create table sms_outbox (
    id uuid primary key default gen_random_uuid(),
    user_id uuid references users (id) on delete cascade,
    phone_number text not null,
    -- a template name the SMS adapter knows; the words live there, not here
    template text not null,
    params jsonb not null default '{}'::jsonb,
    subject_table text,
    subject_id uuid,
    -- one receipt per payment, however many times its row is touched
    dedupe_key text unique,
    status text not null default 'queued',
    attempts integer not null default 0,
    next_attempt_at timestamptz not null default now(),
    claimed_at timestamptz,
    last_error text,
    provider text,
    external_id text,
    sms_count integer,
    raw_response jsonb,
    created_at timestamptz not null default now(),
    sent_at timestamptz,

    constraint sms_outbox_status_known check (status in ('queued', 'sending', 'sent', 'failed'))
);

create index idx_sms_outbox_due on sms_outbox (next_attempt_at) where status in ('queued', 'sending');
create index idx_sms_outbox_user on sms_outbox (user_id, created_at desc);

/** Queues a text to this person's phone. Someone with no number is skipped, not an error. */
create or replace function queue_sms(
    p_user uuid,
    p_template text,
    p_params jsonb,
    p_subject_table text,
    p_subject_id uuid,
    p_dedupe_key text
) returns void
language sql as $$
    insert into sms_outbox (user_id, phone_number, template, params, subject_table, subject_id, dedupe_key)
    select u.id, u.phone_number, p_template, coalesce(p_params, '{}'::jsonb), p_subject_table, p_subject_id, p_dedupe_key
      from users u
     where u.id = p_user and u.phone_number is not null
    on conflict (dedupe_key) do nothing;
$$;

-- ---------------------------------------------------------------------------
-- B. Events
-- ---------------------------------------------------------------------------

/*
 * A new enquiry, to whoever is on the home. The broker answers a brokered
 * home and the landlord one nobody brokered (partner_can_answer_inquiry, 030),
 * so a landlord whose home a broker listed is told who will reply.
 */
create or replace function notify_enquiry_received() returns trigger
language plpgsql as $$
declare
    v_title text;
    v_owner uuid;
    v_broker uuid;
    v_landlord uuid;
    v_customer text;
begin
    select p.title, p.owner_id into v_title, v_owner from properties p where p.id = new.property_id;
    select user_id into v_broker from property_parties
     where property_id = new.property_id and role = 'broker' and is_primary;
    select user_id into v_landlord from property_parties
     where property_id = new.property_id and role = 'landlord' and is_primary;
    v_landlord := coalesce(v_landlord, v_owner);
    select coalesce(full_name, 'A customer') into v_customer from users where id = new.customer_id;

    if v_broker is not null and v_broker <> new.customer_id then
        perform notify_user(
            v_broker, 'enquiry_received', 'New enquiry',
            v_customer || ' asked about ' || coalesce(v_title, 'your listing') || '. Reply to keep them interested.',
            'property_inquiries', new.id, 'broker'
        );
    end if;

    if v_landlord is not null and v_landlord <> new.customer_id and v_landlord is distinct from v_broker then
        perform notify_user(
            v_landlord, 'enquiry_received', 'New enquiry',
            v_customer || ' asked about ' || coalesce(v_title, 'your home') || '.'
                || case when v_broker is not null then ' The broker who listed it will reply.' else '' end,
            'property_inquiries', new.id, 'landlord'
        );
    end if;

    return new;
end;
$$;

create trigger property_inquiries_notify_received after insert on property_inquiries
    for each row execute function notify_enquiry_received();

/*
 * A payment's outcome, to the person who paid and to everyone it pays.
 *
 * Named to fire after payments_confirm_booking (triggers on one event run in
 * name order): when this payment is the one that confirmed a reservation,
 * that trigger has already said "the home is yours", and a second "payment
 * received" beside it would be noise. The SMS receipt goes regardless — it is
 * the customer's proof of payment, not a status update.
 */
create or replace function notify_payment_outcome() returns trigger
language plpgsql as $$
declare
    v_title text;
    v_payer text;
    v_amount text := format_money(new.amount, new.currency);
    v_split record;
begin
    if new.status is not distinct from old.status then return new; end if;

    select title into v_title from properties where id = new.property_id;

    if new.status = 'successful' then
        if not exists (select 1 from bookings
                        where id = new.booking_id and status = 'confirmed' and confirmed_at = now()) then
            perform notify_user(
                new.payer_user_id, 'payment_received', 'Payment received',
                'We have verified your payment of ' || v_amount || ' (' || new.reference || ')'
                    || coalesce(' for ' || v_title, '') || '.',
                'payments', new.id, 'customer'
            );
        end if;

        perform queue_sms(
            new.payer_user_id, 'payment-received',
            jsonb_build_object('reference', new.reference, 'amount', new.amount, 'currency', new.currency,
                               'property', v_title),
            'payments', new.id, 'payment-received:' || new.id
        );

        select coalesce(full_name, 'Your tenant') into v_payer from users where id = new.payer_user_id;
        for v_split in
            select id, beneficiary_type, beneficiary_user_id, amount from payment_splits
             where payment_id = new.id and beneficiary_user_id is not null and amount > 0
        loop
            perform notify_user(
                v_split.beneficiary_user_id, 'payment_received', 'Payment received',
                coalesce(v_payer, 'A tenant') || ' paid for ' || coalesce(v_title, 'a home') || '. Your share is '
                    || format_money(v_split.amount, new.currency) || ' and goes out in your next payout.',
                'payment_splits', v_split.id,
                case when v_split.beneficiary_type in ('broker', 'landlord') then v_split.beneficiary_type::text end
            );
        end loop;

    elsif new.status = 'failed' then
        perform notify_user(
            new.payer_user_id, 'payment_due', 'We could not verify your payment',
            coalesce(new.failure_reason, 'The payment did not go through.')
                || ' If you have paid, contact us and quote ' || new.reference || '.',
            'payments', new.id, 'customer'
        );

    elsif new.status in ('refunded', 'partially_refunded', 'reversed') then
        perform notify_user(
            new.payer_user_id, 'payment_received',
            case new.status when 'reversed' then 'Your payment was reversed' else 'Your payment was refunded' end,
            coalesce(new.failure_reason, 'Payment ' || new.reference || ' of ' || v_amount || ' was '
                || case new.status when 'partially_refunded' then 'partly refunded' else replace(new.status::text, '_', ' ') end
                || '.'),
            'payments', new.id, 'customer'
        );
    end if;

    return new;
end;
$$;

create trigger payments_notify_outcome after update of status on payments
    for each row execute function notify_payment_outcome();

/* A payout sent, failed or held, to the partner it is for. Sent also by SMS. */
create or replace function notify_payout_outcome() returns trigger
language plpgsql as $$
declare
    v_amount text := format_money(new.amount, new.currency);
    v_audience text := case when new.beneficiary_type in ('broker', 'landlord') then new.beneficiary_type::text end;
begin
    if new.status is not distinct from old.status or new.beneficiary_user_id is null then return new; end if;

    if new.status = 'paid' then
        perform notify_user(
            new.beneficiary_user_id, 'payout_update', 'Payout sent',
            'We sent you ' || v_amount || ' (' || new.reference || '). It can take a few minutes to arrive.',
            'payouts', new.id, v_audience
        );
        perform queue_sms(
            new.beneficiary_user_id, 'payout-sent',
            jsonb_build_object('reference', new.reference, 'amount', new.amount, 'currency', new.currency),
            'payouts', new.id, 'payout-sent:' || new.id
        );
    elsif new.status = 'failed' then
        perform notify_user(
            new.beneficiary_user_id, 'payout_update', 'Your payout did not go through',
            coalesce(new.failure_reason, 'The transfer failed.') || ' We will try again — check your payout account is right.',
            'payouts', new.id, v_audience
        );
    elsif new.status = 'on_hold' then
        perform notify_user(
            new.beneficiary_user_id, 'payout_update', 'Your payout is on hold',
            coalesce(new.hold_reason, 'We need to check something before we pay you.'),
            'payouts', new.id, v_audience
        );
    end if;

    return new;
end;
$$;

create trigger payouts_notify_outcome after update of status on payouts
    for each row execute function notify_payout_outcome();

/*
 * A moderation decision, to the partner who made the listing in the app.
 * Listings the backoffice made itself have nobody in the app to tell.
 */
create or replace function notify_listing_decision() returns trigger
language plpgsql as $$
declare
    v_title text := coalesce(new.title, 'Your listing');
begin
    if new.status is not distinct from old.status or new.created_by_user_id is null then return new; end if;

    if new.status = 'approved' and old.status = 'pending_review' then
        perform notify_user(new.created_by_user_id, 'listing_update', 'Your listing is live',
            v_title || ' is approved and customers can now find it.', 'properties', new.id);
    elsif new.status = 'changes_requested' then
        perform notify_user(new.created_by_user_id, 'listing_update', 'Changes needed on your listing',
            v_title || ': ' || coalesce(new.rejection_reason, 'please review it and send it again.'), 'properties', new.id);
    elsif new.status = 'rejected' then
        perform notify_user(new.created_by_user_id, 'listing_update', 'Your listing was not approved',
            v_title || ': ' || coalesce(new.rejection_reason, 'contact us to find out why.'), 'properties', new.id);
    elsif new.status = 'suspended' then
        perform notify_user(new.created_by_user_id, 'listing_update', 'Your listing is paused',
            v_title || ' is hidden from customers for now. Contact us to find out why.', 'properties', new.id);
    end if;

    return new;
end;
$$;

create trigger properties_notify_decision after update of status on properties
    for each row execute function notify_listing_decision();

/* The end of an identity check. `users` + the person's id opens their ID screen. */
create or replace function notify_kyc_outcome() returns trigger
language plpgsql as $$
begin
    if new.kyc_status is not distinct from old.kyc_status then return new; end if;

    if new.kyc_status = 'verified' then
        perform notify_user(new.id, 'kyc_update', 'Your identity is verified',
            'Landlords can now see that your ID has been checked.', 'users', new.id);
    elsif new.kyc_status = 'rejected' then
        perform notify_user(new.id, 'kyc_update', 'We could not verify your identity',
            coalesce(new.kyc_rejection_reason, 'Please upload your ID again.'), 'users', new.id);
    elsif new.kyc_status = 'expired' then
        perform notify_user(new.id, 'kyc_update', 'Your ID check has expired',
            'Upload a current ID to stay verified.', 'users', new.id);
    end if;

    return new;
end;
$$;

create trigger users_notify_kyc_outcome after update of kyc_status on users
    for each row execute function notify_kyc_outcome();
