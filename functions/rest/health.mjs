import {getPool} from '../../src/db/pool.mjs';
import {route} from '../../src/shared/http.mjs';

/**
 * Is this instance actually working?
 *
 * Deliberately unauthenticated and deliberately cheap, because it is what a
 * deploy script, Traefik and a monitor all ask. "The process is listening" is
 * not the same as "the service works" — an instance that cannot reach Postgres
 * answers every real request with a 500 while looking perfectly alive, so this
 * touches the database and reports the schema version it found.
 *
 * It reveals nothing a caller could use: no connection string, no counts, no
 * names — only whether the parts are talking to each other.
 */

const startedAt = new Date();

export const health = route({
    method: 'get',
    path: '/health',
    description: 'Liveness and readiness, including whether the database is reachable',
    handler: async (request, response) => {
        const checks = {database: 'unknown'};
        let schemaVersion = null;
        let ok = true;

        try {
            const {rows} = await getPool().query(
                `select count(*)::int as applied, max(name) as latest from schema_migrations`
            );
            checks.database = 'ok';
            schemaVersion = {applied: rows[0].applied, latest: rows[0].latest};
        } catch (error) {
            checks.database = 'unreachable';
            ok = false;
            // The reason belongs in the logs, not in an unauthenticated response.
            console.error('health: database check failed', error.message);
        }

        // 503 rather than 200-with-a-flag: an orchestrator reads the status
        // code, and a broken instance that answers 200 stays in the pool.
        response.status(ok ? 200 : 503).json({
            status: ok ? 'ok' : 'degraded',
            service: 'homemate-functions',
            uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
            startedAt: startedAt.toISOString(),
            checks,
            schemaVersion,
        });
    },
});
