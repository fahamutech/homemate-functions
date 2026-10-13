import 'dotenv/config';
import {migrate} from '../migrations/run.mjs';

/**
 * The server brings its own database up to date before it takes traffic, so
 * a deploy is "push the code" and never "push the code, then remember to run
 * the migrations". The runner takes an advisory lock, so several instances
 * starting at once apply each file exactly once, and a database that is
 * already current costs one query.
 *
 * Set AUTO_MIGRATE=false to opt out (for example when migrations are run as a
 * separate release step). A failed migration is logged loudly rather than
 * crashing the process: the file that failed rolled back whole, and the fix is
 * to correct it and restart — which a crash loop would only make harder to see.
 */
if (process.env.DATABASE_URL && process.env.AUTO_MIGRATE !== 'false') {
    try {
        const applied = await migrate({log: (line) => console.log(`[migrate] ${line}`)});
        if (applied.length > 0) console.log(`[migrate] applied ${applied.length} migration(s)`);
    } catch (error) {
        console.error('[migrate] FAILED — the server is running against an out-of-date schema:', error);
    }
}
