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
// RESOLUTION ORDER (fixed):
//   1. `FLEET_SE_NODE` env override -- an explicit operator escape hatch.
//      Probed with `--version`; a SET-BUT-UNUSABLE override is a HARD ERROR
//      (never a silent fall-through to the next tier -- the operator asked
//      for THIS interpreter by name).
//   2. The current process's own execPath -- but ONLY when this process is a
//      real Node.js runtime, i.e. NOT a single-executable app (node:sea's
//      isSea() === false). This preserves today's behaviour for a plain
//      `node bin/serve.mjs` supervisor.
//   3. `node` resolved from PATH, gated at >= MIN_NODE_VERSION.
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
    /** Tier 2: this process's own execPath (a real Node.js runtime, not a SEA binary). */
    CURRENT_RUNTIME: 'current-runtime',
    /** Tier 3: `node` resolved from PATH. */
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
 * Parses a version string (with or without a leading 'v', tolerant of
 * trailing whitespace/build metadata) into a normalized "major.minor.patch"
 * string. Returns null when no version-like substring is found -- mirrors
 * src/cli/fleet-se-prereqs.ts's parseVersionString().
 * @param {string|Buffer|null|undefined} raw
 * @returns {string|null}
 */
function parseVersionString(raw) {
    if (raw === null || raw === undefined) return null;
    const match = String(raw).match(/(\d+)\.(\d+)\.(\d+)/);
    if (!match) return null;
    return `${match[1]}.${match[2]}.${match[3]}`;
}

/**
 * Numeric major.minor.patch comparison -- NEVER a string compare (a string
 * compare would treat '22.9.0' as GREATER than '22.16.0', a defect this
 * module's acceptance criteria calls out explicitly). Mirrors
 * src/cli/fleet-se-prereqs.ts's compareVersions().
 * @param {string} a
 * @param {string} b
 * @returns {number} negative if a < b, positive if a > b, 0 if equal
 */
function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i += 1) {
        const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (diff !== 0) return diff < 0 ? -1 : 1;
    }
    return 0;
}

/**
 * Quotes a single win32 shell command-line token when it needs it (contains
 * whitespace), so `cmd.exe /d /s /c "<file> <args...>"` -- the literal string
 * Node's child_process builds internally when `shell: true` on Windows --
 * does not get re-split on the space inside a candidate path. Node joins
 * `file` and `args` with a single space and wraps the WHOLE line in one pair
 * of outer quotes for the `/s` flag; `/s` only strips those outer quotes when
 * the line contains no OTHER embedded quotes, so an unquoted spaced file
 * (e.g. the default `C:\Program Files\nodejs\node.exe`) is handed to cmd.exe
 * as bare, unquoted text and splits into `C:\Program` (treated as the
 * executable) plus `Files\nodejs\node.exe` and `--version` (treated as
 * args) -- this IS the bug this module exists to fix (apra-fleet-i9ag.15.4).
 * Quoting `file` here instead defeats that outer-quote stripping (the line
 * now has embedded quotes), so cmd.exe parses the whole thing itself and
 * keeps the spaced path as one token. No-op for a token with no whitespace,
 * and only ever called on the win32 shell path -- POSIX shells/argv arrays
 * never see this. Escapes embedded double quotes by doubling them, cmd.exe's
 * own quoting convention (distinct from POSIX backslash-escaping).
 * @param {string} token
 * @returns {string}
 */
function quoteForWindowsShell(token) {
    if (!/\s/.test(token)) return token;
    return `"${token.replace(/"/g, '""')}"`;
}

/**
 * Probes `file --version` (well, `file`, `args`), returning the parsed
 * version or null when the probe fails or its output carries no
 * version-like substring. `shell: true` on win32 only -- mirrors
 * src/cli/fleet-se-prereqs.ts's PROBE_OPTIONS doc comment: both `node` and an
 * explicit FLEET_SE_NODE override routinely resolve to a `.cmd`/shim on
 * Windows, and Node refuses to spawn one without a shell. Argv is always a
 * fixed-literal array (never a caller-interpolated command string), so
 * routing through a shell here introduces no expansion (CLAUDE.md). On
 * win32, `file` (a caller/environment-supplied path, unlike the fixed
 * literal args) is quoted via quoteForWindowsShell() before being handed to
 * `exec` -- see that function's doc comment for why an unquoted spaced path
 * breaks under `shell: true` on Windows. This is probe-internal only: the
 * unquoted original path is still what resolveSprintRunnerCommand() returns
 * to its caller.
 * @param {(file: string, args: string[], options?: object) => string|Buffer} exec
 * @param {NodeJS.Platform} platform
 * @param {string} file
 * @param {string[]} args
 * @returns {string|null}
 */
function probeVersion(exec, platform, file, args) {
    const isWin32Shell = platform === 'win32';
    try {
        const raw = exec(isWin32Shell ? quoteForWindowsShell(file) : file, args, {
            shell: isWin32Shell,
            timeout: SPRINT_RUNNER_PROBE_TIMEOUT_MS,
        });
        return parseVersionString(raw);
    } catch {
        return null;
    }
}

/**
 * Resolves the Node.js command line the supervisor should spawn a sprint's
 * fleet-sprint CLI child process with. See the file-level doc comment above
 * for the fixed 3-tier resolution order and rationale.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   execPath?: string,
 *   isSea?: () => boolean,
 *   exec?: (file: string, args: string[], options?: object) => string|Buffer,
 *   platform?: NodeJS.Platform,
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
    // silent fall-through to tier 2/3 when it is not.
    const override = typeof env.FLEET_SE_NODE === 'string' ? env.FLEET_SE_NODE.trim() : '';
    if (override.length > 0) {
        const version = probeVersion(exec, platform, override, ['--version']);
        if (version === null) {
            throw new SprintRunnerResolutionError(
                `FLEET_SE_NODE=${JSON.stringify(override)} does not resolve to a usable Node.js runtime ` +
                `(probed '${override} --version' and it failed, or returned no parseable version). ` +
                `Fix the FLEET_SE_NODE override, or unset it to let fleet-se auto-detect Node.js. ${SPRINT_RUNNER_FIX_LINE}`,
            );
        }
        return { command: override, source: SPRINT_RUNNER_SOURCE.OVERRIDE, version };
    }

    const candidates = [];

    // Tier 2: this process's own execPath -- only when it is a real Node.js
    // runtime, i.e. NOT a single-executable app. Never fall back to
    // process.execPath when isSea() is true: that silent fallback IS the bug
    // this module exists to fix.
    if (!isSea()) {
        const version = probeVersion(exec, platform, execPath, ['--version']);
        if (version !== null) {
            return { command: execPath, source: SPRINT_RUNNER_SOURCE.CURRENT_RUNTIME, version };
        }
        candidates.push(`current runtime (${execPath}) -- probed '--version' and it failed or returned no parseable version`);
    } else {
        candidates.push(`current runtime (${execPath}) -- skipped: running as a single-executable binary (node:sea isSea() is true)`);
    }

    // Tier 3: node resolved from PATH, gated at >= MIN_NODE_VERSION.
    const pathVersion = probeVersion(exec, platform, 'node', ['--version']);
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
