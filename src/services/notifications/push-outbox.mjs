import pg from 'pg';

/**
 * Pushes new notifications to the phones of the person they are for
 * (migration 035).
 *
 * A notification row is its own push job: `push_status` starts `queued`, a
 * sweep claims due rows with `for update skip locked` (so several server
 * instances never push the same row twice), sends to each of the person's
 * live devices, and records every answer in `push_deliveries`.
 *
 * - No live device: `skipped`. The inbox still has it.
 * - FCM says a token is dead: that device is disabled and the rest still tried.
 * - An outage: retried with a growing delay, `failed` after `maxAttempts`.
 * - Older than `freshForHours` before it could go: `skipped` — a buzz about
 *   yesterday is worse than none.
 *
 * Draining starts the moment a notification is committed: `listen()` holds a
 * connection on the `homemate_push` channel the insert trigger announces on,
 * and the per-minute schedule sweeps whatever that missed.
 *
 * @param {object} deps
 * @param {import('pg').Pool} deps.pool
 * @param {import('./ports.mjs').PushPort} deps.pushPort
 * @param {string} [deps.webBaseUrl]  where the PWA lives, for the web click-through
 */
export function createPushOutbox({
    pool,
    pushPort,
    webBaseUrl = process.env.PUBLIC_WEB_URL ?? 'https://homemate.co.tz',
    batchSize = 50,
    maxAttempts = 5,
    staleClaimMinutes = 5,
    freshForHours = 24,
}) {
    const webBase = webBaseUrl.replace(/\/$/, '');
    let draining = null;
    let again = false;

    async function claim() {
        await pool.query(
            `update notifications set push_status = 'skipped'
              where push_status = 'queued' and created_at < now() - make_interval(hours => $1)`,
            [freshForHours]
        );
        const {rows} = await pool.query(
            `update notifications
                set push_status = 'sending', push_attempts = push_attempts + 1, push_claimed_at = now()
              where id in (
                    select id from notifications
                     where (push_status = 'queued' and push_next_attempt_at <= now())
                        or (push_status = 'sending' and push_claimed_at < now() - make_interval(mins => $2))
                     order by created_at
                     limit $1
                     for update skip locked)
              returning id, user_id, kind::text as kind, title, body, subject_table, subject_id, audience, push_attempts`,
            [batchSize, staleClaimMinutes]
        );
        return rows;
    }

    /** What the app reads to open the right screen. FCM data values must be strings. */
    function dataFor(row) {
        return {
            notificationId: row.id,
            kind: row.kind,
            audience: row.audience ?? '',
            subjectTable: row.subject_table ?? '',
            subjectId: row.subject_id ?? '',
        };
    }

    /** The PWA route that opens a notification (lib/routing: Routes.openNotification). Hash URLs, as the web build uses. */
    function linkFor(data) {
        return `${webBase}/#/open-notification?${new URLSearchParams(data)}`;
    }

    async function pushOne(row) {
        const {rows: devices} = await pool.query(
            'select id, token, platform from push_devices where user_id = $1 and disabled_at is null',
            [row.user_id]
        );
        if (devices.length === 0) {
            await pool.query(`update notifications set push_status = 'skipped' where id = $1`, [row.id]);
            return 'skipped';
        }

        const data = dataFor(row);
        let delivered = 0;
        let retry = false;
        for (const device of devices) {
            const result = await pushPort.send({
                token: device.token,
                platform: device.platform,
                title: row.title,
                body: row.body,
                data,
                link: linkFor(data),
            }).catch((error) => ({ok: false, provider: pushPort.provider, retryable: true, error: `${error?.message ?? error}`}));

            const status = result.ok ? 'sent' : result.invalidToken ? 'invalid_token' : 'failed';
            await pool.query(
                `insert into push_deliveries (notification_id, device_id, status, provider, message_id, error)
                 values ($1, $2, $3, $4, $5, $6)`,
                [row.id, device.id, status, result.provider ?? pushPort.provider, result.messageId ?? null,
                    result.error?.slice(0, 500) ?? null]
            );
            if (result.ok) delivered += 1;
            else if (result.invalidToken) {
                await pool.query(
                    `update push_devices set disabled_at = now(), disabled_reason = $2 where id = $1`,
                    [device.id, result.error ?? 'invalid token']
                );
            } else if (result.retryable) retry = true;
        }

        // One phone reached is a sent notification: retrying would buzz it again.
        if (delivered > 0) {
            await pool.query(`update notifications set push_status = 'sent', pushed_at = now() where id = $1`, [row.id]);
            return 'sent';
        }
        if (retry && row.push_attempts < maxAttempts) {
            await pool.query(
                `update notifications set push_status = 'queued', push_next_attempt_at = now() + make_interval(mins => $2)
                  where id = $1`,
                [row.id, row.push_attempts ** 2]
            );
            return 'retry';
        }
        await pool.query(
            `update notifications set push_status = $2 where id = $1`,
            [row.id, retry ? 'failed' : 'skipped']
        );
        return retry ? 'failed' : 'skipped';
    }

    /** Pushes everything due now. Returns a count per outcome. */
    async function drain() {
        const outcome = {sent: 0, skipped: 0, retry: 0, failed: 0};
        for (;;) {
            const rows = await claim();
            for (const row of rows) outcome[await pushOne(row)] += 1;
            if (rows.length < batchSize) break;
        }
        return outcome;
    }

    /**
     * Fire-and-forget. A call that arrives mid-drain is not dropped: the drain
     * runs once more when it finishes, so a notification committed while the
     * last batch was being claimed still goes now.
     */
    function drainSoon() {
        if (draining) {
            again = true;
            return draining;
        }
        draining = (async () => {
            do {
                again = false;
                await drain().catch((error) => console.error('push-outbox: drain failed', error));
            } while (again);
        })().finally(() => {
            draining = null;
        });
        return draining;
    }

    /**
     * Holds a connection LISTENing on `homemate_push` and drains on every
     * announcement. Reconnects after a lost connection. Returns `stop()`.
     */
    function listen({connectionString = process.env.DATABASE_URL, retryMs = 5_000} = {}) {
        let client = null;
        let stopped = false;
        let timer = null;

        const reconnect = () => {
            if (stopped) return;
            client?.end().catch(() => {});
            client = null;
            timer = setTimeout(connect, retryMs);
        };

        async function connect() {
            if (stopped) return;
            const next = new pg.Client({connectionString});
            next.on('notification', () => drainSoon());
            next.on('error', (error) => {
                console.error('push-outbox: listener lost its connection', error?.message ?? error);
                reconnect();
            });
            try {
                await next.connect();
                await next.query('listen homemate_push');
                client = next;
                drainSoon(); // whatever arrived while nobody was listening
            } catch (error) {
                console.error('push-outbox: could not listen', error?.message ?? error);
                next.end().catch(() => {});
                reconnect();
            }
        }

        connect();
        return async () => {
            stopped = true;
            clearTimeout(timer);
            await client?.end().catch(() => {});
        };
    }

    return {drain, drainSoon, listen};
}
