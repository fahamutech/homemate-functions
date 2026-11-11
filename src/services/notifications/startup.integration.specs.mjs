import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

/**
 * A wrong push setting must never stop the API from starting.
 *
 * Production went down for ~16 minutes when PUSH_PROVIDER=fcm was set without
 * a usable credentials file: the notifications container threw while the
 * server was loading its functions, before migrations ran. Each case below
 * loads the real entry files in a fresh process, as the server does.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const LOAD_EVERYTHING = `
    await import('./functions/index.mjs');
    await import('./functions/schedule/index.mjs');
    await import('./functions/rest/customer-app.mjs');
    console.log('LOADED');
    process.exit(0);
`;

function startApi(env) {
    return spawnSync(process.execPath, ['--input-type=module', '-e', LOAD_EVERYTHING], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 60_000,
        env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            DATABASE_URL: process.env.DATABASE_URL,
            SESSION_TOKEN_SECRET: 'startup-spec',
            NOTIFICATION_PROVIDER: 'sandbox',
            SMS_PROVIDER: 'sandbox',
            STORAGE_PROVIDER: process.env.STORAGE_PROVIDER ?? 'memory',
            AUTO_MIGRATE: 'false',
            PUSH_LISTEN: 'false',
            // The server reads a .env file without overriding what is already
            // set, so a developer's own push settings are blanked out rather
            // than left to leak into the case being tested.
            PUSH_PROVIDER: 'sandbox',
            FCM_SERVICE_ACCOUNT_FILE: '',
            FCM_SERVICE_ACCOUNT_JSON: '',
            GOOGLE_APPLICATION_CREDENTIALS: '',
            ...env,
        },
    });
}

describe('API startup with push settings (integration)', () => {
    test('with no push settings it starts on the sandbox', () => {
        const run = startApi({});
        assert.match(run.stdout, /LOADED/, run.stderr);
        assert.doesNotMatch(run.stderr, /\[push\] DISABLED/);
    });

    for (const [name, env, reason] of [
        ['fcm without credentials', {PUSH_PROVIDER: 'fcm'}, /FCM needs a service account/],
        ['a credentials file that is not in the container',
            {PUSH_PROVIDER: 'fcm', FCM_SERVICE_ACCOUNT_FILE: '/etc/secrets/does-not-exist.json'}, /ENOENT/],
        ['credentials JSON mangled by the host',
            {PUSH_PROVIDER: 'fcm', FCM_SERVICE_ACCOUNT_JSON: '{type:service_account}'}, /JSON/],
        ['credentials missing required fields',
            {PUSH_PROVIDER: 'fcm', FCM_SERVICE_ACCOUNT_JSON: '{"project_id":"homematetz"}'}, /client_email, private_key and project_id/],
        ['a typo in the provider name', {PUSH_PROVIDER: 'firebase'}, /Unknown PUSH_PROVIDER "firebase"/],
    ]) {
        test(`${name}: the API still starts and says push is disabled`, () => {
            const run = startApi(env);
            assert.match(run.stdout, /LOADED/, `the API did not start:\n${run.stderr}`);
            assert.match(run.stderr, /\[push\] DISABLED/);
            assert.match(run.stderr, reason);
        });
    }
});
