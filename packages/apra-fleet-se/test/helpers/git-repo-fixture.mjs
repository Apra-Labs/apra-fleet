// A REAL git origin + member clone + peer clone, standing up entirely on the
// local filesystem, for driving the G-side (code) sync bracket for real.
//
// WHY THIS EXISTS (apra-fleet-j918.6.1)
// -------------------------------------
// test/helpers/mock-sprint-harness.mjs intercepts every command matching
// /^(git|gh)\s/ and answers it with a literal success result
// ("ok (mocked -- no real git remote in this mock sprint)") unless the test
// opted into failure via `gitGhFailurePattern`. Nearly a hundred test files
// under test/ import that harness, so in every one of them `git fetch`,
// `git merge --ff-only`, `git push`, `git pull --rebase`,
// `git rebase --abort` and `git status --porcelain` succeed unconditionally.
// That means the bracket in fleet-sprint/git-sync.mjs (and the
// fleet-sprint/member-sync.mjs G-pull/G-push halves it drives) has never been
// executed against a git that can actually refuse: a fast-forward that is not
// a fast-forward, a push that is genuinely rejected, a rebase that genuinely
// rewrites a commit. Asserting that a command STRING was emitted cannot catch
// a wrong flag, a wrong refspec, or a wrong recovery order.
//
// This fixture is the G-side counterpart of ./dolt-remote-fixture.mjs (which
// did the same thing for the D-side in apra-fleet-j918.5.1) and follows its
// shape deliberately: a bare repo as the shared "origin", a member clone that
// the injected command() runs REAL git in, and a peer clone standing in for
// another machine publishing to the same branch. No network, no credentials,
// no GitHub: a local bare repo accepts, rejects non-fast-forward, or fails
// exactly as a hosted one does, and the stderr the bracket classifies is git's
// own.
//
// THE MOCK IS NOT REPLACED. This fixture is additive: mock-sprint-harness's
// git/gh interception and its `gitGhFailurePattern` failure injection are
// untouched, and remain the right tool for the ~97 sprint-shaped tests that
// need a deterministic simulated remote.
//
// HERMETIC BY CONSTRUCTION. Every git invocation -- the fixture's own setup
// AND the ones the bracket issues through command() -- runs with HOME,
// XDG_CONFIG_HOME, GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM redirected INSIDE
// the fixture's tempdir and GIT_CONFIG_NOSYSTEM=1 set, so:
//   - the host's ~/.gitconfig (commit.gpgsign, pull.rebase, merge.ff,
//     core.hooksPath, init.templateDir, ...) cannot change a verdict, and
//   - nothing this fixture runs can write a byte outside its own tempdir.
// That second property is what lets a caller assert "leaves nothing outside
// the test sandbox" and mean it.
//
// ASCII only.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const IDENTITY_NAME = 'git-repo-fixture';
const IDENTITY_EMAIL = 'git-repo-fixture@test.local';

/** Env that makes a git invocation hermetic within `root`. */
function hermeticEnv(root) {
    return {
        ...process.env,
        // isolated-home-allow: this is git-config isolation (hermetic
        // ~/.gitconfig for the real git subprocess this fixture drives),
        // not a fleet-home/fleet.key sandbox -- see the file header. It
        // still sets USERPROFILE alongside HOME per the lane's rule.
        HOME: path.join(root, 'home'),
        USERPROFILE: path.join(root, 'home'),
        XDG_CONFIG_HOME: path.join(root, 'home', '.config'),
        GIT_CONFIG_GLOBAL: path.join(root, 'home', '.gitconfig'),
        GIT_CONFIG_SYSTEM: path.join(root, 'home', '.gitconfig-system'),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '',
        SSH_ASKPASS: '',
        GIT_AUTHOR_NAME: IDENTITY_NAME,
        GIT_AUTHOR_EMAIL: IDENTITY_EMAIL,
        GIT_COMMITTER_NAME: IDENTITY_NAME,
        GIT_COMMITTER_EMAIL: IDENTITY_EMAIL,
    };
}

function runGit(args, cwd, root) {
    const res = spawnSync('git', args, { cwd, encoding: 'utf8', env: hermeticEnv(root) });
    const output = `${res.stdout || ''}${res.stderr || ''}`;
    return {
        ok: res.status === 0,
        status: res.status,
        output,
        stdout: (res.stdout || '').trim(),
        error: res.status === 0 ? null : output.trim() || `git ${args[0]} failed`,
    };
}

/**
 * Host-capability gate. Returns `{ ok: true, reason: '' }` or
 * `{ ok: false, reason }`; callers pass `reason` straight to node:test's
 * `{ skip: reason }` so a degraded host SAYS WHY instead of silently
 * reporting a pass it never ran.
 *
 * GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM need git >= 2.32; rather than parse a
 * version string this probes the behaviour directly.
 *
 * @returns {{ ok: boolean, reason: string }}
 */
export function probeGitRepoFixtureSupport() {
    const version = spawnSync('git', ['--version'], { encoding: 'utf8' });
    if (version.status !== 0) {
        return { ok: false, reason: `requires a host with a working 'git' on PATH (git --version exited ${version.status === null ? 'on a signal' : version.status})` };
    }
    let probeRoot;
    try {
        probeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-repo-probe-')));
    } catch (err) {
        return { ok: false, reason: `requires a writable temp directory (${(err && err.message) || err})` };
    }
    try {
        fs.mkdirSync(path.join(probeRoot, 'home'), { recursive: true });
        // Does this git honour GIT_CONFIG_GLOBAL at all? If it does not, the
        // host's ~/.gitconfig could silently change a merge/push verdict and
        // the assertions below would be measuring the host, not the bracket.
        const write = runGit(['config', '--global', 'fixture.probe', 'yes'], probeRoot, probeRoot);
        if (!write.ok) {
            return { ok: false, reason: `requires a git that honours GIT_CONFIG_GLOBAL (git >= 2.32); 'git config --global' failed: ${write.error}` };
        }
        if (!fs.existsSync(path.join(probeRoot, 'home', '.gitconfig'))) {
            return { ok: false, reason: 'requires a git that honours GIT_CONFIG_GLOBAL (git >= 2.32); the redirected global config file was never written' };
        }
        const init = runGit(['init', '--bare', '-b', 'main', path.join(probeRoot, 'probe.git')], probeRoot, probeRoot);
        if (!init.ok) {
            return { ok: false, reason: `requires 'git init --bare -b <branch>' to work in a temp directory: ${init.error}` };
        }
        return { ok: true, reason: '' };
    } finally {
        fs.rmSync(probeRoot, { recursive: true, force: true });
    }
}

/**
 * Stand up a bare "origin" carrying one shared sprint branch, a member clone
 * (the one the sync bracket operates in), and a peer clone standing in for
 * another machine publishing to the same branch.
 *
 * @param {{ member?: string, branch?: string, prefix?: string }} [opts]
 */
export function createGitRepoFixture(opts = {}) {
    const member = opts.member || 'memberA';
    const branch = opts.branch || 'feat/real-git-bracket';
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), opts.prefix || 'git-repo-fixture-')));
    fs.mkdirSync(path.join(root, 'home', '.config'), { recursive: true });

    const originDir = path.join(root, 'origin.git');
    const clonePath = path.join(root, 'member-clone');
    const peerPath = path.join(root, 'peer-clone');

    const git = (args, cwd) => runGit(args, cwd, root);
    function gitOrThrow(args, cwd) {
        const res = git(args, cwd);
        if (!res.ok) throw new Error(`fixture setup: 'git ${args.join(' ')}' failed in ${cwd || root}:\n${res.output}`);
        return res;
    }

    gitOrThrow(['init', '--bare', '-b', branch, originDir], root);

    // Seed the shared branch so both clones start from a common base commit
    // -- the single-writer-token starting state every real sprint dispatch
    // begins from.
    const seedDir = path.join(root, 'seed');
    fs.mkdirSync(seedDir);
    gitOrThrow(['init', '-b', branch], seedDir);
    configureIdentity(seedDir);
    fs.writeFileSync(path.join(seedDir, 'README.md'), 'seed\n', 'utf-8');
    gitOrThrow(['add', '--', 'README.md'], seedDir);
    gitOrThrow(['commit', '-m', 'seed'], seedDir);
    gitOrThrow(['push', originDir, `refs/heads/${branch}:refs/heads/${branch}`], seedDir);
    const seedSha = git(['rev-parse', 'HEAD'], seedDir).stdout;

    cloneFromOrigin(clonePath);
    cloneFromOrigin(peerPath);

    function configureIdentity(dir) {
        gitOrThrow(['config', 'user.email', IDENTITY_EMAIL], dir);
        gitOrThrow(['config', 'user.name', IDENTITY_NAME], dir);
        gitOrThrow(['config', 'commit.gpgsign', 'false'], dir);
        // Leave merge.ff / pull.rebase at their DEFAULTS: the whole point is
        // that `git merge --ff-only` and `git pull --rebase` are the flags the
        // production code passes, not flags the fixture pre-arranged.
    }

    function cloneFromOrigin(dir) {
        gitOrThrow(['clone', '--branch', branch, originDir, dir], root);
        configureIdentity(dir);
    }

    /** One "code mutation": a real commit on the branch, not yet published. */
    function commitIn(dir, label, body) {
        const rel = `${label}.txt`;
        fs.writeFileSync(path.join(dir, rel), `${body == null ? label : body}\n`, 'utf-8');
        gitOrThrow(['add', '--', rel], dir);
        gitOrThrow(['commit', '-m', label], dir);
        return git(['rev-parse', 'HEAD'], dir).stdout;
    }

    /**
     * A code mutation at an ARBITRARY relative path (creating parent
     * directories as needed), rather than the flat "<label>.txt" commitIn()
     * always writes. Exists for apra-fleet-2wdc.8: proving the sync bracket
     * itself neither rejects nor mangles a path like
     * ".github/workflows/ci.yml" needs the fixture to actually commit
     * something nested -- flat-file commitIn() cannot exercise that.
     */
    function commitFileAt(dir, relPath, body, message) {
        const abs = path.join(dir, relPath);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, `${body == null ? relPath : body}\n`, 'utf-8');
        gitOrThrow(['add', '--', relPath], dir);
        gitOrThrow(['commit', '-m', message || relPath], dir);
        return git(['rev-parse', 'HEAD'], dir).stdout;
    }

    function revParse(dir, ref) {
        const res = git(['rev-parse', ref], dir);
        return res.ok ? res.stdout : null;
    }

    function revParseGitDir() {
        const res = git(['rev-parse', '--absolute-git-dir'], clonePath);
        return res.ok ? res.stdout : path.join(clonePath, '.git');
    }

    function subjects(dir, ref) {
        const res = git(['log', '--format=%s', ref], dir);
        return res.ok ? res.stdout.split('\n').filter(Boolean) : [];
    }

    const calls = [];

    /**
     * The injected command() the sync bracket drives. Any `git ...` command is
     * executed VERBATIM (argv = the composed string, split on whitespace) in
     * the member clone, so the fixture cannot accidentally paper over a wrong
     * flag or a wrong refspec -- if the bracket composes a bad git command,
     * real git says so.
     *
     * `bd config get sync.remote --json` is answered with a positively-parsed
     * EMPTY value, which is what makes both Dolt pre-gates take their benign
     * `no-remote` skip. This fixture is about the G side; the D side has its
     * own real-execution fixture (./dolt-remote-fixture.mjs).
     */
    async function command(cmd, cmdOpts = {}) {
        calls.push({ cmd, opts: cmdOpts });

        if (cmd.includes('bd config get sync.remote --json')) {
            return { ok: true, output: JSON.stringify({ key: 'sync.remote', value: '' }), error: null };
        }
        if (/^git\s/.test(cmd.trim())) {
            const argv = cmd.trim().split(/\s+/).slice(1);
            const res = git(argv, clonePath);
            return { ok: res.ok, output: res.output, error: res.error };
        }
        return { ok: true, output: '', error: null };
    }

    return {
        member,
        branch,
        root,
        originDir,
        clonePath,
        peerPath,
        seedSha,
        command,
        calls,

        /** Commands issued through command() whose text contains `needle`. */
        commandsOf(needle) {
            return calls.filter((c) => c.cmd.includes(needle));
        },

        /** A code mutation in the MEMBER's clone -- committed, NOT published. */
        memberCommit(label, body) {
            return commitIn(clonePath, label, body);
        },

        /** A code mutation in the MEMBER's clone at an arbitrary relative
         *  path (e.g. "'.github/workflows/ci.yml'") -- committed, NOT
         *  published. See commitFileAt() for why this differs from
         *  memberCommit(). */
        memberCommitFile(relPath, body, message) {
            return commitFileAt(clonePath, relPath, body, message);
        },

        /** A code mutation in the PEER's clone, published to the shared origin. */
        peerPublish(label, body) {
            const sha = commitIn(peerPath, label, body);
            gitOrThrow(['push', originDir, `refs/heads/${branch}:refs/heads/${branch}`], peerPath);
            return sha;
        },

        /** What actually landed on origin -- read straight from the bare repo,
         *  never through the injected command(). */
        originTip() {
            return revParse(originDir, `refs/heads/${branch}`);
        },
        originSubjects() {
            return subjects(originDir, `refs/heads/${branch}`);
        },
        /** Merge commits reachable from origin's branch tip. A rebase-based
         *  reconciliation must leave this EMPTY. */
        originMergeSubjects() {
            const res = git(['rev-list', '--merges', '--format=%s', `refs/heads/${branch}`], originDir);
            return res.ok ? res.stdout.split('\n').filter((l) => l && !l.startsWith('commit ')) : [];
        },
        /** The content of `relPath` as it landed on origin's branch tip, read
         *  straight from the bare repo (never through the injected
         *  command()), or null if the path does not exist there. */
        originFileAt(relPath) {
            const res = git(['show', `refs/heads/${branch}:${relPath}`], originDir);
            return res.ok ? res.stdout : null;
        },

        localTip() {
            return revParse(clonePath, 'HEAD');
        },
        localSubjects() {
            return subjects(clonePath, 'HEAD');
        },
        localMergeSubjects() {
            const res = git(['rev-list', '--merges', '--format=%s', 'HEAD'], clonePath);
            return res.ok ? res.stdout.split('\n').filter((l) => l && !l.startsWith('commit ')) : [];
        },
        /** The member clone's remote-tracking ref for the shared branch. */
        localRemoteTrackingTip() {
            return revParse(clonePath, `refs/remotes/origin/${branch}`);
        },
        /** `git status --porcelain` in the member clone: '' means a clean tree
         *  with no unmerged paths and no rebase leftovers. */
        localStatus() {
            const res = git(['status', '--porcelain'], clonePath);
            return res.ok ? res.stdout : `STATUS FAILED: ${res.error}`;
        },
        /** True when a rebase/merge is still in progress in the member clone
         *  (an aborted-but-not-cleaned-up state the bracket must never leave). */
        localRebaseInProgress() {
            const gitDir = revParseGitDir();
            return fs.existsSync(path.join(gitDir, 'rebase-merge')) || fs.existsSync(path.join(gitDir, 'rebase-apply'));
        },
        /** True iff `ancestor` is reachable from `descendant` in the member clone. */
        isAncestor(ancestor, descendant) {
            return git(['merge-base', '--is-ancestor', ancestor, descendant], clonePath).ok;
        },
        /** Everything under the fixture's redirected HOME -- the assertion
         *  surface for "wrote nothing outside its sandbox". */
        homeEntries() {
            const home = path.join(root, 'home');
            return fs.existsSync(home) ? fs.readdirSync(home).sort() : [];
        },

        cleanup() {
            fs.rmSync(root, { recursive: true, force: true });
        },
    };
}
