import {test, describe, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {start} from 'bfast-function';
import {createSessionTokenService} from '../../src/shared/session-tokens.mjs';

/**
 * T08's backend over HTTP: staff suspend and reactivate a partner role, pick
 * brokers by their T01 role, and see who listed a home — with the users ACL
 * applied as for every /admin/users route.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('journey: backoffice partner roles (e2e)', () => {
    /** @type {import('node:http').Server} */
    let server;
    let baseUrl;
    let db;
    let adminToken;
    let propertiesOnly;

    async function api(path, {method = 'GET', body, token} = {}) {
        const response = await fetch(`${baseUrl}${path}`, {
            method,
            headers: {
                ...(body ? {'content-type': 'application/json'} : {}),
                ...(token ? {authorization: `Bearer ${token}`} : {}),
            },
            ...(body ? {body: JSON.stringify(body)} : {}),
        });
        return {status: response.status, body: await response.json().catch(() => null)};
    }

    before(async () => {
        server = await start({
            port: process.env.PORT ?? '0',
            functionsConfig: {
                functionsDirPath: join(repoRoot, 'functions'),
                bfastJsonPath: join(repoRoot, 'bfast.json'),
            },
        });
        if (!server.listening) await once(server, 'listening');
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        db = new pg.Client({connectionString: process.env.DATABASE_URL});
        await db.connect();
        const login = await api('/auth/admin/login', {
            method: 'POST',
            body: {email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD},
        });
        adminToken = login.body.token;
        propertiesOnly = createSessionTokenService(process.env.SESSION_TOKEN_SECRET)
            .sign({role: 'moderator', email: 'm@homemate.co.tz', allowedRoutes: ['properties']});
    });

    after(async () => {
        await db.end();
        await new Promise((resolve) => server.close(resolve));
        setImmediate(() => process.exit(0));
    });

    beforeEach(async () => {
        await db.query('truncate table notifications, property_parties, properties, users, organizations restart identity cascade');
    });

    test('suspend → reactivate a broker role; pick brokers by role; see who listed a home', async () => {
        const {rows} = await db.query(
            `insert into users (phone_number, full_name, role, status) values ('+255716000001', 'Juma Broker', 'broker', 'active') returning id`
        );
        const broker = rows[0].id;
        await db.query(`insert into properties (title, created_by_user_id, status) values ('Home', $1, 'draft')`, [broker]);
        const {rows: prop} = await db.query('select id from properties');
        await db.query(`insert into property_parties (property_id, user_id, role, is_primary) values ($1, $2, 'broker', true)`, [prop[0].id, broker]);

        const refused = await api(`/admin/users/${broker}/roles/broker/status`, {method: 'POST', token: propertiesOnly, body: {status: 'suspended', reason: 'x'}});
        assert.equal(refused.status, 403);

        const noReason = await api(`/admin/users/${broker}/roles/broker/status`, {method: 'POST', token: adminToken, body: {status: 'suspended'}});
        assert.equal(noReason.status, 400);

        const suspended = await api(`/admin/users/${broker}/roles/broker/status`, {
            method: 'POST',
            token: adminToken,
            body: {status: 'suspended', reason: 'Fake listings'},
        });
        assert.equal(suspended.status, 200, JSON.stringify(suspended.body));
        assert.equal(suspended.body.roles.find((r) => r.role === 'broker').status, 'suspended');
        assert.equal((await api('/admin/users?partnerRole=broker&partnerStatus=active', {token: adminToken})).body.items.length, 0);

        await api(`/admin/users/${broker}/roles/broker/status`, {method: 'POST', token: adminToken, body: {status: 'active'}});
        const picker = await api('/admin/users?partnerRole=broker&partnerStatus=active', {token: adminToken});
        assert.deepEqual(picker.body.items.map((u) => u.id), [broker]);

        const list = await api('/admin/properties', {token: adminToken});
        assert.deepEqual(list.body.items[0].listed_by, {kind: 'broker', user_id: broker, name: 'Juma Broker'});
        assert.equal(list.body.items[0].landlord_confirmation.status, 'not_required');
    });
});
