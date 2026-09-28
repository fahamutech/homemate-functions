/**
 * Route ACL for the backoffice portal. A staff account (role other than
 * 'admin') carries an `allowed_routes` list of sidebar section keys — this
 * maps an incoming `/admin/*` request path to the key(s) that must appear in
 * that list, mirroring homemate-partner-portal's navConfig.ts.
 *
 * Contract of the returned value:
 *   - [] (empty array)   -> always allowed, no ACL key needed (e.g. the
 *                            dashboard/attention counters every screen needs)
 *   - [key, ...]          -> allowed iff allowed_routes contains at least one
 *   - null                -> unmapped path; denied for any non-admin role,
 *                            since that role class could not reach any
 *                            /admin/* route at all before this ACL existed
 */
const ALWAYS_ALLOWED_PREFIXES = ['/admin/dashboard', '/admin/attention'];

const RULES = [
    ['/admin/audit', ['audit']],
    ['/admin/kyc', ['users', 'staff']],
    ['/admin/media', ['users', 'staff', 'properties']],
    ['/admin/users', ['users', 'staff']],
    ['/admin/organizations', ['agencies']],
    ['/admin/properties', ['properties']],
    ['/admin/dictionary-items', ['dictionaries']],
    ['/admin/dictionaries', ['dictionaries']],
    ['/admin/settings', ['settings']],
    ['/admin/inquiries', ['inquiries']],
    ['/admin/bookings', ['bookings']],
    ['/admin/payment-queue', ['payments']],
    ['/admin/sms', ['payments']],
    ['/admin/payment-methods', ['payments']],
    ['/admin/payments', ['payments']],
    ['/admin/money', ['payments']],
    ['/admin/payouts', ['payments']],
    ['/admin/ledger', ['payments']],
    ['/admin/geocode', ['properties', 'agencies']],
];

export function resourceKeysForPath(path) {
    if (ALWAYS_ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix))) return [];

    let best = null;
    for (const [prefix, keys] of RULES) {
        if (path.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) {
            best = {prefix, keys};
        }
    }
    return best ? best.keys : null;
}
