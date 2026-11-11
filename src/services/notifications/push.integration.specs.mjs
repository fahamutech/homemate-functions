import {test, describe, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createPushOutbox} from './push-outbox.mjs';
import {createPushDevicesService} from './devices.mjs';
import {createSandboxPushAdapter} from './adapters/sandbox-push.adapter.mjs';

/**
 * Push notifications (migration 035): every inbox notification is pushed to
 * the person's live devices, dead tokens are retired, outages retried, and
 * the listener pushes the moment a notification is committed.
 */
describe('push notifications (Postgres integration)', () => {
    /** @type {pg.Pool} */
    let pool;
    let devices;
    let pushPort;
    let outbox;
    let neema;
    let juma;

    before(() => {
        pool = new pg.Pool({connectionString: process.env.DATABASE_URL});
        devices = createPushDevicesService({pool});
    });

    after(async () => {
        await pool.end();
    });

    beforeEach(async () => {
        await pool.query('truncate table push_deliveries, push_devices, notifications, users restart identity cascade');
        neema = await makeUser('+255714300001', 'Neema');
        juma = await makeUser('+255714300002', 'Juma');
        pushPort = createSandboxPushAdapter({log: false});
        outbox = createPushOutbox({pool, pushPort, webBaseUrl: 'https://app.homemate.test/'});
    });

    async function makeUser(phone, name) {
        const {rows} = await pool.query(
            `insert into users (phone_number, full_name, role, status) values ($1, $2, 'customer', 'active') returning id`,
            [phone, name]
        );
        return rows[0].id;
    }

    async function notify(userId, {title = 'You have a reply', audience = 'customer'} = {}) {
        const {rows} = await pool.query(
            `insert into notifications (user_id, kind, title, body, subject_table, subject_id, audience)
             values ($1, 'inquiry_response', $2, 'Yes, it is free from May.', 'property_inquiries', gen_random_uuid(), $3)
             returning id, subject_id`,
            [userId, title, audience]
        );
        return rows[0];
    }

    const pushState = async (id) =>
        (await pool.query('select push_status, push_attempts, pushed_at from notifications where id = $1', [id])).rows[0];

    test('a notification goes to every live phone of its person, with what the app needs to open it', async () => {
        await devices.register(neema, {token: 'android-token-neema-0001', platform: 'android', appVersion: '1.4.0+5'});
        await devices.register(neema, {token: 'web-token-neema-00000001', platform: 'web'});
        await devices.register(juma, {token: 'android-token-juma-00001', platform: 'android'});
        const {id, subject_id: subjectId} = await notify(neema);

        assert.deepEqual(await outbox.drain(), {sent: 1, skipped: 0, retry: 0, failed: 0});
        assert.deepEqual(pushPort.sentMessages.map((m) => m.token).sort(),
            ['android-token-neema-0001', 'web-token-neema-00000001'], 'only Neema’s phones');
        const [android] = pushPort.sentMessages;
        assert.equal(android.title, 'You have a reply');
        assert.equal(android.body, 'Yes, it is free from May.');
        assert.deepEqual(android.data, {
            notificationId: id, kind: 'inquiry_response', audience: 'customer',
            subjectTable: 'property_inquiries', subjectId,
        });
        assert.equal(android.link, `https://app.homemate.test/#/open-notification?${new URLSearchParams(android.data)}`);

        const state = await pushState(id);
        assert.equal(state.push_status, 'sent');
        assert.ok(state.pushed_at);
        const {rows} = await pool.query(`select status, provider from push_deliveries where notification_id = $1`, [id]);
        assert.deepEqual(rows.map((r) => r.status), ['sent', 'sent']);
        assert.deepEqual(await outbox.drain(), {sent: 0, skipped: 0, retry: 0, failed: 0}, 'never pushed twice');
    });

    test('someone with no phone registered keeps the notification in the inbox only', async () => {
        const {id} = await notify(neema);
        assert.deepEqual(await outbox.drain(), {sent: 0, skipped: 1, retry: 0, failed: 0});
        assert.equal((await pushState(id)).push_status, 'skipped');
    });

    test('a dead token is retired and the person’s other phone still reached', async () => {
        await devices.register(neema, {token: 'invalid-token-uninstalled', platform: 'android'});
        await devices.register(neema, {token: 'android-token-neema-0002', platform: 'android'});
        const {id} = await notify(neema);

        await outbox.drain();
        assert.equal((await pushState(id)).push_status, 'sent');
        const {rows} = await pool.query('select token, disabled_at is not null as disabled from push_devices order by token');
        assert.deepEqual(rows, [
            {token: 'android-token-neema-0002', disabled: false},
            {token: 'invalid-token-uninstalled', disabled: true},
        ]);

        await notify(neema, {title: 'Second'});
        await outbox.drain();
        assert.equal(pushPort.sentMessages.filter((m) => m.token.startsWith('invalid-')).length, 0, 'not tried again');

        await devices.register(neema, {token: 'invalid-token-uninstalled', platform: 'android'});
        const {rows: revived} = await pool.query(`select disabled_at from push_devices where token = 'invalid-token-uninstalled'`);
        assert.equal(revived[0].disabled_at, null, 'the app handing the token back revives it');
    });

    test('an outage is retried later and given up after the last attempt', async () => {
        await devices.register(neema, {token: 'flaky-token-provider-down', platform: 'android'});
        const {id} = await notify(neema);
        outbox = createPushOutbox({pool, pushPort, maxAttempts: 2});

        assert.deepEqual(await outbox.drain(), {sent: 0, skipped: 0, retry: 1, failed: 0});
        assert.deepEqual(await outbox.drain(), {sent: 0, skipped: 0, retry: 0, failed: 0}, 'not before its retry time');
        await pool.query('update notifications set push_next_attempt_at = now() where id = $1', [id]);
        assert.deepEqual(await outbox.drain(), {sent: 0, skipped: 0, retry: 0, failed: 1});
        const state = await pushState(id);
        assert.deepEqual([state.push_status, state.push_attempts], ['failed', 2]);
    });

    test('a notification that waited a day is not pushed late', async () => {
        await devices.register(neema, {token: 'android-token-neema-0003', platform: 'android'});
        const {id} = await notify(neema);
        await pool.query(`update notifications set created_at = now() - interval '25 hours' where id = $1`, [id]);

        await outbox.drain();
        assert.equal((await pushState(id)).push_status, 'skipped');
        assert.equal(pushPort.sentMessages.length, 0);
    });

    test('a token moves to whoever signs in on that phone, and sign-out removes only your own', async () => {
        await devices.register(neema, {token: 'shared-phone-token-0001', platform: 'android'});
        await devices.register(juma, {token: 'shared-phone-token-0001', platform: 'android'});
        const {rows} = await pool.query('select user_id from push_devices');
        assert.deepEqual(rows, [{user_id: juma}]);

        assert.deepEqual(await devices.unregister(neema, {token: 'shared-phone-token-0001'}), {removed: 0});
        assert.deepEqual(await devices.unregister(juma, {token: 'shared-phone-token-0001'}), {removed: 1});

        await assert.rejects(devices.register(neema, {token: 'short', platform: 'android'}), /FCM registration token/);
        await assert.rejects(devices.register(neema, {token: 'a-perfectly-long-token', platform: 'desktop'}), /platform must be one of/);
    });

    test('the listener pushes as soon as a notification is committed', async () => {
        await devices.register(neema, {token: 'android-token-neema-0004', platform: 'android'});
        const stop = outbox.listen({connectionString: process.env.DATABASE_URL});
        try {
            await new Promise((resolve) => setTimeout(resolve, 300)); // let it LISTEN
            const client = await pool.connect();
            try {
                await client.query('begin');
                await client.query(
                    `insert into notifications (user_id, kind, title) values ($1, 'system', 'Rolled back')`, [neema]);
                await client.query('rollback');
            } finally {
                client.release();
            }
            const {id} = await notify(neema, {title: 'Committed'});

            const deadline = Date.now() + 5_000;
            while ((await pushState(id)).push_status !== 'sent' && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            assert.equal((await pushState(id)).push_status, 'sent');
            assert.deepEqual(pushPort.sentMessages.map((m) => m.title), ['Committed'], 'a rolled-back notification is never pushed');
        } finally {
            await stop();
        }
    });
});
