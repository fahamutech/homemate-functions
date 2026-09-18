-- Reference/master data. Per BR-004 and the Master Spec's "launch geography is
-- reference data, not hardcoded" resolution, none of this lives in code.

-- Property types -------------------------------------------------------------
insert into dictionary_items (category, code, name, sort_order) values
    ('property_type', 'apartment', 'Apartment', 10),
    ('property_type', 'house', 'House', 20),
    ('property_type', 'villa', 'Villa', 30),
    ('property_type', 'room', 'Single Room', 40),
    ('property_type', 'studio', 'Studio', 50),
    ('property_type', 'office', 'Office Space', 60),
    ('property_type', 'shop', 'Shop / Retail', 70),
    ('property_type', 'warehouse', 'Warehouse', 80),
    ('property_type', 'land', 'Land / Plot', 90);

-- Amenities ------------------------------------------------------------------
insert into dictionary_items (category, code, name, sort_order) values
    ('amenity', 'parking', 'Parking', 10),
    ('amenity', 'security', '24/7 Security', 20),
    ('amenity', 'water_tank', 'Water Tank', 30),
    ('amenity', 'generator', 'Backup Generator', 40),
    ('amenity', 'furnished', 'Furnished', 50),
    ('amenity', 'air_conditioning', 'Air Conditioning', 60),
    ('amenity', 'balcony', 'Balcony', 70),
    ('amenity', 'garden', 'Garden', 80),
    ('amenity', 'swimming_pool', 'Swimming Pool', 90),
    ('amenity', 'elevator', 'Elevator', 100);

-- Currencies -----------------------------------------------------------------
insert into dictionary_items (category, code, name, sort_order, metadata) values
    ('currency', 'TZS', 'Tanzanian Shilling', 10, '{"symbol": "TSh"}'::jsonb),
    ('currency', 'USD', 'US Dollar', 20, '{"symbol": "$"}'::jsonb);

-- Rejection reasons (moderation dictionary) ----------------------------------
insert into dictionary_items (category, code, name, sort_order) values
    ('rejection_reason', 'incomplete_data', 'Incomplete property information', 10),
    ('rejection_reason', 'poor_media', 'Photos unclear or insufficient', 20),
    ('rejection_reason', 'duplicate', 'Duplicate of an existing listing', 30),
    ('rejection_reason', 'ownership_unverified', 'Ownership could not be verified', 40),
    ('rejection_reason', 'pricing_suspicious', 'Pricing appears fraudulent', 50),
    ('rejection_reason', 'policy_violation', 'Violates platform policy', 60);

-- Geography: regions ---------------------------------------------------------
insert into dictionary_items (category, code, name, sort_order) values
    ('region', 'dar_es_salaam', 'Dar es Salaam', 10),
    ('region', 'arusha', 'Arusha', 20),
    ('region', 'mwanza', 'Mwanza', 30),
    ('region', 'dodoma', 'Dodoma', 40),
    ('region', 'zanzibar_urban_west', 'Zanzibar Urban/West', 50),
    ('region', 'mbeya', 'Mbeya', 60);

-- Geography: districts -------------------------------------------------------
insert into dictionary_items (category, code, name, parent_id, sort_order)
select 'district', d.code, d.name,
       (select id from dictionary_items where category = 'region' and code = d.region_code),
       d.sort_order
from (values
    ('kinondoni', 'Kinondoni', 'dar_es_salaam', 10),
    ('ilala', 'Ilala', 'dar_es_salaam', 20),
    ('temeke', 'Temeke', 'dar_es_salaam', 30),
    ('ubungo', 'Ubungo', 'dar_es_salaam', 40),
    ('kigamboni', 'Kigamboni', 'dar_es_salaam', 50),
    ('arusha_city', 'Arusha City', 'arusha', 10),
    ('nyamagana', 'Nyamagana', 'mwanza', 10),
    ('dodoma_city', 'Dodoma City', 'dodoma', 10),
    ('mjini', 'Mjini', 'zanzibar_urban_west', 10),
    ('mbeya_city', 'Mbeya City', 'mbeya', 10)
) as d(code, name, region_code, sort_order);

-- Geography: wards -----------------------------------------------------------
insert into dictionary_items (category, code, name, parent_id, sort_order)
select 'ward', w.code, w.name,
       (select id from dictionary_items where category = 'district' and code = w.district_code),
       w.sort_order
from (values
    ('masaki', 'Masaki', 'kinondoni', 10),
    ('mikocheni', 'Mikocheni', 'kinondoni', 20),
    ('oyster_bay', 'Oyster Bay', 'kinondoni', 30),
    ('msasani', 'Msasani', 'kinondoni', 40),
    ('kariakoo', 'Kariakoo', 'ilala', 10),
    ('upanga', 'Upanga', 'ilala', 20),
    ('mbagala', 'Mbagala', 'temeke', 10),
    ('chang_ombe', 'Chang''ombe', 'temeke', 20),
    ('manzese', 'Manzese', 'ubungo', 10),
    ('kimara', 'Kimara', 'ubungo', 20),
    ('kibada', 'Kibada', 'kigamboni', 10)
) as w(code, name, district_code, sort_order);

-- Platform settings ----------------------------------------------------------
insert into settings (key, value, category, description) values
    ('platform.name', '"HomeMate Africa"'::jsonb, 'general', 'Display name used across the platform'),
    ('platform.support_email', '"support@homemate.co.tz"'::jsonb, 'general', 'Public support mailbox'),
    ('platform.default_currency', '"TZS"'::jsonb, 'general', 'Default currency code for new listings'),
    ('platform.maintenance_mode', 'false'::jsonb, 'general', 'When true the public apps show a maintenance notice'),
    ('listing.min_photos', '3'::jsonb, 'listings', 'Minimum photos required before a listing may be submitted'),
    ('listing.max_photos', '10'::jsonb, 'listings', 'Maximum photos accepted per listing'),
    ('listing.auto_archive_days', '180'::jsonb, 'listings', 'Days an approved listing stays live before auto-archive review'),
    ('commission.broker_percentage', '5'::jsonb, 'commission', 'Default broker commission percentage (BR-004: configuration, not code)'),
    ('commission.agency_split_percentage', '60'::jsonb, 'commission', 'Share of commission retained by the agency'),
    ('reservation.hold_hours', '48'::jsonb, 'reservations', 'Hours a reservation hold remains valid before expiry'),
    ('moderation.sla_hours', '24'::jsonb, 'moderation', 'Target turnaround for a listing review');
