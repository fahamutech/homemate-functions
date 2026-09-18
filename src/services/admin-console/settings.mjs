import {withActor, query, nullIfBlank} from '../../shared/db.mjs';
import {notFound, invalid} from '../../shared/errors.mjs';

/**
 * Platform settings. Versioning is a database trigger (settings_history), so
 * every change is recorded with its previous value and author regardless of
 * who writes it.
 */
export function createSettingsService({pool}) {
    async function list({category} = {}) {
        const {rows} = await query(
            pool,
            `select key, value, category, description, updated_by, updated_at
               from settings
              where ($1::text is null or category = $1)
              order by category, key`,
            [nullIfBlank(category)]
        );
        const grouped = rows.reduce((acc, row) => {
            (acc[row.category] ??= []).push(row);
            return acc;
        }, {});
        return {items: rows, grouped};
    }

    async function update(key, {value}, actor) {
        const settingKey = nullIfBlank(key);
        if (!settingKey) throw invalid('key is required');
        if (value === undefined) throw invalid('value is required');

        return withActor(pool, actor, async (client) => {
            const {rows} = await client.query(
                `update settings set value = $2::jsonb where key = $1
                 returning key, value, category, description, updated_by, updated_at`,
                [settingKey, JSON.stringify(value)]
            );
            if (rows.length === 0) throw notFound('Setting');
            return rows[0];
        });
    }

    async function history(key) {
        const {rows} = await query(
            pool,
            `select id, key, old_value, new_value, changed_by, changed_at
               from settings_history where key = $1 order by changed_at desc limit 50`,
            [key]
        );
        return {items: rows};
    }

    return {list, update, history};
}
