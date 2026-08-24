import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCmd, realReadServeCount } from './helpers/bd-replay.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';

// =============================================================================
// apra-fleet-5co8.7 -- pin bd-replay.mjs's real-mode READ CACHE invalidation.
//
// apra-fleet-u87n.1 added a cache that serves a repeated `bd list`/`bd show`/
// `bd stats` for the same cwd without spawning bd, dropped by any non-read bd
// command on that cwd. Its correctness-critical invariant is NEGATIVE -- a read
// issued after a write must never see pre-write state -- and a cache that is
// merely "fast" satisfies every performance assertion while silently violating
// it. Nothing pinned that: realReadServeCount() shipped with no caller at all.
//
// The cache only exists under real bd, so this test forces
// APRA_FLEET_BD_MOCK=real for its own duration (restored in `finally`) and is
// gated on the real binary being present -- same skip-with-a-clear-message
// discipline as bd-init-templating.test.mjs, and the same reason it needs no
// recorded fixture: in replay mode it does not run at all.
//
// Every assertion is made against realReadServeCount() DELTAS, never absolute
// values: sibling tests in this process share the counter.
// =============================================================================

// Probed THROUGH A SHELL on purpose: bd-replay's own execCmd() runs bd via
// child_process.exec (a shell), and on Windows `bd` is a shim script that a
// shell-less spawn cannot execute at all -- a non-shell probe would skip this
// test on the very platform it is being written on, which is a silent pass in
// all but name.
function resolveBdBinary() {
    try {
        const res = spawnSync('bd --version', { encoding: 'utf8', timeout: 30000, shell: true });
        return res.status === 0 ? 'bd' : null;
    } catch {
        return null;
    }
}

const BD_SKIP = resolveBdBinary()
    ? false
    : 'bd binary unavailable on PATH -- skipping the real-bd read-cache invalidation regression test.';

test(
    'apra-fleet-5co8.7: the real-mode read cache serves repeat reads and is dropped by any writer',
    { skip: BD_SKIP, timeout: scaledTimeout(120000) },
    async () => {
        const prevMode = process.env.APRA_FLEET_BD_MOCK;
        process.env.APRA_FLEET_BD_MOCK = 'real';
        // Short directory name on purpose: bd derives its dolt database name
        // from the directory name and rejects an over-long one.
        const dir = path.join(os.tmpdir(), `bdrc-${process.pid}-${Date.now().toString(36)}`);
        try {
            await fsp.mkdir(dir, { recursive: true });
            const initRes = await runCmd('bd init', dir);
            assert.equal(initRes.err, null, `bd init into ${dir} should succeed, stderr=${initRes.stderr}`);

            // --- (1) two identical reads, no intervening write ---------------
            // The second must be SERVED FROM CACHE (serve count +1) and return
            // byte-identical output.
            const beforeFirst = realReadServeCount();
            const readA = await runCmd('bd list --json', dir);
            assert.equal(readA.err, null, `bd list --json should succeed, stderr=${readA.stderr}`);
            assert.equal(
                realReadServeCount() - beforeFirst,
                0,
                'the FIRST read of a command must spawn bd, not be served from cache',
            );

            const readB = await runCmd('bd list --json', dir);
            assert.equal(
                realReadServeCount() - beforeFirst,
                1,
                'an identical repeat read with no intervening write must be served from cache (exactly one serve)',
            );
            assert.equal(readB.stdout, readA.stdout, 'a cache-served read must return the same output');

            // --- (2) a write between two identical reads ---------------------
            // The read after the write must SPAWN AGAIN (serve count unchanged)
            // and reflect the mutation -- the invariant this whole test exists
            // for.
            const beforeWrite = realReadServeCount();
            const createRes = await runCmd('bd create "read-cache invalidation probe" --silent', dir);
            assert.equal(createRes.err, null, `bd create should succeed, stderr=${createRes.stderr}`);
            const createdId = createRes.stdout.trim().split(/\s+/).pop();
            assert.ok(createdId, 'expected bd create --silent to print the new id');

            const readC = await runCmd('bd list --json', dir);
            assert.equal(
                realReadServeCount() - beforeWrite,
                0,
                'a read issued AFTER a write must spawn bd again -- never be served from the pre-write cache',
            );
            assert.notEqual(readC.stdout, readA.stdout, 'the post-write read must not return pre-write output');
            assert.match(readC.stdout, /read-cache invalidation probe/, 'the post-write read must reflect the mutation');

            // A second write (bd update) must drop the cache the SAME way, so
            // the invalidation is not a one-off property of `bd create`.
            const cachedAgain = await runCmd('bd list --json', dir);
            assert.equal(cachedAgain.stdout, readC.stdout);
            const beforeUpdate = realReadServeCount();
            const updateRes = await runCmd(`bd update ${createdId} --priority 0`, dir);
            assert.equal(updateRes.err, null, `bd update should succeed, stderr=${updateRes.stderr}`);
            await runCmd('bd list --json', dir);
            assert.equal(
                realReadServeCount() - beforeUpdate,
                0,
                'a read after `bd update` must spawn bd again, exactly as after `bd create`',
            );

            // --- (3) an UNRECOGNIZED subcommand fails safe as a writer -------
            // The classification is a strict read-only allowlist, so a future
            // subcommand nobody here has heard of must invalidate rather than
            // be assumed harmless.
            await runCmd('bd list --json', dir);            // repopulate
            const cachedProbe = realReadServeCount();
            await runCmd('bd list --json', dir);            // served from cache
            assert.equal(realReadServeCount() - cachedProbe, 1, 'guard: the cache is warm before the unknown-subcommand step');

            const beforeUnknown = realReadServeCount();
            await runCmd('bd frobnicate-not-a-real-subcommand', dir);
            await runCmd('bd list --json', dir);
            assert.equal(
                realReadServeCount() - beforeUnknown,
                0,
                'an unrecognized bd subcommand must be treated as a writer and drop the read cache',
            );
        } finally {
            if (prevMode === undefined) delete process.env.APRA_FLEET_BD_MOCK;
            else process.env.APRA_FLEET_BD_MOCK = prevMode;
            await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
        }
    },
);
