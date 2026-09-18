/**
 * The `user_role` enum (migrations/002_core_domain.sql), split into the two
 * groups every service that discriminates on role needs — kept here once so
 * admin-console, admin-access and the guards agree on the same lists.
 */
export const PLATFORM_ROLES = ['customer', 'landlord', 'agency', 'broker'];
export const STAFF_ROLES = ['moderator', 'manager', 'finance_auditor', 'admin'];
