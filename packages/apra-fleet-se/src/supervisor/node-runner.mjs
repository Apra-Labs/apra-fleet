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
//      apra-fleet-i9ag.19.35 (see "STARTUP AND LAUNCH MUST AGREE" below):
//      this tier CONSUMES `configuredNodeVersion` -- the version startup
//      validation already ACCEPTED for this exact path in this process -- and
//      does not probe at all when it has one; when it has none it probes with
//      `{ retry: true }`, the same bounded retry and transient-vs-genuine
//      classification toolchain.mjs uses for the same path. A probe that
//      times out even on the retry is still a HARD ERROR (same severity as
//      today), just worded distinguishably (`formatIncompleteProbeProblem()`,
//      ./node-version.mjs) so an operator is never told a node that merely
//      could not be probed in time "does not resolve".
//   3. The current process's own execPath -- but ONLY when this process is a
//      real Node.js runtime, i.e. NOT a single-executable app (node:sea's
//      isSea() === false). This preserves today's behaviour for a plain
//      `node bin/serve.mjs` supervisor. apra-fleet-i9ag.19.35: when that
//      execPath is genuinely THIS process's own interpreter, its version is
//      taken from `process.versions.node` (`knownSelfNodeVersion()`,
//      ./node-version.mjs) instead of spawning a `--version` child to ask a
//      binary we are already executing.
//
// STARTUP AND LAUNCH MUST AGREE (apra-fleet-i9ag.19.35) -- the defect and the
// ONE strategy chosen for it, recorded here and not only in a commit message:
// toolchain.mjs's `validateRecordedToolchain()` probes the recorded node at
// supervisor startup (with a bounded retry) and this resolver probed the very
// SAME path again at every launch (originally with none). Two independent
// probes of one binary, two policies, and the launch-side one collapsed ANY
// failure -- including a probe that merely could not COMPLETE under host load
// -- into "does not resolve to a usable Node.js runtime" and hard-refused the
// launch (503). So an installed supervisor could log a healthy toolchain at
// boot and still refuse every sprint on a loaded machine.
// CHOSEN: BOTH options the bead offered, because each closes a hole the other
// cannot, and neither is "scale the timeout" (see toolchain.mjs's header for
// why that budget stays a flat, honest SLA):
//   (a) CONSUME the startup validation result for the recorded node
//       (`deps.configuredNodeVersion`, threaded bin/serve.mjs ->
//       spawner.mjs -> here) so the launch path re-probes NOTHING that
//       startup already accepted. A retry alone can still lose twice in a
//       row; consuming the accepted result makes a refusal for an accepted
//       node structurally impossible rather than merely less likely.
//   (b) KEEP a re-probe for the case where there is no accepted result to
//       consume (a standalone/injected caller, or a recording startup
//       validation did NOT accept), and give it the identical bounded-retry
//       plus transient-vs-genuine classification, so the two probes can never
//       disagree on the same input and an incomplete probe is never worded as
//       a genuinely broken recording.
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

import {
    probeVersion as sharedProbeVersion,
    compareVersions,
    formatIncompleteProbeProblem,
    parseVersionString,
    knownSelfNodeVersion,
    defaultIsSea,
} from './node-version.mjs';

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

// `defaultIsSea` (the real node:sea probe, defensively wrapped so a host
// running some unexpected Node.js build is treated as "not a SEA binary" --
// the safer default, since it preserves today's execPath behaviour -- rather
// than crashing resolution) now lives in ./node-version.mjs
// (apra-fleet-i9ag.19.35): `knownSelfNodeVersion()` there needs the identical
// check, and one copy is the whole point of that shared module.

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
 *   configuredNodeVersion?: string,
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
        // apra-fleet-i9ag.19.35, leg 1 -- CONSUME THE STARTUP VALIDATION
        // RESULT instead of re-probing. `deps.configuredNodeVersion` is the
        // version toolchain.mjs's `validateRecordedToolchain()` ACCEPTED for
        // this exact recorded path, in this same supervisor process, moments
        // ago (bin/serve.mjs passes it only when `nodeOk` was true, and
        // spawner.mjs threads it through untouched). When it is present there
        // is nothing left to find out: re-spawning a `--version` child could
        // only ever ADD a way to fail -- host load, fd/process exhaustion, a
        // timeout -- for a binary this process has already seen answer. That
        // is precisely how a supervisor came to log a healthy toolchain at
        // boot and still 503 the next launch over the SAME node, so this tier
        // no longer probes at all in that case and a launch can never be
        // refused for a node startup validation accepted.
        //
        // Still gated at >= MIN_NODE_VERSION (a version below it is not an
        // "accepted" one -- startup validation would itself have reported
        // that as a problem and bin/serve.mjs would not pass it here), and an
        // unparseable value is ignored rather than trusted: the code falls
        // through to the probe below, which is the conservative direction.
        const acceptedVersion = typeof deps.configuredNodeVersion === 'string'
            ? parseVersionString(deps.configuredNodeVersion)
            : null;
        if (acceptedVersion !== null) {
            if (compareVersions(acceptedVersion, MIN_NODE_VERSION) < 0) {
                throw new SprintRunnerResolutionError(
                    `Recorded node path ${JSON.stringify(configuredNodePath)} resolved to Node.js ${acceptedVersion}, ` +
                    `which is older than the required ${MIN_NODE_VERSION}. Fix the recorded toolchain (reinstall, or set FLEET_SE_NODE to an explicit Node.js binary to launch sprints with). ${SPRINT_RUNNER_FIX_LINE}`,
                );
            }
            return { command: configuredNodePath, source: SPRINT_RUNNER_SOURCE.CONFIGURED, version: acceptedVersion };
        }
        // apra-fleet-i9ag.19.35, leg 2 -- nothing validated this path in this
        // process (an injected/standalone caller, or a recording that never
        // passed startup validation), so the tier DOES probe -- with
        // `{ retry: true }`, the SAME bounded retry and transient-vs-genuine
        // classification the startup check has, so the two can never disagree
        // on the same input. See this file's header.
        const { version, incomplete } = sharedProbeVersion(
            exec, platform, configuredNodePath, ['--version'],
            { timeoutMs: SPRINT_RUNNER_PROBE_TIMEOUT_MS, retry: true },
        );
        if (incomplete) {
            throw new SprintRunnerResolutionError(
                `${formatIncompleteProbeProblem('node', configuredNodePath, incomplete, SPRINT_RUNNER_PROBE_TIMEOUT_MS)} ` +
                `This may be transient host load rather than a broken recording -- retry the launch, or fix the recorded ` +
                `toolchain (reinstall, or set FLEET_SE_NODE to an explicit Node.js binary to launch sprints with). ${SPRINT_RUNNER_FIX_LINE}`,
            );
        }
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
        // apra-fleet-i9ag.19.35, leg 3 -- NEVER SPAWN A PROBE WHOSE ANSWER
        // THIS PROCESS ALREADY KNOWS. When `execPath` is literally the binary
        // this process is running on (the real, uninjected default -- see
        // knownSelfNodeVersion()'s doc comment for why the comparison is
        // against the true `process.execPath` and never an injected one),
        // `process.versions.node` IS its version, with certainty. Asking a
        // child process instead added a 15s-bounded, timeout-capable spawn to
        // every launch on a host with no recorded toolchain -- two of them
        // once tier 4 followed -- which is how a loaded host turned a POST
        // /api/sprints into a 30s+ request that could still fall through to a
        // "no usable node" hard error over the very interpreter running the
        // supervisor. A caller that injects `execPath` (every test in this
        // package) is unaffected and still probes exactly as before.
        const selfVersion = knownSelfNodeVersion(execPath, { isSea });
        if (selfVersion !== null) {
            return { command: execPath, source: SPRINT_RUNNER_SOURCE.CURRENT_RUNTIME, version: selfVersion };
        }
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
