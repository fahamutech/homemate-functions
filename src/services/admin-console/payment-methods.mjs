import {withActor, query, nullIfBlank, updateById} from '../../shared/db.mjs';
import {notFound, invalid} from '../../shared/errors.mjs';

const UPDATABLE_FIELDS = ['name', 'kind', 'provider', 'is_active', 'instructions', 'config', 'sort_order'];

/**
 * Payment methods the platform offers. `provider` names the PaymentPort
 * adapter that will actually move the money, and `config` carries whatever
 * that adapter needs (short code, till number, account…), so adding a real
 * provider is an adapter file plus a row here — no schema or code change in
 * the property/checkout paths.
 */
export function createPaymentMethodsService({pool, paymentPorts}) {
    async function list({activeOnly} = {}) {
        const {rows} = await query(
            pool,
            `select id, code, name, kind, provider, is_active, instructions, config, sort_order, updated_at
               from payment_methods
              where ($1::boolean is null or is_active = $1)
              order by sort_order, name`,
            [activeOnly === undefined || activeOnly === '' ? null : activeOnly === true || activeOnly === 'true']
        );
        return {
            items: rows,
            // what the admin may choose from — the adapters actually registered
            availableProviders: Object.keys(paymentPorts ?? {}),
        };
    }

    async function create(input, actor) {
        const code = nullIfBlank(input.code);
        const name = nullIfBlank(input.name);
        const kind = nullIfBlank(input.kind);
        if (!code || !name || !kind) throw invalid('code, name and kind are required');

        const provider = nullIfBlank(input.provider) ?? 'sandbox';
        assertProviderRegistered(provider);

        return withActor(pool, actor, async (client) => {
            const {rows} = await client.query(
                `insert into payment_methods (code, name, kind, provider, is_active, instructions, config, sort_order)
                 values ($1, $2, $3::payment_method_kind, $4, coalesce($5, false), $6,
                         coalesce($7::jsonb, '{}'::jsonb), coalesce($8, 0))
                 returning *`,
                [
                    code,
                    name,
                    kind,
                    provider,
                    input.isActive === undefined ? null : input.isActive === true || input.isActive === 'true',
                    nullIfBlank(input.instructions),
                    input.config ? JSON.stringify(input.config) : null,
                    input.sortOrder === undefined || input.sortOrder === '' ? null : Number(input.sortOrder),
                ]
            );
            return rows[0];
        });
    }

    async function update(id, patch, actor) {
        if (patch.provider !== undefined) assertProviderRegistered(nullIfBlank(patch.provider));

        return withActor(pool, actor, async (client) => {
            const updated = await updateById(client, {
                table: 'payment_methods',
                id,
                allowed: UPDATABLE_FIELDS,
                patch: {
                    name: nullIfBlank(patch.name) ?? undefined,
                    kind: nullIfBlank(patch.kind) ?? undefined,
                    provider: nullIfBlank(patch.provider) ?? undefined,
                    is_active:
                        patch.isActive === undefined ? undefined : patch.isActive === true || patch.isActive === 'true',
                    instructions: patch.instructions === undefined ? undefined : nullIfBlank(patch.instructions),
                    config: patch.config === undefined ? undefined : JSON.stringify(patch.config),
                    sort_order: patch.sortOrder === undefined ? undefined : Number(patch.sortOrder),
                },
            });
            if (!updated) throw notFound('Payment method');
            return updated;
        });
    }

    /**
     * Refuses to point a payment method at an adapter that does not exist —
     * otherwise the misconfiguration only surfaces when a customer tries to
     * pay.
     */
    function assertProviderRegistered(provider) {
        if (!provider) return;
        if (paymentPorts && !Object.hasOwn(paymentPorts, provider)) {
            throw invalid(
                `No PaymentPort adapter is registered for "${provider}". Available: ${Object.keys(paymentPorts).join(', ')}`
            );
        }
    }

    return {list, create, update};
}
