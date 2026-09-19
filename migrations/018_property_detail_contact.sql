-- The landlord card on the property screen (CUS-005).
--
-- The design puts a person next to the listing — their name, whether HomeMate
-- has verified who they are, and how much else they let. The first two already
-- exist on `users`; the third is a count the app was otherwise going to make
-- five round trips for, once per card. All three go into the single detail
-- payload the screen already fetches.
--
-- Only `contact` changes. The rest of customer_property_detail is repeated
-- verbatim because Postgres replaces a function whole; a diff against 014 is
-- the way to read what is new here.

create or replace function customer_property_detail(p_property_id uuid, p_customer_id uuid default null)
returns jsonb
language sql stable as $$
    select jsonb_build_object(
        'property', to_jsonb(v) - 'search_vector',
        'media', coalesce((
            select jsonb_agg(jsonb_build_object(
                'id', m.id, 'kind', m.kind, 'caption', m.caption,
                'isCover', m.is_cover, 'position', m.position
            ) order by m.is_cover desc, m.position)
            from property_media m where m.property_id = p_property_id
        ), '[]'::jsonb),
        'amenities', coalesce((
            select jsonb_agg(jsonb_build_object('id', d.id, 'code', d.code, 'name', d.name) order by d.sort_order, d.name)
            from property_amenities a join dictionary_items d on d.id = a.amenity_id
            where a.property_id = p_property_id
        ), '[]'::jsonb),
        'charges', coalesce((
            select jsonb_agg(jsonb_build_object(
                'id', c.id, 'name', c.name, 'amount', c.amount,
                'frequency', c.frequency, 'isMandatory', c.is_mandatory,
                'isRefundable', c.is_refundable
            ) order by c.name)
            from property_charges c where c.property_id = p_property_id
        ), '[]'::jsonb),
        'paymentMethods', coalesce((
            select jsonb_agg(jsonb_build_object('id', pm.id, 'code', pm.code, 'name', pm.name, 'kind', pm.kind))
            from property_payment_methods ppm join payment_methods pm on pm.id = ppm.payment_method_id
            where ppm.property_id = p_property_id and pm.is_active
        ), '[]'::jsonb),
        'contact', (
            select jsonb_build_object(
                'landlordName', lu.full_name,
                'brokerName', bu.full_name,
                'agencyName', o.name,
                -- Whose card this is: the broker fronts the listing when there
                -- is one, otherwise the landlord. The app should not have to
                -- re-derive that rule to know which name it is showing.
                'contactRole', case when bu.id is not null then 'broker' else 'landlord' end,
                'contactUserId', coalesce(bu.id, lu.id),
                -- 'verified' here is HomeMate's identity review, not a claim
                -- about the property. A card that says "verified" about an
                -- unreviewed account would be the app lying on our behalf.
                'isVerified', coalesce(bu.kyc_status, lu.kyc_status) = 'verified',
                'hasPhoto', coalesce(bu.profile_photo_url, lu.profile_photo_url) is not null,
                'activeListings', coalesce((
                    select count(*)
                      from property_parties pp
                      join properties p2 on p2.id = pp.property_id
                     where pp.user_id = coalesce(bu.id, lu.id)
                       and pp.is_primary
                       and p2.status = 'approved'
                ), 0)
            )
            from properties pr
            left join property_parties lp on lp.property_id = pr.id and lp.role = 'landlord' and lp.is_primary
            left join users lu on lu.id = lp.user_id
            left join property_parties bp on bp.property_id = pr.id and bp.role = 'broker' and bp.is_primary
            left join users bu on bu.id = bp.user_id
            left join organizations o on o.id = (
                select u2.organization_id from property_parties ap
                  join users u2 on u2.id = ap.user_id
                 where ap.property_id = pr.id and ap.role = 'agency' and ap.is_primary
                 limit 1
            )
            where pr.id = p_property_id
        ),
        'isSaved', coalesce((
            select true from saved_properties s
             where s.property_id = p_property_id and s.customer_id = p_customer_id
        ), false),
        'myInquiry', (
            select jsonb_build_object('id', i.id, 'reference', i.reference, 'status', i.status)
              from property_inquiries i
             where i.property_id = p_property_id and i.customer_id = p_customer_id
             order by i.created_at desc limit 1
        )
    )
    from v_properties v
    where v.id = p_property_id;
$$;
