import {withActor, query, toPage, pageParams, nullIfBlank, updateById} from '../../shared/db.mjs';
import {notFound, invalid} from '../../shared/errors.mjs';

const UPDATABLE_FIELDS = ['code', 'name', 'parent_id', 'sort_order', 'is_active', 'metadata'];

/**
 * Master data: regions → districts → wards, property types, amenities,
 * currencies, rejection reasons. The hierarchy rule (a ward needs a district
 * parent, a district needs a region) is a database trigger, so it holds for
 * every writer, not just this service.
 */
export function createDictionariesService({pool}) {
    async function categories() {
        const {rows} = await query(
            pool,
            `select category, count(*)::int as item_count, count(*) filter (where is_active)::int as active_count
               from dictionary_items group by category order by category`
        );
        return {items: rows};
    }

    async function list(filters = {}) {
        const {limit, offset} = pageParams({limit: filters.limit ?? 50, offset: filters.offset});
        const {rows} = await query(
            pool,
            'select * from search_dictionary_items($1, $2, $3, $4, $5, $6)',
            [
                nullIfBlank(filters.query),
                nullIfBlank(filters.category),
                nullIfBlank(filters.parentId),
                filters.includeInactive === true || filters.includeInactive === 'true',
                limit,
                offset,
            ]
        );
        return toPage(rows, {limit, offset});
    }

    async function create(input, actor) {
        const category = nullIfBlank(input.category);
        const code = nullIfBlank(input.code);
        const name = nullIfBlank(input.name);
        if (!category || !code || !name) throw invalid('category, code and name are required');

        return withActor(pool, actor, async (client) => {
            const {rows} = await client.query(
                `insert into dictionary_items (category, code, name, parent_id, sort_order, is_active, metadata)
                 values ($1, $2, $3, $4, coalesce($5, 0), coalesce($6, true), coalesce($7::jsonb, '{}'::jsonb))
                 returning *`,
                [
                    category,
                    code,
                    name,
                    nullIfBlank(input.parentId),
                    input.sortOrder === undefined || input.sortOrder === '' ? null : Number(input.sortOrder),
                    input.isActive === undefined ? null : input.isActive === true || input.isActive === 'true',
                    input.metadata ? JSON.stringify(input.metadata) : null,
                ]
            );
            return rows[0];
        });
    }

    async function update(id, patch, actor) {
        return withActor(pool, actor, async (client) => {
            const updated = await updateById(client, {
                table: 'dictionary_items',
                id,
                allowed: UPDATABLE_FIELDS,
                patch: {
                    code: nullIfBlank(patch.code) ?? undefined,
                    name: nullIfBlank(patch.name) ?? undefined,
                    parent_id: patch.parentId === undefined ? undefined : nullIfBlank(patch.parentId),
                    sort_order: patch.sortOrder === undefined ? undefined : Number(patch.sortOrder),
                    is_active:
                        patch.isActive === undefined ? undefined : patch.isActive === true || patch.isActive === 'true',
                    metadata: patch.metadata === undefined ? undefined : JSON.stringify(patch.metadata),
                },
            });
            if (!updated) throw notFound('Dictionary item');
            return updated;
        });
    }

    /**
     * Archive rather than delete. A dictionary item that properties or child
     * items already point at cannot be removed without orphaning them, so the
     * honest operation is to stop offering it going forward. `is_active` is
     * what every picker filters on, so archiving takes effect immediately
     * while existing records keep their label.
     */
    async function archive(id, actor) {
        return withActor(pool, actor, async (client) => {
            const {rows} = await client.query(
                'update dictionary_items set is_active = false where id = $1 returning *',
                [id]
            );
            if (rows.length === 0) throw notFound('Dictionary item');
            // Children of an archived parent are unreachable in the UI anyway;
            // archiving them too keeps the data honest about what is on offer.
            await client.query('update dictionary_items set is_active = false where parent_id = $1', [id]);
            return rows[0];
        });
    }

    async function restore(id, actor) {
        return withActor(pool, actor, async (client) => {
            const {rows} = await client.query(
                'update dictionary_items set is_active = true where id = $1 returning *',
                [id]
            );
            if (rows.length === 0) throw notFound('Dictionary item');
            return rows[0];
        });
    }

    /**
     * Hard delete, allowed only when nothing references the item. The check is
     * `in_use` from the search view, which knows every table that points at a
     * dictionary item — so a new reference added later is covered by updating
     * one view rather than remembering to update this guard.
     */
    async function remove(id, actor) {
        return withActor(pool, actor, async (client) => {
            const {rows} = await client.query(
                `select d.id, s.in_use
                   from dictionary_items d
                   join search_dictionary_items(null, d.category, null, true, 1000, 0) s on s.id = d.id
                  where d.id = $1`,
                [id]
            );
            if (rows.length === 0) throw notFound('Dictionary item');
            if (rows[0].in_use) {
                throw invalid(
                    'This item is already used by properties or has child items — archive it instead of deleting it'
                );
            }
            await client.query('delete from dictionary_items where id = $1', [id]);
            return {id, deleted: true};
        });
    }

    /**
     * Bulk import. Master data arrives as spreadsheets — wards for a new
     * region, a revised amenity list — and typing them one at a time is how
     * they end up inconsistent. An existing code is updated rather than
     * rejected, so re-importing a corrected sheet is safe, and a parent can be
     * named by code so a sheet does not have to carry uuids.
     *
     * The whole import is one transaction: a sheet either lands completely or
     * not at all, and the per-row outcome is reported back.
     */
    async function importItems({category, items, deactivateMissing = false}, actor) {
        const cat = nullIfBlank(category);
        if (!cat) throw invalid('category is required');
        if (!Array.isArray(items) || items.length === 0) throw invalid('items must be a non-empty array');

        return withActor(pool, actor, async (client) => {
            const {rows: existing} = await client.query(
                'select id, code from dictionary_items where category = $1',
                [cat]
            );
            const idByCode = new Map(existing.map((row) => [row.code, row.id]));
            const results = {created: 0, updated: 0, deactivated: 0, rows: []};
            const seen = new Set();

            for (const [index, raw] of items.entries()) {
                const code = nullIfBlank(raw.code);
                const name = nullIfBlank(raw.name);
                if (!code || !name) {
                    throw invalid(`Row ${index + 1}: code and name are required`);
                }

                // A parent may be given by id, or by the code of a row earlier
                // in the same sheet — which is how a regions/districts/wards
                // sheet is actually shaped.
                let parentId = nullIfBlank(raw.parentId);
                const parentCode = nullIfBlank(raw.parentCode);
                if (!parentId && parentCode) {
                    parentId = idByCode.get(parentCode) ?? null;
                    if (!parentId) {
                        throw invalid(`Row ${index + 1}: parent code "${parentCode}" is not in this category`);
                    }
                }

                const sortOrder =
                    raw.sortOrder === undefined || raw.sortOrder === '' ? null : Number(raw.sortOrder);
                const isActive = raw.isActive === undefined ? true : raw.isActive === true || raw.isActive === 'true';

                const {rows} = await client.query(
                    `insert into dictionary_items (category, code, name, parent_id, sort_order, is_active, metadata)
                     values ($1, $2, $3, $4, coalesce($5, 0), $6, coalesce($7::jsonb, '{}'::jsonb))
                     on conflict (category, code) do update
                        set name = excluded.name,
                            parent_id = coalesce(excluded.parent_id, dictionary_items.parent_id),
                            sort_order = excluded.sort_order,
                            is_active = excluded.is_active,
                            metadata = excluded.metadata
                     returning id, code, (xmax = 0) as inserted`,
                    [
                        cat,
                        code,
                        name,
                        parentId,
                        sortOrder,
                        isActive,
                        raw.metadata ? JSON.stringify(raw.metadata) : null,
                    ]
                );

                idByCode.set(code, rows[0].id);
                seen.add(code);
                if (rows[0].inserted) results.created += 1;
                else results.updated += 1;
                results.rows.push({code, id: rows[0].id, action: rows[0].inserted ? 'created' : 'updated'});
            }

            if (deactivateMissing === true || deactivateMissing === 'true') {
                const {rowCount} = await client.query(
                    `update dictionary_items set is_active = false
                      where category = $1 and is_active and not (code = any($2::text[]))`,
                    [cat, [...seen]]
                );
                results.deactivated = rowCount;
            }

            return results;
        });
    }

    return {categories, list, create, update, archive, restore, remove, importItems};
}
