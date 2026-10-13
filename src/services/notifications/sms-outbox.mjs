/**
 * Sends the texts the database queued (sms_outbox, migration 034).
 *
 * The triggers that decide an event deserves an SMS run inside the
 * transaction that caused it, and cannot call a vendor — nor should they: a
 * provider outage must never undo a verified payment. So the row is queued
 * with the event and this sends it after commit.
 *
 * Rows are claimed with `for update skip locked`, so two server instances
 * draining at once each take different rows. A failed send is retried with a
 * growing delay and given up after `maxAttempts`. A row left `sending` by a
 * process that died mid-send is picked up again once its claim is stale —
 * which can, rarely, text someone twice; a duplicate receipt is the cheaper
 * mistake than a missing one.
 *
 * @param {object} deps
 * @param {import('pg').Pool} deps.pool
 * @param {import('../identity-access/ports.mjs').NotificationPort} deps.smsPort
 */
export function createSmsOutbox({pool, smsPort, batchSize = 20, maxAttempts = 5, staleClaimMinutes = 5}) {
    let draining = null;

    async function claim() {
        const {rows} = await pool.query(
            `update sms_outbox
                set status = 'sending', attempts = attempts + 1, claimed_at = now()
              where id in (
                    select id from sms_outbox
                     where (status = 'queued' and next_attempt_at <= now())
                        or (status = 'sending' and claimed_at < now() - make_interval(mins => $2))
                     order by created_at
                     limit $1
                     for update skip locked)
              returning id, phone_number, template, params, attempts`,
            [batchSize, staleClaimMinutes]
        );
        return rows;
    }

    async function sendOne(row) {
        try {
            const delivery = await smsPort.send({
                to: row.phone_number,
                template: row.template,
                params: {...row.params, reference: row.params?.reference ?? row.id},
            });
            await pool.query(
                `update sms_outbox
                    set status = 'sent', sent_at = now(), last_error = null,
                        provider = $2, external_id = $3, sms_count = $4, raw_response = $5
                  where id = $1`,
                [
                    row.id,
                    delivery.provider,
                    delivery.externalId ?? null,
                    delivery.smsCount ?? 1,
                    JSON.stringify(delivery.raw ?? {}),
                ]
            );
            return true;
        } catch (error) {
            const givingUp = row.attempts >= maxAttempts;
            await pool.query(
                `update sms_outbox
                    set status = $2, last_error = $3,
                        next_attempt_at = now() + make_interval(mins => $4)
                  where id = $1`,
                [row.id, givingUp ? 'failed' : 'queued', `${error?.message ?? error}`.slice(0, 500), row.attempts ** 2]
            );
            console.error(`sms-outbox: ${row.template} ${givingUp ? 'gave up' : 'will retry'}`, error?.message ?? error);
            return false;
        }
    }

    /** Sends everything due now. Returns how many went out and how many did not. */
    async function drain() {
        let sent = 0;
        let failed = 0;
        for (;;) {
            const rows = await claim();
            if (rows.length === 0) break;
            for (const row of rows) {
                if (await sendOne(row)) sent += 1;
                else failed += 1;
            }
            if (rows.length < batchSize) break;
        }
        return {sent, failed};
    }

    /**
     * Fire-and-forget, for right after a commit that may have queued a text:
     * the customer's receipt goes now instead of at the next scheduled sweep.
     * Overlapping calls share one drain.
     */
    function drainSoon() {
        if (draining) return draining;
        draining = drain()
            .catch((error) => console.error('sms-outbox: drain failed', error))
            .finally(() => {
                draining = null;
            });
        return draining;
    }

    return {drain, drainSoon};
}
