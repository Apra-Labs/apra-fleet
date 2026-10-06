// Smoke test: pins the package manifest's shape and proves bin/fleet-bridge.mjs
// is a runnable module, not just a file that happens to exist. This is the
// package's only test today (skeleton phase -- verbs/adapters/sinks land in
// parallel work), so it exists to keep the suite from ever being empty.

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { VERBS } from '../src/cli/args.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
const binPath = path.join(pkgRoot, 'bin', 'fleet-bridge.mjs');

// `node --test` sets NODE_TEST_CONTEXT on ITS OWN process, and `spawnSync`
// inherits the parent's env by default -- so a spawned child would see it
// too, and bin/fleet-bridge.mjs's own isMainModule() guard (added so
// test/composition-root.test.mjs can import this module for its exports
// without the CLI self-executing against the test runner's argv) treats
// that as "I was loaded as a test file" and no-ops: empty stdout, exit 0,
// nothing actually ran. Established pattern elsewhere in this monorepo
// (packages/apra-fleet-se/test/phase1-leaf-facade-completeness.test.mjs and
// its siblings): strip it from every spawned child's env.
function spawnBin(args) {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    return spawnSync(process.execPath, [binPath, ...args], { encoding: 'utf8', env });
}

describe('package.json', () => {
    test('identifies as @apralabs/apra-fleet-bridge', () => {
        assert.strictEqual(pkg.name, '@apralabs/apra-fleet-bridge');
    });

    test('is private and monorepo-internal', () => {
        assert.strictEqual(pkg.private, true);
    });

    test('is an ES module package', () => {
        assert.strictEqual(pkg.type, 'module');
    });

    test('exposes the fleet-bridge bin entry', () => {
        assert.strictEqual(pkg.bin?.['fleet-bridge'], 'bin/fleet-bridge.mjs');
    });

    test('runs its suite with node --test', () => {
        assert.strictEqual(pkg.scripts?.test, 'node --test test/*.test.mjs');
    });
});

describe('bin/fleet-bridge.mjs', () => {
    test('exists on disk', () => {
        assert.ok(existsSync(binPath), `expected ${binPath} to exist`);
    });

    test('is executable as a module: --help exits 0 and prints usage', () => {
        const result = spawnBin(['--help']);
        assert.strictEqual(result.status, 0, result.stderr);
        assert.match(result.stdout, /Usage: fleet-bridge <verb>/);
    });

    test('is executable as a module: --version exits 0 and prints the package version', () => {
        const result = spawnBin(['--version']);
        assert.strictEqual(result.status, 0, result.stderr);
        assert.strictEqual(result.stdout.trim(), pkg.version);
    });

    test('exits 2 on an unknown verb', () => {
        const result = spawnBin(['not-a-real-verb']);
        assert.strictEqual(result.status, 2);
        assert.match(result.stderr, /unknown verb/);
    });

    test('advertises the exact verb list exported by src/cli/args.mjs', () => {
        const result = spawnBin(['--help']);
        const helpText = result.stdout;
        for (const verb of VERBS) {
            assert.match(
                helpText,
                new RegExp(`\\b${verb}\\b`),
                `Expected help output to mention verb "${verb}"`,
            );
        }
    });
});
