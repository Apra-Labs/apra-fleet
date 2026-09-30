// Case-correct search-path manipulation for a SPAWNED CHILD's environment.
//
// apra-fleet-i9ag.19.32: this used to be the sole implementation, duplicated
// nowhere else. spawner.mjs's spawnSprint() now needs the same case-correct
// PATH-key logic in PRODUCTION code (to put the recorded node's directory on
// the sprint child's search path), and production code must never import
// from test/helpers -- so the implementation moved to
// src/supervisor/lib/child-path-env.mjs and this file re-exports it, keeping
// exactly one implementation for both test and production callers. See that
// module's doc comment for the full "why this exists" (the Windows
// `Path`-vs-`PATH` case trap) and the windows-latest regression it fixes.
//
// ASCII only.

import assert from 'node:assert/strict';
import path from 'node:path';

import { pathEnvKey, prependToPathEnv } from '../../src/supervisor/lib/child-path-env.mjs';

export { pathEnvKey, prependToPathEnv };

/**
 * apra-fleet-i9ag.19.43: the recurring trap this helper exists to close.
 * A test that hard-codes the search-path key as the literal `'PATH'` and
 * splits its value on the HOST's own `path.delimiter` is silently wrong on a
 * windows-latest CI runner in two independent ways: (1) `process.env`
 * spells the key `Path` there, so a spread-and-overwrite of a `PATH` literal
 * adds a SECOND, differently-cased key instead of updating the one the
 * composition under test actually wrote (production always goes through
 * `pathEnvKey()`, see that module's own doc comment for the windows-latest
 * regression this protects); and (2) a POSIX-only composition (like
 * toolchain.mjs's `withNodeFirstBdExec()`) may pass `path.posix.delimiter`
 * EXPLICITLY regardless of host platform, so the host's own `path.delimiter`
 * (';' on win32) does not match what was actually written even once the key
 * case is fixed. This helper checks the search-path entry case-correctly
 * via `pathEnvKey()` and splits on the delimiter the implementation under
 * test actually used (injectable, defaulting to `path.posix.delimiter` to
 * match this repo's only current caller), so one assertion is correct on
 * all three CI platforms rather than needing a per-test `win32` skip.
 *
 * @param {{env?: Record<string, string|undefined>}} options - the options
 *   object a captured/injected exec call received.
 * @param {{
 *   dir: string,
 *   baseEnv?: Record<string, string|undefined>,
 *   delimiter?: string,
 * }} expected - `dir` is the directory expected to be prepended;
 *   `baseEnv` is the env the composition started from (defaults to the
 *   current `process.env`); `delimiter` is the delimiter the composition
 *   under test actually joined entries with (defaults to
 *   `path.posix.delimiter`).
 */
export function assertPrependedPathEnv(options, { dir, baseEnv = process.env, delimiter = path.posix.delimiter }) {
    assert.ok(options && typeof options === 'object' && options.env, 'expected the captured exec options to carry a composed env');
    const key = pathEnvKey(baseEnv);
    assert.equal(
        pathEnvKey(options.env),
        key,
        `composed env must reuse baseEnv's own search-path key ('${key}'), never introduce a differently-cased one`,
    );
    const actualValue = options.env[key];
    assert.equal(typeof actualValue, 'string', `expected a string search-path entry under key '${key}'`);
    const [firstEntry, ...rest] = actualValue.split(delimiter);
    assert.equal(firstEntry, dir, `expected '${dir}' prepended as the first search-path entry under key '${key}'`);
    assert.equal(
        rest.join(delimiter),
        baseEnv[key] ?? '',
        'the rest of the search path must be the base env\'s own value, carried through unchanged',
    );

    const expectedEnv = { ...baseEnv, [key]: actualValue };
    assert.deepEqual(
        options.env,
        expectedEnv,
        'composed env must be exactly baseEnv with only the search-path entry replaced -- no other keys added, removed, or changed',
    );
}
