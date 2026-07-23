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

import { execFileSync } from 'node:child_process';
import { rmSync, existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
    const out = { prefix: 'gh-toy' };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--sandbox-root') out.sandboxRoot = argv[++i];
        else if (argv[i] === '--toy-repo') out.toyRepo = argv[++i];
        else if (argv[i] === '--prefix') out.prefix = argv[++i];
        else throw new Error(`${GUARD} unknown argument: ${argv[i]}`);
    }
    return out;
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
    rmSync(remote, { recursive: true, force: true });

    const remoteUrl = pathToFileURL(remote).href;
    execFileSync('bd', ['init', '--from-jsonl', `--prefix`, args.prefix, '--remote', remoteUrl, '--non-interactive'], {
        cwd: repo,
        stdio: 'inherit',
    });
    execFileSync('bd', ['dolt', 'push'], { cwd: repo, stdio: 'inherit' });
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
