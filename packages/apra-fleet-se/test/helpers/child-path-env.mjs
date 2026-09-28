// Case-correct search-path manipulation for a SPAWNED CHILD's environment.
//
// WHY THIS EXISTS: `{ ...process.env }` produces a PLAIN object. On Windows
// that spread throws away the case-INSENSITIVE lookup `process.env` itself
// provides, and the OS spells the variable `Path`, not `PATH`. So the
// obvious shape
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
