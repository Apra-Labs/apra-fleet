// =============================================================================
// Supervisor startup -- recorded toolchain validation (apra-fleet-i9ag.19.9)
// =============================================================================
//
// WHY: a recorded absolute path (supervisor.config.json's `toolchain` block,
// written at install time by `seedSupervisorToolchain()` in
// `src/cli/supervisor.ts`) goes stale for reasons the operator is not present
// to fix -- a version manager removed that release, the checkout moved, the
// machine was reimaged. The resolvers that actually USE the recording
// (node-runner.mjs's CONFIGURED tier, apra-fleet-i9ag.19.5; exec-bd.mjs's
// `configureBdInvocation()`, apra-fleet-i9ag.19.7) both treat a configured
// value as trustworthy and either hard-fail (node) or fall back silently
// (bd) the moment it turns out not to be. Neither of those call sites is the
// right place to explain WHY a recording is bad, in one voice, before the
// supervisor gets anywhere near a launch attempt -- that is this module's
// one job: RE-PROBE what was recorded at startup, and say precisely what is
// wrong when it is wrong.
//
// This module does NOT itself decide what the supervisor does with the
// result (log a warning, refuse to serve `/api/sprints`, etc.) -- that is
// apra-fleet-i9ag.19.10's job, which reads this module's result and hands
// the same validated paths on to the runner/bd. This module's only
// responsibility is a total, side-effect-free (beyond the two `--version`
// probes) validation:
//
//   - It reads the recorded block ONLY through `./project-config.mjs`'s
//     `readSupervisorConfig()` -- this module must NEVER open
//     `supervisor.config.json` itself (that file's single-owner contract,
//     see project-config.mjs's own file-level doc comment).
//   - It NEVER throws. A missing recording, a malformed config file, an
//     absent binary, an unprobeable binary, or a too-old node all degrade to
//     a `problems` entry (or, for the "nothing recorded" case, no problem at
//     all -- see below) rather than a thrown error, because a supervisor
//     must be able to boot, validate its own toolchain, and still serve the
//     console page an operator would use to fix whatever this reports.
//   - `configured: false` (nothing recorded at all) is explicitly NOT a
//     problem: an older install that predates this feature, or a foreground
//     `node bin/serve.mjs` development run, legitimately has no recorded
//     toolchain at all. This module reports that fact (`reason`, threaded
//     straight through from `readSupervisorConfig()`'s own `toolchainReason`)
//     and leaves the caller to decide what it means for THEM -- which, for
//     the resolvers, is simply "fall back to today's PATH-lookup tiers."
//   - `ok` tracks NODE health only (absent, unprobeable, or below
//     `MIN_NODE_VERSION`) -- node is what apra-fleet-i9ag.19.5's CONFIGURED
//     tier hard-fails a sprint launch over the moment it is configured, so it
//     is the one condition serious enough to gate this module's single
//     pass/fail signal. A missing or unprobeable `bd` is real and IS
//     reported (its own, separately worded entry in `problems`, naming `bd`
//     specifically so an operator is never left guessing whether it was node
//     or bd that broke) -- but it does not flip `ok`, because
//     apra-fleet-i9ag.19.7's `execBdAsync`/`execBdSync` degrade to a PATH
//     lookup for `bd` rather than hard-failing the way the node resolver
//     does, so a broken *recording* for `bd` is not the same class of outage
//     as a broken one for node.
//   - Exactly ONE operator-facing fix line (`TOOLCHAIN_FIX_LINE`) is defined
//     here, covering both node and bd, so no consumer of this module's
//     result has to invent or restate its own version of that sentence.
//
// Everything environment-shaped (`exec`, `platform`) plus every
// `readSupervisorConfig()` passthrough (`dataDir`, `filePath`, `cwd`, `fs`)
// is injectable with real defaults, the same injected-exec/injected-platform
// convention node-runner.mjs already follows -- so every branch here
// (a good recording, a missing binary, a too-old node, an unprobeable bd, no
// recording at all, a malformed config file) is exercisable with no real
// node, no real bd, and no real config file on disk.
//
// The small version-probing helpers below (`parseVersionString`,
// `compareVersions`, `quoteForWindowsShell`, `probeVersion`) are deliberately
// a local, self-contained copy of node-runner.mjs's own identically-named,
// identically-behaved helpers rather than an import from it: this task's
// FILES list is this one new module, and node-runner.mjs does not export
// them (they are resolver-internal there). Only `MIN_NODE_VERSION` itself is
// imported from node-runner.mjs -- the one thing that MUST stay a single
// source of truth, per this task's own acceptance criteria ("sourced from
// the existing constant, not a new literal").
//
// NOTHING in this file imports from outside packages/apra-fleet-se, matching
// node-runner.mjs's own standalone-package contract.
// =============================================================================

import { execFileSync } from 'node:child_process';

import { readSupervisorConfig } from './project-config.mjs';
import { MIN_NODE_VERSION } from './node-runner.mjs';

/**
 * Wall-clock ceiling for a single `--version` probe (mirrors
 * node-runner.mjs's SPRINT_RUNNER_PROBE_TIMEOUT_MS): a probe that never
 * returns -- a wedged interpreter, a broken shim, a network-mounted path
 * that hangs -- must never hang supervisor startup indefinitely.
 */
export const TOOLCHAIN_PROBE_TIMEOUT_MS = 15_000;

/**
 * The single operator-facing fix line every problem entry this module
 * produces is meant to be read alongside -- defined once here so no consumer
 * (apra-fleet-i9ag.19.10's startup wiring, any future health surface)
 * restates it as its own literal.
 */
export const TOOLCHAIN_FIX_LINE =
    'Re-run the installer to re-record the toolchain (node and bd), or set FLEET_SE_NODE to an explicit Node.js binary '
    + 'and ensure bd resolves on PATH, to override the recording explicitly.';

function defaultExec(file, args, options = {}) {
    return String(execFileSync(file, args, { encoding: 'utf-8', stdio: 'pipe', ...options }));
}

/**
 * Parses a version string (with or without a leading 'v', tolerant of
 * trailing whitespace/build metadata) into a normalized "major.minor.patch"
 * string. Returns null when no version-like substring is found. A local copy
 * of node-runner.mjs's identically-named helper -- see this file's header
 * for why it is duplicated rather than imported.
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
 * compare would treat '22.9.0' as GREATER than '22.16.0'). A local copy of
 * node-runner.mjs's identically-named helper -- see this file's header for
 * why it is duplicated rather than imported.
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
 * whitespace), so an unquoted spaced path (e.g. the default
 * `C:\Program Files\nodejs\node.exe`) is not mis-split by cmd.exe. A local
 * copy of node-runner.mjs's identically-named, identically-behaved helper --
 * see this file's header for why it is duplicated rather than imported, and
 * node-runner.mjs's own copy for the full rationale.
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
 * version-like substring. `shell: true` on win32 only, with `file` quoted
 * first when it contains whitespace -- a local copy of node-runner.mjs's
 * identically-named, identically-behaved helper; see this file's header for
 * why it is duplicated rather than imported.
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
            timeout: TOOLCHAIN_PROBE_TIMEOUT_MS,
        });
        return parseVersionString(raw);
    } catch {
        return null;
    }
}

/**
 * Re-probes the toolchain recorded in `supervisor.config.json` (read ONLY
 * through `readSupervisorConfig()` -- see this file's header) and reports
 * exactly what is wrong with it, if anything. Never throws.
 *
 * @param {{
 *   dataDir?: string,
 *   filePath?: string,
 *   cwd?: string,
 *   fs?: { readFile: Function },
 *   exec?: (file: string, args: string[], options?: object) => string|Buffer,
 *   platform?: NodeJS.Platform,
 * }} [deps]
 * @returns {Promise<{
 *   configured: boolean,
 *   nodePath: string|null,
 *   nodeVersion: string|null,
 *   bdPath: string|null,
 *   bdVersion: string|null,
 *   source: string,
 *   reason: string|null,
 *   ok: boolean,
 *   problems: string[],
 *   fixLine: string,
 * }>}
 */
export async function validateRecordedToolchain(deps = {}) {
    const exec = deps.exec ?? defaultExec;
    const platform = deps.platform ?? process.platform;

    const config = await readSupervisorConfig({
        dataDir: deps.dataDir,
        filePath: deps.filePath,
        cwd: deps.cwd,
        fs: deps.fs,
    });

    const { toolchain, toolchainReason } = config;

    // Nothing recorded at all -- including a malformed config file, which
    // readSupervisorConfig() ALSO degrades to `toolchain: null` plus its own
    // distinguishable `toolchainReason` (apra-fleet-i9ag.19.3). Both cases
    // are legitimate, non-error states from this module's point of view: an
    // older install, a foreground dev run, or a config file an operator will
    // fix through the console all look the same here -- `configured: false`,
    // no `problems`, `ok: true` (there is nothing broken, just nothing
    // configured), and `reason` carrying whichever of those two explanations
    // actually applies, so a caller that wants to surface it still can.
    if (!toolchain) {
        return {
            configured: false,
            nodePath: null,
            nodeVersion: null,
            bdPath: null,
            bdVersion: null,
            source: config.path,
            reason: toolchainReason,
            ok: true,
            problems: [],
            fixLine: TOOLCHAIN_FIX_LINE,
        };
    }

    const { nodePath, bdPath } = toolchain;
    const problems = [];

    // Node: the ONLY input to `ok` (see this file's header for why) --
    // node-runner.mjs's CONFIGURED tier hard-fails a sprint launch the
    // moment this recording turns out to be unusable, so this is the one
    // condition serious enough to gate this module's single pass/fail
    // signal.
    const nodeVersion = probeVersion(exec, platform, nodePath, ['--version']);
    let nodeOk;
    if (nodeVersion === null) {
        nodeOk = false;
        problems.push(
            `Recorded node path ${JSON.stringify(nodePath)} does not resolve to a usable Node.js runtime `
            + `(probed '${nodePath} --version' and it failed, or returned no parseable version).`,
        );
    } else if (compareVersions(nodeVersion, MIN_NODE_VERSION) < 0) {
        nodeOk = false;
        problems.push(
            `Recorded node path ${JSON.stringify(nodePath)} resolved to Node.js ${nodeVersion}, `
            + `which is older than the required ${MIN_NODE_VERSION}.`,
        );
    } else {
        nodeOk = true;
    }

    // bd: always its OWN, separately worded problem entry (missing OR
    // unprobeable) -- distinguishable from any node problem above -- but
    // never flips `ok`. exec-bd.mjs's configured-bd invocation degrades to a
    // PATH lookup rather than hard-failing, so a broken recording for `bd`
    // is not the same class of outage as one for node; it is still real and
    // worth reporting, just not this module's single pass/fail gate.
    let bdVersion = null;
    if (typeof bdPath !== 'string' || bdPath.length === 0) {
        problems.push('No bd path was recorded for this installation.');
    } else {
        bdVersion = probeVersion(exec, platform, bdPath, ['--version']);
        if (bdVersion === null) {
            problems.push(
                `Recorded bd path ${JSON.stringify(bdPath)} does not resolve to a usable bd `
                + `(probed '${bdPath} --version' and it failed, or returned no parseable version).`,
            );
        }
    }

    return {
        configured: true,
        nodePath,
        nodeVersion,
        bdPath: typeof bdPath === 'string' && bdPath.length > 0 ? bdPath : null,
        bdVersion,
        source: config.path,
        reason: null,
        ok: nodeOk,
        problems,
        fixLine: TOOLCHAIN_FIX_LINE,
    };
}
