import {readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {spawn} from 'node:child_process';

function collect(dir, suffix, out = []) {
    let entries;
    try {
        entries = readdirSync(dir);
    } catch {
        return out;
    }
    for (const entry of entries) {
        if (entry === 'node_modules' || entry.startsWith('.')) continue;
        const fullPath = join(dir, entry);
        const stats = statSync(fullPath);
        if (stats.isDirectory()) {
            collect(fullPath, suffix, out);
        } else if (entry.endsWith(suffix)) {
            out.push(fullPath);
        }
    }
    return out;
}

const [, , rootDir, suffix, ...flags] = process.argv;
if (!rootDir || !suffix) {
    console.error('Usage: node scripts/run-specs.mjs <rootDir> <suffix> [--serial]');
    process.exit(1);
}

// Database-backed suites share one `homemate_test` database and truncate
// tables between tests, so running their files concurrently (the Node test
// runner's default) lets one file wipe another's fixtures mid-assertion.
const serial = flags.includes('--serial');

const files = collect(rootDir, suffix);
if (files.length === 0) {
    console.log(`No spec files found under ${rootDir} matching ${suffix} — skipping.`);
    process.exit(0);
}

console.log(`Running ${files.length} spec file(s) matching ${suffix} under ${rootDir}:`);
files.forEach(f => console.log(`  - ${f}`));

const args = ['--test', ...(serial ? ['--test-concurrency=1'] : []), ...files];
const child = spawn(process.execPath, args, {stdio: 'inherit'});
child.on('exit', code => process.exit(code ?? 1));
