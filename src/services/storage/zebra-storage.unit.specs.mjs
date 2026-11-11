import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {createZebraStorageAdapter} from './adapters/zebra-storage.adapter.mjs';
import {createMemoryStorageAdapter} from './adapters/memory-storage.adapter.mjs';

/**
 * The Zebra adapter is tested against a scripted fetch rather than the live
 * service: what matters here is that it speaks the protocol correctly —
 * multipart upload, and the relative URL it gets back resolved against the
 * base. A real round trip is covered by the e2e suite when the storage service
 * is running.
 *
 * Authentication is on: a static token is sent as is, and a username/password
 * login is cached across uploads, refreshed before expiry, and fails loudly
 * on bad credentials.
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

    test('uploads and resolves the returned relative URL', async () => {
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
        assert.ok(upload.options.body instanceof FormData);
    });

    test('sends a static token without calling the login endpoint', async () => {
        const fetchImpl = scriptedFetch([
            tokenHandler,
            {match: '/storage', respond: async () => jsonResponse({urls: ['/storage/x/y.webp']})},
        ]);
        const adapter = createZebraStorageAdapter({baseUrl: 'http://storage.test', token: 'static-tok', fetchImpl});

        await adapter.put({name: 'a.webp', contentType: 'image/webp', body: Buffer.from('a')});

        assert.equal(fetchImpl.calls.filter((c) => c.href.includes('/auth/token')).length, 0);
        assert.equal(fetchImpl.calls[0].options.headers.authorization, 'Bearer static-tok');
    });

    test('logs in once and reuses the token across uploads', async () => {
        const fetchImpl = scriptedFetch([
            {match: '/storage/auth/token', respond: async () => jsonResponse({accessToken: 'tok-1', expiresIn: 3600})},
            {match: '/storage', respond: async () => jsonResponse({urls: ['/storage/x/y.webp']})},
        ]);
        const adapter = createZebraStorageAdapter({baseUrl: 'http://storage.test', username: 'u', password: 'p', fetchImpl});

        await adapter.put({name: 'a.webp', contentType: 'image/webp', body: Buffer.from('a')});
        await adapter.put({name: 'b.webp', contentType: 'image/webp', body: Buffer.from('b')});

        assert.equal(fetchImpl.calls.filter((c) => c.href.includes('/auth/token')).length, 1);
        const uploads = fetchImpl.calls.filter((c) => c.href.endsWith('/storage'));
        assert.equal(uploads[1].options.headers.authorization, 'Bearer tok-1');
    });

    test('refreshes the token a minute before it expires', async () => {
        let clock = 0;
        let logins = 0;
        const fetchImpl = scriptedFetch([
            {match: '/storage/auth/token', respond: async () => jsonResponse({accessToken: `tok-${++logins}`, expiresIn: 120})},
            {match: '/storage', respond: async () => jsonResponse({urls: ['/storage/x/y.webp']})},
        ]);
        const adapter = createZebraStorageAdapter({baseUrl: 'http://storage.test', username: 'u', password: 'p', fetchImpl, now: () => clock});

        await adapter.put({name: 'a.webp', contentType: 'image/webp', body: Buffer.from('a')});
        clock = 30_000;
        await adapter.put({name: 'b.webp', contentType: 'image/webp', body: Buffer.from('b')});
        assert.equal(logins, 1, 'still valid with more than a minute left');
        clock = 70_000;
        await adapter.put({name: 'c.webp', contentType: 'image/webp', body: Buffer.from('c')});
        assert.equal(logins, 2, 'inside the last minute it logs in again');
    });

    test('falls back to the older /auth/token path', async () => {
        const fetchImpl = scriptedFetch([
            {match: '/storage/auth/token', respond: async () => jsonResponse({}, 404)},
            {match: '/auth/token', respond: async () => jsonResponse({accessToken: 'old-tok', expiresIn: 3600})},
            {match: '/storage', respond: async () => jsonResponse({urls: ['/storage/x/y.webp']})},
        ]);
        const adapter = createZebraStorageAdapter({baseUrl: 'http://storage.test', username: 'u', password: 'p', fetchImpl});

        await adapter.put({name: 'a.webp', contentType: 'image/webp', body: Buffer.from('a')});

        const upload = fetchImpl.calls.find((c) => c.href.endsWith('/storage'));
        assert.equal(upload.options.headers.authorization, 'Bearer old-tok');
    });

    test('fails loudly when the service rejects the credentials', async () => {
        const fetchImpl = scriptedFetch([
            {match: '/auth/token', respond: async () => jsonResponse({message: 'no'}, 401)},
        ]);
        const adapter = createZebraStorageAdapter({baseUrl: 'http://storage.test', username: 'u', password: 'bad', fetchImpl});

        await assert.rejects(
            () => adapter.put({name: 'a.webp', contentType: 'image/webp', body: Buffer.from('a')}),
            (error) => error.code === 'AUTH_FAILED'
        );
    });

    test('refuses to run without any credentials', async () => {
        const adapter = createZebraStorageAdapter({baseUrl: 'http://storage.test', fetchImpl: scriptedFetch([])});
        await assert.rejects(
            () => adapter.put({name: 'a.webp', contentType: 'image/webp', body: Buffer.from('a')}),
            (error) => error.code === 'NOT_CONFIGURED'
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

    test('joins a key that has no leading slash onto the base URL', async () => {
        // The bug this covers: keys are stored exactly as the service returned
        // them, and a key without a leading slash concatenated straight onto
        // the base URL produced `http://storage.testdemo/...`, which is not a
        // URL at all — every thumbnail read 500ed.
        const fetchImpl = scriptedFetch([
            tokenHandler,
            {
                match: 'demo/',
                respond: async () => ({
                    ok: true,
                    status: 200,
                    headers: new Map([['content-type', 'image/webp']]),
                    arrayBuffer: async () => Buffer.from('bytes'),
                }),
            },
        ]);
        const adapter = createZebraStorageAdapter({
            baseUrl: 'http://storage.test',
            username: 'u',
            password: 'p',
            fetchImpl,
        });

        const file = await adapter.get('demo/e819f5ee/0.webp');

        assert.equal(file.contentType, 'image/webp');
        const read = fetchImpl.calls.find((c) => c.href.includes('demo/'));
        assert.equal(read.href, 'http://storage.test/demo/e819f5ee/0.webp');
    });

    test('does not double the slash when the base URL and the key both have one', async () => {
        const fetchImpl = scriptedFetch([
            tokenHandler,
            {
                match: '/storage/',
                respond: async () => ({
                    ok: true,
                    status: 200,
                    headers: new Map([['content-type', 'image/webp']]),
                    arrayBuffer: async () => Buffer.from('bytes'),
                }),
            },
        ]);
        const adapter = createZebraStorageAdapter({
            baseUrl: 'http://storage.test/',
            username: 'u',
            password: 'p',
            fetchImpl,
        });

        await adapter.get('/storage/bafy123/front.webp');

        const read = fetchImpl.calls.find((c) => c.href.includes('/storage/bafy123'));
        assert.equal(read.href, 'http://storage.test/storage/bafy123/front.webp');
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
