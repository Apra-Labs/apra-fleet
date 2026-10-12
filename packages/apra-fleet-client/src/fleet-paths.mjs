// =============================================================================
// Fleet-owned path resolver -- the ONE place every per-instance fleet path is
// derived from APRA_FLEET_DATA_DIR (apra-fleet-q1ku).
//
// Consumers: src/paths.ts (re-exports these for the TypeScript server),
// src/services/jwt.ts (fleet.key signer), src/cli/config.ts (install-config),
// src/cli/install.ts + src/tools/code-intelligence*.ts (code-intelligence
// config/usage), ./auth/local-token.mjs (fleet.key reader for the supervisor
// and console) and packages/apra-fleet-se/src/supervisor/id-allocator.mjs
// (supervisor child-id allocator dir). Plain .mjs so both the TS server and
// the JS packages import the same code -- a second copy of these rules is
// exactly how jwt.ts (signer) and local-token.mjs (reader) could drift apart
// and break supervisor/console auth.
//
// LAYOUT
//
//   APRA_FLEET_DATA_DIR unset (the default instance) -- byte-identical to the
//   pre-resolver paths, no migration:
//     data dir            ~/.apra-fleet/data
//     fleet.key           ~/.apra-fleet/fleet.key
//     supervisor dir      ~/.apra-fleet/supervisor
//     install-config      ~/.apra-fleet/data/install-config.json
//     code-intelligence   ~/.apra-fleet/data/code-intelligence
//
//   APRA_FLEET_DATA_DIR=<D> (a non-default instance) -- everything lives
//   INSIDE <D>, never beside it, so the instance is self-contained and never
//   writes to the real home or to <D>'s parent (which may be a shared dir
//   such as the system temp dir):
//     data dir            <D>
//     fleet.key           <D>/fleet.key
//     supervisor dir      <D>/supervisor
//     install-config      <D>/install-config.json
//     code-intelligence   <D>/code-intelligence
//
//   An empty APRA_FLEET_DATA_DIR counts as unset (same rule as
//   src/paths.ts isNonDefaultInstance()). So does an APRA_FLEET_DATA_DIR that
//   names the default data dir itself (~/.apra-fleet/data): that IS the
//   default instance spelled explicitly, so fleet.key and the supervisor dir
//   stay at ~/.apra-fleet/{fleet.key,supervisor} rather than moving inside
//   data/ (tests/helpers/isolated-home.mjs sets exactly this layout).
//
// Every function is LAZY: it reads `env` (default process.env) and the home
// directory at call time, never at module load, so a test that sets
// APRA_FLEET_DATA_DIR / HOME after this module was first imported still gets
// the right answer.
//
// `opts.home` is a test seam (local-token.mjs readLocalToken({ home })): an
// explicit home roots the DEFAULT layout at that directory and takes
// precedence over APRA_FLEET_DATA_DIR, because a caller naming a home is
// asking for "the default instance of that home". Production never passes it.
// =============================================================================

import os from 'node:os';
import path from 'node:path';

/** Directory under the home dir that holds the default instance. */
export const FLEET_HOME_DIRNAME = '.apra-fleet';

/** Filename of the fleet JWT signing key / shared local credential. */
export const FLEET_KEY_FILENAME = 'fleet.key';

/**
 * The APRA_FLEET_DATA_DIR override, or null when unset/empty.
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|null}
 */
export function dataDirOverride(env = process.env) {
    const raw = env.APRA_FLEET_DATA_DIR;
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * @param {{ home?: string }} [opts]
 * @returns {string} the home directory the default layout is rooted at
 */
function homeOf(opts) {
    return typeof opts?.home === 'string' && opts.home.length > 0 ? opts.home : os.homedir();
}

/** Comparable form of a path (case-folded on win32, whose paths are case-insensitive). */
function comparable(p) {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * The override that actually relocates the instance: null when there is no
 * override, when `opts.home` is given (test seam), or when the override names
 * the default data dir itself.
 * @param {Record<string, string|undefined>} env
 * @param {{ home?: string }} opts
 * @returns {string|null}
 */
function effectiveOverride(env, opts) {
    if (opts?.home) return null;
    const override = dataDirOverride(env);
    if (override === null) return null;
    const home = homeOf(opts);
    if (home && comparable(override) === comparable(path.join(home, FLEET_HOME_DIRNAME, 'data'))) return null;
    return override;
}

/**
 * The per-instance root that holds fleet.key and the supervisor dir: <D> for
 * a non-default instance, ~/.apra-fleet for the default one.
 * @param {Record<string, string|undefined>} [env]
 * @param {{ home?: string }} [opts]
 * @returns {string}
 */
function instanceRoot(env = process.env, opts = {}) {
    const override = effectiveOverride(env, opts);
    return override ?? path.join(homeOf(opts), FLEET_HOME_DIRNAME);
}

/**
 * Fleet data dir (registry, server.json, logs, install-config, ...).
 * @param {Record<string, string|undefined>} [env]
 * @param {{ home?: string }} [opts]
 * @returns {string}
 */
export function fleetDataDir(env = process.env, opts = {}) {
    const override = opts.home ? null : dataDirOverride(env);
    return override ?? path.join(homeOf(opts), FLEET_HOME_DIRNAME, 'data');
}

/**
 * fleet.key: the JWT signing key src/services/jwt.ts mints and the shared
 * local credential local-token.mjs reads. Signer and readers MUST call this.
 * @param {Record<string, string|undefined>} [env]
 * @param {{ home?: string }} [opts]
 * @returns {string}
 */
export function fleetKeyPath(env = process.env, opts = {}) {
    return path.join(instanceRoot(env, opts), FLEET_KEY_FILENAME);
}

/**
 * Default directory of the fleet-sprint supervisor's global child-id
 * allocator (packages/apra-fleet-se/src/supervisor/id-allocator.mjs).
 * @param {Record<string, string|undefined>} [env]
 * @param {{ home?: string }} [opts]
 * @returns {string}
 */
export function supervisorIdDir(env = process.env, opts = {}) {
    const override = effectiveOverride(env, opts);
    if (override) return path.join(override, 'supervisor');
    // `|| os.tmpdir()`: preserved from id-allocator.mjs's original default
    // for a process with no resolvable home.
    const home = homeOf(opts) || os.tmpdir();
    return path.join(home, FLEET_HOME_DIRNAME, 'supervisor');
}

/**
 * install-config.json (written by `apra-fleet install`).
 * @param {Record<string, string|undefined>} [env]
 * @param {{ home?: string }} [opts]
 * @returns {string}
 */
export function installConfigPath(env = process.env, opts = {}) {
    return path.join(fleetDataDir(env, opts), 'install-config.json');
}

/**
 * Code-intelligence config/usage dir (config.json, usage.jsonl).
 * @param {Record<string, string|undefined>} [env]
 * @param {{ home?: string }} [opts]
 * @returns {string}
 */
export function codeIntelligenceDir(env = process.env, opts = {}) {
    return path.join(fleetDataDir(env, opts), 'code-intelligence');
}
