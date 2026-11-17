#!/usr/bin/env node
//
// record-vcs-stderr.mjs -- RECORDER for vcs-stderr-corpus.json.
//
// WHY THIS EXISTS (apra-fleet-j918.6.2)
// -------------------------------------
// The VCS failure-classification taxonomy (classifyGitFailure in
// fleet-sprint/git-topology.mjs, classifyDoltFailure in
// fleet-sprint/dolt-sync.mjs, both delegating to VCSModule.classifyFailure)
// is regex-over-stderr. Before this recorder, EVERY fixture that exercised it
// was hand-typed from memory -- the tell-tale was
// `fatal: unable to access ... Could not resolve host: github.com`, whose
// `...` is a human's elision, not anything git has ever printed. A hand-typed
// corpus cannot catch the failure mode that actually matters: a git/dolt
// message REWORD that silently moves a real failure into a different bucket.
//
// So: this script PROVOKES each failure for real, against real git / real
// `bd dolt`, and records the verbatim combined stdout+stderr into
// ./vcs-stderr-corpus.json together with the exact command and the tool
// version that produced it. The tests then read the JSON. They never shell
// out, so the suite stays hermetic, fast and offline -- only re-recording
// needs git, dolt, bd and (for the auth samples) network.
//
// USAGE
//   node packages/apra-fleet-se/test/fixtures/vcs-stderr/record-vcs-stderr.mjs
//   node .../record-vcs-stderr.mjs --only=git        # skip the dolt/bd half
//   node .../record-vcs-stderr.mjs --print           # do not write, just dump
//
// It writes into an mktemp-style scratch dir under os.tmpdir() and removes it
// on the way out. It NEVER touches the repo it is run from: every `bd`
// invocation runs with cwd inside the scratch dir and its own --database.
//
// See ./README.md for the re-record checklist and what to do when a sample's
// expected kind changes.
//
// ASCII only.

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, 'vcs-stderr-corpus.json');

const argv = process.argv.slice(2);
const ONLY = (argv.find((a) => a.startsWith('--only=')) || '').slice('--only='.length);
const PRINT_ONLY = argv.includes('--print');

// ---------------------------------------------------------------------------
// tiny shell helpers
// ---------------------------------------------------------------------------

/** Run a command and return its combined stdout+stderr, trimmed of the
 *  trailing newline only. Never throws on a non-zero exit -- a non-zero exit
 *  is the entire point here. */
function capture(cmd, { cwd, env } = {}) {
    try {
        const out = execSync(cmd, {
            cwd,
            env: { ...process.env, ...(env || {}) },
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { exitCode: 0, text: stripTrailingNewline(out) };
    } catch (err) {
        const text = `${err.stdout || ''}${err.stderr || ''}`;
        return { exitCode: typeof err.status === 'number' ? err.status : 1, text: stripTrailingNewline(text) };
    }
}

function stripTrailingNewline(s) {
    return String(s == null ? '' : s).replace(/\n+$/, '');
}

/** Dolt's CLI paints an ANSI spinner ("- Pulling...\ Pulling...") into the
 *  same stream as the error. Production never sees it (the runner reads a
 *  captured buffer through bd, which does not re-emit the spinner), and it
 *  would make the fixture unreadable, so collapse repeated spinner frames.
 *  Nothing else about the text is altered. */
function stripSpinner(text) {
    return String(text)
        .replace(/(?:[-\\|/] [A-Za-z]+\.\.\.)+/g, '')
        .replace(/\r/g, '');
}

function quiet(cmd, opts) {
    capture(cmd, opts);
}

function toolVersion(bin, args) {
    try {
        return stripTrailingNewline(
            execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
        ).split('\n')[0];
    } catch {
        return null;
    }
}

function have(bin) {
    return toolVersion(bin, ['--version']) !== null || toolVersion(bin, ['version']) !== null;
}

// ---------------------------------------------------------------------------
// git samples -- all hermetic except the two auth ones, which need to reach
// github.com (a credential failure is not reproducible against a local repo:
// file:// transport never asks for credentials).
// ---------------------------------------------------------------------------

function recordGit(scratch, gitVersion) {
    const samples = [];
    const add = (id, expect, command, result, note) => {
        samples.push({
            id,
            tool: 'git',
            toolVersion: gitVersion,
            command,
            expect,
            exitCode: result.exitCode,
            stderr: result.text,
            ...(note ? { note } : {}),
        });
    };

    const root = path.join(scratch, 'git');
    fs.mkdirSync(root, { recursive: true });
    // Neutralize the host's global/system git config so a developer's own
    // credential helper, aliases or push.default cannot change the wording.
    const env = {
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_AUTHOR_NAME: 'corpus',
        GIT_AUTHOR_EMAIL: 'corpus@example.invalid',
        GIT_COMMITTER_NAME: 'corpus',
        GIT_COMMITTER_EMAIL: 'corpus@example.invalid',
    };
    const at = (cwd) => ({ cwd, env });

    // -- transient: DNS ------------------------------------------------------
    const badHost = 'no-such-host-apra-fleet-stderr-corpus.invalid';
    add(
        'git/transient/dns-could-not-resolve-host',
        'transient',
        `git ls-remote https://${badHost}/x.git`,
        capture(`git ls-remote https://${badHost}/x.git`, at(root)),
        'the sample the old hand-typed "unable to access ... Could not resolve host" fixture was guessing at',
    );

    // -- transient: refused connection (git:// on a closed port) -------------
    add(
        'git/transient/connection-refused',
        'transient',
        'git ls-remote git://127.0.0.1:9418/x.git',
        capture('git ls-remote git://127.0.0.1:9418/x.git', at(root)),
    );

    // -- a two-clone divergence scaffold ------------------------------------
    const remote = path.join(root, 'remote.git');
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    quiet(`git init -q --bare ${remote}`, at(root));
    quiet(`git clone -q ${remote} ${a}`, at(root));
    fs.writeFileSync(path.join(a, 'f.txt'), 'one\n');
    quiet('git add . && git commit -qm one && git branch -M main && git push -q -u origin main', at(a));
    quiet(`git clone -q ${remote} ${b}`, at(root));
    fs.appendFileSync(path.join(a, 'f.txt'), 'two-from-a\n');
    quiet('git add . && git commit -qm two-from-a && git push -q', at(a));
    fs.appendFileSync(path.join(b, 'f.txt'), 'two-from-b\n');
    quiet('git add . && git commit -qm two-from-b', at(b));

    // -- diverged: push rejected BEFORE the diverging fetch ------------------
    add(
        'git/diverged/push-rejected-fetch-first',
        'diverged',
        'git push   (local and remote diverged, remote tip not yet fetched)',
        capture('git push', at(b)),
        'git 2.50 says "(fetch first)", NOT "(non-fast-forward)" -- the diverged verdict survives only via "failed to push some refs" / "Updates were rejected"',
    );

    // -- diverged: push rejected AFTER the fetch (the classic wording) -------
    quiet('git fetch -q', at(b));
    add(
        'git/diverged/push-rejected-non-fast-forward',
        'diverged',
        'git push   (local and remote diverged, remote tip already fetched)',
        capture('git push', at(b)),
    );

    // -- diverged: --ff-only refuses -----------------------------------------
    add(
        'git/diverged/merge-ff-only-refused',
        'diverged',
        'git merge --ff-only origin/main   (histories diverged)',
        capture('git merge --ff-only origin/main', at(b)),
    );

    // -- diverged: a real content conflict -----------------------------------
    add(
        'git/diverged/merge-conflict',
        'diverged',
        'git merge origin/main   (both sides edited the same line)',
        capture('git merge origin/main', at(b)),
    );

    // -- diverged: pull refused while unmerged paths exist -------------------
    add(
        'git/diverged/pull-with-unmerged-files',
        'diverged',
        'git pull   (run while the working tree still has unmerged paths)',
        capture('git pull', at(b)),
    );
    quiet('git merge --abort', at(b));

    // -- transient: index.lock -----------------------------------------------
    const lock = path.join(b, '.git', 'index.lock');
    fs.writeFileSync(lock, '');
    add(
        'git/transient/index-lock-exists',
        'transient',
        'git add f.txt   (with a stale .git/index.lock present)',
        capture('git add f.txt', at(b)),
    );
    fs.rmSync(lock, { force: true });

    // -- transient: cannot lock ref (a ref/directory collision) --------------
    add(
        'git/transient/cannot-lock-ref',
        'transient',
        'git branch main/sub   (refs/heads/main already exists as a file)',
        capture('git branch main/sub', at(b)),
    );

    // -- unknown: real git errors that no bucket claims ----------------------
    add(
        'git/unknown/not-a-valid-object-name',
        'unknown',
        'git cat-file -p deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        capture('git cat-file -p deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', at(b)),
    );
    add(
        'git/unknown/pathspec-did-not-match',
        'unknown',
        'git checkout no-such-branch-in-this-repo',
        capture('git checkout no-such-branch-in-this-repo', at(b)),
    );

    // -- auth: needs network -------------------------------------------------
    const ghMissing = 'https://github.com/Apra-Labs/apra-fleet-stderr-corpus-no-such-repo.git';
    const authHttps = capture(`git ls-remote ${ghMissing}`, at(root));
    if (/could not read Username/i.test(authHttps.text)) {
        add(
            'git/auth/could-not-read-username-prompts-disabled',
            'auth',
            `GIT_TERMINAL_PROMPT=0, no credential helper: git ls-remote ${ghMissing}`,
            authHttps,
        );
    } else {
        warnSkipped('git/auth/could-not-read-username-prompts-disabled', authHttps.text);
    }

    const sshEnv = {
        ...env,
        GIT_SSH_COMMAND:
            'ssh -o IdentitiesOnly=yes -o IdentityFile=/dev/null -o StrictHostKeyChecking=no'
            + ' -o BatchMode=yes -o UserKnownHostsFile=/dev/null',
    };
    const authSsh = capture('git ls-remote git@github.com:Apra-Labs/apra-fleet.git', { cwd: root, env: sshEnv });
    if (/Permission denied \(publickey\)/i.test(authSsh.text)) {
        add(
            'git/auth/permission-denied-publickey',
            'auth',
            'git ls-remote git@github.com:Apra-Labs/apra-fleet.git   (GIT_SSH_COMMAND forces IdentityFile=/dev/null)',
            authSsh,
        );
    } else {
        warnSkipped('git/auth/permission-denied-publickey', authSsh.text);
    }

    return samples;
}

// ---------------------------------------------------------------------------
// dolt samples -- provoked through `bd dolt`, which is the ONLY way
// dolt-sync.mjs ever sees dolt output. Raw `dolt` CLI wording differs from the
// bd/SQL path (bd surfaces "Error 1105: ..." from dolt_pull()/dolt_push()),
// so recording the raw CLI here would be recording the wrong surface.
// ---------------------------------------------------------------------------

function recordDolt(scratch, versions) {
    const samples = [];
    const add = (id, expect, command, result, note) => {
        samples.push({
            id,
            tool: 'dolt',
            toolVersion: versions.dolt,
            bdVersion: versions.bd,
            command,
            expect,
            exitCode: result.exitCode,
            stderr: stripSpinner(result.text),
            ...(note ? { note } : {}),
        });
    };

    const root = path.join(scratch, 'dolt');
    fs.mkdirSync(root, { recursive: true });
    const env = {
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_AUTHOR_NAME: 'corpus',
        GIT_AUTHOR_EMAIL: 'corpus@example.invalid',
        GIT_COMMITTER_NAME: 'corpus',
        GIT_COMMITTER_EMAIL: 'corpus@example.invalid',
    };
    const at = (cwd) => ({ cwd, env });

    /** Stand up a throwaway beads project (its own prefix + database, so it
     *  cannot collide with the caller's clone or with the other one below). */
    const newBeadsProject = (name, prefix) => {
        const dir = path.join(root, name);
        fs.mkdirSync(dir, { recursive: true });
        quiet('git init -q .', at(dir));
        fs.writeFileSync(path.join(dir, 'seed.md'), `${name}\n`);
        quiet('git add . && git commit -qm init', at(dir));
        quiet(`bd init --prefix ${prefix} --database ${prefix}db`, at(dir));
        return dir;
    };

    const setRemote = (dir, url) => {
        quiet('bd dolt remote remove origin', at(dir));
        quiet(`bd dolt remote add origin ${url}`, at(dir));
    };

    const projA = newBeadsProject('projA', 'crpa');

    // -- no-remote: nothing configured at all --------------------------------
    add(
        'dolt/no-remote/pull-with-no-remote-configured',
        'no-remote',
        'bd dolt pull   (no Dolt remote configured)',
        capture('bd dolt pull', at(projA)),
    );

    // -- empty-remote: a real git remote with commits but no refs/dolt/data --
    const seeded = path.join(root, 'seeded-remote.git');
    const seedWt = path.join(root, 'seed-worktree');
    quiet(`git init -q --bare ${seeded}`, at(root));
    quiet(`git clone -q ${seeded} ${seedWt}`, at(root));
    fs.writeFileSync(path.join(seedWt, 'x'), 'x\n');
    quiet('git add . && git commit -qm init && git branch -M main && git push -q -u origin main', at(seedWt));
    setRemote(projA, `file://${seeded}`);
    add(
        'dolt/empty-remote/pull-git-remote-without-dolt-data',
        'empty-remote',
        'bd dolt pull   (remote is a git repo with commits but no refs/dolt/data)',
        capture('bd dolt pull', at(projA)),
    );

    // -- remote-unreachable: the remote path does not exist ------------------
    const missing = path.join(root, 'this-path-does-not-exist.git');
    setRemote(projA, `file://${missing}`);
    add(
        'dolt/remote-unreachable/push-to-nonexistent-path',
        'remote-unreachable',
        'bd dolt push   (remote file:// path does not exist)',
        capture('bd dolt push', at(projA)),
    );

    // -- transient: DNS and refused connection -------------------------------
    setRemote(projA, 'https://no-such-host-apra-fleet-stderr-corpus.invalid/x/y.git');
    add(
        'dolt/transient/dns-could-not-resolve-host',
        'transient',
        'bd dolt pull   (remote host does not resolve)',
        capture('bd dolt pull', at(projA)),
    );
    setRemote(projA, 'http://127.0.0.1:9/x/y.git');
    add(
        'dolt/transient/connection-refused',
        'transient',
        'bd dolt pull   (remote port closed)',
        capture('bd dolt pull', at(projA)),
    );

    // -- auth: needs network -------------------------------------------------
    const ghMissing = 'https://github.com/Apra-Labs/apra-fleet-stderr-corpus-no-such-repo.git';
    setRemote(projA, ghMissing);
    const auth = capture('bd dolt pull', at(projA));
    if (/could not read Username/i.test(auth.text)) {
        add(
            'dolt/auth/could-not-read-username-prompts-disabled',
            'auth',
            `GIT_TERMINAL_PROMPT=0, no credential helper: bd dolt pull against ${ghMissing}`,
            auth,
        );
    } else {
        warnSkipped('dolt/auth/could-not-read-username-prompts-disabled', auth.text);
    }

    // -- unknown: a real bd/dolt error no bucket claims ----------------------
    add(
        'dolt/unknown/unknown-remote-name',
        'unknown',
        'bd dolt remote remove no-such-remote',
        capture('bd dolt remote remove no-such-remote', at(projA)),
    );

    // -- diverged: two clones with independent Dolt histories ----------------
    const divRemote = path.join(root, 'div-remote.git');
    const divSeed = path.join(root, 'div-seed');
    quiet(`git init -q --bare ${divRemote}`, at(root));
    quiet(`git clone -q ${divRemote} ${divSeed}`, at(root));
    fs.writeFileSync(path.join(divSeed, 'x'), 'x\n');
    quiet('git add . && git commit -qm init && git branch -M main && git push -q -u origin main', at(divSeed));

    const projB = newBeadsProject('projB', 'crpb');
    setRemote(projA, `file://${divRemote}`);
    setRemote(projB, `file://${divRemote}`);
    quiet('bd create "seed from A" -t task', at(projA));
    quiet('bd dolt commit -m seed-a', at(projA));
    quiet('bd dolt push', at(projA));
    quiet('bd create "seed from B" -t task', at(projB));
    quiet('bd dolt commit -m seed-b', at(projB));
    add(
        'dolt/diverged/push-no-common-ancestor',
        'diverged',
        'bd dolt push   (two clones with independent Dolt histories, remote already advanced)',
        capture('bd dolt push', at(projB)),
        'the "have diverged" token that earns the diverged verdict is on the FOURTH line -- truncating this output to its first line flips the verdict to unknown',
    );

    return samples;
}

const skipped = [];
function warnSkipped(id, text) {
    skipped.push(id);
    process.stderr.write(
        `[record-vcs-stderr] SKIPPED ${id}: the provoking command did not produce the expected failure.\n`
        + `  Got: ${JSON.stringify(String(text).slice(0, 300))}\n`
        + '  This sample needs network access and no ambient git credential helper.\n',
    );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
    const gitVersion = toolVersion('git', ['--version']);
    if (!gitVersion) throw new Error('record-vcs-stderr: git is required.');
    const doltVersion = toolVersion('dolt', ['version']);
    const bdVersion = toolVersion('bd', ['version']);

    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vcs-stderr-corpus-'));
    let samples = [];
    try {
        if (ONLY !== 'dolt') samples = samples.concat(recordGit(scratch, gitVersion));
        if (ONLY !== 'git') {
            if (!doltVersion || !bdVersion || !have('bd')) {
                process.stderr.write('[record-vcs-stderr] dolt and/or bd not on PATH -- skipping the dolt half.\n');
            } else {
                samples = samples.concat(recordDolt(scratch, { dolt: doltVersion, bd: bdVersion }));
            }
        }
    } finally {
        try {
            fs.rmSync(scratch, { recursive: true, force: true });
        } catch {
            /* best effort */
        }
    }

    const corpus = {
        _comment:
            'RECORDED, NOT HAND-WRITTEN. Every `stderr` below is verbatim combined stdout+stderr from the'
            + ' `command` beside it, produced by the recorded tool version. Re-record with'
            + ' `node packages/apra-fleet-se/test/fixtures/vcs-stderr/record-vcs-stderr.mjs`; see ./README.md.'
            + ' Do NOT edit a `stderr` value by hand -- a hand-edited sample is exactly the defect this corpus'
            + ' was created to remove.',
        recordedAt: new Date().toISOString().slice(0, 10),
        recordedOn: `${process.platform} ${process.arch}`,
        tools: { git: gitVersion, dolt: doltVersion, bd: bdVersion },
        samples,
    };

    const json = `${JSON.stringify(corpus, null, 2)}\n`;
    if (PRINT_ONLY) {
        process.stdout.write(json);
    } else {
        fs.writeFileSync(OUT_PATH, json);
        process.stdout.write(`[record-vcs-stderr] wrote ${samples.length} samples to ${OUT_PATH}\n`);
    }
    if (skipped.length) {
        process.stderr.write(`[record-vcs-stderr] ${skipped.length} sample(s) skipped: ${skipped.join(', ')}\n`);
        process.exitCode = 2;
    }
}

main();
