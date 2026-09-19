-- ---------------------------------------------------------------------------
-- Confirming a booking once the money is actually in.
--
-- The gap this closes: `enforce_booking_paid_before_confirm` (013) refuses to
-- confirm a booking that has not been settled, but nothing ever performed the
-- confirmation once it had been. Settling a payment — by provider callback in
-- `settlePayment`, or by a finance officer in `reconcilePayment` — left the
-- booking on `awaiting_payment` until somebody remembered to move it by hand
-- from the portal.
--
-- For the customer that read as "I have paid and the app still says pending":
-- the booking never reached `confirmed`, so it never appeared in
-- `v_active_rentals`, so Favourites showed no active rent and the activity
-- list still showed the property as awaiting payment.
--
-- Doing this in a trigger rather than in each service is deliberate. There is
-- more than one way a payment settles, and a rule that lives beside the money
-- cannot be forgotten by the next path that settles one.
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
        'Your booking ' || v_booking.reference || ' is confirmed',
        'We have received your payment. The home is yours.',
        'bookings',
        v_booking.id
    );

    return new;
end;
$$;

-- After, not before: the payment row must already read `successful` when
-- `enforce_booking_paid_before_confirm` re-counts what has settled.
create trigger payments_confirm_booking after update of status on payments
    for each row execute function confirm_booking_when_settled();
