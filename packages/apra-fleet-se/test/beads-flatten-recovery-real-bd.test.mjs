// Flattened-remote recovery at sprint launch, against the REAL pinned bd.
//
// Real pieces: a bare git remote (beads syncs through refs/dolt/data on it),
// clone A (the source) and clone B (another clone), both real bd clones that
// created beads and pushed; the REAL launch beads-health gate
// (dolt-sync.mjs preflightBeadsHealthGate) with the real recovery
// (beads-flatten-recovery.mjs) and the real SE command primitives for this
// host's shell. Every member command runs for real in clone B.
//
// HOW THE REMOTE IS REWRITTEN: on the pinned bd, `bd flatten --force` followed
// by `bd dolt remote reset-data origin --yes` keeps the original root commit,
// so another clone's next pull still merges (recorded by
// test/fixtures/dolt-unrelated-history/record-unrelated-history.mjs, whose
// control step shows exit 0). The condition the engine must recover from is a
// remote whose history shares NO ancestor with the clone, so this test builds
// exactly that: a new database (`bd init` in A2) importing A's full export,
// written over the remote with the same reset-data command the maintenance
// playbook uses. B's next `bd dolt pull` then fails "no common ancestor".
//
// Scenario 1 (clean): B holds nothing the rewritten remote lacks. The gate
// re-bootstraps B: B's issue set equals the source's, one WARN line names the
// backup path, the backup directory exists.
// Scenario 2 (unpushed work): B created a bead it never pushed. The gate
// refuses with the typed error naming that id; B's .beads is the original
// (the bead is read back with bd show on B); no backup or discarded clone is
// left behind and nothing was deleted.
//
// Scenarios 3-6 (unpushed work the remote cannot show by id): after its last
// push B ONLY (3) adds a dependency, (4) adds a label, (5) adds a comment, or
// (6) deletes a bead the remote still holds. On the pinned bd none of these
// bumps updated_at and a delete leaves no record, so each is caught by the
// record diff / history probe of beads-flatten-recovery.mjs. The gate refuses,
// the refusal names the kind, and B's .beads still shows the change.
// Scenarios 7-8 (prune): A runs `bd prune` before the rewrite, so the rebuilt
// remote lacks closed beads B still holds. A clean B is re-bootstrapped and
// then reads the rebuilt remote's beads; a B that commented on such a closed
// bead after its last pull is refused and left intact.
//
// Falsifiability: removing the unrelated-history branch from the health gate
// (the recovery call in preflightBeadsHealthGate) makes scenario 1 fail -- the
// gate throws DoltUnrelatedHistoryError -- checked locally once by reverting it.
// Reverting the detection in beads-flatten-recovery.mjs to the id/updated_at
// comparison makes scenarios 3-5 fail (re-bootstrapped, the work dropped) and
// the clean prune scenario 7 fail (refused: the pruned closed bead counts as
// local work) -- checked locally once.
//
// Hermetic: HOME, USERPROFILE, GIT_CONFIG_GLOBAL and TMPDIR point into one temp
// sandbox (asserted), removed afterwards; no network. Skips when no bd binary
// is on PATH. ASCII only.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec, spawnSync } from 'node:child_process';

import {
    preflightBeadsHealthGate,
    invalidateSyncRemoteCache,
    clearLastSyncedTip,
    clearTipProbeFailures,
    clearDegradedSyncRecords,
} from '../fleet-sprint/dolt-sync.mjs';
import { getSeCommands } from '../fleet-sprint/se-os-commands.mjs';
import { BeadsFlattenRecoveryRefusedError } from '../fleet-sprint/errors.mjs';
import {
    FLATTEN_BACKUP_PREFIX,
    FLATTEN_PENDING_PREFIX,
    FLATTEN_DISCARD_PREFIX,
    FLATTEN_LOCAL_EXPORT,
    FLATTEN_RECOVERY_WARNING_PREFIX,
} from '../fleet-sprint/beads-flatten-recovery.mjs';
import { bdChildEnv } from './helpers/bd-replay.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';
import { TEST_CONCURRENCY } from './helpers/test-concurrency.mjs';

function bdAvailable() {
    // A PATH lookup, not `bd version`: any bd invocation records state under
    // the invoking HOME, and this test must leave nothing outside its sandbox.
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

// The member shell this host's exec() hands the command string to.
const SHELL = process.platform === 'win32'
    ? getSeCommands({ os: 'windows', shell: 'powershell' })
    : getSeCommands({ os: process.platform === 'darwin' ? 'darwin' : 'linux', shell: 'bash' });

function createSandbox() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flatten-realbd-')));
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
    const dirs = { A: path.join(root, 'A'), A2: path.join(root, 'A2'), B: path.join(root, 'B') };
    return { root, env, dirs, remote: path.join(root, 'remote.git') };
}

function run(cmd, cwd, env) {
    return new Promise((resolve) => {
        exec(cmd, { cwd, env, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
            resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', err });
        });
    });
}

async function runOrThrow(sb, cmd, cwd) {
    const r = await run(cmd, cwd, sb.env);
    if (!r.ok) throw new Error(`sandbox setup: '${cmd}' failed in ${cwd}:\n${r.stdout}${r.stderr}`);
    return r.stdout.trim();
}

const createBead = async (sb, title, dir) => (await runOrThrow(sb, `bd create "${title}" -t task --silent`, dir)).split(/\s+/).pop();

async function issueIds(sb, dir) {
    const rows = JSON.parse(await runOrThrow(sb, 'bd list --all --limit 0 --json --brief', dir));
    return rows.map((r) => r.id).sort();
}

/**
 * A and B both create beads and push; then the remote is rewritten with an
 * independent history carrying A's full issue set (see the file header).
 * `unpushedOnB` creates one bead on B that is never pushed. `prune` closes
 * one of A's beads, lets B pull it, and runs `bd prune` on A before the
 * rewrite. `onB(sb, ids)` then makes B's unpushed change (never pushed).
 */
async function buildScenario({ unpushedOnB = false, prune = false, onB = null } = {}) {
    const sb = createSandbox();
    const { A, A2, B } = sb.dirs;
    await runOrThrow(sb, 'git config --global user.name "Flatten Recovery"', sb.root);
    await runOrThrow(sb, 'git config --global user.email flatten-recovery@test.local', sb.root);
    await runOrThrow(sb, 'git config --global commit.gpgsign false', sb.root);
    await runOrThrow(sb, `git init -q --bare -b main "${sb.remote}"`, sb.root);
    const url = `file://${sb.remote.split(path.sep).join('/')}`;
    fs.mkdirSync(A);
    await runOrThrow(sb, 'git init -q -b main', A);
    await runOrThrow(sb, `git remote add origin "${url}"`, A);
    await runOrThrow(sb, 'git commit -q --allow-empty -m init', A);
    await runOrThrow(sb, 'git push -q origin main', A);
    await runOrThrow(sb, 'bd init --prefix fr', A);
    const ids = {};
    ids.a1 = await createBead(sb, 'from A one', A);
    ids.a2 = await createBead(sb, 'from A two', A);
    if (prune) {
        ids.closed = await createBead(sb, 'closed on A, pruned later', A);
        await runOrThrow(sb, `bd close ${ids.closed}`, A);
        // bd timestamps have one-second resolution: the bead synced after
        // the close must be strictly newer than it.
        await pause(1100);
        ids.a3 = await createBead(sb, 'from A three', A);
    }
    await runOrThrow(sb, 'bd dolt push', A);

    fs.mkdirSync(B);
    await runOrThrow(sb, `git clone -q "${url}" .`, B);
    await runOrThrow(sb, 'bd bootstrap --yes', B);
    ids.b = await createBead(sb, 'from B', B);
    await runOrThrow(sb, 'bd dolt push', B);
    await runOrThrow(sb, 'bd dolt pull', A);
    if (prune) await runOrThrow(sb, 'bd prune --pattern "*" --force', A);

    // The rewrite: an independent database carrying A's issues, written over
    // the remote's data.
    const exportFile = path.join(sb.root, 'a-export.jsonl');
    await runOrThrow(sb, `bd export --all -o "${exportFile}"`, A);
    fs.mkdirSync(A2);
    await runOrThrow(sb, 'git init -q -b main', A2);
    await runOrThrow(sb, 'bd init --prefix fr', A2);
    await runOrThrow(sb, `bd import "${exportFile}"`, A2);
    await runOrThrow(sb, `bd dolt remote add origin "${url}"`, A2);
    await runOrThrow(sb, 'bd dolt remote reset-data origin --yes', A2);

    let unpushedId = null;
    if (unpushedOnB) unpushedId = await createBead(sb, 'unpushed on B', B);
    if (onB) {
        // One-second bd timestamps: B's change is strictly newer than B's
        // last sync.
        await pause(1100);
        await onB(sb, ids);
    }
    return { sb, unpushedId, ids };
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const bdJson = async (sb, cmd, dir) => JSON.parse(await runOrThrow(sb, cmd, dir));

function engineFor(sb) {
    const calls = [];
    const logs = [];
    const command = async (cmd, opts = {}) => {
        const cwd = sb.dirs[opts.member_name];
        assert.ok(cwd, `command for an unknown member '${opts.member_name}': ${cmd}`);
        calls.push(cmd);
        const res = await run(cmd, cwd, sb.env);
        const output = `${res.stdout}${res.ok ? '' : res.stderr}`;
        if (opts.failSoft) return { ok: res.ok, output, error: res.ok ? null : (res.stderr || res.stdout || 'command failed').trim() };
        if (!res.ok) throw new Error(`[Command Failed] ${cmd}: ${res.stderr || res.stdout}`);
        return res.stdout;
    };
    const gateOpts = { command, log: (l) => logs.push(l), sleep: async () => {}, flattenRecovery: async () => SHELL };
    return { calls, logs, gateOpts };
}

const topLevel = (dir) => fs.readdirSync(dir);

describe('flattened beads remote: sprint-launch recovery against real bd', { skip: SKIP, concurrency: false }, () => {
    const budget = scaledTimeout(180_000, { concurrency: TEST_CONCURRENCY });
    const sandboxes = [];
    before(() => {
        invalidateSyncRemoteCache();
        clearLastSyncedTip();
        clearTipProbeFailures();
        clearDegradedSyncRecords();
    });
    after(() => {
        for (const root of sandboxes) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        // Nothing outlives the file: no sandbox directory, and (where ps
        // exists) no process -- a dolt server included -- still running in one.
        for (const root of sandboxes) assert.ok(!fs.existsSync(root), `sandbox ${root} was removed`);
        if (process.platform !== 'win32') {
            const ps = spawnSync('ps', ['-eo', 'args='], { encoding: 'utf8' });
            if (!ps.error && ps.status === 0) {
                const left = ps.stdout.split('\n').filter((l) => sandboxes.some((root) => l.includes(root)));
                assert.deepEqual(left, [], 'no process left running in a sandbox');
            }
        }
    });

    test('the sandbox owns HOME, USERPROFILE and GIT_CONFIG_GLOBAL', () => {
        const sb = createSandbox();
        sandboxes.push(sb.root);
        const tmpRoot = fs.realpathSync(os.tmpdir());
        for (const key of ['HOME', 'USERPROFILE', 'GIT_CONFIG_GLOBAL', 'TMPDIR']) {
            assert.ok(sb.env[key].startsWith(sb.root + path.sep), `${key}=${sb.env[key]} is inside the sandbox`);
            assert.ok(sb.env[key].startsWith(tmpRoot), `${key} is a temp path`);
        }
    });

    test('a clean clone is re-bootstrapped from the rewritten remote, loudly, keeping a backup', { timeout: budget }, async () => {
        const { sb } = await buildScenario();
        sandboxes.push(sb.root);
        // The precondition is real: B's own pull fails with no common ancestor.
        const probe = await run('bd dolt pull', sb.dirs.B, sb.env);
        assert.equal(probe.ok, false, 'the rewritten remote must not merge into B');
        assert.match(`${probe.stdout}${probe.stderr}`, /no common ancestor/);
        clearLastSyncedTip('B');

        const eng = engineFor(sb);
        const res = await preflightBeadsHealthGate('B', eng.gateOpts);
        assert.equal(res.ok, true, JSON.stringify(res));
        assert.equal(res.recovered, true, eng.logs.join('\n'));

        assert.deepEqual(await issueIds(sb, sb.dirs.B), await issueIds(sb, sb.dirs.A2), 'B holds the source issue set');
        const warn = eng.logs.filter((l) => l.startsWith(FLATTEN_RECOVERY_WARNING_PREFIX));
        assert.equal(warn.length, 1, eng.logs.join('\n'));
        assert.ok(warn[0].includes(res.backup) && warn[0].includes(`'B'`), warn[0]);
        assert.ok(res.backup.startsWith(FLATTEN_BACKUP_PREFIX));
        assert.ok(fs.statSync(path.join(sb.dirs.B, res.backup)).isDirectory(), 'the backup directory exists');
        assert.ok(fs.existsSync(path.join(sb.dirs.B, res.backup, FLATTEN_LOCAL_EXPORT)), 'the pre-recovery export is kept with it');
        // B is in sync again: a plain pull now succeeds.
        await runOrThrow(sb, 'bd dolt pull', sb.dirs.B);
    });

    test('a clone holding an unpushed bead is refused and left intact', { timeout: budget }, async () => {
        const { sb, unpushedId } = await buildScenario({ unpushedOnB: true });
        sandboxes.push(sb.root);
        const before = topLevel(sb.dirs.B).sort();
        const idsBefore = await issueIds(sb, sb.dirs.B);
        assert.ok(idsBefore.includes(unpushedId));
        clearLastSyncedTip('B');

        const eng = engineFor(sb);
        await assert.rejects(() => preflightBeadsHealthGate('B', eng.gateOpts), (err) => {
            assert.ok(err instanceof BeadsFlattenRecoveryRefusedError, `${err && err.name}: ${err && err.message}`);
            assert.ok(err.message.includes(unpushedId), err.message);
            assert.deepEqual(err.details.localOnly.map((w) => w.id), [unpushedId]);
            assert.equal(err.details.restored, true);
            return true;
        });

        // The unpushed bead is still on B, read back with bd.
        const shown = await runOrThrow(sb, `bd show ${unpushedId} --json`, sb.dirs.B);
        assert.ok(shown.includes(unpushedId), shown);
        assert.deepEqual(await issueIds(sb, sb.dirs.B), idsBefore, 'nothing was deleted');
        // Same top-level entries as before: no backup, pending or discarded clone.
        assert.deepEqual(topLevel(sb.dirs.B).sort(), before);
        assert.ok(!topLevel(sb.dirs.B).some((n) => n.startsWith(FLATTEN_PENDING_PREFIX) || n.startsWith(FLATTEN_BACKUP_PREFIX) || n.startsWith(FLATTEN_DISCARD_PREFIX)));
        assert.ok(fs.existsSync(path.join(sb.dirs.B, '.beads', FLATTEN_LOCAL_EXPORT)), 'the export the fix replays from is in .beads');
        assert.equal(eng.logs.filter((l) => l.startsWith(FLATTEN_RECOVERY_WARNING_PREFIX)).length, 0);
    });

    /** Run the gate on B, expect a refusal of `kind`; B's top level is unchanged. */
    async function expectRefused(sb, { kind, summary, id }) {
        const before = topLevel(sb.dirs.B).sort();
        const idsBefore = await issueIds(sb, sb.dirs.B);
        clearLastSyncedTip('B');
        const eng = engineFor(sb);
        await assert.rejects(() => preflightBeadsHealthGate('B', eng.gateOpts), (err) => {
            assert.ok(err instanceof BeadsFlattenRecoveryRefusedError, `${err && err.name}: ${err && err.message}`);
            assert.deepEqual(err.details.localOnly.map((w) => [w.id, w.kind]), [[id, kind]], err.message);
            assert.match(err.message, summary);
            assert.ok(!/no local-only work found/.test(err.message), err.message);
            assert.equal(err.details.restored, true);
            return true;
        });
        assert.deepEqual(await issueIds(sb, sb.dirs.B), idsBefore, 'the issue set is unchanged');
        assert.deepEqual(topLevel(sb.dirs.B).sort(), before, 'no backup, pending or discarded clone left');
        assert.equal(eng.logs.filter((l) => l.startsWith(FLATTEN_RECOVERY_WARNING_PREFIX)).length, 0);
    }

    test('only an unpushed dependency add: refused, the dependency still on B', { timeout: budget }, async () => {
        const { sb, ids } = await buildScenario({ onB: (s, i) => runOrThrow(s, `bd dep add ${i.b} ${i.a1}`, s.dirs.B) });
        sandboxes.push(sb.root);
        await expectRefused(sb, { kind: 'dependency', summary: /1 dependency add/, id: ids.b });
        const shown = await bdJson(sb, `bd show ${ids.b} --json`, sb.dirs.B);
        const rec = Array.isArray(shown) ? shown[0] : shown;
        assert.ok((rec.dependencies || []).some((d) => (d.depends_on_id || d.id) === ids.a1), JSON.stringify(rec));
    });

    test('only an unpushed label add: refused, the label still on B', { timeout: budget }, async () => {
        const { sb, ids } = await buildScenario({ onB: (s, i) => runOrThrow(s, `bd label add ${i.a1} unpushed-label`, s.dirs.B) });
        sandboxes.push(sb.root);
        await expectRefused(sb, { kind: 'label', summary: /1 label add/, id: ids.a1 });
        const labels = await runOrThrow(sb, `bd label list ${ids.a1} --json`, sb.dirs.B);
        assert.ok(labels.includes('unpushed-label'), labels);
    });

    test('only an unpushed comment add: refused, the comment still on B', { timeout: budget }, async () => {
        const { sb, ids } = await buildScenario({ onB: (s, i) => runOrThrow(s, `bd comments add ${i.a2} "unpushed comment"`, s.dirs.B) });
        sandboxes.push(sb.root);
        await expectRefused(sb, { kind: 'comment', summary: /1 comment add/, id: ids.a2 });
        const comments = await runOrThrow(sb, `bd comments ${ids.a2} --json`, sb.dirs.B);
        assert.ok(comments.includes('unpushed comment'), comments);
    });

    test('only an unpushed delete: refused, the bead still absent on B', { timeout: budget }, async () => {
        const { sb, ids } = await buildScenario({ onB: (s, i) => runOrThrow(s, `bd delete ${i.a2} --force`, s.dirs.B) });
        sandboxes.push(sb.root);
        assert.ok(!(await issueIds(sb, sb.dirs.B)).includes(ids.a2), 'the delete happened on B');
        await expectRefused(sb, { kind: 'deleted', summary: /1 local delete/, id: ids.a2 });
        assert.ok(!(await issueIds(sb, sb.dirs.B)).includes(ids.a2), 'the deleted bead is still absent');
        assert.ok((await issueIds(sb, sb.dirs.A2)).includes(ids.a2), 'the rewritten remote still holds it');
    });

    test('prune before the rewrite: a clean clone that never received the prune is re-bootstrapped', { timeout: budget }, async () => {
        const { sb, ids } = await buildScenario({ prune: true });
        sandboxes.push(sb.root);
        assert.ok((await issueIds(sb, sb.dirs.B)).includes(ids.closed), 'B still holds the closed bead');
        assert.ok(!(await issueIds(sb, sb.dirs.A2)).includes(ids.closed), 'the rebuilt remote does not');
        clearLastSyncedTip('B');
        const eng = engineFor(sb);
        const res = await preflightBeadsHealthGate('B', eng.gateOpts);
        assert.equal(res.ok, true, JSON.stringify(res));
        assert.equal(res.recovered, true, eng.logs.join('\n'));
        assert.deepEqual(await issueIds(sb, sb.dirs.B), await issueIds(sb, sb.dirs.A2), 'B reads the rebuilt remote');
        const warn = eng.logs.filter((l) => l.startsWith(FLATTEN_RECOVERY_WARNING_PREFIX));
        assert.equal(warn.length, 1, eng.logs.join('\n'));
        assert.match(warn[0], /1 closed bead\(s\) the remote pruned/);
        await runOrThrow(sb, 'bd dolt pull', sb.dirs.B);
    });

    test('prune before the rewrite: a clone that changed a pruned closed bead after its last pull is refused intact', { timeout: budget }, async () => {
        const { sb, ids } = await buildScenario({ prune: true, onB: (s, i) => runOrThrow(s, `bd comments add ${i.closed} "late note"`, s.dirs.B) });
        sandboxes.push(sb.root);
        await expectRefused(sb, { kind: 'absent', summary: /1 bead not on the remote/, id: ids.closed });
        const comments = await runOrThrow(sb, `bd comments ${ids.closed} --json`, sb.dirs.B);
        assert.ok(comments.includes('late note'), comments);
    });
});
