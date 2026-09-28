-- ---------------------------------------------------------------------------
-- The message a customer gets when their payment is verified, in the terms of
-- the journey they actually took: enquire, be accepted, pay, be verified.
-- "Your booking HM-BK-… is confirmed" named a step that no longer exists for
-- them. Only the notification wording changes; the function is otherwise
-- reproduced from 021 because Postgres replaces a function whole.
-- ---------------------------------------------------------------------------

create or replace function confirm_booking_when_settled() returns trigger
language plpgsql as $$
declare
    v_booking bookings%rowtype;
    v_settled numeric;
    v_start date;
begin
    if new.booking_id is null then return new; end if;
    if new.status is not distinct from old.status then return new; end if;
    if new.status <> 'successful' then return new; end if;

    select * into v_booking from bookings where id = new.booking_id for update;
    if not found then return new; end if;

    -- Only a booking that is waiting for this money. A cancelled or expired
    -- one must not spring back to life because a late payment landed, and one
    -- already confirmed or active has nothing to do here.
    if v_booking.status <> 'awaiting_payment' then return new; end if;

    select coalesce(sum(amount), 0) into v_settled
      from payments
     where booking_id = new.booking_id and status = 'successful';

    -- A part payment is progress, not a tenancy. The booking stays where it is
    -- until the whole of what was agreed has settled.
    if v_settled < v_booking.total_due then return new; end if;

    -- The lease runs from the day they said they would move in, or from today
    -- when they named no day — a confirmed booking with no dates produces a
    -- rental card with no next payment on it.
    v_start := coalesce(v_booking.lease_start_date, v_booking.move_in_date, current_date);

    update bookings
       set status = 'confirmed',
           confirmed_at = coalesce(confirmed_at, now()),
           lease_start_date = v_start,
           lease_end_date = coalesce(
               lease_end_date,
               (v_start + make_interval(months => coalesce(lease_months, 12)))::date
           )
     where id = new.booking_id;

    -- The hold exists to keep the property while they pay. They have paid, so
    -- it has done its job — and leaving it live would block the one-unreleased-
    -- hold-per-property index against the very customer who now holds a lease.
    update property_holds
       set released_at = now(),
           release_reason = coalesce(release_reason, 'converted')
     where booking_id = new.booking_id and released_at is null;

    insert into notifications (user_id, kind, title, body, subject_table, subject_id)
    values (
        v_booking.customer_id,
        'booking_update',
        'Payment verified — the home is yours',
        'We have verified your payment for ' || coalesce(
            (select title from properties where id = v_booking.property_id), 'your new home'
        ) || '. Your rental and lease are in the app.',
        'bookings',
        v_booking.id
    );

    return new;
end;
$$;
