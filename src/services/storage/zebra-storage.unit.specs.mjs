import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {createZebraStorageAdapter} from './adapters/zebra-storage.adapter.mjs';
import {createMemoryStorageAdapter} from './adapters/memory-storage.adapter.mjs';

/**
 * The Zebra adapter is tested against a scripted fetch rather than the live
 * service: what matters here is that it speaks the protocol correctly (token
 * first, multipart upload, relative URL resolved against the base) and caches
 * the token. A real round trip is covered by the e2e suite when the storage
 * service is running.
 */
function scriptedFetch(handlers) {
    const calls = [];
    const impl = async (url, options = {}) => {
        const href = typeof url === 'string' ? url : url.toString();
        calls.push({href, options});
        const handler = handlers.find((h) => href.includes(h.match));
        if (!handler) throw new Error(`No scripted response for ${href}`);
        return handler.respond(options);
    };
    impl.calls = calls;
    return impl;
}

function jsonResponse(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
        headers: new Map(),
    };
}

describe('Zebra storage adapter', () => {
    const tokenHandler = {
        match: '/auth/token',
        respond: async () => jsonResponse({accessToken: 'tok-1', expiresIn: 3600}),
    };

    test('authenticates, uploads and resolves the returned relative URL', async () => {
        const fetchImpl = scriptedFetch([
            tokenHandler,
            {
                match: '/storage',
                respond: async () => jsonResponse({urls: ['/storage/bafy123/front.webp']}),
            },
        ]);
        const adapter = createZebraStorageAdapter({
            baseUrl: 'http://storage.test/',
            username: 'homemate',
            password: 'secret',
            fetchImpl,
        });

        const stored = await adapter.put({
            name: 'front.webp',
            contentType: 'image/webp',
            body: Buffer.from('bytes'),
        });

        assert.equal(stored.key, '/storage/bafy123/front.webp', 'the relative path is the storage key');
        assert.equal(stored.url, 'http://storage.test/storage/bafy123/front.webp');
        assert.equal(stored.contentType, 'image/webp');

        const upload = fetchImpl.calls.find((c) => c.href.endsWith('/storage'));
        assert.equal(upload.options.headers.authorization, 'Bearer tok-1');
        assert.ok(upload.options.body instanceof FormData);
    });

    test('reuses the access token across uploads instead of re-authenticating', async () => {
        const fetchImpl = scriptedFetch([
            tokenHandler,
            {match: '/storage', respond: async () => jsonResponse({urls: ['/storage/x/y.webp']})},
        ]);
        const adapter = createZebraStorageAdapter({
            baseUrl: 'http://storage.test',
            username: 'u',
            password: 'p',
            fetchImpl,
        });

        await adapter.put({name: 'a.webp', contentType: 'image/webp', body: Buffer.from('a')});
        await adapter.put({name: 'b.webp', contentType: 'image/webp', body: Buffer.from('b')});

        assert.equal(fetchImpl.calls.filter((c) => c.href.includes('/auth/token')).length, 1);
    });

    test('re-authenticates once the token is close to expiry', async () => {
        let clock = 0;
        const fetchImpl = scriptedFetch([
            {match: '/auth/token', respond: async () => jsonResponse({accessToken: 'tok', expiresIn: 120})},
            {match: '/storage', respond: async () => jsonResponse({urls: ['/storage/x/y.webp']})},
        ]);
        const adapter = createZebraStorageAdapter({
            baseUrl: 'http://storage.test',
            username: 'u',
            password: 'p',
            fetchImpl,
            now: () => clock,
        });

        await adapter.put({name: 'a.webp', contentType: 'image/webp', body: Buffer.from('a')});
        clock = 119_000; // inside the 60s refresh margin of a 120s token
        await adapter.put({name: 'b.webp', contentType: 'image/webp', body: Buffer.from('b')});

        assert.equal(fetchImpl.calls.filter((c) => c.href.includes('/auth/token')).length, 2);
    });

    test('surfaces bad credentials rather than retrying forever', async () => {
        const fetchImpl = scriptedFetch([
            {match: '/auth/token', respond: async () => jsonResponse({message: 'nope'}, 401)},
        ]);
        const adapter = createZebraStorageAdapter({
            baseUrl: 'http://storage.test',
            username: 'u',
            password: 'bad',
            fetchImpl,
        });

        await assert.rejects(
            () => adapter.put({name: 'a.webp', contentType: 'image/webp', body: Buffer.from('a')}),
            (error) => {
                assert.equal(error.code, 'AUTH_FAILED');
                return true;
            }
        );
    });

    test('maps a missing object to NOT_FOUND', async () => {
        const fetchImpl = scriptedFetch([
            tokenHandler,
            {match: '/storage/', respond: async () => ({ok: false, status: 404, headers: new Map()})},
        ]);
        const adapter = createZebraStorageAdapter({
            baseUrl: 'http://storage.test',
            username: 'u',
            password: 'p',
            fetchImpl,
        });

        await assert.rejects(
            () => adapter.get('/storage/missing/x.webp'),
            (error) => {
                assert.equal(error.code, 'NOT_FOUND');
                assert.equal(error.status, 404);
                return true;
            }
        );
    });

    test('refuses to start without a base URL', () => {
        assert.throws(() => createZebraStorageAdapter({baseUrl: ''}), (error) => {
            assert.equal(error.code, 'NOT_CONFIGURED');
            return true;
        });
    });
});

describe('memory storage adapter', () => {
    test('round-trips bytes and reports NOT_FOUND for unknown keys', async () => {
        const adapter = createMemoryStorageAdapter();
        const stored = await adapter.put({
            name: 'x.webp',
            contentType: 'image/webp',
            body: Buffer.from('hello'),
        });

        const read = await adapter.get(stored.key);
        assert.equal(read.body.toString(), 'hello');
        assert.equal(read.contentType, 'image/webp');

        await assert.rejects(() => adapter.get('/storage/nope/x.webp'), (error) => {
            assert.equal(error.code, 'NOT_FOUND');
            return true;
        });
    });
});
