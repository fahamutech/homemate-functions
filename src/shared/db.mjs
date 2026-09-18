import './pg-types.mjs';
import {translatePostgresError} from './errors.mjs';

/**
 * Runs `work` inside a transaction that has `homemate.actor` set, so every
 * audit trigger fired by the statements inside it records who did it (see
 * migrations/003_triggers.sql). Attribution therefore cannot be forgotten by
 * a caller — it is a property of the write path itself.
 *
 * @param {import('pg').Pool} pool
 * @param {string|null} actor
 * @param {(client: import('pg').PoolClient) => Promise<T>} work
 * @returns {Promise<T>}
 * @template T
 */
export async function withActor(pool, actor, work) {
    const client = await pool.connect();
    try {
        await client.query('begin');
        await client.query('select set_config($1, $2, true)', ['homemate.actor', actor ?? '']);
        const result = await work(client);
        await client.query('commit');
        return result;
    } catch (error) {
        await client.query('rollback').catch(() => {});
        throw translatePostgresError(error);
    } finally {
        client.release();
    }
}

/**
 * Read-only query helper — no transaction, no actor, errors still translated.
 */
export async function query(db, text, params = []) {
    try {
        return await db.query(text, params);
    } catch (error) {
        throw translatePostgresError(error);
    }
}

/**
 * Search functions in SQL all return a `total_count` window column. This peels
 * it off into a pagination envelope so every list endpoint has the same shape
 * without repeating the arithmetic.
 */
export function toPage(rows, {limit, offset}) {
    const total = rows.length > 0 ? Number(rows[0].total_count) : 0;
    const items = rows.map(({total_count, ...rest}) => rest);
    return {
        items,
        pagination: {
            total,
            limit,
            offset,
            hasMore: offset + items.length < total,
        },
    };
}

/** Clamps caller-supplied paging into something sane. */
export function pageParams({limit, offset} = {}) {
    const parsedLimit = Number.parseInt(limit ?? '20', 10);
    const parsedOffset = Number.parseInt(offset ?? '0', 10);
    return {
        limit: Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 100) : 20,
        offset: Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0,
    };
}

/**
 * Partial update by id. Column names come from the caller's `allowed`
 * whitelist (developer-controlled constants), never from request keys, so the
 * generated SQL can't be influenced by input; values always go through
 * placeholders. Saves every entity writing its own near-identical UPDATE.
 *
 * @returns the updated row, or null when no row matched.
 */
export async function updateById(client, {table, id, patch, allowed, returning = '*'}) {
    const entries = Object.entries(patch ?? {}).filter(
        ([key, value]) => allowed.includes(key) && value !== undefined
    );

    if (entries.length === 0) {
        const {rows} = await client.query(`select ${returning} from ${table} where id = $1`, [id]);
        return rows[0] ?? null;
    }

    const assignments = entries.map(([key], index) => `${key} = $${index + 2}`);
    const values = entries.map(([, value]) => value);
    const {rows} = await client.query(
        `update ${table} set ${assignments.join(', ')} where id = $1 returning ${returning}`,
        [id, ...values]
    );
    return rows[0] ?? null;
}

/** Turns '' into null so optional filters don't accidentally filter on empty. */
export function nullIfBlank(value) {
    if (value === undefined || value === null) return null;
    const trimmed = String(value).trim();
    return trimmed.length === 0 ? null : trimmed;
}
