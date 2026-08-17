#!/usr/bin/env node
// Guarded sandbox beads seeding (run-24 abort root cause).
//
// The smoke-test playbook's Setup used to inline the beads seed steps
// (`bd init --from-jsonl --remote file://...` + `bd dolt push`) as raw shell.
// Run outside strict sandbox env pinning, those steps rewired the HOST
// repo's beads sync remote to a sandbox-local path; when the sandbox was
// later deleted, the host repo's next D-push/D-pull bracket crashed and
// aborted the whole sprint.
//
// This script is now the ONLY sanctioned entry point for that seed step.
// It refuses to mutate anything unless every touched path provably lives
// inside the sandbox root, and the sandbox root is disjoint from the repo
// this script itself lives in (the host product repo). Isolation is
// enforced by path checks, not by trusting the caller's environment.
//
// Usage:
//   node scripts/sandbox-seed-beads.mjs --sandbox-root <dir> --toy-repo <dir> [--prefix gh-toy]
//
// Effects (all inside the sandbox root, all previously inline in the playbook):
//   rm -rf <toy-repo>/.beads/embeddeddolt <toy-repo>/.beads/.local_version
//   rm -rf <sandbox-root>/.apra-fleet-toy-dolt-remote
//   bd init --from-jsonl --prefix <prefix> --remote file://<dolt-remote> --non-interactive   (cwd: toy repo)
//   bd dolt push                                                                             (cwd: toy repo)

import { rmSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execBdSync } from './lib/exec-bd.mjs';

const GUARD = '[sandbox-seed guard]';

function realOrIntended(p) {
    // Resolve symlinks when the path exists; otherwise normalize the intended
    // absolute path (e.g. the dolt-remote dir that is about to be created).
    const abs = path.resolve(p);
    try {
        return realpathSync(abs);
    } catch {
        return abs;
    }
}

function isInside(child, parent) {
    const rel = path.relative(parent, child);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Validate every path this seed step will touch. Throws with a named guard
 * error on any violation; returns the resolved paths on success. Pure with
 * respect to mutation -- safe to unit test with arbitrary paths.
 */
export function validateSandboxSeedPaths({ sandboxRoot, toyRepo, doltRemote, hostRepoRoot }) {
    if (!sandboxRoot || !toyRepo || !hostRepoRoot) {
        throw new Error(`${GUARD} sandboxRoot, toyRepo, and hostRepoRoot are all required`);
    }
    const root = realOrIntended(sandboxRoot);
    const repo = realOrIntended(toyRepo);
    const host = realOrIntended(hostRepoRoot);
    const remote = realOrIntended(doltRemote ?? path.join(root, '.apra-fleet-toy-dolt-remote'));

    if (!isInside(repo, root)) {
        throw new Error(`${GUARD} refusing: toy repo '${repo}' is not inside the sandbox root '${root}'`);
    }
    if (!isInside(remote, root)) {
        throw new Error(`${GUARD} refusing: dolt remote '${remote}' is not inside the sandbox root '${root}'`);
    }
    if (host === root || isInside(host, root) || isInside(root, host)) {
        throw new Error(`${GUARD} refusing: sandbox root '${root}' overlaps the host repo '${host}' -- the sandbox must be a disjoint directory tree`);
    }
    if (repo === host || isInside(repo, host)) {
        throw new Error(`${GUARD} refusing: toy repo '${repo}' overlaps the host repo '${host}'`);
    }
    return { root, repo, host, remote };
}

function parseArgs(argv) {
    const out = { prefix: 'gh-toy', mode: 'setup' };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--sandbox-root') out.sandboxRoot = argv[++i];
        else if (argv[i] === '--toy-repo') out.toyRepo = argv[++i];
        else if (argv[i] === '--prefix') out.prefix = argv[++i];
        else if (argv[i] === '--mode') out.mode = argv[++i];
        else throw new Error(`${GUARD} unknown argument: ${argv[i]}`);
    }
    if (out.mode !== 'setup' && out.mode !== 'reset') {
        throw new Error(`${GUARD} --mode must be 'setup' or 'reset' (got '${out.mode}')`);
    }
    return out;
}

// bd's dolt-remote-history probe runs a `git` command against `remote`
// (a directory this script just created via mkdirSync moments earlier), and
// on a resource-constrained CI runner that probe has been observed to return
// a non-zero exit under I/O latency; bd conservatively treats a failed probe
// as "assume history exists" and refuses `--from-jsonl` init entirely
// (observed message: "bd init refuses: remote 'origin' already has Dolt
// history (refs/dolt/data)"), even though we know deterministically the
// directory is empty -- we created it ourselves synchronously just above.
// Retrying is therefore safe (not error-masking): a real "actually has
// history" refusal is not something a retry could produce, since nothing
// else writes to this sandbox-local directory between attempts.
function initFromJsonlWithRetry(repo, prefix, remoteUrl, attempts = 3, delayMs = 500) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            execBdSync(['init', '--from-jsonl', '--prefix', prefix, '--remote', remoteUrl, '--non-interactive'], {
                cwd: repo,
                stdio: 'inherit',
                shell: true,
            });
            return;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const isProbeRaceRefusal = /already has Dolt history/.test(message);
            if (!isProbeRaceRefusal || attempt === attempts) {
                throw err;
            }
            console.warn(`[sandbox-seed] bd init dolt-remote-history probe raced a fresh directory (attempt ${attempt}/${attempts}), retrying in ${delayMs}ms...`);
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
        }
    }
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const hostRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const { repo, remote } = validateSandboxSeedPaths({
        sandboxRoot: args.sandboxRoot,
        toyRepo: args.toyRepo,
        doltRemote: undefined,
        hostRepoRoot,
    });
    if (!existsSync(repo)) {
        throw new Error(`${GUARD} toy repo '${repo}' does not exist`);
    }

    rmSync(path.join(repo, '.beads', 'embeddeddolt'), { recursive: true, force: true });
    rmSync(path.join(repo, '.beads', '.local_version'), { force: true });

    if (args.mode === 'reset') {
        // Reset re-seed: bd auto-derives its Dolt remote from the toy clone's
        // own git origin (already sandbox-local, asserted by the playbook's
        // check script). No explicit remote is written and nothing is pushed.
        execBdSync(['init', '--from-jsonl', '--prefix', args.prefix, '--non-interactive'], {
            cwd: repo,
            stdio: 'inherit',
            shell: true,
        });
        console.log(`[sandbox-seed] OK (reset): re-seeded '${repo}' from its committed JSONL (no remote rewiring)`);
        return;
    }

    rmSync(remote, { recursive: true, force: true });
    // Re-resolve `remote` off a freshly-created, now-existing directory
    // rather than trusting the `remote` value validateSandboxSeedPaths()
    // returned above. That earlier value went through realOrIntended() while
    // the dolt-remote dir did not exist yet, so its realpathSync() call threw
    // and it fell back to a bare path.resolve() -- pure string concatenation
    // with NO OS-level canonicalization. `root`/`repo` above, by contrast,
    // already existed at that point and DID get OS-canonicalized. On a host
    // whose TEMP/TMP resolves through a short (8.3-alias) path component --
    // e.g. GitHub Actions' Windows runners, where %TEMP% is literally
    // 'C:\Users\RUNNER~1\AppData\Local\Temp' while the real profile dir is
    // '...\runneradmin\...' -- that means `remote`'s uncanonicalized fallback
    // path and `repo`'s canonicalized one silently disagree on which alias to
    // use for the same shared ancestor directory. `pathToFileURL(remote)`
    // then bakes the short alias (percent-encoded '~' and all) into the Dolt
    // remote URL bd is told to push to; Dolt's embedded engine's own
    // GetFileAttributesEx call on that literal short-alias path then fails to
    // find it (observed failure: 'Error 1105: failed to get remote db ...
    // GetFileAttributesEx C:\Users\RUNNER~1\...: The system cannot find the
    // file specified', windows-latest only -- ubuntu/macos have no such
    // short/long alias split so this never reproduced there). Creating the
    // directory first and re-resolving through realpathSync (the same code
    // path `root`/`repo` used) makes `remote` canonicalize the same way as
    // everything else under `root`, closing the mismatch.
    mkdirSync(remote, { recursive: true });
    const resolvedRemote = realpathSync(remote);
    const remoteUrl = pathToFileURL(resolvedRemote).href;
    initFromJsonlWithRetry(repo, args.prefix, remoteUrl);
    execBdSync(['dolt', 'push'], { cwd: repo, stdio: 'inherit' });
    console.log(`[sandbox-seed] OK: seeded '${repo}' with sync.remote '${remoteUrl}' (all paths inside the sandbox root)`);
}

const invokedDirectly = process.argv[1]
    && realOrIntended(process.argv[1]) === realOrIntended(fileURLToPath(import.meta.url));
if (invokedDirectly) {
    try {
        main();
    } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
    }
}
