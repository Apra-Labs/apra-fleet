// Launch-time member alignment (fleet-sprint/member-align.mjs).
//
// A multi-member legacy-mode launch used to refuse whenever members merely sat
// on different commits. prepareLaunchTopology() now aligns every member to the
// sprint base first (fetch, preserve WIP in a named stash, check out the
// sprint branch) and only then runs checkMemberTopology. These tests pin:
//
//   1. REAL GIT: two clones of one bare origin, on different branches/commits
//      and one with uncommitted tracked + untracked changes, end on the same
//      HEAD at origin/<base>'s tip, the topology check passes, one [Align]
//      line is logged per member, and the WIP sits in a named fleet-sprint
//      stash -- nothing discarded.
//   2. FAKE RUNNER: unreachable member, fetch auth failure, base missing on
//      origin and differing origin URLs each refuse naming member, cause and
//      fix, and NO stash/checkout command reaches ANY member (no partial
//      start).
//   3. SHELL NEUTRALITY: every command issued to a Windows/PowerShell member
//      is one git invocation with no '&&', no '$' expansion and no '~/'.
//
// FALSIFICATION: removing the alignMembersToBase() call from
// prepareLaunchTopology() (the step bin/cli.mjs runs in place of the bare
// topology check) makes the real-git scenario fail with the legacy
// "[Topology] Refusing to start ... disagree on their identity signals"
// refusal; the control test below shows that refusal on the same starting
// state without alignment.
//
// HOST GATING mirrors the other real-git tests: a host without a usable git
// skips WITH the reason attached. Every repo lives under one temp root that is
// removed afterwards; git runs hermetically (HOME/global config redirected
// into that root).
//
// ASCII only.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
    alignMembersToBase,
    prepareLaunchTopology,
    toAlignCommandResult,
    launchAlignStashMessage,
    ALIGN_LOG_PREFIX,
} from '../fleet-sprint/member-align.mjs';
import { checkMemberTopology, classifyGitFailure } from '../fleet-sprint/git-topology.mjs';
import { createGitRepoFixture, probeGitRepoFixtureSupport } from './helpers/git-repo-fixture.mjs';

const BASE = 'main';
const SPRINT = 'auto-sprint/align-test';

// ---------------------------------------------------------------------------
// Real-git helpers
// ---------------------------------------------------------------------------

function hermeticEnv(root) {
    return {
        ...process.env,
        HOME: path.join(root, 'home'),
        USERPROFILE: path.join(root, 'home'),
        XDG_CONFIG_HOME: path.join(root, 'home', '.config'),
        GIT_CONFIG_GLOBAL: path.join(root, 'home', '.gitconfig'),
        GIT_CONFIG_SYSTEM: path.join(root, 'home', '.gitconfig-system'),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_AUTHOR_NAME: 'member-align-test',
        GIT_AUTHOR_EMAIL: 'member-align-test@test.local',
        GIT_COMMITTER_NAME: 'member-align-test',
        GIT_COMMITTER_EMAIL: 'member-align-test@test.local',
    };
}

/** Split a command string into argv, honouring double-quoted segments. */
function tokenize(cmd) {
    const out = [];
    const re = /"([^"]*)"|(\S+)/g;
    let m;
    while ((m = re.exec(cmd)) !== null) out.push(m[1] !== undefined ? m[1] : m[2]);
    return out;
}

function gitIn(root, dir, args) {
    const res = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: hermeticEnv(root) });
    const output = `${res.stdout || ''}${res.stderr || ''}`;
    return { ok: res.status === 0, stdout: (res.stdout || '').trim(), output };
}

/** A per-member runGit that executes each command VERBATIM in that member's clone. */
function realRunner(root, dirs, issued) {
    return async (cmd, member) => {
        issued.push({ member, cmd });
        const argv = tokenize(cmd);
        assert.equal(argv[0], 'git', `alignment must only issue git commands, got: ${cmd}`);
        const res = gitIn(root, dirs[member], argv.slice(1));
        return { ok: res.ok, output: res.ok ? res.stdout : res.output, error: res.ok ? null : res.output.trim(), unreachable: false };
    };
}

function setupTwoDivergedClones() {
    const fx = createGitRepoFixture({ branch: BASE, prefix: 'member-align-' });
    const { root, clonePath: dirA, peerPath: dirB } = fx;
    // Origin's base moves ahead (published from B): B now sits on the new tip.
    const baseTip = fx.peerPublish('base-advance');
    // A: on a different branch with its own commit, plus uncommitted work --
    // a tracked modification and an untracked file.
    assert.ok(gitIn(root, dirA, ['checkout', '-b', 'scratch']).ok);
    fx.memberCommit('scratch-work');
    fs.writeFileSync(path.join(dirA, 'README.md'), 'tracked wip\n', 'utf-8');
    fs.writeFileSync(path.join(dirA, 'untracked-wip.txt'), 'untracked wip\n', 'utf-8');
    return { fx, root, dirs: { mA: dirA, mB: dirB }, baseTip };
}

const gitSupport = probeGitRepoFixtureSupport();

describe('real git: two clones on different branches/commits', { skip: gitSupport.ok ? false : gitSupport.reason }, () => {
    test('control: without alignment the legacy topology check refuses the same starting state', async () => {
        const { root, dirs } = setupTwoDivergedClones();
        try {
            const topo = await checkMemberTopology({
                members: ['mA', 'mB'],
                mode: 'legacy',
                getIdentity: async (m) => gitIn(root, dirs[m], ['rev-parse', 'HEAD']).stdout,
            });
            assert.equal(topo.ok, false);
            assert.match(topo.message, /disagree on their identity signals/);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('prepareLaunchTopology aligns both to origin/<base>, passes topology, logs one line per member, stashes WIP', async () => {
        const { root, dirs, baseTip } = setupTwoDivergedClones();
        try {
            const issued = [];
            const logs = [];
            const topo = await prepareLaunchTopology({
                members: ['mA', 'mB'],
                mode: 'legacy',
                baseBranch: BASE,
                branch: SPRINT,
                runGit: realRunner(root, dirs, issued),
                log: (m) => logs.push(m),
            });
            assert.equal(topo.ok, true, `topology must pass after alignment, got: ${topo.message}`);

            for (const m of ['mA', 'mB']) {
                assert.equal(gitIn(root, dirs[m], ['rev-parse', 'HEAD']).stdout, baseTip, `${m} must be at origin/${BASE}'s tip`);
                assert.equal(gitIn(root, dirs[m], ['rev-parse', '--abbrev-ref', 'HEAD']).stdout, SPRINT, `${m} must be on the sprint branch`);
            }

            const alignLines = logs.filter((l) => l.startsWith(ALIGN_LOG_PREFIX));
            assert.equal(alignLines.length, 2, `one alignment line per member, got: ${JSON.stringify(logs)}`);
            assert.ok(alignLines.some((l) => l.includes("member 'mA'") && l.includes('scratch@') && l.includes(`-> ${SPRINT}@`) && l.includes('stash')));
            assert.ok(alignLines.some((l) => l.includes("member 'mB'") && !l.includes('stash')));

            // WIP preserved, nothing discarded.
            const stashList = gitIn(root, dirs.mA, ['stash', 'list']).stdout;
            assert.ok(stashList.includes(launchAlignStashMessage(SPRINT)), `named stash missing, got: ${stashList}`);
            assert.ok(stashList.includes(`fleet-sprint[${SPRINT}]`));
            assert.equal(gitIn(root, dirs.mA, ['show', 'stash@{0}:README.md']).stdout, 'tracked wip');
            assert.equal(gitIn(root, dirs.mA, ['show', 'stash@{0}^3:untracked-wip.txt']).stdout, 'untracked wip');
            assert.equal(gitIn(root, dirs.mB, ['stash', 'list']).stdout, '', 'a clean member gets no stash');
            // The scratch branch and its commit survive.
            assert.ok(gitIn(root, dirs.mA, ['rev-parse', '--verify', 'refs/heads/scratch']).ok);

            for (const { cmd } of issued) {
                assert.ok(!cmd.includes('&&') && !cmd.includes('$') && !cmd.includes('~/'), `shell-neutral command expected: ${cmd}`);
            }
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
        assert.equal(fs.existsSync(root), false, 'the temp root must be removed');
    });

    test('relaunch: an existing origin/<sprint> is adopted instead of resetting to base', async () => {
        const { root, dirs } = setupTwoDivergedClones();
        try {
            // B publishes the sprint branch with one sprint commit on top of base.
            assert.ok(gitIn(root, dirs.mB, ['checkout', '-b', SPRINT]).ok);
            fs.writeFileSync(path.join(dirs.mB, 'sprint.txt'), 'sprint\n', 'utf-8');
            assert.ok(gitIn(root, dirs.mB, ['add', '--', 'sprint.txt']).ok);
            assert.ok(gitIn(root, dirs.mB, ['commit', '-m', 'sprint work']).ok);
            assert.ok(gitIn(root, dirs.mB, ['push', 'origin', `${SPRINT}:${SPRINT}`]).ok);
            const pushed = gitIn(root, dirs.mB, ['rev-parse', 'HEAD']).stdout;

            const res = await prepareLaunchTopology({
                members: ['mA', 'mB'], mode: 'legacy', baseBranch: BASE, branch: SPRINT,
                runGit: realRunner(root, dirs, []),
            });
            assert.equal(res.ok, true, res.message);
            assert.equal(gitIn(root, dirs.mA, ['rev-parse', 'HEAD']).stdout, pushed, 'mA must adopt the pushed sprint history');
            assert.equal(gitIn(root, dirs.mB, ['rev-parse', 'HEAD']).stdout, pushed);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

// ---------------------------------------------------------------------------
// Fake-runner cases
// ---------------------------------------------------------------------------

const ORIGIN = 'https://git.example.test/acme/widgets.git';

/**
 * A fake per-member runner. `overrides(cmd, member)` may return a result (or
 * throw) to replace the default success response for that call.
 */
function fakeRunner({ overrides = () => undefined, os = {} } = {}) {
    const issued = [];
    const runGit = async (cmd, member) => {
        issued.push({ member, cmd, os: os[member] || 'linux' });
        const o = overrides(cmd, member);
        if (o !== undefined) return o;
        if (cmd === 'git remote get-url origin') return { ok: true, output: `${ORIGIN}\n` };
        if (cmd.startsWith(`git fetch origin ${SPRINT}`)) return { ok: false, output: '', error: `fatal: couldn't find remote ref ${SPRINT}` };
        if (cmd.startsWith('git rev-parse --verify --quiet refs/heads/')) return { ok: false, output: '', error: '' };
        if (cmd === 'git status --porcelain') return { ok: true, output: member === 'win' ? ' M README.md\n?? new.txt\n' : '' };
        if (cmd === 'git rev-parse --abbrev-ref HEAD') return { ok: true, output: 'old-branch\n' };
        if (cmd.startsWith('git rev-parse --short HEAD')) return { ok: true, output: 'abc1234\n' };
        if (cmd === 'git rev-parse HEAD') return { ok: true, output: 'deadbeefdeadbeef\n' };
        return { ok: true, output: '' };
    };
    return { runGit, issued };
}

const MUTATING = /^git (checkout|stash|reset|switch)\b/;

function assertNoMemberMoved(issued) {
    const moved = issued.filter((c) => MUTATING.test(c.cmd));
    assert.deepEqual(moved, [], `no member may be moved on a refusal, got: ${JSON.stringify(moved)}`);
}

function assertRefusal(res, member, causeRe, fixRe) {
    assert.equal(res.ok, false);
    assert.match(res.message, /Refusing to start/);
    assert.match(res.message, /no member was moved/);
    assert.ok(res.message.includes(`member '${member}'`), `refusal must name ${member}: ${res.message}`);
    assert.match(res.message, causeRe);
    assert.match(res.message, fixRe);
}

test('unreachable member: refusal names member, cause and fix; no member moved', async () => {
    const { runGit, issued } = fakeRunner({
        overrides: (cmd, member) => {
            if (member === 'm2') throw new Error('member m2 is offline (connection refused)');
            return undefined;
        },
    });
    const res = await prepareLaunchTopology({ members: ['m1', 'm2'], mode: 'legacy', baseBranch: BASE, branch: SPRINT, runGit });
    assertRefusal(res, 'm2', /unreachable/, /back online/);
    assertNoMemberMoved(issued);
});

test('unreachable member reported by the tool without an exit code is classified as unreachable', async () => {
    const offline = toAlignCommandResult({ isError: true, content: [{ type: 'text', text: 'Member m2 is offline' }] });
    assert.equal(offline.unreachable, true);
    const { runGit, issued } = fakeRunner({ overrides: (cmd, member) => (member === 'm2' ? offline : undefined) });
    const res = await alignMembersToBase({ members: ['m1', 'm2'], baseBranch: BASE, branch: SPRINT, runGit });
    assertRefusal(res, 'm2', /unreachable/, /back online/);
    assertNoMemberMoved(issued);
});

test('fetch auth failure (classified via classifyGitFailure): refusal names member, cause and fix; no member moved', async () => {
    const authErr = "remote: Invalid username or password.\nfatal: Authentication failed for 'https://git.example.test/acme/widgets.git/'";
    assert.equal(classifyGitFailure(authErr), 'auth', 'fixture error text must classify as auth');
    const { runGit, issued } = fakeRunner({
        overrides: (cmd, member) => (member === 'm1' && cmd.startsWith(`git fetch origin ${BASE}`) ? { ok: false, output: '', error: authErr } : undefined),
    });
    const res = await prepareLaunchTopology({ members: ['m1', 'm2'], mode: 'legacy', baseBranch: BASE, branch: SPRINT, runGit });
    assertRefusal(res, 'm1', /failed authentication/, /provision_vcs_auth/);
    assertNoMemberMoved(issued);
    // Preconditions still ran on the OTHER member before refusing.
    assert.ok(issued.some((c) => c.member === 'm2' && c.cmd.startsWith(`git fetch origin ${BASE}`)));
});

test('base missing on origin: refusal names member, cause and fix; no member moved', async () => {
    const { runGit, issued } = fakeRunner({
        overrides: (cmd) => (cmd.startsWith(`git fetch origin ${BASE}`) ? { ok: false, output: '', error: `fatal: couldn't find remote ref ${BASE}` } : undefined),
    });
    const res = await prepareLaunchTopology({ members: ['m1', 'm2'], mode: 'legacy', baseBranch: BASE, branch: SPRINT, runGit });
    assertRefusal(res, 'm1', new RegExp(`base branch '${BASE}' does not exist on origin`), /--base/);
    assert.ok(res.message.includes("member 'm2'"), 'every failing member is named');
    assertNoMemberMoved(issued);
});

test('differing origin URLs: refusal names every member and its origin; nothing fetched or moved', async () => {
    const { runGit, issued } = fakeRunner({
        overrides: (cmd, member) => (cmd === 'git remote get-url origin' && member === 'm2' ? { ok: true, output: 'git@elsewhere.test:fork/widgets.git\n' } : undefined),
    });
    const res = await prepareLaunchTopology({ members: ['m1', 'm2'], mode: 'legacy', baseBranch: BASE, branch: SPRINT, runGit });
    assertRefusal(res, 'm2', /differs from the other members/, /same repository/);
    assert.ok(res.message.includes(`m1=${ORIGIN}`) && res.message.includes('m2=git@elsewhere.test:fork/widgets.git'));
    assertNoMemberMoved(issued);
    assert.ok(!issued.some((c) => c.cmd.startsWith('git fetch')), 'no fetch once origins disagree');
});

test('a diverged local sprint branch refuses before moving any member', async () => {
    const { runGit, issued } = fakeRunner({
        overrides: (cmd, member) => {
            if (member !== 'm2') return undefined;
            if (cmd.startsWith(`git fetch origin ${SPRINT}`)) return { ok: true, output: '' };
            if (cmd.startsWith('git rev-parse --verify --quiet refs/heads/')) return { ok: true, output: 'x' };
            if (cmd.startsWith('git merge-base --is-ancestor')) return { ok: false, output: '', error: '' };
            return undefined;
        },
    });
    const res = await alignMembersToBase({ members: ['m1', 'm2'], baseBranch: BASE, branch: SPRINT, runGit });
    assertRefusal(res, 'm2', /diverged/, /reconcile/);
    assertNoMemberMoved(issued);
});

test('Windows/PowerShell member: every issued command is one git call with no &&, $ expansion or ~/', async () => {
    const { runGit, issued } = fakeRunner({ os: { win: 'windows' } });
    const logs = [];
    const res = await prepareLaunchTopology({ members: ['win', 'lin'], mode: 'legacy', baseBranch: BASE, branch: SPRINT, runGit, log: (m) => logs.push(m) });
    assert.equal(res.ok, true, res.message);
    const winCmds = issued.filter((c) => c.member === 'win');
    assert.ok(winCmds.length > 0 && winCmds.every((c) => c.os === 'windows'));
    assert.ok(winCmds.some((c) => c.cmd.startsWith('git stash push -u -m ')), 'dirty Windows member gets a named stash');
    assert.ok(winCmds.some((c) => c.cmd === `git checkout -B ${SPRINT} origin/${BASE}`));
    for (const { cmd } of issued) {
        assert.ok(!cmd.includes('&&'), `no && allowed: ${cmd}`);
        assert.ok(!/\$/.test(cmd), `no $ expansion allowed: ${cmd}`);
        assert.ok(!cmd.includes('~/'), `no ~/ allowed: ${cmd}`);
        assert.match(cmd, /^git /, `one git invocation per call: ${cmd}`);
    }
    assert.equal(logs.filter((l) => l.startsWith(ALIGN_LOG_PREFIX)).length, 2);
});

test('synced mode and a single member skip alignment entirely (unchanged behaviour)', async () => {
    const synced = fakeRunner();
    const res = await prepareLaunchTopology({
        members: ['m1', 'm2'], mode: 'synced', baseBranch: BASE, branch: SPRINT, runGit: synced.runGit,
        getOriginUrl: async () => ORIGIN, doltProbe: async () => 'ok',
    });
    assert.equal(res.ok, true, res.message);
    assert.deepEqual(synced.issued, [], 'synced mode must not issue alignment commands');

    const single = fakeRunner();
    const one = await prepareLaunchTopology({ members: ['m1'], mode: 'legacy', baseBranch: BASE, branch: SPRINT, runGit: single.runGit });
    assert.equal(one.ok, true);
    assert.deepEqual(single.issued, []);
});

test('toAlignCommandResult: exit code decides ok; stdout preferred; thrown call is unreachable', () => {
    const ok = toAlignCommandResult({ content: [{ type: 'text', text: 'Exit code: 0\nabc' }], structuredContent: { exitCode: 0, stdout: 'abc\n' } });
    assert.deepEqual(ok, { ok: true, output: 'abc\n', error: null, unreachable: false });
    const failed = toAlignCommandResult({ content: [{ type: 'text', text: 'Exit code: 128\nfatal: x' }], structuredContent: { exitCode: 128 } });
    assert.equal(failed.ok, false);
    assert.equal(failed.unreachable, false);
    assert.match(failed.error, /fatal: x/);
    const thrown = toAlignCommandResult(undefined, new Error('socket hang up'));
    assert.deepEqual(thrown, { ok: false, output: '', error: 'socket hang up', unreachable: true });
});
