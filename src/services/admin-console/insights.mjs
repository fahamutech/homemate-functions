import {query, toPage, pageParams, nullIfBlank} from '../../shared/db.mjs';

function percentageChange(current, previous) {
    const now = Number(current ?? 0);
    const before = Number(previous ?? 0);
    if (before === 0) return now === 0 ? 0 : 100;
    return Number((((now - before) / before) * 100).toFixed(1));
}

/**
 * Dashboard KPIs and the audit feed. The counting is all done by
 * v_admin_dashboard_kpis in SQL — this only reshapes one row into the card
 * structure the UI renders, and derives month-over-month deltas from the two
 * counts the view already provides.
 */
export function createInsightsService({pool}) {
    async function dashboard() {
        const {rows} = await query(pool, 'select * from v_admin_dashboard_kpis');
        const kpi = rows[0];
        const {rows: activity} = await query(
            pool,
            'select * from v_recent_audit_activity limit 8'
        );

        return {
            kpis: {
                totalPlatformUsers: Number(kpi.total_platform_users),
                totalStaffUsers: Number(kpi.total_staff_users),
                suspendedUsers: Number(kpi.suspended_users),
                activeProperties: Number(kpi.active_properties),
                pendingProperties: Number(kpi.pending_properties),
                pendingOrganizations: Number(kpi.pending_organizations),
                activeOrganizations: Number(kpi.active_organizations),
                activeRentValue: Number(kpi.active_rent_value),
                trends: {
                    users: percentageChange(kpi.new_users_this_month, kpi.new_users_last_month),
                    properties: percentageChange(kpi.new_properties_this_month, kpi.new_properties_last_month),
                },
            },
            recentActivity: activity,
        };
    }

    async function auditLog(filters = {}) {
        const {limit, offset} = pageParams(filters);
        const {rows} = await query(
            pool,
            `select a.*, count(*) over () as total_count
               from v_recent_audit_activity a
              where ($1::text is null or a.table_name = $1)
                and ($2::text is null or a.actor ilike '%' || $2 || '%')
                and ($3::text is null or a.record_id = $3)
              limit $4 offset $5`,
            [
                nullIfBlank(filters.tableName),
                nullIfBlank(filters.actor),
                nullIfBlank(filters.recordId),
                limit,
                offset,
            ]
        );
        return toPage(rows, {limit, offset});
    }

    /**
     * One row of "what needs a human right now", straight from
     * v_attention_counts. Every sidebar badge and every in-page attention
     * marker reads from this single call, so a badge can never disagree with
     * the list it points at — and adding a new badge is a column in the view,
     * not another query here.
     */
    async function attention() {
        const {rows} = await query(pool, 'select * from v_attention_counts');
        const counts = Object.fromEntries(
            Object.entries(rows[0] ?? {}).map(([key, value]) => [camel(key), Number(value)])
        );
        return {
            counts,
            // Grouped the way the sidebar is: one number per nav entry.
            badges: {
                properties: counts.propertiesPendingReview ?? 0,
                agencies: counts.agenciesPending ?? 0,
                users: (counts.usersKycPending ?? 0) + (counts.openRemediations ?? 0),
                staff: counts.staffPending ?? 0,
                // Money the platform must act on, including what customers say
                // they have paid and what they cannot pay yet.
                payments:
                    (counts.paymentsPending ?? 0) +
                    (counts.paymentsFailed ?? 0) +
                    (counts.payoutsDue ?? 0) +
                    (counts.payoutsBlocked ?? 0) +
                    (counts.paymentsDeclared ?? 0) +
                    (counts.paymentsNeedingInstructions ?? 0),
                inquiries: counts.inquiriesPending ?? 0,
                viewings: counts.viewingsRequested ?? 0,
                bookings: counts.bookingsPending ?? 0,
            },
        };
    }

    return {dashboard, auditLog, attention};
}

function camel(snake) {
    return snake.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}
