import pg from 'pg';

const {Pool} = pg;

let pool;

/**
 * Lazily creates a singleton pg Pool from DATABASE_URL.
 * Lazy so importing this module never triggers a connection attempt
 * (unit tests that inject a fake db never call this).
 */
export function getPool() {
    if (!pool) {
        const connectionString = process.env.DATABASE_URL;
        if (!connectionString) {
            throw new Error('DATABASE_URL is not set');
        }
        pool = new Pool({connectionString});
    }
    return pool;
}

export async function closePool() {
    if (pool) {
        await pool.end();
        pool = undefined;
    }
}
