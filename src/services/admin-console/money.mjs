import {withActor, query, toPage, pageParams, nullIfBlank} from '../../shared/db.mjs';
import {notFound, invalid} from '../../shared/errors.mjs';

/**
 * Money: collection in, disbursement out.
 *
 * HomeMate connects a tenant to a landlord, an agency and/or a broker. Rent is
 * collected once and then belongs to several people at once, so every payment
 * is split the moment it is recorded: the landlord's share, the broker's and
 * agency's commissions, and whatever HomeMate retains. The splits must add up
 * to the payment — a deferred constraint trigger refuses a commit where they
 * do not, so a rounding mistake cannot silently create or destroy money.
 *
 * What this service deliberately does NOT do:
 *   - decide a payment succeeded (only a provider callback or an authorised
 *     reconciliation can, per BR-005, enforced in 009),
 *   - stamp who confirmed or released anything (triggers do it),
 *   - touch the ledger (triggers post it, and it is append-only).
 */

const BENEFICIARY_ROLE_COLUMN = {
    landlord: 'landlord',
    broker: 'broker',
    agency: 'agency',
};

export function createMoneyService({pool, paymentPorts = {}}) {
    // --- collection ----------------------------------------------------------

    async function searchPayments(filters = {}) {
        const {limit, offset} = pageParams(filters);
        const {rows} = await query(
            pool,
            'select * from search_payments($1, $2, $3, $4, $5, $6, $7, $8, $9)',
            [
                nullIfBlank(filters.query),
                nullIfBlank(filters.status),
                nullIfBlank(filters.purpose),
                nullIfBlank(filters.propertyId),
                nullIfBlank(filters.payerUserId),
                nullIfBlank(filters.from),
                nullIfBlank(filters.to),
                limit,
                offset,
            ]
        );
        return toPage(rows, {limit, offset});
    }

    async function getPayment(id) {
        const {rows} = await query(pool, 'select * from v_payments where id = $1', [id]);
        if (rows.length === 0) throw notFound('Payment');

        const [splits, events] = await Promise.all([
            query(
                pool,
                `select s.id, s.beneficiary_type, s.beneficiary_user_id, u.full_name as beneficiary_name,
                        s.amount, s.percentage, s.payout_id, po.reference as payout_reference, po.status as payout_status
                   from payment_splits s
                   left join users u on u.id = s.beneficiary_user_id
                   left join payouts po on po.id = s.payout_id
                  where s.payment_id = $1
                  order by s.beneficiary_type`,
                [id]
            ),
            query(
                pool,
                `select id, provider, provider_reference, status, raw_payload, received_at
                   from external_payment_events where payment_id = $1 order by received_at desc`,
                [id]
            ),
        ]);

        const ledger = await query(
            pool,
            `select id, account, direction, amount, currency, description, entry_date
               from ledger_entries where payment_id = $1 order by id`,
            [id]
        );

        return {...rows[0], splits: splits.rows, providerEvents: events.rows, ledger: ledger.rows};
    }

    /**
     * Records a collection. It always opens as `pending`: nothing here can
     * declare it received. Splits are computed once, from the property's own
     * parties and the configured commission, so the arithmetic lives in one
     * place instead of being retyped per payment.
     */
    async function recordPayment(input, actor) {
        const amount = Number(input.amount);
        if (!Number.isFinite(amount) || amount <= 0) throw invalid('amount must be greater than zero');
        const propertyId = nullIfBlank(input.propertyId);
        if (!propertyId) throw invalid('propertyId is required');

        return withActor(pool, actor, async (client) => {
            const {rows: payment} = await client.query(
                `insert into payments
                     (property_id, payer_user_id, payment_method_id, purpose, amount, currency,
                      provider, provider_reference, period_start, period_end, notes, created_by)
                 values ($1, $2, $3, coalesce($4::payment_purpose, 'rent'), $5, coalesce($6, 'TZS'),
                         $7, $8, $9::date, $10::date, $11, $12)
                 returning id, amount, currency`,
                [
                    propertyId,
                    nullIfBlank(input.payerUserId),
                    nullIfBlank(input.paymentMethodId),
                    nullIfBlank(input.purpose),
                    amount,
                    nullIfBlank(input.currency),
                    nullIfBlank(input.provider),
                    nullIfBlank(input.providerReference),
                    nullIfBlank(input.periodStart),
                    nullIfBlank(input.periodEnd),
                    nullIfBlank(input.notes),
                    actor ?? null,
                ]
            );

            const splits = input.splits?.length
                ? normaliseSplits(input.splits, amount)
                : await deriveSplits(client, propertyId, amount);

            for (const split of splits) {
                await client.query(
                    `insert into payment_splits (payment_id, beneficiary_type, beneficiary_user_id, amount, percentage)
                     values ($1, $2::beneficiary_type, $3, $4, $5)`,
                    [
                        payment[0].id,
                        split.beneficiaryType,
                        split.beneficiaryUserId ?? null,
                        split.amount,
                        split.percentage ?? null,
                    ]
                );
            }

            return {id: payment[0].id};
        }).then((created) => getPayment(created.id));
    }

    /**
     * A provider callback. This is the ONLY path that can carry a payment to
     * `successful`: the event is stored verbatim first, then the status move
     * is attempted, and the trigger looks for exactly that evidence.
     */
    async function recordProviderEvent(paymentId, event, actor) {
        const status = nullIfBlank(event.status);
        if (!status) throw invalid('status is required');

        return withActor(pool, actor, async (client) => {
            const {rows: existing} = await client.query(
                'select id, status from payments where id = $1',
                [paymentId]
            );
            if (existing.length === 0) throw notFound('Payment');

            await client.query(
                `insert into external_payment_events (payment_id, provider, provider_reference, status, raw_payload)
                 values ($1, $2, $3, $4, coalesce($5::jsonb, '{}'::jsonb))`,
                [
                    paymentId,
                    nullIfBlank(event.provider) ?? 'unknown',
                    nullIfBlank(event.providerReference),
                    status,
                    event.rawPayload ? JSON.stringify(event.rawPayload) : null,
                ]
            );

            const settled = settledStatusFor(status);
            if (settled && existing[0].status !== settled) {
                await client.query(
                    `update payments
                        set status = $2::payment_status,
                            provider_reference = coalesce($3, provider_reference),
                            failure_reason = case when $2 = 'failed' then $4 else null end
                      where id = $1`,
                    [
                        paymentId,
                        settled,
                        nullIfBlank(event.providerReference),
                        nullIfBlank(event.failureReason) ?? 'Declined by provider',
                    ]
                );
            }
            return {id: paymentId};
        }).then(() => getPayment(paymentId));
    }

    /**
     * Manual reconciliation — cash and bank transfers never produce a callback,
     * so a finance officer vouches for them instead. Stamping `reconciled_at`
     * is what satisfies the trigger, and the audit log records who did it.
     */
    async function reconcilePayment(paymentId, {note} = {}, actor) {
        return withActor(pool, actor, async (client) => {
            const {rows} = await client.query(
                `update payments
                    set reconciled_at = now(),
                        notes = coalesce($2, notes)
                  where id = $1 and status = 'pending'
                  returning id`,
                [paymentId, nullIfBlank(note)]
            );
            if (rows.length === 0) {
                const {rows: found} = await client.query('select status from payments where id = $1', [
                    paymentId,
                ]);
                if (found.length === 0) throw notFound('Payment');
                throw invalid(`Only a pending payment can be reconciled — this one is ${found[0].status}`);
            }
            await client.query("update payments set status = 'successful' where id = $1", [paymentId]);
            return {id: paymentId};
        }).then(() => getPayment(paymentId));
    }

    async function failPayment(paymentId, {reason}, actor) {
        if (!nullIfBlank(reason)) throw invalid('A failure reason is required');
        return withActor(pool, actor, async (client) => {
            const {rows} = await client.query(
                `update payments set status = 'failed', failure_reason = $2 where id = $1 returning id`,
                [paymentId, nullIfBlank(reason)]
            );
            if (rows.length === 0) throw notFound('Payment');
            return {id: paymentId};
        }).then(() => getPayment(paymentId));
    }

    // --- disbursement --------------------------------------------------------

    /** What each landlord, broker and agency is owed right now. Straight from
     *  the view, so the figure on screen is the figure in the database. */
    async function outstandingBalances() {
        const {rows} = await query(
            pool,
            `select * from v_outstanding_balances order by amount_due desc`
        );
        return {items: rows};
    }

    async function searchPayouts(filters = {}) {
        const {limit, offset} = pageParams(filters);
        const {rows} = await query(pool, 'select * from search_payouts($1, $2, $3, $4, $5, $6)', [
            nullIfBlank(filters.query),
            nullIfBlank(filters.status),
            nullIfBlank(filters.beneficiaryType),
            nullIfBlank(filters.beneficiaryUserId),
            limit,
            offset,
        ]);
        return toPage(rows, {limit, offset});
    }

    async function getPayout(id) {
        const {rows} = await query(pool, 'select * from v_payouts where id = $1', [id]);
        if (rows.length === 0) throw notFound('Payout');

        const splits = await query(
            pool,
            `select s.id, s.amount, s.beneficiary_type, p.reference as payment_reference,
                    p.confirmed_at, prop.reference_code as property_reference, prop.title as property_title
               from payment_splits s
               join payments p on p.id = s.payment_id
               left join properties prop on prop.id = p.property_id
              where s.payout_id = $1
              order by p.confirmed_at`,
            [id]
        );
        const ledger = await query(
            pool,
            `select id, account, direction, amount, currency, description, entry_date
               from ledger_entries where payout_id = $1 order by id`,
            [id]
        );
        return {...rows[0], splits: splits.rows, ledger: ledger.rows};
    }

    /**
     * Gathers a beneficiary's unpaid splits into one payout. The amount is the
     * sum of the splits it claims — never a figure typed by a person — and the
     * claim is done in the same transaction, so two operators pressing the
     * button at once cannot pay the same rent twice.
     */
    async function createPayout({beneficiaryType, beneficiaryUserId, paymentMethodId, destination, scheduledFor}, actor) {
        const type = nullIfBlank(beneficiaryType);
        if (!BENEFICIARY_ROLE_COLUMN[type]) {
            throw invalid(`beneficiaryType must be one of: ${Object.keys(BENEFICIARY_ROLE_COLUMN).join(', ')}`);
        }
        const userId = nullIfBlank(beneficiaryUserId);
        if (!userId) throw invalid('beneficiaryUserId is required');

        return withActor(pool, actor, async (client) => {
            // `for update` on the splits: whoever gets here second finds none left.
            const {rows: claimable} = await client.query(
                `select s.id, s.amount
                   from payment_splits s
                   join payments p on p.id = s.payment_id
                  where s.payout_id is null
                    and s.beneficiary_user_id = $1
                    and s.beneficiary_type = $2::beneficiary_type
                    and p.status = 'successful'
                  for update of s`,
                [userId, type]
            );
            if (claimable.length === 0) throw invalid('That beneficiary has nothing outstanding');

            const total = claimable.reduce((sum, row) => sum + Number(row.amount), 0);
            const minimum = await numericSetting(client, 'payouts.minimum_amount', 0);
            if (total < minimum) {
                throw invalid(
                    `Outstanding balance of ${total} is below the minimum payout of ${minimum}`
                );
            }

            const {rows: beneficiary} = await client.query(
                `select kyc_status, bank_account_number, mobile_money_number from users where id = $1`,
                [userId]
            );
            if (beneficiary.length === 0) throw notFound('Beneficiary');

            const payoutDestination =
                nullIfBlank(destination) ??
                beneficiary[0].mobile_money_number ??
                beneficiary[0].bank_account_number;

            // Money leaving the platform to an unverified identity is the exact
            // thing KYC exists to stop, so it is held rather than refused —
            // finance can still see it and release it once KYC clears.
            const unverified = beneficiary[0].kyc_status !== 'verified';
            const missingDestination = !payoutDestination;
            const holdReason = unverified
                ? 'Beneficiary KYC is not verified'
                : missingDestination
                  ? 'No bank account or mobile money number on file'
                  : null;

            const {rows: payout} = await client.query(
                `insert into payouts
                     (beneficiary_type, beneficiary_user_id, amount, payment_method_id, destination,
                      status, hold_reason, scheduled_for, created_by)
                 values ($1::beneficiary_type, $2, $3, $4, $5,
                         case when $6::text is null then 'scheduled' else 'on_hold' end::payout_status,
                         $6, coalesce($7::date, current_date), $8)
                 returning id`,
                [
                    type,
                    userId,
                    total,
                    nullIfBlank(paymentMethodId),
                    payoutDestination,
                    holdReason,
                    nullIfBlank(scheduledFor),
                    actor ?? null,
                ]
            );

            await client.query(
                `update payment_splits set payout_id = $1 where id = any($2::uuid[])`,
                [payout[0].id, claimable.map((row) => row.id)]
            );

            return {id: payout[0].id};
        }).then((created) => getPayout(created.id));
    }

    /**
     * Moves a payout along its lifecycle. The legal moves are a trigger's
     * business (009); this only carries the reason a move needs and releases
     * the claimed splits when a payout is cancelled, so the money becomes
     * payable again instead of disappearing.
     */
    async function changePayoutStatus(id, {status, reason, providerReference}, actor) {
        const next = nullIfBlank(status);
        if (!next) throw invalid('status is required');
        if (next === 'failed' && !nullIfBlank(reason)) throw invalid('A failure reason is required');
        if (next === 'on_hold' && !nullIfBlank(reason)) throw invalid('A hold reason is required');

        return withActor(pool, actor, async (client) => {
            const {rows} = await client.query(
                `update payouts
                    set status = $2::payout_status,
                        failure_reason = case when $2 = 'failed' then $3 else failure_reason end,
                        hold_reason = case when $2 = 'on_hold' then $3 else hold_reason end,
                        provider_reference = coalesce($4, provider_reference)
                  where id = $1
                  returning id, status`,
                [id, next, nullIfBlank(reason), nullIfBlank(providerReference)]
            );
            if (rows.length === 0) throw notFound('Payout');

            if (rows[0].status === 'cancelled') {
                await client.query('update payment_splits set payout_id = null where payout_id = $1', [id]);
            }
            return {id};
        }).then(() => getPayout(id));
    }

    /** The finance summary behind the payments dashboard — every figure is a
     *  database aggregate, none of it recomputed in JavaScript. */
    async function summary() {
        const {rows} = await query(
            pool,
            `select
                coalesce(sum(amount) filter (where status = 'successful'), 0) as collected,
                coalesce(sum(amount) filter (where status = 'pending'), 0) as pending,
                coalesce(sum(amount) filter (where status = 'failed'), 0) as failed,
                count(*) filter (where status = 'successful') as successful_count,
                count(*) filter (where status = 'pending') as pending_count
               from payments`
        );
        const {rows: payoutRows} = await query(
            pool,
            `select
                coalesce(sum(amount) filter (where status = 'paid'), 0) as disbursed,
                coalesce(sum(amount) filter (where status in ('scheduled', 'processing')), 0) as in_flight,
                coalesce(sum(amount) filter (where status in ('on_hold', 'failed')), 0) as blocked
               from payouts`
        );
        const {rows: owed} = await query(
            pool,
            `select coalesce(sum(amount_due), 0) as owed, count(*) as beneficiaries from v_outstanding_balances`
        );
        const {rows: commission} = await query(
            pool,
            `select coalesce(sum(amount), 0) as platform_revenue
               from ledger_entries where account = 'revenue.commission'`
        );
        return {...rows[0], ...payoutRows[0], ...owed[0], ...commission[0]};
    }

    async function ledger(filters = {}) {
        const {limit, offset} = pageParams(filters);
        const {rows} = await query(
            pool,
            `select id, entry_date, account, direction, amount, currency, payment_id, payout_id,
                    beneficiary_user_id, description, count(*) over () as total_count
               from ledger_entries
              where ($1::text is null or account = $1)
              order by id desc
              limit $2 offset $3`,
            [nullIfBlank(filters.account), limit, offset]
        );
        return toPage(rows, {limit, offset});
    }

    // --- internals -----------------------------------------------------------

    /**
     * Derives the split from the property's own parties. The landlord gets
     * what is left after HomeMate's commission and any party commissions,
     * and the remainder is assigned to the last share so the rows always add
     * up to the payment exactly — no rounding dust.
     */
    async function deriveSplits(client, propertyId, amount) {
        const {rows: parties} = await client.query(
            `select role, user_id, commission_percentage
               from property_parties
              where property_id = $1 and is_primary
              order by role`,
            [propertyId]
        );

        const platformPercentage = await numericSetting(client, 'commission.platform_percentage', 10);
        const shares = [];

        const platformAmount = round2((amount * platformPercentage) / 100);
        shares.push({beneficiaryType: 'platform', amount: platformAmount, percentage: platformPercentage});

        for (const party of parties) {
            if (party.role === 'landlord') continue;
            const type = BENEFICIARY_ROLE_COLUMN[party.role];
            if (!type || !party.user_id) continue;
            const percentage = Number(party.commission_percentage ?? 0);
            if (percentage <= 0) continue;
            shares.push({
                beneficiaryType: type,
                beneficiaryUserId: party.user_id,
                amount: round2((amount * percentage) / 100),
                percentage,
            });
        }

        // The landlord is whoever is assigned that role on the property; a
        // property created before parties were assigned falls back to its owner.
        const landlord =
            parties.find((p) => p.role === 'landlord' && p.user_id) ??
            (await ownerOf(client, propertyId));
        if (!landlord?.user_id) {
            throw invalid('This property has no landlord on file, so the rent cannot be split');
        }

        const assigned = shares.reduce((sum, share) => sum + share.amount, 0);
        const remainder = round2(amount - assigned);
        if (remainder < 0) {
            throw invalid('Configured commissions exceed the payment amount');
        }
        shares.push({
            beneficiaryType: 'landlord',
            beneficiaryUserId: landlord.user_id,
            amount: remainder,
        });

        return shares;
    }

    async function ownerOf(client, propertyId) {
        const {rows} = await client.query('select owner_id from properties where id = $1', [propertyId]);
        if (rows.length === 0) throw notFound('Property');
        return {user_id: rows[0].owner_id};
    }

    function normaliseSplits(splits, amount) {
        const parsed = splits.map((split) => ({
            beneficiaryType: nullIfBlank(split.beneficiaryType),
            beneficiaryUserId: nullIfBlank(split.beneficiaryUserId),
            amount: round2(Number(split.amount)),
            percentage: split.percentage === undefined ? null : Number(split.percentage),
        }));
        if (parsed.some((split) => !Number.isFinite(split.amount))) {
            throw invalid('Every split needs a numeric amount');
        }
        const total = round2(parsed.reduce((sum, split) => sum + split.amount, 0));
        if (total !== round2(amount)) {
            throw invalid(`Splits add up to ${total} but the payment is ${amount}`);
        }
        return parsed;
    }

    async function numericSetting(client, key, fallback) {
        const {rows} = await client.query('select value from settings where key = $1', [key]);
        const parsed = Number(rows[0]?.value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    return {
        searchPayments,
        getPayment,
        recordPayment,
        recordProviderEvent,
        reconcilePayment,
        failPayment,
        outstandingBalances,
        searchPayouts,
        getPayout,
        createPayout,
        changePayoutStatus,
        summary,
        ledger,
        providers: Object.keys(paymentPorts),
    };
}

function round2(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/** Maps a provider's own vocabulary onto our payment status. Anything we do
 *  not recognise leaves the payment pending — an unknown word is not evidence. */
function settledStatusFor(providerStatus) {
    const normalised = providerStatus.toLowerCase();
    if (['successful', 'success', 'completed', 'paid'].includes(normalised)) return 'successful';
    if (['failed', 'failure', 'declined', 'cancelled'].includes(normalised)) return 'failed';
    return null;
}
