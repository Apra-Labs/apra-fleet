// A conflicted beads pull that drops a parent link and a blocks edge is caught
// before the engine's push publishes it -- against the REAL pinned bd.
//
// Real pieces: two real bd clones (A and B) of one bare git remote (beads
// syncs through refs/dolt/data on it), the REAL doltPushAfter
// (fleet-sprint/dolt-sync.mjs) and the REAL createBeadsScope verify
// (beadsScope.verifyLinksBeforePush), wired exactly as runner.js wires it
// (git-sync's verifyLinks option). Every member command runs for real in that
// member's clone.
//
// The conflict: A links C under P and adds "X blocked by Y", edits Y's title
// and pushes; B then edits Y's title too. B's engine push is rejected
// (behind), its reconcile `bd dolt pull` conflicts on Y and auto-merges
// (last write wins).
//
// WHAT THE PINNED bd (1.3.x) REALLY DOES THERE (measured while writing this
// test, deterministic in this sandbox): the merge leaves the merged
// dependency rows -- C's parent link and the X/Y blocks edge -- UNCOMMITTED in
// B's working set. `bd list` on B still shows both links, but a plain
// `bd dolt push` publishes only the commit, and A loses both links on its
// next pull. A link READ can never see that loss, so case 1 asserts the real
// outcome: after the guarded push, A has both links (and without the guard it
// does not -- see the falsifiability note).
//
// The read-and-restore half of the guard (ERROR lines, `bd update --parent`
// and `bd dep add` before the push) restores only links a pull DROPPED: links
// the pulling clone held just before the pull and lacks just after it (the
// pull bracket in beads-scope.mjs). The pinned bd does not produce such a
// loss on its own here. Cases 2 and 3 therefore keep the real clones and the
// real conflicted pull and inject the lossy result through the command seam:
// right after B's real reconcile pull, the seam really removes two links B
// held before the pull -- X's parent link (X -> P) and the blocks edge
// "Z blocked by X", both published before B bootstrapped -- from B's clone (a
// direct bd call in B, invisible to the engine's ledger, like a merge that
// dropped them). Case 2 asserts the ERROR lines, the restores before the
// push, and both links on A afterwards; case 3 stubs ONLY the two restore
// commands to fail and asserts no push is issued and the typed error names
// both edges.
//
// Falsifiability: removing the verify call from doltPushAfter's reconcile
// path (verifyLinksBeforePush after the reconcile pull) makes case 1 fail (A
// pulls a state without both links), case 2 fail (no ERROR/restore before the
// re-push) and case 3 fail (the re-push is issued) -- checked locally once by
// reverting the fix.
//
// Hermetic: HOME, USERPROFILE, GIT_CONFIG_GLOBAL and TMPDIR point into one
// temp sandbox, removed afterwards; no network. Skips (with the reason) when
// no bd binary is on PATH. ASCII only.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';

import {
    doltPushAfter,
    invalidateSyncRemoteCache,
    clearLastSyncedTip,
    clearTipProbeFailures,
    clearDegradedSyncRecords,
} from '../fleet-sprint/dolt-sync.mjs';
import { createBeadsScope } from '../fleet-sprint/beads-scope.mjs';
import { parseBdJson } from '../fleet-sprint/runner.js';
import { ParentLinkRestoreError } from '../fleet-sprint/parent-link-guard.mjs';
import { bdChildEnv } from './helpers/bd-replay.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';
import { TEST_CONCURRENCY } from './helpers/test-concurrency.mjs';

function bdAvailable() {
    // A PATH lookup, not `bd version`: any bd invocation records an event
    // under the invoking HOME (and its background writer can outlive a
    // cleanup), and this test must leave nothing outside its sandbox.
    const names = process.platform === 'win32' ? ['bd.exe', 'bd.cmd', 'bd'] : ['bd'];
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
        if (!dir) continue;
        for (const name of names) {
            try {
                if (fs.statSync(path.join(dir, name)).isFile()) return true;
            } catch { /* not here */ }
        }
    }
    return false;
}
const SKIP = bdAvailable() ? false : 'requires a real bd binary on PATH';

/** One sandbox: HOME/USERPROFILE/GIT_CONFIG_GLOBAL/TMPDIR inside it, a bare git remote, clones A and B. */
function createSandbox() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'linkguard-realbd-')));
    const home = path.join(root, 'home');
    const tmp = path.join(root, 'tmp');
    fs.mkdirSync(home);
    fs.mkdirSync(tmp);
    const env = {
        ...bdChildEnv(),
        HOME: home,
        USERPROFILE: home,
        GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'),
        GIT_CONFIG_NOSYSTEM: '1',
        TMPDIR: tmp,
        TEMP: tmp,
        TMP: tmp,
        BD_NON_INTERACTIVE: '1',
        GIT_TERMINAL_PROMPT: '0',
    };
    delete env.BEADS_ACTOR;
    const dirs = { A: path.join(root, 'A'), B: path.join(root, 'B') };
    return { root, env, dirs, remote: path.join(root, 'remote.git') };
}

/** Run `cmd` for real in `cwd`; resolves { ok, stdout, stderr } (never rejects). */
function run(cmd, cwd, env) {
    return new Promise((resolve) => {
        exec(cmd, { cwd, env, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
            resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', err });
        });
    });
}

async function runOrThrow(sb, cmd, cwd) {
    const r = await run(cmd, cwd, sb.env);
    if (!r.ok) throw new Error(`sandbox setup: '${cmd}' failed in ${cwd}:\n${r.stdout}${r.stderr}`);
    return r.stdout.trim();
}

/** The links of one clone, read with bd: { parentOf: Map, blocks: Set<'X>Y'> }. */
async function linksOf(sb, dir) {
    const rows = JSON.parse(await runOrThrow(sb, 'bd list --all --limit 0 --json --brief', dir));
    const parentOf = new Map();
    const blocks = new Set();
    for (const b of rows) {
        if (b.parent) parentOf.set(b.id, b.parent);
        for (const d of b.dependencies || []) if (d.type === 'blocks') blocks.add(`${b.id}>${d.depends_on_id}`);
    }
    return { parentOf, blocks };
}

/**
 * Build the scenario up to the point where B is about to run the engine push:
 * seeded P, C, X, Y on A and pushed; B bootstrapped; A linked C -> P,
 * X blocked-by Y, edited Y and pushed; B edited Y (a later write) so B's
 * reconcile pull conflicts and auto-merges.
 */
async function buildScenario() {
    const sb = createSandbox();
    const { A, B } = sb.dirs;
    await runOrThrow(sb, 'git config --global user.name "Link Guard"', sb.root);
    await runOrThrow(sb, 'git config --global user.email link-guard@test.local', sb.root);
    await runOrThrow(sb, 'git config --global commit.gpgsign false', sb.root);
    await runOrThrow(sb, `git init -q --bare -b main "${sb.remote}"`, sb.root);
    const url = `file://${sb.remote}`;
    fs.mkdirSync(A);
    await runOrThrow(sb, 'git init -q -b main', A);
    await runOrThrow(sb, `git remote add origin "${url}"`, A);
    await runOrThrow(sb, 'git commit -q --allow-empty -m init', A);
    await runOrThrow(sb, 'git push -q origin main', A);
    await runOrThrow(sb, 'bd init --prefix lg', A);
    const ids = {};
    ids.P = (await runOrThrow(sb, 'bd create "P" -t feature --silent', A)).split(/\s+/).pop();
    ids.C = (await runOrThrow(sb, 'bd create "C" -t task --silent', A)).split(/\s+/).pop();
    // X and Y sit under P from the start, so their blocks edge is in the sprint scope.
    ids.X = (await runOrThrow(sb, `bd create "X" -t task --parent ${ids.P} --silent`, A)).split(/\s+/).pop();
    ids.Y = (await runOrThrow(sb, `bd create "Y" -t task --parent ${ids.P} --silent`, A)).split(/\s+/).pop();
    // Z blocked by X: a link every clone holds from the start (cases 2 and 3
    // drop it, with X -> P, in B's reconcile pull).
    ids.Z = (await runOrThrow(sb, `bd create "Z" -t task --parent ${ids.P} --silent`, A)).split(/\s+/).pop();
    await runOrThrow(sb, `bd dep add ${ids.Z} ${ids.X}`, A);
    await runOrThrow(sb, 'bd dolt push', A);
    fs.mkdirSync(B);
    await runOrThrow(sb, `git clone -q "${url}" .`, B);
    await runOrThrow(sb, 'bd bootstrap --yes', B);

    await runOrThrow(sb, `bd update ${ids.C} --parent ${ids.P}`, A);
    await runOrThrow(sb, `bd dep add ${ids.X} ${ids.Y}`, A);
    await runOrThrow(sb, `bd update ${ids.Y} --title "Y edited on A"`, A);
    await runOrThrow(sb, 'bd dolt push', A);
    // A later write on B: the conflicting row then settles last-write-wins
    // (an edit in the same second can abort the merge instead).
    await new Promise((r) => setTimeout(r, 1200));
    await runOrThrow(sb, `bd update ${ids.Y} --title "Y edited on B"`, B);
    return { sb, ids };
}

/**
 * The engine's command seam for this sandbox, plus a beads scope wired the
 * way runner.js wires it. The scope's ledger is fed by one snapshot read on
 * the backlog member (clone A, which holds both links).
 *
 * @param {object} opts
 * @param {(cmd: string, member: string) => boolean} [opts.failCommand] - answer this command with a failure instead of running it
 * @param {(member: string) => Promise<void>} [opts.afterPull] - runs after each real `bd dolt pull`
 */
async function engineFor(sb, ids, { failCommand = () => false, afterPull = async () => {} } = {}) {
    const calls = [];
    const logs = [];
    const rawCommand = async (cmd, opts = {}) => {
        const member = opts.member_name;
        const cwd = sb.dirs[member];
        assert.ok(cwd, `command for an unknown member '${member}': ${cmd}`);
        calls.push({ cmd, member });
        let res;
        if (failCommand(cmd, member)) {
            res = { ok: false, stdout: '', stderr: 'Error: injected restore failure (database is locked)' };
        } else {
            res = await run(cmd, cwd, sb.env);
            if (res.ok && /\bbd dolt pull\b/.test(cmd)) await afterPull(member);
        }
        const output = `${res.stdout}${res.ok ? '' : res.stderr}`;
        if (opts.failSoft) return { ok: res.ok, output, error: res.ok ? null : (res.stderr || res.stdout || 'command failed').trim() };
        if (!res.ok) throw new Error(`[Command Failed] ${cmd}: ${res.stderr || res.stdout}`);
        return res.stdout;
    };
    const scope = createBeadsScope({
        targetIssues: [ids.P],
        parseBdJson,
        getBacklogMember: () => 'A',
        log: (line) => logs.push(line),
    });
    const command = scope.wrapCommand(rawCommand);
    return { calls, logs, scope, command };
}

const pushOptsFor = (eng) => ({
    command: eng.command,
    log: (m) => eng.logs.push(m),
    sleep: async () => {},
    // Wired exactly as runner.js -> createGitSync({ verifyLinks }) does.
    verifyLinks: (member) => eng.scope.verifyLinksBeforePush(member),
});

describe('verify-before-push against a real conflicted bd pull', { skip: SKIP, concurrency: false }, () => {
    const budget = scaledTimeout(120_000, { concurrency: TEST_CONCURRENCY });
    const sandboxes = [];
    before(() => {
        invalidateSyncRemoteCache();
        clearLastSyncedTip();
        clearTipProbeFailures();
        clearDegradedSyncRecords();
    });
    after(() => {
        for (const root of sandboxes) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    });

    test('the merged links reach the remote: after the guarded push from B, clone A still has both links', { timeout: budget }, async () => {
        const { sb, ids } = await buildScenario();
        sandboxes.push(sb.root);
        const eng = await engineFor(sb, ids);
        await seedLedger(eng, ids);

        const res = await doltPushAfter('B', pushOptsFor(eng));
        assert.equal(res.pushed, true, JSON.stringify(res));
        assert.equal(res.reconciled, true, `B's first push must be rejected and reconciled: ${eng.logs.join('\n')}`);

        await runOrThrow(sb, 'bd dolt pull', sb.dirs.A);
        const onA = await linksOf(sb, sb.dirs.A);
        assert.equal(onA.parentOf.get(ids.C), ids.P, `C -> P lost on A after the guarded push:\n${eng.logs.join('\n')}`);
        assert.ok(onA.blocks.has(`${ids.X}>${ids.Y}`), `X blocked-by Y lost on A after the guarded push:\n${eng.logs.join('\n')}`);
    });

    test('links missing from the pushing clone after the pull are reported, restored BEFORE the push, and reach clone A', { timeout: budget }, async () => {
        const { sb, ids } = await buildScenario();
        sandboxes.push(sb.root);
        // The injected lossy merge: both links really removed from B's clone,
        // outside the engine's command path (so its ledger does not know).
        let injected = false;
        const eng = await engineFor(sb, ids, {
            afterPull: async (member) => {
                if (member !== 'B' || injected) return;
                injected = true;
                await runOrThrow(sb, 'bd dolt commit', sb.dirs.B);
                await runOrThrow(sb, `bd update ${ids.X} --parent ""`, sb.dirs.B);
                await runOrThrow(sb, `bd dep remove ${ids.Z} ${ids.X}`, sb.dirs.B);
            },
        });
        await seedLedger(eng, ids);

        const res = await doltPushAfter('B', pushOptsFor(eng));
        assert.equal(res.pushed, true, JSON.stringify(res));
        assert.ok(injected, 'the reconcile pull ran on B');

        const errors = eng.logs.filter((l) => l.startsWith('ERROR:'));
        assert.ok(errors.some((l) => l.includes('parent-child link vanished') && l.includes(`'${ids.X}'`) && l.includes(`'${ids.P}'`)), errors.join('\n'));
        assert.ok(errors.some((l) => l.includes('blocks link vanished') && l.includes(`'${ids.Z}'`) && l.includes(`'${ids.X}'`)), errors.join('\n'));

        const idx = (re, from = 0) => eng.calls.findIndex((c, i) => i >= from && c.member === 'B' && re.test(c.cmd));
        const pull = idx(/bd dolt pull/);
        const restoreParent = idx(new RegExp(`^bd update ${ids.X} --parent ${ids.P}$`));
        const restoreBlocks = idx(new RegExp(`^bd dep add ${ids.Z} ${ids.X}$`));
        const rePush = idx(/bd dolt push/, pull + 1);
        const trace = eng.calls.map((c) => `${c.member}: ${c.cmd}`).join('\n');
        assert.ok(pull >= 0 && restoreParent > pull && restoreParent < rePush, trace);
        assert.ok(restoreBlocks > pull && restoreBlocks < rePush, trace);

        await runOrThrow(sb, 'bd dolt pull', sb.dirs.A);
        const onA = await linksOf(sb, sb.dirs.A);
        assert.equal(onA.parentOf.get(ids.X), ids.P, 'X -> P present on A');
        assert.ok(onA.blocks.has(`${ids.Z}>${ids.X}`), 'Z blocked-by X present on A');
        assert.equal(onA.parentOf.get(ids.C), ids.P, 'C -> P (merged by the conflicted pull) present on A');
        assert.ok(onA.blocks.has(`${ids.X}>${ids.Y}`), 'X blocked-by Y (merged by the conflicted pull) present on A');
    });

    test('a failing restore issues no push and the typed error names both edges', { timeout: budget }, async () => {
        const { sb, ids } = await buildScenario();
        sandboxes.push(sb.root);
        let injected = false;
        const isRestore = (cmd) => cmd === `bd update ${ids.X} --parent ${ids.P}` || cmd === `bd dep add ${ids.Z} ${ids.X}`;
        const eng = await engineFor(sb, ids, {
            failCommand: (cmd, member) => member === 'B' && isRestore(cmd),
            afterPull: async (member) => {
                if (member !== 'B' || injected) return;
                injected = true;
                await runOrThrow(sb, 'bd dolt commit', sb.dirs.B);
                await runOrThrow(sb, `bd update ${ids.X} --parent ""`, sb.dirs.B);
                await runOrThrow(sb, `bd dep remove ${ids.Z} ${ids.X}`, sb.dirs.B);
            },
        });
        await seedLedger(eng, ids);
        const remoteTipBefore = await runOrThrow(sb, `git ls-remote "file://${sb.remote}" refs/dolt/data`, sb.root);

        await assert.rejects(() => doltPushAfter('B', pushOptsFor(eng)), (err) => {
            assert.ok(err instanceof ParentLinkRestoreError, `${err && err.name}: ${err && err.message}`);
            assert.match(err.message, new RegExp(`parent-child link '${ids.X}' -> parent '${ids.P}'`));
            assert.match(err.message, new RegExp(`blocks link '${ids.Z}' blocked by '${ids.X}'`));
            assert.deepEqual(err.edges.map((e) => e.kind).sort(), ['blocks', 'parent-child']);
            return true;
        });
        const pushes = eng.calls.filter((c) => c.member === 'B' && /bd dolt push/.test(c.cmd));
        assert.equal(pushes.length, 1, `only the first (rejected) push may run:\n${eng.calls.map((c) => `${c.member}: ${c.cmd}`).join('\n')}`);
        const remoteTipAfter = await runOrThrow(sb, `git ls-remote "file://${sb.remote}" refs/dolt/data`, sb.root);
        assert.equal(remoteTipAfter, remoteTipBefore, 'nothing from B reached the remote');
    });
});

/**
 * Feed the run's link ledger the way a sprint does: one full-DB snapshot read
 * on the backlog member (clone A, which holds C -> P and X blocked-by Y),
 * scoped to the sprint target P (engineFor's targetIssues).
 */
async function seedLedger(eng, ids) {
    const rows = await eng.scope.fetchAllBeadsShared();
    const c = rows.find((b) => b.id === ids.C);
    assert.equal(c && c.parent, ids.P, 'the ledger snapshot carries C -> P');
    const x = rows.find((b) => b.id === ids.X);
    assert.ok(x && (x.dependencies || []).some((d) => d.type === 'blocks' && d.depends_on_id === ids.Y), 'the ledger snapshot carries X blocked-by Y');
    eng.calls.length = 0;
}
