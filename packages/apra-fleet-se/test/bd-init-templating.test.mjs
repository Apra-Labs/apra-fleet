import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCmd, bdInitTemplateSpawnCount } from './helpers/bd-replay.mjs';

// =============================================================================
// apra-fleet-3ei -- template a pre-initialized empty bd directory for test
// setup() calls.
//
// Every heavy mock-sprint/golden-transcript/budget-live scenario's setup()
// issues a bare `bd init` into a brand-new scratch tempDir before it ever
// creates a bead. Under real bd (APRA_FLEET_BD_MOCK=off, the mode
// `npm run test:integration` uses and apra-fleet-eft.17's real-bd-suite
// budget bug is about) this used to be a full process spawn per scenario
// that bootstraps an embedded Dolt database from scratch -- 25+ times across
// the suite. bd-replay.mjs's realBdInitTemplated() now runs that real
// bootstrap exactly ONCE per test-file process (into a throwaway template
// directory) and serves every subsequent `bd init` call by copying the
// template onto the caller's own tempDir instead of re-spawning bd.
//
// This test drives that mechanism directly (bypassing the mock-sprint
// harness entirely) against the REAL `bd` binary, gated on that binary
// actually being available -- same "skip with a clear message, never a
// silent pass" pattern as the real-dolt-binary cases in
// dolt-sync-discipline.test.mjs. It forces APRA_FLEET_BD_MOCK=real for its
// own duration (restored in `finally`) so it exercises the real templating
// path regardless of which mode the ambient `npm test` invocation is using.
// =============================================================================

function resolveBdBinary() {
    try {
        const res = spawnSync('bd', ['--version'], { encoding: 'utf8', timeout: 15000 });
        return res.status === 0 ? 'bd' : null;
    } catch {
        return null;
    }
}

const BD_BIN = resolveBdBinary();
const BD_SKIP = BD_BIN
    ? false
    : 'bd binary unavailable on PATH -- skipping the real-bd `bd init` templating regression test.';

test(
    'apra-fleet-3ei: real-mode `bd init` is templated -- one real spawn serves every scenario setup in this process',
    { skip: BD_SKIP, timeout: 60000 },
    async () => {
        const prevMode = process.env.APRA_FLEET_BD_MOCK;
        process.env.APRA_FLEET_BD_MOCK = 'real';
        const dirs = [];
        try {
            const spawnsBefore = bdInitTemplateSpawnCount();

            for (let i = 0; i < 3; i += 1) {
                const dir = path.join(os.tmpdir(), `apra-fleet-bd-init-templating-test-${i}-${Date.now()}-${process.pid}`);
                await fsp.mkdir(dir, { recursive: true });
                dirs.push(dir);
                const res = await runCmd('bd init', dir);
                assert.equal(res.err, null, `bd init into ${dir} should succeed, stderr=${res.stderr}`);
                assert.ok(fs.existsSync(path.join(dir, '.beads')), `expected a .beads/ dir to exist in ${dir}`);
            }

            // Exactly one real spawn served all three setups above -- the
            // fix this test pins: template the bootstrap once, copy it per
            // scenario, instead of re-running `bd init`'s own bootstrap
            // from scratch every time.
            assert.equal(
                bdInitTemplateSpawnCount() - spawnsBefore,
                1,
                'expected exactly ONE real `bd init` process spawn to serve all 3 scenario setups',
            );

            // And each resulting directory is a genuinely independent,
            // working bd clone -- not just a directory that LOOKS
            // initialized -- even though it was produced by copying the
            // template rather than running its own `bd init`.
            for (const dir of dirs) {
                const listRes = await runCmd('bd list --json', dir);
                assert.equal(listRes.err, null, `bd list --json in ${dir} should succeed, stderr=${listRes.stderr}`);
                const issues = JSON.parse(listRes.stdout || '[]');
                assert.deepEqual(issues, [], `expected a freshly-templated clone to start with zero issues in ${dir}`);

                const createRes = await runCmd('bd create "Templated-clone smoke test" --silent', dir);
                assert.equal(createRes.err, null, `bd create in templated clone ${dir} should succeed, stderr=${createRes.stderr}`);
                assert.ok(createRes.stdout.trim().length > 0, `expected bd create --silent to return a non-empty id in ${dir}`);
            }
        } finally {
            if (prevMode === undefined) delete process.env.APRA_FLEET_BD_MOCK;
            else process.env.APRA_FLEET_BD_MOCK = prevMode;
            for (const dir of dirs) {
                await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
            }
        }
    },
);
