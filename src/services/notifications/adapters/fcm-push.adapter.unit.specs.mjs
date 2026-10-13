import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, createVerify} from 'node:crypto';
import {createFcmPushAdapter, loadServiceAccount, ANDROID_CHANNEL_ID} from './fcm-push.adapter.mjs';

const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
const serviceAccount = {
    project_id: 'homematetz',
    client_email: 'push@homematetz.iam.gserviceaccount.com',
    private_key: privateKey.export({type: 'pkcs8', format: 'pem'}),
    token_uri: 'https://oauth2.googleapis.com/token',
};

const message = (overrides = {}) => ({
    token: 'device-token-0123456789',
    platform: 'android',
    title: 'New enquiry',
    body: 'Neema asked about Sea view flat.',
    data: {notificationId: 'n-1', kind: 'enquiry_received', audience: 'broker', subjectTable: 'property_inquiries', subjectId: 'i-1'},
    link: 'https://homemate.co.tz/#/open-notification?notificationId=n-1',
    ...overrides,
});

/** A fetch that answers the token exchange, then each send with the next queued reply. */
function fakeFetch(sendReplies = [{status: 200, body: {name: 'projects/homematetz/messages/1'}}]) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({url, init});
        if (url.includes('oauth2')) {
            return new Response(JSON.stringify({access_token: 'ya29.token', expires_in: 3600}), {status: 200});
        }
        const reply = sendReplies.shift() ?? {status: 200, body: {name: 'projects/homematetz/messages/n'}};
        return new Response(JSON.stringify(reply.body), {status: reply.status});
    };
    return {fetchImpl, calls, sends: () => calls.filter((c) => c.url.includes('fcm.googleapis.com'))};
}

describe('FCM push adapter', () => {
    test('signs a service-account JWT, exchanges it once, and reuses the token', async () => {
        const fake = fakeFetch();
        let clock = 1_800_000_000_000;
        const fcm = createFcmPushAdapter({serviceAccount, fetchImpl: fake.fetchImpl, now: () => clock});

        await fcm.send(message());
        clock += 30 * 60 * 1000;
        await fcm.send(message());

        const exchanges = fake.calls.filter((c) => c.url.includes('oauth2'));
        assert.equal(exchanges.length, 1, 'a token good for an hour is reused');
        const assertion = new URLSearchParams(exchanges[0].init.body).get('assertion');
        const [header, claims, signature] = assertion.split('.');
        const verified = createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, signature, 'base64url');
        assert.ok(verified, 'signed with the service account key');
        const body = JSON.parse(Buffer.from(claims, 'base64url').toString());
        assert.equal(body.iss, serviceAccount.client_email);
        assert.equal(body.scope, 'https://www.googleapis.com/auth/firebase.messaging');

        clock += 31 * 60 * 1000;
        await fcm.send(message());
        assert.equal(fake.calls.filter((c) => c.url.includes('oauth2')).length, 2, 'renewed before it expires');
    });

    test('sends an Android notification on the HomeMate channel, with the data the app routes on', async () => {
        const fake = fakeFetch();
        const fcm = createFcmPushAdapter({serviceAccount, fetchImpl: fake.fetchImpl});
        const result = await fcm.send(message());

        assert.deepEqual(result, {ok: true, provider: 'fcm', messageId: 'projects/homematetz/messages/1'});
        const [send] = fake.sends();
        assert.equal(send.url, 'https://fcm.googleapis.com/v1/projects/homematetz/messages:send');
        assert.equal(send.init.headers.authorization, 'Bearer ya29.token');
        const sent = JSON.parse(send.init.body).message;
        assert.deepEqual(sent.notification, {title: 'New enquiry', body: 'Neema asked about Sea view flat.'});
        assert.equal(sent.data.subjectId, 'i-1');
        assert.equal(sent.android.notification.channel_id, ANDROID_CHANNEL_ID);
        assert.equal(sent.webpush, undefined);
    });

    test('a web push carries the click-through link and the app icon', async () => {
        const fake = fakeFetch();
        const fcm = createFcmPushAdapter({serviceAccount, fetchImpl: fake.fetchImpl});
        await fcm.send(message({platform: 'web', body: null}));

        const sent = JSON.parse(fake.sends()[0].init.body).message;
        assert.deepEqual(sent.notification, {title: 'New enquiry'});
        assert.equal(sent.webpush.fcm_options.link, 'https://homemate.co.tz/#/open-notification?notificationId=n-1');
        assert.equal(sent.webpush.notification.icon, '/icons/Icon-192.png');
        assert.equal(sent.android, undefined);
    });

    test('an uninstalled app is a dead token, an outage is worth retrying, a bad message is neither', async () => {
        const fcm = createFcmPushAdapter({
            serviceAccount,
            fetchImpl: fakeFetch([
                {status: 404, body: {error: {status: 'NOT_FOUND', message: 'Requested entity was not found.',
                    details: [{'@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED'}]}}},
                {status: 400, body: {error: {status: 'INVALID_ARGUMENT', message: 'The registration token is not a valid FCM registration token'}}},
                {status: 503, body: {error: {status: 'UNAVAILABLE', message: 'Try later'}}},
                {status: 400, body: {error: {status: 'INVALID_ARGUMENT', message: 'Invalid value at message.data'}}},
            ]).fetchImpl,
        });

        const dead = await fcm.send(message());
        assert.equal(dead.invalidToken, true);
        assert.equal(dead.retryable, false);
        assert.match(dead.error, /^UNREGISTERED/);
        assert.equal((await fcm.send(message())).invalidToken, true, 'a malformed token is as dead');
        const outage = await fcm.send(message());
        assert.deepEqual([outage.invalidToken, outage.retryable], [false, true]);
        const ours = await fcm.send(message());
        assert.deepEqual([ours.invalidToken, ours.retryable], [false, false]);
    });

    test('a network failure is reported, not thrown', async () => {
        const fcm = createFcmPushAdapter({
            serviceAccount,
            fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); },
        });
        const result = await fcm.send(message());
        assert.equal(result.ok, false);
        assert.equal(result.retryable, true);
        assert.match(result.error, /ENOTFOUND/);
    });

    test('the service account must be complete', () => {
        assert.throws(() => loadServiceAccount({json: '', file: undefined}), /FCM needs a service account/);
        assert.throws(() => loadServiceAccount({json: '{"project_id":"x"}'}), /client_email, private_key and project_id/);
        assert.equal(loadServiceAccount({json: JSON.stringify(serviceAccount)}).project_id, 'homematetz');
    });
});
