-- ---------------------------------------------------------------------------
-- The enquiry chip stops asking for money once the money has arrived.
--
-- `customer_saved_overview` rendered any accepted enquiry as "Awaiting
-- payment", with nothing to end that state. Paying did not change it, because
-- payment lands on the *booking* the enquiry produced, not on the enquiry. So
-- the Favourites screen kept telling a customer who had already paid — and who
-- by then had an active rent in the section directly above — that they still
-- owed for it.
--
-- Only the one `display_status` expression changes; the rest of the function is
-- reproduced verbatim from 020 because Postgres replaces a function whole.
-- ---------------------------------------------------------------------------

create or replace function customer_saved_overview(
    p_customer_id uuid,
    p_section_limit integer default 6
)
returns jsonb
language sql stable as $$
    select jsonb_build_object(
        'activeRentals', coalesce((
            select jsonb_agg(r order by r.next_payment_date nulls last)
              from (
                select id, reference, property_id, property_title, property_address,
                       cover_media_id, monthly_rent, currency, next_payment_date,
                       lease_start_date, lease_end_date, days_remaining, months_remaining,
                       status
                  from v_active_rentals
                 where customer_id = p_customer_id
                 order by next_payment_date nulls last
                 limit p_section_limit
              ) r
        ), '[]'::jsonb),

        'activeRentalCount', (
            select count(*) from v_active_rentals where customer_id = p_customer_id
        ),

        'favorites', coalesce((
            select jsonb_agg(f order by f.saved_at desc)
              from (
                select p.id, p.reference_code, p.title, p.price, p.currency,
                       p.bedrooms, p.bathrooms, p.size_sqm, p.address_line,
                       p.region_name, p.district_name, p.ward_name,
                       p.property_type_name, p.furnishing,
                       p.latitude,
                       p.longitude,
                       (select m.id from property_media m
                         where m.property_id = p.id
                         order by m.is_cover desc, m.position limit 1) as cover_media_id,
                       s.created_at as saved_at
                  from saved_properties s
                  join v_properties p on p.id = s.property_id
                 where s.customer_id = p_customer_id
                 order by s.created_at desc
                 limit p_section_limit
              ) f
        ), '[]'::jsonb),

        'favoriteCount', (
            select count(*) from saved_properties where customer_id = p_customer_id
        ),

        'recentInquiries', coalesce((
            select jsonb_agg(i order by i.created_at desc)
              from (
                select v.id, v.reference, v.status, v.created_at, v.responded_at,
                       v.property_id, v.property_title, v.cover_media_id,
                       v.last_nudged_at,
                       -- What the chip on the row says. An accepted enquiry
                       -- reads as "awaiting payment" only until the booking it
                       -- produced is actually paid for — otherwise a customer
                       -- who has moved in is still being asked for money by the
                       -- row that got them there.
                       case
                           when exists (
                               select 1 from bookings b
                                where b.inquiry_id = v.id
                                  and b.status in ('confirmed', 'active', 'completed')
                           ) then 'booked'
                           when v.status = 'accepted' then 'awaiting_payment'
                           else v.status::text
                       end as display_status
                  from v_inquiries v
                 where v.customer_id = p_customer_id
                 order by v.created_at desc
                 limit p_section_limit
              ) i
        ), '[]'::jsonb),

        'inquiryCount', (
            select count(*) from property_inquiries where customer_id = p_customer_id
        ),

        'upcomingBookings', coalesce((
            select jsonb_agg(v order by v.scheduled_for)
              from (
                select id, reference, status, scheduled_for, property_id,
                       property_title, property_address, cover_media_id, host_name
                  from v_viewings
                 where customer_id = p_customer_id
                   and status in ('requested', 'confirmed', 'rescheduled')
                   and scheduled_for >= now() - interval '2 hours'
                 order by scheduled_for
                 limit p_section_limit
              ) v
        ), '[]'::jsonb),

        'upcomingBookingCount', (
            select count(*) from property_viewings
             where customer_id = p_customer_id
               and status in ('requested', 'confirmed', 'rescheduled')
               and scheduled_for >= now() - interval '2 hours'
        )
    );
$$;
