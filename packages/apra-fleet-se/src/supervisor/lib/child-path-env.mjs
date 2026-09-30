// Case-correct search-path manipulation for a SPAWNED CHILD's environment
// (apra-fleet-i9ag.19.32).
//
// WHY THIS EXISTS: `{ ...process.env }` (or `{ ...deps.env }`) produces a
// PLAIN object. On Windows that spread throws away the case-INSENSITIVE
// lookup `process.env` itself provides, and the OS spells the variable
// `Path`, not `PATH`. So the obvious shape
//
//     const env = { ...process.env };
//     env.PATH = `${shimDir}${path.delimiter}${env.PATH ?? ''}`;
//
// reads `env.PATH` as undefined on Windows and hands the child a search path
// holding ONLY `shimDir` -- every real entry is dropped. The failure that
// causes is badly disguised: whatever the shim provides still resolves, so
// only the OTHER tools the child shells out to go missing, and the child
// reports their absence in its own vocabulary.
//
// That is exactly how test/supervisor-project-round-trip.test.mjs failed on
// windows-latest while passing on macOS/ubuntu: its `bd` shim kept
// answering (cmd.exe found bd.cmd in the shim dir), `git` did not (the
// identity probe runs it through a shell-less execFile), and POST
// /api/project refused the fixture's project folder with "a git 'origin'
// remote is missing" -- a correct product answer to a destroyed PATH.
//
// PRODUCTION USE (apra-fleet-i9ag.19.32): src/supervisor/spawner.mjs's
// spawnSprint() uses prependToPathEnv() below to put the recorded node's
// directory on the sprint child's own search path -- the child-env half of
// the same defect exec-bd.mjs (apra-fleet-i9ag.19.7) fixes for the
// supervisor's own `bd` invocations. A service started by launchd or a
// Windows task does not inherit the login PATH, so the sprint child's first
// `bd` call (an npm `'#!/usr/bin/env node'` script) dies with
// `env: node: No such file or directory` (exit 127) unless the recorded
// node's directory is already on the search path this child inherits.
//
// This module lives in src/ (not test/helpers/) specifically so production
// code can depend on it: test/helpers/child-path-env.mjs re-exports from
// here rather than duplicating the logic, so test and production code share
// exactly one implementation of the case-correct PATH-key lookup.
//
// ASCII only.

import path from 'node:path';

/**
 * The key `env` actually spells its search path under, whatever the case
 * ('Path' on Windows, 'PATH' on POSIX). Returns 'PATH' when the env carries
 * no search path at all, so a caller can still seed one.
 * @param {Record<string, string|undefined>} env
 * @returns {string}
 */
export function pathEnvKey(env) {
    for (const key of Object.keys(env)) {
        if (key.toLowerCase() === 'path') return key;
    }
    return 'PATH';
}

/**
 * Prepend `dir` to `env`'s search path IN PLACE, under whatever case that
 * env already uses, preserving every existing entry. Returns the same object
 * for convenience.
 * @param {Record<string, string|undefined>} env
 * @param {string} dir
 * @param {string} [delimiter] - injectable so a POSIX host can exercise the Windows shape.
 * @returns {Record<string, string|undefined>}
 */
export function prependToPathEnv(env, dir, delimiter = path.delimiter) {
    const key = pathEnvKey(env);
    const existing = env[key];
    env[key] = existing ? `${dir}${delimiter}${existing}` : dir;
    return env;
}
