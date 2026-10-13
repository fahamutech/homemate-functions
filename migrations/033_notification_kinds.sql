-- ---------------------------------------------------------------------------
-- The kinds of notification the partner side needs. On a file of their own
-- because Postgres will not let a transaction use an enum value it added
-- itself — 034 writes rows with these, so they must be committed first.
-- ---------------------------------------------------------------------------

alter type notification_kind add value if not exists 'enquiry_received';
alter type notification_kind add value if not exists 'listing_update';
alter type notification_kind add value if not exists 'payout_update';
