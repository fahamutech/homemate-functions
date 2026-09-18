import {readFileSync, readdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';

const {Client} = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        console.error('DATABASE_URL is not set');
        process.exit(1);
    }

    const files = readdirSync(__dirname)
        .filter(name => name.endsWith('.sql'))
        .sort();

    const client = new Client({connectionString});
    await client.connect();
    try {
        await client.query(`
            create table if not exists schema_migrations (
                name text primary key,
                applied_at timestamptz not null default now()
            )
        `);

        const {rows} = await client.query('select name from schema_migrations');
        const applied = new Set(rows.map(r => r.name));

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
        await client.end();
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
