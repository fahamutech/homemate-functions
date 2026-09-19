-- ---------------------------------------------------------------------------
-- Repair the bookings that were already stranded.
--
-- 021 makes settlement confirm a booking from here on, but it fires on a
-- payment *changing* status. Every booking whose money had already settled
-- before that trigger existed is still sitting on `awaiting_payment`, and
-- nothing will ever move it — the customer paid, and the app will go on showing
-- them a pending booking and no active rent for as long as the row lives.
--
-- So this is a one-off data fix, and it applies exactly the rule 021 applies:
-- fully settled, still awaiting payment, and nothing else touched.
-- ---------------------------------------------------------------------------

with settled as (
    select b.id,
           coalesce(b.lease_start_date, b.move_in_date, current_date) as start_on,
           coalesce(b.lease_months, 12) as months
      from bookings b
     where b.status = 'awaiting_payment'
       and b.total_due <= (
           select coalesce(sum(p.amount), 0)
             from payments p
            where p.booking_id = b.id and p.status = 'successful'
       )
)
update bookings b
   set status = 'confirmed',
       confirmed_at = coalesce(b.confirmed_at, now()),
       lease_start_date = s.start_on,
       lease_end_date = coalesce(
           b.lease_end_date,
           (s.start_on + make_interval(months => s.months))::date
       )
  from settled s
 where b.id = s.id;

-- The holds those bookings were still occupying. Leaving them live would keep
-- the one-unreleased-hold-per-property index pointed at a property that is now
-- let, and block the customer who let it.
update property_holds h
   set released_at = now(),
       release_reason = coalesce(h.release_reason, 'converted')
  from bookings b
 where b.id = h.booking_id
   and h.released_at is null
   and b.status in ('confirmed', 'active');
