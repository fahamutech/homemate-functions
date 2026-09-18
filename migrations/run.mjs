import {readFileSync, readdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';

const {Client} = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * One arbitrary but fixed number identifying "the HomeMate migration runner".
 * Postgres advisory locks are just integers; this one is derived from the name
 * so it cannot collide with a lock some other part of the system takes.
 */
const LOCK_ID = 8_147_320_115;

/**
 * Applies every migration that has not been applied yet, in filename order.
 *
 * Two things make it safe to run from a deploy script rather than by hand:
 *
 *   - **It takes an advisory lock first.** A deploy that is retried, or run
 *     while another is still going, would otherwise have two runners both read
 *     "not applied" and both try to create the same type. The second waits
 *     here instead, and by the time it looks the work is already recorded.
 *   - **Each file is its own transaction.** A migration that fails leaves
 *     everything before it applied and everything after it untouched, so the
 *     fix is to correct that one file and run again — not to unpick a
 *     half-applied batch.
 *
 * `--check` reports what would run and changes nothing, which is what a deploy
 * script uses to decide whether a database step is needed at all.
 */
async function main() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        console.error('DATABASE_URL is not set');
        process.exit(1);
    }

    const checkOnly = process.argv.includes('--check');

    const files = readdirSync(__dirname)
        .filter((name) => name.endsWith('.sql'))
        .sort();

    const client = new Client({connectionString});
    await client.connect();

    let locked = false;
    try {
        await client.query(`
            create table if not exists schema_migrations (
                name text primary key,
                applied_at timestamptz not null default now()
            )
        `);

        if (!checkOnly) {
            // Blocks rather than failing: a concurrent deploy is something to
            // wait for, not an error.
            await client.query('select pg_advisory_lock($1)', [LOCK_ID]);
            locked = true;
        }

        const {rows} = await client.query('select name from schema_migrations');
        const applied = new Set(rows.map((r) => r.name));
        const pending = files.filter((file) => !applied.has(file));

        if (checkOnly) {
            if (pending.length === 0) {
                console.log('migrations up to date');
            } else {
                console.log(`${pending.length} pending:`);
                for (const file of pending) console.log(`  ${file}`);
            }
            // A deploy script branches on this: 0 = nothing to do, 10 = work
            // pending. Anything else is a genuine failure.
            process.exitCode = pending.length === 0 ? 0 : 10;
            return;
        }

        for (const file of files) {
            if (applied.has(file)) {
                console.log(`skip  ${file} (already applied)`);
                continue;
            }
            const sql = readFileSync(join(__dirname, file), 'utf8');
            console.log(`apply ${file}`);
            await client.query('begin');
            try {
                await client.query(sql);
                await client.query('insert into schema_migrations (name) values ($1)', [file]);
                await client.query('commit');
            } catch (err) {
                await client.query('rollback');
                throw err;
            }
        }
        console.log('migrations up to date');
    } finally {
        if (locked) {
            await client.query('select pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
        }
        await client.end();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
