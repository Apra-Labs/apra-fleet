// =============================================================================
// Auto-sprint supervisor -- explicit sprint-runner (Node.js) resolver
// (apra-fleet-i9ag.15.1)
// =============================================================================
//
// PROBLEM: createSpawner() (spawner.mjs) launches every sprint as
// spawn(command, [cliPath, ...args]) where `command` defaults to
// process.execPath. Under a plain `node bin/serve.mjs` supervisor that
// default IS node, so it works. But when the supervisor runs as the
// installed single-executable binary (src/cli/supervisor.ts, running on the
// embedded Node runtime), process.execPath is the apra-fleet binary itself,
// NOT node -- so the child is invoked as `apra-fleet.exe <...>/bin/cli.mjs`
// and dies instantly with "unknown option <path>". Falling back to
// process.execPath when it is not a real Node runtime IS that bug.
//
// This module owns resolving WHICH Node.js binary a sprint child should be
// spawned with -- wiring the result into spawner.mjs is the next task
// (apra-fleet-i9ag.15.2), deliberately kept separate so this resolver is
// independently testable.
//
// RESOLUTION ORDER (fixed, apra-fleet-i9ag.19.5 inserts CONFIGURED as tier 2):
//   1. `FLEET_SE_NODE` env override -- an explicit operator escape hatch.
//      Probed with `--version`; a SET-BUT-UNUSABLE override is a HARD ERROR
//      (never a silent fall-through to the next tier -- the operator asked
//      for THIS interpreter by name).
//   2. `configuredNodePath` -- the absolute node path the installer recorded
//      into supervisor.config.json's toolchain block (read and validated by
//      the caller, injected here so this resolver stays synchronous and
//      filesystem-free). This is what makes a launchd/Windows-service
//      supervisor -- whose PATH the login shell never populates, and whose
//      own execPath is the apra-fleet SEA binary, not node -- able to launch
//      a sprint at all. Probed with `--version` and gated at >=
//      MIN_NODE_VERSION exactly like the PATH tier; a SET-BUT-UNUSABLE
//      configured path is a HARD ERROR for the same reason the override is:
//      a skipped check is indistinguishable from a passed one, and this tier
//      MUST beat current-runtime and PATH so a service with no usable PATH
//      never silently falls through to a PATH lookup that cannot succeed.
//   3. The current process's own execPath -- but ONLY when this process is a
//      real Node.js runtime, i.e. NOT a single-executable app (node:sea's
//      isSea() === false). This preserves today's behaviour for a plain
//      `node bin/serve.mjs` supervisor.
//   4. `node` resolved from PATH, gated at >= MIN_NODE_VERSION.
//   Otherwise: throw a SprintRunnerResolutionError naming every candidate
//   tried, the resolved-but-too-old version when that is the reason, and the
//   operator fix line.
//
// Everything environment-shaped is injectable with real defaults (env, exec,
// execPath, isSea, platform) -- the same injected-exec/injected-platform
// convention already used by src/cli/fleet-se-prereqs.ts (core, not
// importable here -- see MIN_NODE_VERSION's doc comment below) -- so every
// branch is exercisable from any host without touching the real filesystem/
// PATH/environment.
//
// NOTHING in this file imports from outside packages/apra-fleet-se: fleet-se
// ships as a standalone npm package with no dependency on the core apra-fleet
// TypeScript source tree.
// =============================================================================

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { probeVersion as sharedProbeVersion, compareVersions } from './node-version.mjs';

const require = createRequire(import.meta.url);

/**
 * Minimum Node.js version fleet-se requires (major.minor.patch).
 *
 * CANONICAL DEFINITION: src/cli/fleet-se-prereqs.ts's own `MIN_NODE_VERSION`
 * (apra-fleet-i9ag.13.7.1) is the single source of truth for this
 * requirement across the whole repo. This module cannot import that
 * TypeScript constant directly (fleet-se ships as a standalone package with
 * no dependency on core's source tree, see the file-level doc comment
 * above), so the value is duplicated here deliberately. Keep both literals
 * in sync by hand.
 */
export const MIN_NODE_VERSION = '22.16.0';

/** 'major.minor' slice of MIN_NODE_VERSION, e.g. '22.16', for fix-line text. */
const MIN_NODE_MAJOR_MINOR = MIN_NODE_VERSION.split('.').slice(0, 2).join('.');

/**
 * Wall-clock ceiling for a single `--version` probe (mirrors
 * src/cli/fleet-se-prereqs.ts's PREREQ_PROBE_TIMEOUT_MS): a probe that never
 * returns -- a wedged interpreter, a broken shim, a network-mounted PATH
 * entry that hangs -- must never hang a sprint launch indefinitely.
 */
export const SPRINT_RUNNER_PROBE_TIMEOUT_MS = 15_000;

/** Exact operator-facing fix line this module's resolution error carries. */
export const SPRINT_RUNNER_FIX_LINE =
    `Install Node.js ${MIN_NODE_MAJOR_MINOR}+ and ensure 'node' resolves on PATH, ` +
    'or set FLEET_SE_NODE to an explicit Node.js binary to launch sprints with.';

/** Discriminates which tier resolveSprintRunnerCommand()'s result came from. */
export const SPRINT_RUNNER_SOURCE = Object.freeze({
    /** Tier 1: the FLEET_SE_NODE env override. */
    OVERRIDE: 'FLEET_SE_NODE',
    /** Tier 2 (apra-fleet-i9ag.19.5): the recorded toolchain's node path. */
    CONFIGURED: 'configured',
    /** Tier 3: this process's own execPath (a real Node.js runtime, not a SEA binary). */
    CURRENT_RUNTIME: 'current-runtime',
    /** Tier 4: `node` resolved from PATH. */
    PATH: 'path',
});

/**
 * Thrown when resolveSprintRunnerCommand() cannot find any usable Node.js
 * runtime to spawn a sprint's fleet-sprint CLI child process with. Exported
 * (with a discriminating `isSprintRunnerResolutionError` own-property, in
 * addition to being `instanceof`-checkable) so a caller -- apra-fleet-i9ag.15.2's
 * spawner wiring -- can recognise a resolution failure specifically, e.g. to
 * answer POST /api/sprints with a 503 and this error's own operator-facing
 * message, rather than the launch dying with an opaque spawn ENOENT/exit
 * failure downstream.
 */
export class SprintRunnerResolutionError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SprintRunnerResolutionError';
        this.isSprintRunnerResolutionError = true;
    }
}

function defaultExec(file, args, options = {}) {
    return String(execFileSync(file, args, { encoding: 'utf-8', stdio: 'pipe', ...options }));
}

/**
 * Real node:sea probe. Lazily required (via createRequire, this file is ESM)
 * and defensively wrapped: node:sea is a recent addition, and a host running
 * some other unexpected Node.js build should be treated as "not a SEA
 * binary" (the safer default -- it preserves today's execPath behaviour)
 * rather than crashing resolution entirely.
 */
function defaultIsSea() {
    try {
        const sea = require('node:sea');
        return typeof sea.isSea === 'function' && sea.isSea();
    } catch {
        return false;
    }
}

/**
 * Resolves the Node.js command line the supervisor should spawn a sprint's
 * fleet-sprint CLI child process with. See the file-level doc comment above
 * for the fixed 4-tier resolution order and rationale.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   execPath?: string,
 *   isSea?: () => boolean,
 *   exec?: (file: string, args: string[], options?: object) => string|Buffer,
 *   platform?: NodeJS.Platform,
 *   configuredNodePath?: string,
 * }} [deps]
 * @returns {{ command: string, source: string, version: string }}
 * @throws {SprintRunnerResolutionError} when no tier resolves to a usable Node.js runtime
 */
export function resolveSprintRunnerCommand(deps = {}) {
    const env = deps.env ?? process.env;
    const execPath = deps.execPath ?? process.execPath;
    const isSea = deps.isSea ?? defaultIsSea;
    const exec = deps.exec ?? defaultExec;
    const platform = deps.platform ?? process.platform;

    // Tier 1: FLEET_SE_NODE -- an explicit, deliberate operator override.
    // Honored even below MIN_NODE_VERSION (the operator asked for THIS
    // interpreter by name); this resolver's only job for this tier is to
    // confirm the override is a real, spawnable Node.js runtime, never a
    // silent fall-through to a later tier when it is not.
    const override = typeof env.FLEET_SE_NODE === 'string' ? env.FLEET_SE_NODE.trim() : '';
    if (override.length > 0) {
        const { version } = sharedProbeVersion(exec, platform, override, ['--version'], { timeoutMs: SPRINT_RUNNER_PROBE_TIMEOUT_MS });
        if (version === null) {
            throw new SprintRunnerResolutionError(
                `FLEET_SE_NODE=${JSON.stringify(override)} does not resolve to a usable Node.js runtime ` +
                `(probed '${override} --version' and it failed, or returned no parseable version). ` +
                `Fix the FLEET_SE_NODE override, or unset it to let fleet-se auto-detect Node.js. ${SPRINT_RUNNER_FIX_LINE}`,
            );
        }
        return { command: override, source: SPRINT_RUNNER_SOURCE.OVERRIDE, version };
    }

    // Tier 2 (apra-fleet-i9ag.19.5): the recorded toolchain's node path, read
    // and validated by the caller and handed in here so this resolver stays
    // synchronous and filesystem-free (its existing all-inputs-injectable
    // contract). This MUST be consulted before tier 3/4 -- a service whose
    // PATH the login shell never populates, and whose own execPath is the
    // apra-fleet SEA binary rather than node, has no other way to reach a
    // usable Node.js runtime. Gated at >= MIN_NODE_VERSION exactly like the
    // PATH tier, and -- like the FLEET_SE_NODE override above -- a
    // configured-but-unusable path is a HARD ERROR, never a silent
    // fall-through to current-runtime/PATH: a skipped check here is
    // indistinguishable from a passed one, and letting resolution continue
    // would risk silently falling through to a PATH lookup that cannot
    // succeed on exactly the service that needed this tier in the first
    // place. The shared probeVersion() (./node-version.mjs) already handles
    // win32 shell-quoting for a path
    // containing spaces (e.g. the default `C:\Program Files\nodejs\node.exe`)
    // the same way it does for execPath/FLEET_SE_NODE.
    const configuredNodePath = typeof deps.configuredNodePath === 'string' ? deps.configuredNodePath.trim() : '';
    if (configuredNodePath.length > 0) {
        const { version } = sharedProbeVersion(exec, platform, configuredNodePath, ['--version'], { timeoutMs: SPRINT_RUNNER_PROBE_TIMEOUT_MS });
        if (version === null) {
            throw new SprintRunnerResolutionError(
                `Recorded node path ${JSON.stringify(configuredNodePath)} does not resolve to a usable Node.js runtime ` +
                `(probed '${configuredNodePath} --version' and it failed, or returned no parseable version). ` +
                `Fix the recorded toolchain (reinstall, or set FLEET_SE_NODE to an explicit Node.js binary to launch sprints with). ${SPRINT_RUNNER_FIX_LINE}`,
            );
        }
        if (compareVersions(version, MIN_NODE_VERSION) < 0) {
            throw new SprintRunnerResolutionError(
                `Recorded node path ${JSON.stringify(configuredNodePath)} resolved to Node.js ${version}, ` +
                `which is older than the required ${MIN_NODE_VERSION}. Fix the recorded toolchain (reinstall, or set FLEET_SE_NODE to an explicit Node.js binary to launch sprints with). ${SPRINT_RUNNER_FIX_LINE}`,
            );
        }
        return { command: configuredNodePath, source: SPRINT_RUNNER_SOURCE.CONFIGURED, version };
    }

    const candidates = [];

    // Tier 3: this process's own execPath -- only when it is a real Node.js
    // runtime, i.e. NOT a single-executable app. Never fall back to
    // process.execPath when isSea() is true: that silent fallback IS the bug
    // this module exists to fix.
    if (!isSea()) {
        const { version } = sharedProbeVersion(exec, platform, execPath, ['--version'], { timeoutMs: SPRINT_RUNNER_PROBE_TIMEOUT_MS });
        if (version !== null) {
            return { command: execPath, source: SPRINT_RUNNER_SOURCE.CURRENT_RUNTIME, version };
        }
        candidates.push(`current runtime (${execPath}) -- probed '--version' and it failed or returned no parseable version`);
    } else {
        candidates.push(`current runtime (${execPath}) -- skipped: running as a single-executable binary (node:sea isSea() is true)`);
    }

    // Tier 4: node resolved from PATH, gated at >= MIN_NODE_VERSION.
    const { version: pathVersion } = sharedProbeVersion(exec, platform, 'node', ['--version'], { timeoutMs: SPRINT_RUNNER_PROBE_TIMEOUT_MS });
    if (pathVersion === null) {
        candidates.push("'node' on PATH -- not found");
    } else if (compareVersions(pathVersion, MIN_NODE_VERSION) < 0) {
        candidates.push(`'node' on PATH -- found ${pathVersion}, requires ${MIN_NODE_VERSION}+`);
    } else {
        return { command: 'node', source: SPRINT_RUNNER_SOURCE.PATH, version: pathVersion };
    }

    throw new SprintRunnerResolutionError(
        'Could not resolve a Node.js runtime to launch a sprint with. '
        + `Tried: ${candidates.join('; ')}. ${SPRINT_RUNNER_FIX_LINE}`,
    );
}
