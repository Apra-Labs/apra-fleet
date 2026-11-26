// Launch pull of a member that ALREADY has a beads database, against the REAL
// pinned bd. A (the backlog member) and B (a non-backlog beads-reading member)
// are real bd clones of one beads remote; the remote is then rebuilt with an
// independent history (no common ancestor with B, the same construction as
// beads-flatten-recovery-real-bd.test.mjs). The REAL launch precondition
// (beads-identity-check.mjs verifyBeadsIdentity) runs with the real
// health-gate pull and real recovery; every member command runs for real in
// that member's clone.
//
// Scenario 1: B holds nothing the rebuilt remote lacks. verifyBeadsIdentity
// pulls B at launch, the recovery WARN line names B, and afterwards `bd` on B
// reads the rebuilt remote's beads and a plain `bd dolt pull` succeeds. All of
// that happens inside verifyBeadsIdentity, i.e. before the sprint's first
// dispatch.
// Scenario 2: B holds an unpushed bead. The launch fails with an error naming
// member B and its .beads is left intact (the bead is read back with bd show).
//
// Falsifiability: with the launch pull removed from verifyBeadsIdentity (the
// launchPullMember call in the member loop) scenario 1 fails -- B is never
// recovered at launch, its first plain pull still fails with "no common
// ancestor" -- checked locally once by reverting the impl change.
//
// Hermetic: HOME, USERPROFILE, GIT_CONFIG_GLOBAL and TMPDIR point into one temp
// sandbox (asserted), removed afterwards; no real credentials, no network.
// Skips when no bd binary is on PATH. ASCII only.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec, spawnSync } from 'node:child_process';

import { verifyBeadsIdentity } from '../fleet-sprint/beads-identity-check.mjs';
import { invalidateSyncRemoteCache, clearLastSyncedTip, clearTipProbeFailures, clearDegradedSyncRecords } from '../fleet-sprint/dolt-sync.mjs';
import { getSeCommands } from '../fleet-sprint/se-os-commands.mjs';
import { BeadsFlattenRecoveryRefusedError } from '../fleet-sprint/errors.mjs';
import { FLATTEN_BACKUP_PREFIX, FLATTEN_RECOVERY_WARNING_PREFIX } from '../fleet-sprint/beads-flatten-recovery.mjs';
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

const SHELL = process.platform === 'win32'
    ? getSeCommands({ os: 'windows', shell: 'powershell' })
    : getSeCommands({ os: process.platform === 'darwin' ? 'darwin' : 'linux', shell: 'bash' });

function createSandbox() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lp-')));
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
    return { root, env, dirs: { A: path.join(root, 'A'), A2: path.join(root, 'A2'), B: path.join(root, 'B') }, remote: path.join(root, 'remote.git') };
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

// A and B are real clones that both have a database AND sync.remote set; the
// remote is then rewritten with an independent history carrying A's issues.
async function buildScenario({ unpushedOnB = false } = {}) {
    const sb = createSandbox();
    const { A, A2, B } = sb.dirs;
    await runOrThrow(sb, 'git config --global user.name "Launch Pull"', sb.root);
    await runOrThrow(sb, 'git config --global user.email launch-pull@test.local', sb.root);
    await runOrThrow(sb, 'git config --global commit.gpgsign false', sb.root);
    // dolt's git remote cache inside .beads passes MAX_PATH on Windows; this
    // is the member-side fix the product names on that failure (longPathHint).
    if (process.platform === 'win32') await runOrThrow(sb, 'git config --global core.longpaths true', sb.root);
    await runOrThrow(sb, `git init -q --bare -b main "${sb.remote}"`, sb.root);
    const url = `file://${sb.remote.split(path.sep).join('/')}`;
    fs.mkdirSync(A);
    await runOrThrow(sb, 'git init -q -b main', A);
    await runOrThrow(sb, `git remote add origin "${url}"`, A);
    await runOrThrow(sb, 'git commit -q --allow-empty -m init', A);
    await runOrThrow(sb, 'git push -q origin main', A);
    await runOrThrow(sb, 'bd init --prefix lp', A);
    await runOrThrow(sb, `bd config set sync.remote ${url}`, A);
    await createBead(sb, 'from A one', A);
    await createBead(sb, 'from A two', A);
    await runOrThrow(sb, 'bd dolt push', A);

    fs.mkdirSync(B);
    await runOrThrow(sb, `git clone -q "${url}" .`, B);
    await runOrThrow(sb, 'bd bootstrap --yes', B);
    await runOrThrow(sb, `bd config set sync.remote ${url}`, B);
    await createBead(sb, 'from B', B);
    await runOrThrow(sb, 'bd dolt push', B);
    await runOrThrow(sb, 'bd dolt pull', A);

    const exportFile = path.join(sb.root, 'a-export.jsonl');
    await runOrThrow(sb, `bd export --all -o "${exportFile}"`, A);
    fs.mkdirSync(A2);
    await runOrThrow(sb, 'git init -q -b main', A2);
    await runOrThrow(sb, 'bd init --prefix lp', A2);
    await runOrThrow(sb, `bd import "${exportFile}"`, A2);
    await runOrThrow(sb, `bd dolt remote add origin "${url}"`, A2);
    await runOrThrow(sb, 'bd dolt remote reset-data origin --yes', A2);

    const unpushedId = unpushedOnB ? await createBead(sb, 'unpushed on B', B) : null;
    return { sb, url, unpushedId };
}

function launch(sb, url) {
    const calls = [];
    const logs = [];
    const command = async (cmd, opts = {}) => {
        const cwd = sb.dirs[opts.member_name];
        assert.ok(cwd && ['A', 'B'].includes(opts.member_name), `command for an unknown member '${opts.member_name}': ${cmd}`);
        calls.push({ member: opts.member_name, cmd });
        const res = await run(cmd, cwd, sb.env);
        const output = `${res.stdout}${res.ok ? '' : res.stderr}`;
        if (opts.failSoft) return { ok: res.ok, output, error: res.ok ? null : (res.stderr || res.stdout || 'command failed').trim() };
        if (!res.ok) throw new Error(`[Command Failed] ${cmd}: ${res.stderr || res.stdout}`);
        return res.stdout;
    };
    const verify = () => verifyBeadsIdentity({
        command,
        log: (l) => logs.push(l),
        backlogMember: 'A',
        members: ['B'],
        expected: null,
        memberShell: async () => SHELL,
    });
    return { calls, logs, verify };
}

describe('launch pull of a member with an existing beads database, real bd', { skip: SKIP, concurrency: false }, () => {
    const budget = scaledTimeout(180_000, { concurrency: TEST_CONCURRENCY });
    const sandboxes = [];
    after(() => {
        for (const root of sandboxes) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
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

    test('a flattened remote is recovered at launch: B is re-bootstrapped before any dispatch and bd on B reads the rebuilt beads', { timeout: budget }, async () => {
        invalidateSyncRemoteCache(); clearLastSyncedTip(); clearTipProbeFailures(); clearDegradedSyncRecords();
        const { sb, url } = await buildScenario();
        sandboxes.push(sb.root);
        const probe = await run('bd dolt pull', sb.dirs.B, sb.env);
        assert.equal(probe.ok, false, 'the rebuilt remote must not merge into B');
        assert.match(`${probe.stdout}${probe.stderr}`, /no common ancestor/);
        clearLastSyncedTip('B');

        const l = launch(sb, url);
        const res = await l.verify();
        assert.deepEqual(res.setUp, ['B'], l.logs.join('\n'));
        const warn = l.logs.filter((line) => line.startsWith(FLATTEN_RECOVERY_WARNING_PREFIX));
        assert.equal(warn.length, 1, l.logs.join('\n'));
        assert.ok(warn[0].includes(`'B'`), warn[0]);
        assert.ok(fs.readdirSync(sb.dirs.B).some((n) => n.startsWith(FLATTEN_BACKUP_PREFIX)), 'the backup of the original .beads exists');
        assert.deepEqual(await issueIds(sb, sb.dirs.B), await issueIds(sb, sb.dirs.A2), 'bd on B reads the rebuilt remote beads');
        await runOrThrow(sb, 'bd dolt pull', sb.dirs.B); // the first pre-dispatch pull now works
        assert.ok(!l.calls.some((c) => c.member === 'A' && /^bd dolt pull/.test(c.cmd)), 'the backlog member is not pulled here');
    });

    test('a member holding unpushed work fails the launch naming it; its .beads is left intact', { timeout: budget }, async () => {
        invalidateSyncRemoteCache(); clearLastSyncedTip(); clearTipProbeFailures(); clearDegradedSyncRecords();
        const { sb, url, unpushedId } = await buildScenario({ unpushedOnB: true });
        sandboxes.push(sb.root);
        const top = fs.readdirSync(sb.dirs.B).sort();
        const idsBefore = await issueIds(sb, sb.dirs.B);
        clearLastSyncedTip('B');

        const l = launch(sb, url);
        await assert.rejects(() => l.verify(), (err) => {
            assert.ok(err instanceof BeadsFlattenRecoveryRefusedError, `${err && err.name}: ${err && err.message}`);
            assert.ok(err.message.includes(`'B'`), err.message);
            assert.ok(err.message.includes(unpushedId), err.message);
            return true;
        });
        const shown = await runOrThrow(sb, `bd show ${unpushedId} --json`, sb.dirs.B);
        assert.ok(shown.includes(unpushedId), shown);
        assert.deepEqual(await issueIds(sb, sb.dirs.B), idsBefore, 'nothing was deleted');
        assert.ok(fs.existsSync(path.join(sb.dirs.B, '.beads')), '.beads is still there');
        assert.deepEqual(fs.readdirSync(sb.dirs.B).sort().filter((n) => !n.startsWith('.beads.gate')), top.filter((n) => !n.startsWith('.beads.gate')), 'no backup or pending clone left');
    });
});
