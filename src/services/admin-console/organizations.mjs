import {withActor, query, toPage, pageParams, nullIfBlank, updateById} from '../../shared/db.mjs';
import {notFound, invalid} from '../../shared/errors.mjs';

const UPDATABLE_FIELDS = ['name', 'type', 'registration_number', 'email', 'phone_number', 'address_line'];

/**
 * Agencies, developers and institutions. Approval/rejection is a status
 * transition; the database stamps verified_at/verified_by and refuses illegal
 * moves (migrations/003_triggers.sql).
 */
export function createOrganizationsService({pool}) {
    async function search(filters = {}) {
        const {limit, offset} = pageParams(filters);
        const {rows} = await query(
            pool,
            'select * from search_organizations($1, $2, $3, $4, $5)',
            [
                nullIfBlank(filters.query),
                nullIfBlank(filters.status),
                nullIfBlank(filters.type),
                limit,
                offset,
            ]
        );
        return toPage(rows, {limit, offset});
    }

    async function getById(id) {
        const {rows} = await query(pool, 'select * from v_organizations where id = $1', [id]);
        if (rows.length === 0) throw notFound('Organization');
        return rows[0];
    }

    async function create(input, actor) {
        const name = nullIfBlank(input.name);
        if (!name) throw invalid('name is required');

        return withActor(pool, actor, async (client) => {
            const {rows} = await client.query(
                `insert into organizations (name, type, registration_number, email, phone_number, address_line, status)
                 values ($1, coalesce($2::organization_type, 'agency'), $3, $4, $5, $6, coalesce($7::organization_status, 'pending'))
                 returning id`,
                [
                    name,
                    nullIfBlank(input.type),
                    nullIfBlank(input.registrationNumber),
                    nullIfBlank(input.email),
                    nullIfBlank(input.phoneNumber),
                    nullIfBlank(input.addressLine),
                    nullIfBlank(input.status),
                ]
            );
            const {rows: created} = await client.query('select * from v_organizations where id = $1', [rows[0].id]);
            return created[0];
        });
    }

    async function update(id, patch, actor) {
        return withActor(pool, actor, async (client) => {
            const updated = await updateById(client, {
                table: 'organizations',
                id,
                allowed: UPDATABLE_FIELDS,
                returning: 'id',
                patch: {
                    name: nullIfBlank(patch.name) ?? undefined,
                    type: nullIfBlank(patch.type) ?? undefined,
                    registration_number:
                        patch.registrationNumber === undefined ? undefined : nullIfBlank(patch.registrationNumber),
                    email: patch.email === undefined ? undefined : nullIfBlank(patch.email),
                    phone_number: patch.phoneNumber === undefined ? undefined : nullIfBlank(patch.phoneNumber),
                    address_line: patch.addressLine === undefined ? undefined : nullIfBlank(patch.addressLine),
                },
            });
            if (!updated) throw notFound('Organization');
            const {rows} = await client.query('select * from v_organizations where id = $1', [id]);
            return rows[0];
        });
    }

    async function changeStatus(id, {status, reason}, actor) {
        const nextStatus = nullIfBlank(status);
        if (!nextStatus) throw invalid('status is required');
        if (nextStatus === 'rejected' && !nullIfBlank(reason)) {
            throw invalid('A rejection reason is required');
        }

        return withActor(pool, actor, async (client) => {
            const {rows} = await client.query(
                `update organizations
                    set status = $2::organization_status,
                        rejection_reason = case when $2 = 'rejected' then $3 else null end
                  where id = $1
                  returning id`,
                [id, nextStatus, nullIfBlank(reason)]
            );
            if (rows.length === 0) throw notFound('Organization');
            const {rows: updated} = await client.query('select * from v_organizations where id = $1', [id]);
            return updated[0];
        });
    }

    return {search, getById, create, update, changeStatus};
}
