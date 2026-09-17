// A CONFIGURED Dolt sync.remote, standing up entirely on the local filesystem.
//
// WHY THIS EXISTS (apra-fleet-j918.5.1)
// -------------------------------------
// Every other dolt-sync suite drives doltPullBefore/doltPushAfter with a
// sync.remote that is EMPTY (the recorded bd fixtures answer
// `bd config get sync.remote --json` with `{"value":""}`, and the real-bd
// scratch workspace has none either), so both brackets short-circuit at their
// pre-gate to `{ skipped: true, reason: 'no-remote' }` and the whole
// pull/push path below the gate is never exercised. This fixture closes that
// gap: sync.remote is genuinely set, the pre-gates pass, and the commands the
// brackets issue move REAL refs on a REAL remote.
//
// THE MODEL. beads syncs its Dolt database through `refs/dolt/data` on a git
// remote (see the repo's SYNC_CONCEPTS pointer in CLAUDE.md), which is also
// exactly what dolt-sync.mjs's own remote-tip probe assumes -- it runs
// `git ls-remote <sync.remote> refs/dolt/data`. So the remote here is a real
// bare git repo, the "beads data" is real commits, and:
//
//   bd dolt push  ->  git push  <remote> refs/dolt/data:refs/dolt/data
//   bd dolt pull  ->  git fetch <remote> refs/dolt/data + git merge
//
// are run for real, with their real stderr on failure (which is what
// classifyDoltFailure() then reads). No dolt binary, no bd binary, no
// network, no credentials: a `file://` remote is enough for the push to be
// accepted, rejected non-fast-forward, or fail, exactly as a hosted one is.
//
// Every clone keeps the invariant `refs/dolt/data == refs/heads/main`, which
// is what lets a merge be expressed with ordinary git plumbing.
//
// ASCII only.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** dolt-sync.mjs's SAFE_REMOTE_URL_RE, duplicated here so the host gate can
 *  report up front that this host's temp path would be rejected by the
 *  remote-tip probe (which would silently turn every D-pull into a real pull
 *  with no fingerprint, and make these assertions lie about why). */
const SAFE_REMOTE_URL_RE = /^[A-Za-z0-9._~:/@+-]+$/;

function git(args, cwd) {
    const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
    const output = `${res.stdout || ''}${res.stderr || ''}`;
    return {
        ok: res.status === 0,
        status: res.status,
        output,
        stdout: (res.stdout || '').trim(),
        error: res.status === 0 ? null : output.trim() || `git ${args[0]} failed`,
    };
}

function gitOrThrow(args, cwd) {
    const res = git(args, cwd);
    if (!res.ok) throw new Error(`fixture setup: 'git ${args.join(' ')}' failed in ${cwd || process.cwd()}:\n${res.output}`);
    return res;
}

/**
 * Host-capability gate. Returns `{ ok: true }` or `{ ok: false, reason }` with
 * a human-readable reason -- callers pass the reason straight to node:test's
 * `{ skip: reason }` so a degraded host says WHY in the test output instead of
 * quietly reporting a pass it never ran.
 *
 * @returns {{ ok: boolean, reason: string }}
 */
export function probeDoltRemoteFixtureSupport() {
    const version = spawnSync('git', ['--version'], { encoding: 'utf8' });
    if (version.status !== 0) {
        return { ok: false, reason: `requires a host with a working 'git' on PATH (git --version exited ${version.status === null ? 'on a signal' : version.status})` };
    }
    let probeDir;
    try {
        probeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dolt-remote-probe-')));
    } catch (err) {
        return { ok: false, reason: `requires a writable temp directory (${(err && err.message) || err})` };
    }
    try {
        const url = `file://${probeDir}/remote.git`;
        if (!SAFE_REMOTE_URL_RE.test(url)) {
            return { ok: false, reason: `this host's temp path produces a sync.remote URL that dolt-sync's SAFE_REMOTE_URL_RE rejects (${url}), so the remote-tip probe could never run here` };
        }
        return { ok: true, reason: '' };
    } finally {
        fs.rmSync(probeDir, { recursive: true, force: true });
    }
}

/**
 * Stand up a bare "Dolt data remote", a member clone wired to it via a
 * genuinely configured bd-level sync.remote, and a peer clone that stands in
 * for another machine pushing to the same remote.
 *
 * @param {{ member?: string, prefix?: string }} [opts]
 */
export function createDoltRemoteFixture(opts = {}) {
    const member = opts.member || 'memberA';
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), opts.prefix || 'dolt-remote-fixture-')));
    const remoteDir = path.join(root, 'beads-data-remote.git');
    const remoteUrl = `file://${remoteDir}`;

    gitOrThrow(['init', '--bare', '-b', 'main', remoteDir]);

    // Seed the remote so it is a NON-EMPTY remote with a refs/dolt/data to
    // compare against -- an empty one takes doltPullBefore's separate benign
    // `empty-remote` exit, which is not the path under test.
    const seedDir = path.join(root, 'seed');
    fs.mkdirSync(seedDir);
    initClone(seedDir);
    fs.mkdirSync(path.join(seedDir, 'beads'));
    commitBeadsFile(seedDir, 'seed', 'seed');
    gitOrThrow(['push', remoteUrl, 'refs/heads/main:refs/heads/main', 'refs/dolt/data:refs/dolt/data'], seedDir);

    const clonePath = path.join(root, 'member-clone');
    const peerPath = path.join(root, 'peer-clone');
    cloneFromRemote(clonePath);
    cloneFromRemote(peerPath);

    // The bd-level sync.remote is real, on-disk, mutable state -- not a
    // literal baked into the command mock -- so a test can neutralize it the
    // way a member's own session would and watch the pre-gate react.
    const beadsConfigPath = path.join(clonePath, '.beads-config.json');
    fs.writeFileSync(beadsConfigPath, `${JSON.stringify({ sync: { remote: remoteUrl } }, null, 2)}\n`, 'utf-8');

    function initClone(dir) {
        gitOrThrow(['init', '-b', 'main'], dir);
        configureIdentity(dir);
    }

    function configureIdentity(dir) {
        gitOrThrow(['config', 'user.email', 'dolt-remote-fixture@test.local'], dir);
        gitOrThrow(['config', 'user.name', 'dolt-remote-fixture'], dir);
        // Deliberately NOT merge.ff=false: a pull with no local commits must
        // fast-forward (so the clone's tip becomes exactly the remote's SHA,
        // which is what the fingerprint records), while a genuinely diverged
        // pull still mints a merge commit.
        gitOrThrow(['config', 'commit.gpgsign', 'false'], dir);
    }

    function cloneFromRemote(dir) {
        gitOrThrow(['clone', remoteUrl, dir]);
        configureIdentity(dir);
        gitOrThrow(['update-ref', 'refs/dolt/data', 'refs/heads/main'], dir);
    }

    /** One "beads mutation": a real commit, with refs/dolt/data moved onto it. */
    function commitBeadsFile(dir, label, body) {
        const rel = path.join('beads', `${label}.json`);
        fs.mkdirSync(path.join(dir, 'beads'), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), `${JSON.stringify({ id: label, body })}\n`, 'utf-8');
        gitOrThrow(['add', '--', rel], dir);
        gitOrThrow(['commit', '-m', `beads mutation: ${label}`], dir);
        gitOrThrow(['update-ref', 'refs/dolt/data', 'refs/heads/main'], dir);
        return revParse(dir, 'refs/dolt/data');
    }

    function revParse(dir, ref) {
        const res = git(['rev-parse', ref], dir);
        return res.ok ? res.stdout : null;
    }

    const calls = [];

    /**
     * The injected command() dolt-sync.mjs drives. It runs the REAL git the
     * bracket asked for; nothing about the outcome is simulated.
     */
    async function command(cmd, cmdOpts = {}) {
        calls.push({ cmd, opts: cmdOpts });

        if (cmd.includes('bd config get sync.remote --json')) {
            // bd's own JSON shape for `config get`.
            let value = '';
            try {
                value = JSON.parse(fs.readFileSync(beadsConfigPath, 'utf-8')).sync.remote || '';
            } catch {
                value = '';
            }
            return { ok: true, output: JSON.stringify({ key: 'sync.remote', value }), error: null };
        }

        if (/\bls-remote\b/.test(cmd)) {
            // Run the probe command EXACTLY as composed (including its
            // credential-suppressing -c flags), so the fixture cannot
            // accidentally paper over a malformed probe string.
            const argv = cmd.trim().split(/\s+/);
            const res = git(argv.slice(1), clonePath);
            return { ok: res.ok, output: res.output, error: res.error };
        }

        if (cmd.includes('bd dolt push')) {
            const res = git(['push', remoteUrl, 'refs/dolt/data:refs/dolt/data'], clonePath);
            return { ok: res.ok, output: res.output, error: res.error };
        }

        if (cmd.includes('bd dolt pull')) {
            const fetched = git(['fetch', '--force', remoteUrl, 'refs/dolt/data:refs/remotes/doltdata/data'], clonePath);
            if (!fetched.ok) return { ok: false, output: fetched.output, error: fetched.error };
            const merged = git(['merge', '--no-edit', 'refs/remotes/doltdata/data'], clonePath);
            if (!merged.ok) {
                // Leave the clone usable for the assertions that follow; the
                // merge's own conflict text is what the caller classifies.
                git(['merge', '--abort'], clonePath);
                return { ok: false, output: merged.output, error: merged.error };
            }
            gitOrThrow(['update-ref', 'refs/dolt/data', 'refs/heads/main'], clonePath);
            return { ok: true, output: merged.output, error: null };
        }

        return { ok: true, output: '', error: null };
    }

    return {
        member,
        root,
        remoteDir,
        remoteUrl,
        clonePath,
        peerPath,
        command,
        calls,

        /** Commands issued through command() whose text contains `needle`. */
        commandsOf(needle) {
            return calls.filter((c) => c.cmd.includes(needle));
        },

        /** A beads mutation in the MEMBER's clone (not yet pushed). */
        mutate(label, body = label) {
            return commitBeadsFile(clonePath, label, body);
        },

        /** A beads mutation in the PEER's clone, published to the shared remote. */
        peerPublish(label, body = label) {
            const sha = commitBeadsFile(peerPath, label, body);
            gitOrThrow(['push', remoteUrl, 'refs/heads/main:refs/heads/main', 'refs/dolt/data:refs/dolt/data'], peerPath);
            return sha;
        },

        /** What actually landed on the remote -- read straight from the bare
         *  repo, never through the injected command(). */
        remoteTip() {
            return revParse(remoteDir, 'refs/dolt/data');
        },
        remoteFiles() {
            const res = git(['ls-tree', '-r', '--name-only', 'refs/dolt/data'], remoteDir);
            return res.ok ? res.stdout.split('\n').filter(Boolean) : [];
        },
        localTip() {
            return revParse(clonePath, 'refs/dolt/data');
        },
        localFiles() {
            const res = git(['ls-tree', '-r', '--name-only', 'refs/dolt/data'], clonePath);
            return res.ok ? res.stdout.split('\n').filter(Boolean) : [];
        },
        /** Commits reachable from the remote's refs/dolt/data, newest first. */
        remoteLog() {
            const res = git(['log', '--format=%s', 'refs/dolt/data'], remoteDir);
            return res.ok ? res.stdout.split('\n').filter(Boolean) : [];
        },

        /** Neutralize the member's bd-level sync.remote, as a member session
         *  running `bd config set sync.remote ""` would. */
        neutralizeSyncRemote() {
            fs.writeFileSync(beadsConfigPath, `${JSON.stringify({ sync: { remote: '' } }, null, 2)}\n`, 'utf-8');
        },

        /** Delete the backing remote repository: sync.remote stays configured,
         *  but the remote it names is gone. */
        destroyRemote() {
            fs.rmSync(remoteDir, { recursive: true, force: true });
        },

        cleanup() {
            fs.rmSync(root, { recursive: true, force: true });
        },
    };
}
