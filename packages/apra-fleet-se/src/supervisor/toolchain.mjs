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
//   - `nodeOk`/`bdOk` (2026-09-29 review fix) make that node-vs-bd
//     distinction MACHINE-READABLE, not just a fact a caller has to recover
//     by substring-matching `problems`. `ok` alone conflates "node is fine"
//     with "the whole toolchain is fine" (it is, by design, ONLY the former),
//     which left no way for a consumer to ask "is node specifically okay?"
//     or "is bd specifically okay?" without parsing prose. Both are `null`
//     when `configured` is `false` (nothing to judge, not "good" or "bad"),
//     otherwise strict booleans: `nodeOk` mirrors `ok` exactly (kept as a
//     separate field for symmetry with `bdOk`, not because it can ever
//     disagree with `ok`); `bdOk` is `true` only when a recorded `bdPath`
//     probed successfully, `false` for either "no bdPath was recorded" or
//     "the recorded bdPath did not probe" -- both already produce their own
//     `problems` entry, this just gives a consumer a field to branch on
//     instead.
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
// The small version-probing helpers this module needs (`compareVersions`,
// `probeVersion`, and transitively `parseVersionString`/
// `quoteForWindowsShell`) used to be a local, self-contained copy of
// node-runner.mjs's own identically-named, identically-behaved helpers.
// apra-fleet-i9ag.19.15 moved all four into the shared
// `./node-version.mjs` -- both this module and node-runner.mjs import from
// there now; neither keeps a local copy. `MIN_NODE_VERSION` itself is still
// imported straight from node-runner.mjs -- the one thing that MUST stay a
// single source of truth, and the shared module never redeclares it.
//
// NOTHING in this file imports from outside packages/apra-fleet-se, matching
// node-runner.mjs's own standalone-package contract.
//
// apra-fleet-i9ag.19.20 -- BOUNDING THE TOTAL WALL-CLOCK NOW THAT EACH PROBE
// CAN RETRY (apra-fleet-i9ag.19.18 added one bounded retry per probe on a
// timeout/transient spawn errno). Sequentially, that raised the worst case
// from 2 tools x 1 attempt x 15s = 30s to 2 tools x 2 attempts x 15s = 60s --
// a full minute during which bin/serve.mjs has not yet bound the port an
// operator would use to fix the very setting being validated. Of the
// strategies this task's own acceptance criteria lists (shorten the retry's
// ceiling; give the whole validation one shared budget; probe node and bd
// concurrently, since they are fully independent; log each retry), this
// module picks CONCURRENT PROBING (option c), alone, deliberately over the
// other two "shrink a budget" options:
//   - it needs NO new timeout value and changes NOTHING about
//     TOOLCHAIN_PROBE_TIMEOUT_MS -- every attempt, first or retried, still
//     carries the exact same per-attempt ceiling it always has, so a probe
//     is never given LESS time to complete than it had before this task;
//   - node and bd have no dependency on each other's outcome (see this
//     file's header: `ok` is gated on node ALONE, `bd` is always its own
//     separately-worded entry) -- there is no reason two fully independent
//     probes should ever have run sequentially at all;
//   - running them concurrently instead of sequentially exactly HALVES the
//     worst case back to 2 attempts x 15s = 30s total (both probes' own
//     worst case is 30s each; running at the same time, the wall clock is
//     the MAX of the two, not the sum) -- precisely the pre-retry total,
//     with no new "budget exhausted, never even attempted" state to invent
//     wording for, unlike a shared-budget approach would require.
// See `TOOLCHAIN_VALIDATION_WORST_CASE_MS` below for the single named
// constant this bounds to, and `validateRecordedToolchain()`'s own
// `Promise.all()` call for where the concurrency actually happens.
// This module's `exec` dependency returns a Promise (the real
// `defaultExec()` below spawns via non-blocking `child_process.execFile`
// rather than a blocking `execFileSync`), which is what makes two in-flight
// probes able to actually overlap on the wall clock rather than merely being
// *expressed* concurrently while still running back-to-back. The shared
// `probeVersion()` (./node-version.mjs) is deliberately NOT declared
// `async` itself -- it returns a genuine Promise when `exec` does (this
// module's contract) and a plain value when `exec` is synchronous
// (node-runner.mjs's contract) -- so every existing injected-`exec` test
// mock here keeps working unchanged: a synchronous mock that returns a
// plain value or throws still behaves identically whether or not its result
// is `await`ed by `validateRecordedToolchain()` below.
// =============================================================================

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { readSupervisorConfig } from './project-config.mjs';
import { MIN_NODE_VERSION } from './node-runner.mjs';
import { compareVersions, probeVersion } from './node-version.mjs';

const execFileAsync = promisify(execFile);

/**
 * Wall-clock ceiling for a single `--version` probe (mirrors
 * node-runner.mjs's SPRINT_RUNNER_PROBE_TIMEOUT_MS): a probe that never
 * returns -- a wedged interpreter, a broken shim, a network-mounted path
 * that hangs -- must never hang supervisor startup indefinitely. Unchanged
 * by apra-fleet-i9ag.19.20 (see this file's header) -- every attempt, first
 * or retried, still carries exactly this ceiling.
 */
export const TOOLCHAIN_PROBE_TIMEOUT_MS = 15_000;

/**
 * apra-fleet-i9ag.19.20: the single named constant this module's worst-case
 * wall clock is bounded by -- node's own probe (first attempt + one bounded
 * retry) and bd's own probe (same shape) run CONCURRENTLY (see this file's
 * header and `validateRecordedToolchain()`'s `Promise.all()`), so the
 * overall wall clock is the MAX of the two, not their sum: one probe's own
 * worst case, `TOOLCHAIN_PROBE_TIMEOUT_MS * 2` (an attempt plus one retry,
 * each bounded by `TOOLCHAIN_PROBE_TIMEOUT_MS`) -- exactly the pre-retry
 * total (2 tools x 1 attempt x 15s, run sequentially, before
 * apra-fleet-i9ag.19.18 added the retry).
 */
export const TOOLCHAIN_VALIDATION_WORST_CASE_MS = TOOLCHAIN_PROBE_TIMEOUT_MS * 2;

/**
 * The single operator-facing fix line every problem entry this module
 * produces is meant to be read alongside -- defined once here so no consumer
 * (apra-fleet-i9ag.19.10's startup wiring, any future health surface)
 * restates it as its own literal.
 */
export const TOOLCHAIN_FIX_LINE =
    'Re-run the installer to re-record the toolchain (node and bd), or set FLEET_SE_NODE to an explicit Node.js binary '
    + 'and ensure bd resolves on PATH, to override the recording explicitly.';

/**
 * apra-fleet-i9ag.19.20: non-blocking (`child_process.execFile`, not
 * `execFileSync`) -- this is what actually lets the node probe and the bd
 * probe overlap on the wall clock when `validateRecordedToolchain()` runs
 * them concurrently (see this file's header): a *blocking* sync call can
 * never truly overlap with anything else on Node's single thread no matter
 * how it is scheduled, so switching the default `exec` to an async spawn is
 * a required part of this bound, not an unrelated cleanup. Same error
 * shape as `execFileSync` on failure/timeout (`err.killed`, `err.signal`,
 * `err.code`) -- node-version.mjs's `classifyIncompleteProbe()` inspects
 * exactly those fields and is unaffected by this swap.
 */
async function defaultExec(file, args, options = {}) {
    const { stdout } = await execFileAsync(file, args, { encoding: 'utf-8', ...options });
    return String(stdout);
}

// parseVersionString, compareVersions, quoteForWindowsShell and probeVersion
// used to be a local, self-contained copy of node-runner.mjs's identically-
// named, identically-behaved helpers (see this file's own now-superseded
// former header note, and node-runner.mjs's git history). apra-fleet-i9ag.19.15
// moved all four into the shared ./node-version.mjs, which both this module
// and node-runner.mjs now import -- see that module's file-level doc comment
// for the full sync-vs-async, retry-vs-no-retry contract `probeVersion()`
// serves for its two callers. This module opts into `{ retry: true }` below
// (its own bounded, one-retry-on-timeout/transient-errno behaviour,
// apra-fleet-i9ag.19.18/19.20, is unchanged); `classifyIncompleteProbe()`
// and `TRANSIENT_SPAWN_ERRNOS` moved into the shared module alongside it,
// since they exist only to support that retry decision.

/**
 * Words a "the probe could not complete" problem entry for `label` (`'node'`
 * or `'bd'`) -- deliberately distinct from this module's "does not resolve
 * to a usable ..." wording (see `probeVersion()`'s own doc comment for why):
 * a probe that never got to run to completion, twice, is a different finding
 * from one that ran and genuinely found nothing, and a consumer/operator
 * must never have to guess which of the two this module means.
 * @param {string} label
 * @param {string} recordedPath
 * @param {string} incomplete `'timeout'` or a transient errno code
 * @returns {string}
 */
function formatIncompleteProbeProblem(label, recordedPath, incomplete) {
    const cause = incomplete === 'timeout'
        ? `the probe was killed after exceeding that timeout, even on a retry`
        : `a transient spawn error (${incomplete}) persisted even on a retry`;
    return `Recorded ${label} path ${JSON.stringify(recordedPath)} could not be probed within `
        + `${TOOLCHAIN_PROBE_TIMEOUT_MS / 1_000}s (${cause}).`;
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
 *   nodeOk: boolean|null,
 *   bdOk: boolean|null,
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
            nodeOk: null,
            bdOk: null,
            problems: [],
            fixLine: TOOLCHAIN_FIX_LINE,
        };
    }

    const { nodePath, bdPath } = toolchain;
    const problems = [];
    const bdRecorded = typeof bdPath === 'string' && bdPath.length > 0;

    // apra-fleet-i9ag.19.20: node's probe and bd's probe are fully
    // independent of each other (see this file's header for why they never
    // needed to run sequentially in the first place) -- both are STARTED
    // here, before either is awaited, so their two `--version` child
    // processes are in flight at the same time; `Promise.all()` below is
    // what bounds the overall wall clock to ONE probe's own worst case
    // (`TOOLCHAIN_VALIDATION_WORST_CASE_MS`) rather than the sum of both.
    // `bdProbePromise` is `null` (never even started) when nothing was
    // recorded for bd at all -- exactly the existing "only the node probe
    // ran" contract, unaffected by running concurrently.
    const probeOptions = { timeoutMs: TOOLCHAIN_PROBE_TIMEOUT_MS, retry: true };
    const nodeProbePromise = probeVersion(exec, platform, nodePath, ['--version'], probeOptions);
    const bdProbePromise = bdRecorded ? probeVersion(exec, platform, bdPath, ['--version'], probeOptions) : null;
    const [nodeProbe, bdProbe] = await Promise.all([nodeProbePromise, bdProbePromise]);

    // Node: the ONLY input to `ok` (see this file's header for why) --
    // node-runner.mjs's CONFIGURED tier hard-fails a sprint launch the
    // moment this recording turns out to be unusable, so this is the one
    // condition serious enough to gate this module's single pass/fail
    // signal.
    //
    // apra-fleet-i9ag.19.18: `probeVersion()` already retries once, bounded,
    // on a timeout/transient spawn errno before giving up -- so by the time
    // `incomplete` is still set here, the SAME class of failure survived a
    // retry. That is deliberately still treated as `nodeOk: false` (today's
    // exact severity, gating exactly like a genuinely broken recording
    // does) -- a probe that cannot complete twice in a row on a machine that
    // is otherwise able to run this process at all is a real finding worth
    // surfacing loudly, not a coin flip to shrug off. What changes is ONLY
    // the wording: `formatIncompleteProbeProblem()`'s distinct sentence,
    // never this module's "does not resolve to a usable Node.js runtime"
    // line, so a consumer/operator is never told a node that merely could
    // not be probed in time "does not resolve" -- those are different
    // findings and must read as different findings.
    const nodeVersion = nodeProbe.version;
    let nodeOk;
    if (nodeProbe.incomplete) {
        nodeOk = false;
        problems.push(formatIncompleteProbeProblem('node', nodePath, nodeProbe.incomplete));
    } else if (nodeVersion === null) {
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
    // worth reporting, just not this module's single pass/fail gate. `bdOk`
    // (see this file's header) gives a consumer that same distinction as a
    // plain boolean, without having to substring-match `problems`.
    let bdVersion = null;
    let bdOk;
    if (!bdRecorded) {
        bdOk = false;
        problems.push('No bd path was recorded for this installation.');
    } else {
        bdVersion = bdProbe.version;
        if (bdProbe.incomplete) {
            bdOk = false;
            problems.push(formatIncompleteProbeProblem('bd', bdPath, bdProbe.incomplete));
        } else if (bdVersion === null) {
            bdOk = false;
            problems.push(
                `Recorded bd path ${JSON.stringify(bdPath)} does not resolve to a usable bd `
                + `(probed '${bdPath} --version' and it failed, or returned no parseable version).`,
            );
        } else {
            bdOk = true;
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
        nodeOk,
        bdOk,
        problems,
        fixLine: TOOLCHAIN_FIX_LINE,
    };
}
