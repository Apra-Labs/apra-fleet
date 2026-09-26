// status.mjs -- fleet-bridge-implementation-plan.md Part B, `fleet-bridge
// status`. A single, one-shot read of a sprint's current progress: no poll
// loop, no writes, no adapter calls -- the always-on watcher (watch.mjs) is
// what keeps observing a sprint after this exits.
//
// -----------------------------------------------------------------------------
// THE INCIDENT THIS FILE FIXES: "unknown" ERASES A REAL FAILURE
// -----------------------------------------------------------------------------
// A real sprint failed (GitSyncError: authentication failed pulling the
// member's repo) while `status` was polled every 45s. While the process
// (and its 300s-lingering dashboard) was alive, status correctly answered
// `health: terminal`. The MOMENT the process exited, status degraded to
// `health: unknown, cycle: 0, spend: undefined` and stayed there on every
// poll thereafter, forever -- the worst possible answer: `unknown` is
// indistinguishable from "never started", and it silently ERASES a terminal
// failure the log and the spool both still have. A pipeline polling
// `status` after its own job detached would see nothing but `unknown` and
// never learn the run had died.
//
// CORRECTED PREMISE (read this before touching step 1/2 below): an earlier
// pass at this incident assumed the ROOT CAUSE was `getSprint(sprintId)`
// itself starting to 404 once the process exits, and built steps 2-4 below
// (the getLog/spool/log-file fallback chain) as the fix. That diagnosis was
// WRONG for the case that was actually observed. Verified live against a
// real failed sprint: `getSprint()` answers 200, not 404 -- the supervisor's
// own durable, disk-persisted history log (packages/apra-fleet-se/src/
// supervisor/history.mjs) remembers a finished sprint long after its ledger
// reservation is released, and `getSprint()` (packages/apra-fleet-se/src/
// supervisor/api.mjs, READ-ONLY reference) returns that history as a THIRD
// response shape -- `{live:false, history, latest}`, no `state` at all --
// that snapshot.mjs's `toProgressSnapshot()` never recognised. THAT is where
// `unknown` was actually being manufactured: on the very first
// `getSprint()` call, not after it and `getLog()` both came up empty. See
// snapshot.mjs's own file header for the fix (`buildSnapshotFromHistory()`)
// -- this module's own step 1 already routes there unchanged; no change was
// needed here for the actual fix to land.
//
// The fallback chain in steps 2-4 below is NOT dead, though: a genuine
// `getSprint()` 404 (ledger AND history both empty for this id) is still a
// real, if narrow, possibility -- e.g. a restart-stale ledger reservation
// whose port no longer resolves and whose watchdog tick has not yet run, or
// an id that was never launched on this supervisor at all. That is a race
// window, not the ordinary "sprint finished" case this incident was about,
// so it is kept as genuine defense-in-depth for that narrower scenario, not
// as the fix for the reported bug.
//
// The information was never actually lost, only unread: the spooled
// SprintHandle (spool.mjs) and the sprint's own log at `handle.logPath`
// both survive the supervisor forgetting the process. This module now
// reads them before giving up.
//
// SEQUENCE:
//   1. `supervisorClient.getSprint(sprintId)`. A hit is handed straight to
//      snapshot.mjs's `toProgressSnapshot()` -- this module owns no
//      state-shape knowledge of its own; that module is the single owner of
//      the sprint-state -> ProgressSnapshot derivation, INCLUDING the
//      history-only shape (see "CORRECTED PREMISE" above) -- this is now
//      where the reported incident actually gets fixed.
//   2. A miss (`getSprint`'s own "404 -> null" contract, per
//      supervisor-client.mjs's doc comment: "404 is a real 'no such sprint'
//      answer here, not an error") falls back to
//      `supervisorClient.getLog(sprintId, { tail })` -- the same fallback
//      watch.mjs's poll loop uses when a sprint died before writing
//      structured state (see that file's "FALLBACK TO THE RAW LOG"
//      section). If the supervisor still answers with SOME text, that text
//      is now classified first (`classifyTerminalLog()`, snapshot.mjs) for
//      the engine's own 'Sprint failed:'/'Sprint finished:' marker lines --
//      this is the exact spot the incident's blind `health: 'unknown'` was
//      manufactured while a decisive answer was sitting right there in the
//      text. Only when no marker is found does this fall through to the
//      ORIGINAL, unchanged `buildFallbackSnapshot()` shape (health:
//      'unknown', mirroring watch.mjs's own private helper of the same name
//      field-for-field -- see watch.mjs for why `makeProgressSnapshot()`
//      would be the wrong constructor there: it would silently drop
//      `logTail`, the entire point of that fallback).
//   3. `getLog` ALSO answering "no log file" (`null`, not a throw -- see
//      supervisor-client.mjs) used to mean nothing at all was known and
//      `runStatus` returned a blank `null`. This is the incident's actual
//      failure mode: the supervisor had forgotten the process, so BOTH
//      calls came back empty, even though the spool and the log FILE were
//      still sitting on disk. Before answering `null`, this module now
//      reads the injected (optional) `deps.spool`:
//        a. no spool injected, or no handle recorded for this id -> `null`,
//           unchanged -- genuinely nothing is known anywhere (see rule 4
//           below).
//        b. a handle IS recorded -- the sprint is at least IDENTIFIED now,
//           never a blank `null`, even before its outcome is known.
//        c. if the daemon already ran finalize/failed this sprint (spool.mjs's
//           `complete()`/`fail()`), that recorded outcome is preferred over
//           re-parsing text: it already carries the engine's own thrown
//           reason, captured verbatim at the moment it happened.
//        d. otherwise, read `handle.logPath` directly via the injected
//           (optional) `deps.fs.readFile` -- never a real `node:fs` import
//           here -- since the supervisor's own log route already said 404
//           above, but the file itself can outlive the supervisor's
//           bookkeeping (see this task's incident fixture log). Classified
//           exactly like step 2.
//        e. if NONE of (c)/(d) yields a decisive outcome, this still
//           returns a non-null snapshot (`buildFallbackSnapshot(id, null,
//           now())`, health: 'unknown') rather than `null` -- "identified,
//           outcome unknown" is a real, different answer from "nothing
//           known at all", and an operator must be able to tell them apart.
//   4. The ONLY remaining `null` case: no spool injected, or the spool has
//      no handle for this id at all. That is genuinely "never existed, or
//      truly lost" -- this module does not paper over a real absence with a
//      guess (never invents a phase, a cycle, or an outcome it cannot
//      substantiate -- see snapshot.mjs's `buildTerminalFromEvidence()` for
//      why `cycle` is `null`, not `0`, once evidence-based).
//
// A genuine `getSprint`/`getLog`/`fs.readFile` failure (SUPERVISOR_UNAVAILABLE,
// SUPERVISOR_UNAUTHORIZED, a permission error reading the log file, ...) is
// NEVER swallowed into a `null` result for `getSprint`/`getLog` -- only the
// two documented "not found" signals (both calls answering with their own
// `null`) proceed to the spool fallback above. A log-FILE read failure
// (step 3d) IS swallowed (logged, degrades to step 3e): that read is a
// best-effort improvement on top of an already-degraded path, and must
// never make `status` throw where it previously returned a snapshot.
//
// Nothing here reaches for `process.env`, `node:fs`, or a real `fetch`
// directly -- `deps.spool` and `deps.fs` (both OPTIONAL, duck-typed) are the
// only new collaborators, and this verb still performs no writes at all:
// `deps.spool` is used for `.read()` ONLY, never `.write()`/`.claim()`/
// anything else -- injected I/O only, per this package's rule.
//
// ASCII only.

import { BridgeError, BRIDGE_ERROR_CODES } from '../errors.mjs';
import {
  toProgressSnapshot,
  snapshotFromLogTail,
  buildFallbackSnapshot,
  classifyTerminalLog,
  buildTerminalFromEvidence,
} from '../snapshot.mjs';
import { DEFAULT_LOG_TAIL_LINES } from './watch.mjs';

const noopLog = () => {};

// ---------------------------------------------------------------------------
// Step 0: validate this verb's own inputs -- see watch.mjs/ingest.mjs for
// the same split (a pure opts validator, a pure internal deps validator).
// ---------------------------------------------------------------------------

/**
 * @param {{ sprintId?: string, logTailLines?: number }} opts
 * @returns {{ sprintId: string, logTailLines: number }} frozen, normalized
 * @throws {BridgeError} CONFIG_MISSING / CONFIG_INVALID
 */
export function validateStatusOpts(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};

  if (typeof o.sprintId !== 'string' || o.sprintId.length === 0) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'status: opts.sprintId is required (non-empty string)',
      { field: 'sprintId' }
    );
  }

  // Mirrors watch.mjs's own DEFAULT_LOG_TAIL_LINES default (imported, not
  // duplicated) so a status check's fallback and the daemon's watch loop
  // agree on how much log to pull by default.
  let logTailLines = DEFAULT_LOG_TAIL_LINES;
  if (o.logTailLines !== undefined) {
    if (typeof o.logTailLines !== 'number' || !Number.isInteger(o.logTailLines) || o.logTailLines <= 0) {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.CONFIG_INVALID,
        'status: opts.logTailLines must be a positive integer when provided',
        { field: 'logTailLines' }
      );
    }
    logTailLines = o.logTailLines;
  }

  return Object.freeze({ sprintId: o.sprintId, logTailLines });
}

/**
 * Validates `runStatus`'s injected `deps`, defaulting `log` to a no-op. A
 * missing injected dependency is CONFIG_MISSING, never a connectivity code
 * -- see the error-rule corollary in fleet-bridge-build-log.md: "a missing
 * injected dependency is never SUPERVISOR_UNAVAILABLE".
 *
 * `spool` and `fs` are both OPTIONAL and duck-typed, unlike
 * `supervisorClient`/`now`: a caller that omits them gets exactly the
 * pre-fix behaviour (both `getSprint` and `getLog` answering "not found" ->
 * a blank `null`) -- see the module header's step 4 for what supplying them
 * unlocks. This verb STILL performs no writes: `spool` is read-only here,
 * only `.read()` is ever called (never `.write()`/`.claim()`/anything
 * else), and `fs` is read-only too (only `.readFile()`).
 *
 * @param {{ supervisorClient?: object, now?: Function, log?: Function, spool?: object, fs?: object }} deps
 * @returns {{ supervisorClient: object, now: Function, log: Function, spool: object|null, fs: object|null }}
 * @throws {BridgeError} CONFIG_MISSING
 */
function validateStatusDeps(deps) {
  const d = deps && typeof deps === 'object' ? deps : {};

  if (!d.supervisorClient || typeof d.supervisorClient.getSprint !== 'function' || typeof d.supervisorClient.getLog !== 'function') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'status: deps.supervisorClient must expose getSprint() and getLog() -- none was provided to runStatus()',
      { param: 'deps.supervisorClient' }
    );
  }
  if (typeof d.now !== 'function') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'status: deps.now is required (injected clock; used only to stamp the log-tail fallback snapshot)',
      { param: 'deps.now' }
    );
  }

  return {
    supervisorClient: d.supervisorClient,
    now: d.now,
    log: typeof d.log === 'function' ? d.log : noopLog,
    spool: d.spool && typeof d.spool.read === 'function' ? d.spool : null,
    fs: d.fs && typeof d.fs.readFile === 'function' ? d.fs : null,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator.
// ---------------------------------------------------------------------------

/**
 * `fleet-bridge status`: one-shot read of a sprint's current
 * ProgressSnapshot. See the file-level doc comment for the full sequence,
 * the fallback this deliberately mirrors from watch.mjs, the spool/log-file
 * fallback chain that fixes the "unknown erases a real failure" incident,
 * and why a genuine infrastructure failure is never collapsed into a `null`
 * result.
 *
 * @param {{ sprintId: string, logTailLines?: number }} opts
 * @param {{ supervisorClient: object, now: Function, log?: Function, spool?: object, fs?: object }} deps
 * @returns {Promise<object|null>} a frozen ProgressSnapshot, or `null` ONLY
 *   when nothing at all is known about this sprint id anywhere -- `getSprint`,
 *   its `getLog` fallback, AND the spool (if injected) all came back empty.
 * @throws {BridgeError} CONFIG_MISSING, CONFIG_INVALID, and whatever the
 *   injected `supervisorClient` itself throws for a genuine infrastructure
 *   failure (SUPERVISOR_UNAVAILABLE, SUPERVISOR_UNAUTHORIZED) -- propagated
 *   unchanged, never collapsed into `null`.
 */
export async function runStatus(opts, deps) {
  const { sprintId, logTailLines } = validateStatusOpts(opts);
  const d = validateStatusDeps(deps);

  const sprint = await d.supervisorClient.getSprint(sprintId);
  if (sprint) {
    return toProgressSnapshot(sprint);
  }

  // getSprint found nothing -- fall back to the raw log exactly as
  // watch.mjs's own fallback does (module header). A genuine getLog failure
  // is NOT caught here: it propagates with its own BridgeError code, per
  // the error rule -- only getLog's own documented "no log file" answer
  // (null) is treated as part of the "nothing found via the supervisor"
  // outcome that proceeds to the spool below.
  const logTail = await d.supervisorClient.getLog(sprintId, { tail: logTailLines });

  if (logTail !== null) {
    // The supervisor is still reachable and still serves SOME text for this
    // id -- classify it for the engine's own terminal marker BEFORE
    // defaulting to a blind "unknown" (module header, step 2): this is
    // exactly the spot the observed incident's `health: 'unknown'` was
    // manufactured while a decisive "Sprint failed:" line was sitting right
    // there in the text.
    // snapshotFromLogTail() owns this classification for the whole package
    // (see its doc comment): watch.mjs had an independent, unfixed copy of
    // the same fork, so the rule now lives in exactly one place.
    const snapshot = snapshotFromLogTail(sprintId, logTail, d.now());
    if (snapshot.health === 'terminal') {
      d.log(`[status] sprint "${sprintId}" not found via getSprint, but its log tail shows a terminal outcome (${snapshot.verdict}) -- reporting terminal, not unknown`);
    } else {
      d.log(`[status] sprint "${sprintId}" not found via getSprint -- falling back to the log tail (health: unknown; no terminal marker in it)`);
    }
    return snapshot;
  }

  // Both getSprint's 404 and getLog's own "no log file" answer say "not
  // found via the supervisor" -- this is the exact moment the observed
  // incident degraded to `unknown` forever. Before answering with a blank
  // `null`, consult the durable spool (module header, step 3): the
  // SprintHandle `launch` wrote survives the supervisor forgetting the
  // sprint entirely (spool.mjs's file header).
  if (!d.spool) {
    d.log(`[status] sprint "${sprintId}" not found via getSprint or getLog, and no spool was injected to check for a handle -- reporting not-found (null)`);
    return null;
  }

  const doc = await d.spool.read(sprintId);
  if (!doc || !doc.handle) {
    // Genuinely nothing known anywhere: no live sprint, no log, no spool
    // record either. This is the ONE case that stays `null` -- module
    // header, step 4: an operator must be able to tell "this sprint never
    // existed, or is truly lost" apart from "it existed and we know how it
    // ended."
    return null;
  }
  const handle = doc.handle;

  // The daemon (daemon.mjs's runWorker) may already have recorded a durable
  // outcome on this very spool doc via spool.complete()/spool.fail() --
  // prefer that structured record over re-parsing raw text: it already
  // carries the engine's own thrown reason, captured verbatim at the moment
  // it happened.
  if (doc.finalize && doc.finalize.outcome === 'failed') {
    const reason = doc.finalize.error && typeof doc.finalize.error.message === 'string'
      ? doc.finalize.error.message
      : null;
    d.log(`[status] sprint "${sprintId}" not found via getSprint or getLog, but the spool recorded a failed finalize -- reporting terminal/failed`);
    return buildTerminalFromEvidence(sprintId, { outcome: 'failed', reason, updatedAt: d.now() });
  }
  if (doc.finalize && doc.finalize.outcome === 'completed') {
    d.log(`[status] sprint "${sprintId}" not found via getSprint or getLog, but the spool recorded a completed finalize -- reporting terminal/completed`);
    return buildTerminalFromEvidence(sprintId, { outcome: 'completed', reason: null, updatedAt: d.now() });
  }

  // No recorded finalize outcome on the spool -- the last durable source
  // left is the sprint's own log FILE at the handle's logPath (module
  // header, step 3d): the supervisor's HTTP log route already said 404
  // above, but the file itself can outlive the supervisor's own
  // bookkeeping (see this task's incident fixture log). A read failure here
  // (missing file, permission error, ...) is logged and swallowed -- this
  // is a best-effort improvement layered on an already-degraded path, and
  // must never make `status` throw where it previously returned a
  // snapshot.
  const logPath = handle.logPath;
  if (typeof logPath === 'string' && logPath.length > 0 && d.fs) {
    let fileText = null;
    try {
      fileText = await d.fs.readFile(logPath, 'utf-8');
    } catch (err) {
      d.log(`[status] sprint "${sprintId}" identified via the spool, but reading its log file "${logPath}" failed (degrading to identified-only): ${err && err.message ? err.message : err}`);
    }
    if (typeof fileText === 'string' && fileText.length > 0) {
      const classified = classifyTerminalLog(fileText);
      if (classified) {
        d.log(`[status] sprint "${sprintId}" identified via the spool; its log file at "${logPath}" shows a terminal outcome (${classified.outcome})`);
        return buildTerminalFromEvidence(sprintId, { ...classified, updatedAt: d.now(), logTail: fileText });
      }
    }
  }

  // Identified via the spool, but no outcome evidence anywhere (no recorded
  // finalize, no decisive log file) -- health legitimately unknown, but
  // NEVER the blank `null` the observed incident produced: the operator can
  // at least see this sprint existed (module header, step 3e).
  d.log(`[status] sprint "${sprintId}" identified via the spool, but no terminal evidence was found anywhere -- reporting health: unknown, not blank`);
  return buildFallbackSnapshot(sprintId, null, d.now());
}

export default runStatus;
