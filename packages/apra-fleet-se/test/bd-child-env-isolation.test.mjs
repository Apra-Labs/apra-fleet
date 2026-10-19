import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCmd, bdChildEnv } from './helpers/bd-replay.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';

// =============================================================================
// bd resolves BEADS_DIR / BEADS_DB / BD_DB before cwd. bd-replay.mjs's execCmd
// (the real-bd choke point every mock-sprint scenario reaches via runCmd)
// drops them, so a `bd` spawn reaches the scratch dir the test built, never a
// workspace the host exports globally.
//
// Without that strip, the integration test below fails at its "sentinel must
// be byte-for-byte unchanged" assertions: commands run against the scratch
// clone land on the sentinel that BEADS_DIR points at.
// =============================================================================

function resolveBdBinary() {
    try {
        const res = spawnSync('bd', ['--version'], { encoding: 'utf8', timeout: 15000, env: bdChildEnv() });
        return res.status === 0 ? 'bd' : null;
    } catch {
        return null;
    }
}

const BD_BIN = resolveBdBinary();
const BD_SKIP = BD_BIN
    ? false
    : 'bd binary unavailable on PATH -- skipping the BEADS_DIR isolation regression test.';

// ---------------------------------------------------------------------------
// Unit level: bdChildEnv() itself.
// ---------------------------------------------------------------------------

const BEADS_VARS = ['BEADS_DIR', 'BEADS_DB', 'BD_DB'];

test('bdChildEnv() strips BEADS_DIR, BEADS_DB and BD_DB but leaves every other env var -- including BD_ALLOW_REMOTE_MIGRATE -- intact', () => {
    const prev = Object.fromEntries(BEADS_VARS.map((k) => [k, process.env[k]]));
    const prevPath = process.env.PATH;
    for (const k of BEADS_VARS) process.env[k] = `/some/polluted/ambient/beads/workspace/${k}`;
    try {
        const env = bdChildEnv();
        for (const k of BEADS_VARS) assert.equal(env[k], undefined, `${k} must be stripped from the child env`);
        assert.equal(
            env.BD_ALLOW_REMOTE_MIGRATE,
            '1',
            'BD_ALLOW_REMOTE_MIGRATE must still be set -- execCmd relies on it for dolt remote migrations',
        );
        assert.equal(env.PATH, prevPath, 'every other env var (e.g. PATH) must pass through unmodified');

        // bdChildEnv() must return a genuine clone, not a live reference into
        // process.env -- mutating the result must never leak back.
        env.BD_ALLOW_REMOTE_MIGRATE = 'mutated';
        assert.notEqual(process.env.BD_ALLOW_REMOTE_MIGRATE, 'mutated');
    } finally {
        for (const k of BEADS_VARS) {
            if (prev[k] === undefined) delete process.env[k];
            else process.env[k] = prev[k];
        }
    }
});

test('bdChildEnv() is also BEADS_DIR-free when the ambient env never had it set (unset case must not throw)', () => {
    const prevBeadsDir = process.env.BEADS_DIR;
    delete process.env.BEADS_DIR;
    try {
        const env = bdChildEnv();
        assert.equal(env.BEADS_DIR, undefined);
    } finally {
        if (prevBeadsDir === undefined) delete process.env.BEADS_DIR;
        else process.env.BEADS_DIR = prevBeadsDir;
    }
});

// ---------------------------------------------------------------------------
// Integration level: a remote rewrite through a polluted BEADS_DIR.
// ---------------------------------------------------------------------------

// Direct, independent read path (NOT through runCmd/execCmd) used only to
// snapshot the sentinel's real on-disk state -- always with BEADS_DIR
// stripped via bdChildEnv() so these reads are themselves immune to whatever
// this process's ambient BEADS_DIR is doing.
function bdDirect(args, cwd) {
    return spawnSync('bd', args, { cwd, encoding: 'utf-8', env: bdChildEnv(), timeout: 15000 });
}

function sentinelSnapshot(sentinelDir) {
    const configYaml = fs.readFileSync(path.join(sentinelDir, '.beads', 'config.yaml'), 'utf-8');
    const remoteList = bdDirect(['dolt', 'remote', 'list', '--json'], sentinelDir);
    const issues = bdDirect(['list', '--all', '--json'], sentinelDir);
    let issueCount = -1; // -1 (never a real count) if unparsable, so a parse failure never masquerades as "unchanged"
    try {
        const parsed = JSON.parse(issues.stdout || '[]');
        issueCount = (Array.isArray(parsed) ? parsed : parsed.issues || []).length;
    } catch {
        issueCount = -1;
    }
    return { configYaml, remoteListStdout: remoteList.stdout, issueCount };
}

test(
    'a polluted BEADS_DIR cannot redirect a bd command away from its real cwd workspace',
    { skip: BD_SKIP, timeout: scaledTimeout(60000) },
    async () => {
        const prevMode = process.env.APRA_FLEET_BD_MOCK;
        const prevBeadsDir = process.env.BEADS_DIR;
        process.env.APRA_FLEET_BD_MOCK = 'real';

        const sentinelDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bd-child-env-sentinel-'));
        const scratchDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bd-child-env-scratch-'));
        const remoteDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bd-child-env-remote-'));

        try {
            // Two REAL, independent bd workspaces. `bd init` (bare, no
            // flags) is served from the shared host-level template bd-replay.mjs
            // maintains (see its own header comment) -- a cheap directory
            // copy, not a fresh real bootstrap, so this stays fast.
            const sentinelInit = await runCmd('bd init', sentinelDir);
            assert.equal(sentinelInit.err, null, `sentinel bd init failed: ${sentinelInit.stderr}`);
            const scratchInit = await runCmd('bd init', scratchDir);
            assert.equal(scratchInit.err, null, `scratch bd init failed: ${scratchInit.stderr}`);

            const before = sentinelSnapshot(sentinelDir);
            // Sanity: a freshly templated clone starts with no dolt remote
            // and no issues -- if this ever fails, the snapshot below is
            // meaningless (nothing to protect).
            assert.deepEqual(JSON.parse(before.remoteListStdout || '[]'), []);
            assert.equal(before.issueCount, 0);

            // Pollute BEADS_DIR to point at the sentinel, as a shell profile
            // that exports it globally would.
            process.env.BEADS_DIR = path.join(sentinelDir, '.beads');

            // A remote rewrite (bd dolt remote add + bd config set
            // sync.remote) through the harness entry point (runCmd ->
            // execCmd), against scratchDir, a valid workspace of its own that
            // BEADS_DIR never names.
            const remoteUrl = pathToFileURL(remoteDir).href;
            const addRes = await runCmd(`bd dolt remote add origin ${remoteUrl}`, scratchDir);
            const setRes = await runCmd('bd config set sync.remote origin', scratchDir);

            // These must land on scratchDir -- proof the commands succeeded
            // against the CORRECT (cwd-resolved) target, not merely failed
            // everywhere, which would prove isolation for the wrong reason.
            assert.equal(addRes.err, null, `bd dolt remote add against scratchDir failed: ${addRes.stderr}`);
            assert.equal(setRes.err, null, `bd config set against scratchDir failed: ${setRes.stderr}`);
            const scratchConfig = fs.readFileSync(path.join(scratchDir, '.beads', 'config.yaml'), 'utf-8');
            assert.match(
                scratchConfig,
                /sync\.remote:\s*"origin"/,
                'scratchDir (the real cwd workspace) must show the attack commands actually landed on IT',
            );

            const after = sentinelSnapshot(sentinelDir);

            // THE invariant this whole bead exists to protect: the sentinel
            // -- reachable ONLY via the polluted BEADS_DIR, never via cwd --
            // is byte-for-byte untouched by commands that never named it.
            assert.equal(after.configYaml, before.configYaml, 'sentinel config.yaml must be byte-for-byte unchanged');
            assert.equal(
                after.remoteListStdout,
                before.remoteListStdout,
                'sentinel bd dolt remote list must be unchanged',
            );
            assert.equal(
                after.issueCount,
                before.issueCount,
                'sentinel issue count must be unchanged (no junk beads created)',
            );
        } finally {
            if (prevMode === undefined) delete process.env.APRA_FLEET_BD_MOCK;
            else process.env.APRA_FLEET_BD_MOCK = prevMode;
            if (prevBeadsDir === undefined) delete process.env.BEADS_DIR;
            else process.env.BEADS_DIR = prevBeadsDir;
            await fsp.rm(sentinelDir, { recursive: true, force: true }).catch(() => {});
            await fsp.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
            await fsp.rm(remoteDir, { recursive: true, force: true }).catch(() => {});
        }
    },
);
