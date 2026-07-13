import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveFleetServerCommand, resolveRunnerScriptPath } from '../bin/cli.mjs';

// apra-fleet-3ns.1 -- layout-aware fleet-server + runner-script resolution.
// Same-class bug as apra-fleet-bun: cli.mjs's defaults assumed a dev
// monorepo checkout (three levels up from bin/) with no existence check, so
// any installed/bundled layout failed with an opaque spawn error. Both
// resolvers are exported with an injectable `deps` (env/dirname/exists) so
// every branch -- including a simulated real installed layout -- can be
// tested in isolation.

describe('resolveFleetServerCommand', () => {
    test('branch 1: APRA_FLEET_SERVER_CMD wins outright, split into command + args', () => {
        const result = resolveFleetServerCommand({
            env: { APRA_FLEET_SERVER_CMD: 'my-server --flag value' },
            exists: () => {
                throw new Error('exists() must not be called when APRA_FLEET_SERVER_CMD is set');
            },
        });
        assert.deepStrictEqual(result, { command: 'my-server', args: ['--flag', 'value'] });
    });

    test('APRA_FLEET_SERVER_CMD set but empty throws', () => {
        assert.throws(
            () => resolveFleetServerCommand({ env: { APRA_FLEET_SERVER_CMD: '   ' } }),
            /APRA_FLEET_SERVER_CMD is set but empty/,
        );
    });

    test('branch 2: APRA_FLEET_SERVER_BIN wins over the file-based defaults, no exists() check', () => {
        const result = resolveFleetServerCommand({
            env: { APRA_FLEET_SERVER_BIN: 'apra-fleet' },
            exists: () => {
                throw new Error('exists() must not be called when APRA_FLEET_SERVER_BIN is set');
            },
        });
        assert.deepStrictEqual(result, { command: 'apra-fleet', args: ['run', '--transport', 'stdio'] });
    });

    test('branch 3: bundled sibling dist/index.js resolves first when it exists', () => {
        const result = resolveFleetServerCommand({
            env: {},
            dirname: path.join('some', 'install', 'dist'),
            exists: (candidate) => candidate === path.join('some', 'install', 'dist', 'index.js'),
        });
        assert.strictEqual(result.command, 'node');
        assert.strictEqual(result.args[0], path.join('some', 'install', 'dist', 'index.js'));
    });

    test('branch 4: falls through to the dev-monorepo three-up dist/index.js when the bundled sibling is absent', () => {
        const dirname = path.join('repo', 'packages', 'apra-fleet-se', 'bin');
        const expectedDevEntry = path.resolve(dirname, '..', '..', '..', 'dist', 'index.js');
        const result = resolveFleetServerCommand({
            env: {},
            dirname,
            exists: (candidate) => candidate === expectedDevEntry,
        });
        assert.strictEqual(result.command, 'node');
        assert.strictEqual(result.args[0], expectedDevEntry);
    });

    test('missing-entry error names both env overrides and both attempted paths', () => {
        assert.throws(
            () => resolveFleetServerCommand({ env: {}, dirname: 'anywhere', exists: () => false }),
            (err) => {
                assert.match(err.message, /APRA_FLEET_SERVER_CMD/);
                assert.match(err.message, /APRA_FLEET_SERVER_BIN/);
                assert.match(err.message, /bundled layout/);
                assert.match(err.message, /dev-monorepo layout/);
                return true;
            },
        );
    });

    test('simulated installed layout: a real temp dir with only dist/index.js resolves the sibling server', () => {
        const tmpInstall = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-se-installed-'));
        try {
            const distDir = path.join(tmpInstall, 'dist');
            fs.mkdirSync(distDir, { recursive: true });
            fs.writeFileSync(path.join(distDir, 'index.js'), '// fleet server entry', 'utf-8');
            fs.writeFileSync(path.join(distDir, 'auto-sprint.mjs'), '// bundled cli', 'utf-8');

            // No packages/ or monorepo root anywhere in this tree -- __dirname
            // for a real bundled dist/auto-sprint.mjs would be distDir itself.
            const result = resolveFleetServerCommand({ env: {}, dirname: distDir });
            assert.strictEqual(result.command, 'node');
            assert.strictEqual(result.args[0], path.join(distDir, 'index.js'));
        } finally {
            fs.rmSync(tmpInstall, { recursive: true, force: true });
        }
    });
});

describe('resolveRunnerScriptPath', () => {
    test('bundled layout: sibling auto-sprint-runner.mjs resolves first when present', () => {
        const result = resolveRunnerScriptPath({
            dirname: path.join('some', 'install', 'dist'),
            exists: (candidate) => candidate === path.join('some', 'install', 'dist', 'auto-sprint-runner.mjs'),
        });
        assert.strictEqual(result, path.join('some', 'install', 'dist', 'auto-sprint-runner.mjs'));
    });

    test('dev-monorepo layout: falls through to ../auto-sprint/runner.js when the bundled asset is absent', () => {
        const dirname = path.join('repo', 'packages', 'apra-fleet-se', 'bin');
        const expected = path.join(dirname, '../auto-sprint/runner.js');
        const result = resolveRunnerScriptPath({
            dirname,
            exists: (candidate) => candidate === expected,
        });
        assert.strictEqual(result, expected);
    });

    test('throws an actionable error when neither candidate exists', () => {
        assert.throws(
            () => resolveRunnerScriptPath({ dirname: 'anywhere', exists: () => false }),
            (err) => {
                assert.match(err.message, /bundled layout/);
                assert.match(err.message, /dev-monorepo layout/);
                return true;
            },
        );
    });

    test('dev-mode default (no deps) resolves the real runner.js in this checkout', () => {
        const result = resolveRunnerScriptPath();
        assert.ok(fs.existsSync(result), `expected ${result} to exist`);
        assert.ok(result.replace(/\\/g, '/').endsWith('auto-sprint/runner.js'), result);
    });
});
