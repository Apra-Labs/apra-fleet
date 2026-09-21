// Derives a ProgressSnapshot (contracts.mjs) from the normalised sprint
// object supervisor-client.mjs's getSprint() returns:
// `{sprintId, live, terminal, state, history, latest}`. See the
// implementation plan's Part B ("snapshot.mjs -- sprint state ->
// ProgressSnapshot") and section 7 (observability).
//
// Pure, synchronous, no I/O -- this module has nothing to inject. `state`
// comes from another process and has typically been leaned
// (dedupeStrings()'d and re-inflated by supervisor-client.mjs's
// resolveStringRefs() call), so EVERY field access here assumes the thing
// above it may be missing, wrong-typed, or absent entirely. Nothing in this
// module ever throws on malformed input from that source -- see
// `currentPhase()` below, which is the one place the plan calls this out by
// name: "never throw on an unrecognised title -- new phases get added
// upstream and a bridge that crashes on one is worse than one that reports
// `cycle: null`."
//
// `toProgressSnapshot()` has no injected clock: its signature is
// `(sprint) -> ProgressSnapshot`, a pure function of its one argument, so
// `updatedAt` is read from the data itself (`state.updatedAt`, stamped by
// the engine -- see apra-fleet-workflow's phase-timestamp work) rather than
// a `Date.now()` call that would make an identical input produce a
// different snapshot on every call.
//
// -----------------------------------------------------------------------------
// CORRECTED PREMISE -- a prior fix here was built on a wrong diagnosis
// -----------------------------------------------------------------------------
// An earlier pass at this incident (status.mjs's own header tells the same
// story) was told that once a sprint's process exits, the supervisor
// "forgets" it and `GET /api/sprints/<id>` starts 404ing -- so the fix
// should be a fallback chain to the spool and the raw log file. That premise
// is FALSE for the common case. Verified live against a real failed sprint
// (ado_toy-e3z-1fbb61f0-5d7c-493a-b8a9-f5dfa86a0367): the supervisor answers
// `GET /api/sprints/<id>` with 200, not 404, and its `getSprint()` handler
// (packages/apra-fleet-se/src/supervisor/api.mjs, READ-ONLY reference) has a
// THIRD response shape this module never accounted for at all:
//
//   { sprintId, live:false, history:[...events], latest:{...} }
//
// -- no `state` key and no `terminal` key -- returned once the ledger has
// released its reservation for this sprint (auto-release fires within
// ~1s of the child exiting, per the watchdog) but its append-only,
// disk-persisted terminal-event history (packages/apra-fleet-se/src/
// supervisor/history.mjs) still remembers it, which survives even a
// supervisor restart (that file is reloaded on `history.start()`). This is
// now the ORDINARY steady state for any sprint that ever ran to completion,
// not an edge case -- yet the old code below only ever branched on
// `sprint.terminal` (shape `{live:false, terminal:true, state}`, the
// dashboard-linger window right after exit, before auto-release) or
// `sprint.live` (the running shape, `{live:true, state}`). Neither branch
// matches `{live:false, history, latest}`, so `state` came back `null`,
// `currentPhase(null)` returned `null`, and `health` fell through to
// `'unknown'` -- silently erasing a verbatim, structured failure reason that
// was sitting right there in `history`. `buildSnapshotFromHistory()` below
// is the fix: it reads this third shape directly.
//
// A genuine 404 is NOT impossible -- `getSprint()` still throws one when
// NEITHER the ledger nor the history log has anything for the id at all
// (an id that was never launched here, or a narrow race: the ledger's
// reservation survives a restart stale, its port is unresolvable, and
// the watchdog has not yet had a tick to append anything to history) -- so
// status.mjs's spool/log-file fallback chain for that case is kept; see its
// own header for why. What changes here is which path actually fires for
// an ORDINARY finished sprint: it is this module's history branch, not that
// fallback chain, and it fires on the FIRST read via `getSprint()`, not
// after both `getSprint()` and `getLog()` come up empty.

import { makeProgressSnapshot, validateProgressSnapshot } from './contracts.mjs';
import { computeSprintProgress } from '@apralabs/apra-fleet-se/fleet-sprint/sprint-progress.mjs';

/** Fallback phase name when no current phase can be derived at all (e.g. an empty tree). */
export const UNKNOWN_PHASE = 'unknown';

/**
 * Build the snapshot shape for the fallback case: when `getSprint` yielded
 * nothing but `getLog` did. Deliberately NOT run through `makeProgressSnapshot()`
 * (contracts.mjs): that function's frozen return copies only its own named
 * fields and would silently drop `logTail`, which is the entire point of this
 * fallback -- "the difference between 'we can see it crashed' and 'we have
 * nothing'" (implementation-plan.md Part B). `validateProgressSnapshot()` is
 * still run for its side-effect-free shape check (throws CONFIG_INVALID on a
 * malformed input) without stripping the extra field.
 *
 * @param {string} sprintId
 * @param {string|null} logTail
 * @param {number} updatedAt - epoch ms, from the injected `now()`.
 * @returns {object} a frozen snapshot carrying `logTail`
 */
export function buildFallbackSnapshot(sprintId, logTail, updatedAt) {
  const snapshot = {
    sprintId,
    phase: UNKNOWN_PHASE,
    cycle: 0,
    health: 'unknown',
    logTail: logTail ?? null,
    updatedAt,
  };
  validateProgressSnapshot(snapshot);
  return Object.freeze(snapshot);
}

/**
 * Recognise the sprint engine CLI's own two, and ONLY two, "this run just
 * ended" console lines (packages/apra-fleet-se/bin/cli.mjs:
 * `console.log('Sprint finished:', res)` on success, `console.error('Sprint
 * failed:', err)` on failure -- read-only reference, this package never
 * touches that file) inside a raw log tail, and turns them into a
 * `{ outcome, reason }` pair -- or `null` when NEITHER line is present,
 * meaning the log is not decisive (still running, truncated before either
 * line was written, or from a different code path entirely). This is the
 * one place this package infers a terminal outcome from unstructured log
 * text rather than the supervisor's structured state, so it is deliberately
 * narrow: it looks for these two exact, stable markers rather than trying
 * to parse the engine's log format in general.
 *
 * `reason` is populated ONLY for a failure, and is a VERBATIM slice of the
 * log -- everything from right after 'Sprint failed:' up to the first
 * stack-trace frame line (a line matching `/^\s*at\s/`), trimmed. This is
 * never reworded or summarized, by the same rule await-gate.mjs applies to
 * a live sprint's own `state.terminalReason` (see its
 * `colorForAwaitOutcome` doc comment: "the caller is expected to surface
 * `awaited.reason` verbatim, never reworded") -- an operator reading this
 * reason must see exactly what the engine itself printed, never this
 * package's paraphrase of it. A completion carries `reason: null`: there is
 * nothing to explain.
 *
 * @param {string|null|undefined} logText
 * @returns {{ outcome: 'failed', reason: string|null }|{ outcome: 'completed', reason: null }|null}
 */
export function classifyTerminalLog(logText) {
  if (typeof logText !== 'string' || logText.length === 0) return null;

  const FAILED_MARKER = 'Sprint failed:';
  const failedIdx = logText.indexOf(FAILED_MARKER);
  if (failedIdx !== -1) {
    const rest = logText.slice(failedIdx + FAILED_MARKER.length);
    const stackMatch = rest.match(/\n\s*at\s/);
    const reasonText = (stackMatch ? rest.slice(0, stackMatch.index) : rest).trim();
    return { outcome: 'failed', reason: reasonText.length > 0 ? reasonText : null };
  }

  const FINISHED_MARKER = 'Sprint finished:';
  if (logText.indexOf(FINISHED_MARKER) !== -1) {
    return { outcome: 'completed', reason: null };
  }

  return null;
}

/**
 * Build the ProgressSnapshot for a sprint the supervisor has TRULY forgotten
 * (a genuine 404 on both `getSprint` AND its own `getLog` -- see this
 * module's file-header "CORRECTED PREMISE" section: this is a narrow race
 * window, e.g. a restart-stale ledger reservation with an unresolvable port
 * and no watchdog tick yet, NOT the ordinary "sprint finished" case, which
 * `buildSnapshotFromHistory()` below now handles off `getSprint()`'s own
 * 200 response) but whose OUTCOME could still be recovered from durable
 * evidence that outlives the process -- either the spool's own recorded
 * `finalize()` result, or the raw log file at the handle's `logPath`,
 * classified by `classifyTerminalLog()` above. See status.mjs's file header
 * for the sequence this participates in.
 *
 * WHY THIS IS ITS OWN CONSTRUCTOR, NOT `buildFallbackSnapshot()`: that
 * function's `health: 'unknown'` (and its `cycle: 0`) is exactly what stood
 * in for -- and erased -- a genuine terminal failure in the observed
 * incident; widening it to sometimes mean "terminal" would make its one
 * remaining, still-legitimate case (log reachable, but genuinely
 * undecided -- no marker in it yet) ambiguous with this one. A snapshot
 * built here always carries `health: 'terminal'`: the sprint DID end, this
 * package just cannot see which phase it was in when it did. `cycle` is
 * `null`, never `0` -- `0` would read as "cycle zero happened," which is
 * not evidence this function has (see contracts.mjs's `validateProgressSnapshot`
 * for why `null` is now a legal `cycle`). `verdict` here is this package's
 * OWN coarse classification (`'failed'`/`'completed'`), not the engine's own
 * opaque verdict token (`verdictFromSprint`'s job, only available while the
 * supervisor still knows the sprint) -- `reason` is where the engine's own
 * words are preserved, verbatim, for a failure.
 *
 * Bypasses `makeProgressSnapshot()` the same way `buildFallbackSnapshot()`
 * does (`validateProgressSnapshot()` only, no field-stripping) so the extra
 * `reason` field survives -- the whole point of this snapshot is a failure
 * message the engine wrote, and a constructor that dropped it would defeat
 * the fix.
 *
 * @param {string} sprintId
 * @param {{ outcome: 'failed'|'completed', reason?: string|null, updatedAt: number, logTail?: string|null }} evidence
 * @returns {object} a frozen ProgressSnapshot with `health: 'terminal'` and a `reason` field
 */
export function buildTerminalFromEvidence(sprintId, { outcome, reason, updatedAt, logTail }) {
  const snapshot = {
    sprintId,
    phase: UNKNOWN_PHASE,
    cycle: null,
    health: 'terminal',
    verdict: outcome === 'failed' ? 'failed' : 'completed',
    reason: outcome === 'failed' ? (reason ?? null) : null,
    logTail: logTail ?? null,
    updatedAt,
  };
  validateProgressSnapshot(snapshot);
  return Object.freeze(snapshot);
}

/**
 * Parse a leading cycle number out of a free-text phase title, e.g.
 * 'Plan C1 R1' -> 1, 'Develop C2 R1' -> 2, 'Publish PR C1' -> 1. Returns
 * `null` -- never throws -- for a title with no recognisable `C<N>` token,
 * which is expected and normal: phase titles are free text with no API
 * contract (see the implementation plan's `--await-until phase:<regex>`
 * section), and new ones get added upstream over the program's life.
 * @param {any} title
 * @returns {number|null}
 */
export function parseCycleFromTitle(title) {
  if (typeof title !== 'string') return null;
  const match = title.match(/\bC(\d+)\b/);
  if (!match) return null;
  const cycle = Number.parseInt(match[1], 10);
  return Number.isInteger(cycle) ? cycle : null;
}

/**
 * Walk `state.tree` (an array of groups, each `{title, phases:[]}` -- the
 * same shape `apra-fleet-workflow/src/viewer/index.mjs` renders and
 * `await-gate.mjs`'s `collectPhaseTitles()` walks) and derive the CURRENT
 * phase: the last group's last phase. `phaseEndedAt === null` means that
 * phase is still running (apra-fleet-eft.53.1: the engine stamps
 * `phaseStartedAt` on entry and `phaseEndedAt` -- initially `null`, filled
 * in on exit -- for every phase).
 *
 * Returns `null` -- never throws -- for any malformed or absent shape: no
 * `state`, no `tree`, an empty tree, a group with no `phases`, or a last
 * phase missing a `title`. The state "carries no `currentPhase` field",
 * per the implementation plan, so `null` here means "not derivable from
 * this snapshot of state", not an error.
 *
 * @param {any} state
 * @returns {{title: string, cycle: number|null, startedAt: string|null, endedAt: string|null}|null}
 */
export function currentPhase(state) {
  if (!state || typeof state !== 'object') return null;

  const tree = state.tree;
  if (!Array.isArray(tree) || tree.length === 0) return null;

  const lastGroup = tree[tree.length - 1];
  const phases = lastGroup && typeof lastGroup === 'object' && Array.isArray(lastGroup.phases)
    ? lastGroup.phases
    : [];
  if (phases.length === 0) return null;

  const lastPhase = phases[phases.length - 1];
  if (!lastPhase || typeof lastPhase !== 'object' || typeof lastPhase.title !== 'string') {
    return null;
  }

  return {
    title: lastPhase.title,
    cycle: parseCycleFromTitle(lastPhase.title),
    startedAt: typeof lastPhase.phaseStartedAt === 'string' ? lastPhase.phaseStartedAt : null,
    // Deliberately NOT `?? null` -- `phaseEndedAt` legitimately IS `null`
    // while the phase is running, and that value must survive unchanged
    // (it is the running/finished discriminator), never collapsed with
    // "field absent".
    endedAt: lastPhase.phaseEndedAt === undefined ? null : lastPhase.phaseEndedAt,
  };
}

/**
 * Extract a `{title, cycle}` comparison key from either shape this module
 * hands around: a `currentPhase()` result (`.title`/`.cycle`) or a
 * `ProgressSnapshot` (`.phase`/`.cycle`) -- `phaseChanged()` accepts both so
 * `throttle.mjs`'s phase gate can compare two full snapshots directly
 * without re-deriving a bare phase tuple first.
 * @param {any} x
 * @returns {{title: string|null, cycle: number|null}}
 */
function phaseKey(x) {
  if (!x || typeof x !== 'object') return { title: null, cycle: null };
  const title = typeof x.phase === 'string'
    ? x.phase
    : (typeof x.title === 'string' ? x.title : null);
  const cycle = typeof x.cycle === 'number' ? x.cycle : null;
  return { title, cycle };
}

/**
 * Whether the phase changed between `prev` and `next` -- either may be
 * `null`/`undefined` (no prior announcement yet), a `currentPhase()`
 * result, or a `ProgressSnapshot`. A title change counts; a cycle change
 * under the SAME title also counts (a phase name repeating in a later
 * cycle, e.g. 'Plan C1 R1' -> 'Plan C2 R1', is a real transition and must
 * not be conflated with staying put). `null` <-> non-null in either
 * direction always counts as a change.
 * @param {any} prev
 * @param {any} next
 * @returns {boolean}
 */
export function phaseChanged(prev, next) {
  const a = phaseKey(prev);
  const b = phaseKey(next);
  return a.title !== b.title || a.cycle !== b.cycle;
}

/**
 * `sprint.state`, when present and object-shaped; `null` otherwise. Never
 * throws. Shared by every extractor below (and by `toProgressSnapshot()`
 * itself) so there is exactly one reading of "does this sprint have a
 * state object" in this module.
 * @param {any} sprint
 * @returns {object|null}
 */
function readSprintState(sprint) {
  return sprint && typeof sprint === 'object' && sprint.state && typeof sprint.state === 'object'
    ? sprint.state
    : null;
}

/**
 * Read a verdict off a supervisor-client.mjs `getSprint()` result, wherever
 * it lives. `sprint.latest` is the terminal record when the sprint is
 * purely historical (supervisor-client.mjs's third shape, a HistoryEvent
 * from `packages/apra-fleet-se/src/supervisor/history.mjs` carrying
 * `verdict` verbatim off the engine's own terminalReason/
 * `extensions.terminal.verdict`). When the sprint went terminal without
 * leaving live state (or the verdict was normalised straight onto `state`,
 * per `history-view.mjs`'s `state.result` shim), fall back to
 * `state.result.verdict` (the post-M2 opaque core result shape) or a bare
 * `state.verdict` (pre-M2 / legacy). Returns `undefined` -- never throws --
 * when none of these is present, which is the normal case for a sprint
 * still running.
 *
 * This is the single owner of verdict extraction for the package:
 * ../verbs/finalize.mjs imports this rather than keeping its own copy (see
 * that module's header for why the two were briefly separate). The
 * `undefined` sentinel (not `null`) is load-bearing here, not stylistic:
 * `toProgressSnapshot()` feeds this straight into `makeProgressSnapshot()`,
 * and contracts.mjs's `validateProgressSnapshot()` only special-cases
 * `undefined` for the optional `verdict` field -- passing `null` for the
 * (very common) still-running case would throw CONFIG_INVALID on every
 * live-sprint poll.
 * @param {any} sprint
 * @returns {string|undefined}
 */
export function verdictFromSprint(sprint) {
  if (sprint && sprint.latest && typeof sprint.latest === 'object' && typeof sprint.latest.verdict === 'string') {
    return sprint.latest.verdict;
  }
  const state = readSprintState(sprint);
  if (state) {
    if (state.result && typeof state.result === 'object' && typeof state.result.verdict === 'string') {
      return state.result.verdict;
    }
    if (typeof state.verdict === 'string') return state.verdict;
  }
  return undefined;
}

/**
 * Read the PR URL off a `getSprint()` result -- `state.result.prUrl` (post-M2
 * opaque core result), else a bare `state.prUrl` (pre-M2 / legacy). Unlike
 * verdict, no HistoryEvent (`sprint.latest`) ever carries a prUrl (see
 * apra-fleet-se/src/supervisor/history.mjs), so that source is not checked
 * here. Returns `undefined` -- never throws -- when neither is present, for
 * the same reason `verdictFromSprint()` does: this package's convention
 * for "absent" on these three extractors is `undefined`, never `null`, so
 * callers can treat all three identically.
 * @param {any} sprint
 * @returns {string|undefined}
 */
export function prUrlFromSprint(sprint) {
  const state = readSprintState(sprint);
  if (state) {
    if (state.result && typeof state.result === 'object' && typeof state.result.prUrl === 'string') {
      return state.result.prUrl;
    }
    if (typeof state.prUrl === 'string') return state.prUrl;
  }
  return undefined;
}

/**
 * Read total spend (`state.stats.totalCost`) off a `getSprint()` result --
 * the same field `toProgressSnapshot()` reads for `spendUsd`. Returns
 * `undefined` -- never throws -- when absent (see `verdictFromSprint()`'s
 * doc comment for why `undefined`, not `null`, is the required sentinel).
 * @param {any} sprint
 * @returns {number|undefined}
 */
export function spendUsdFromSprint(sprint) {
  const state = readSprintState(sprint);
  const stats = state && typeof state.stats === 'object' ? state.stats : null;
  return stats && typeof stats.totalCost === 'number' ? stats.totalCost : undefined;
}

/** Parse an ISO string or epoch number into epoch ms, or `0` if absent/unparsable -- a visible sentinel, never a wall-clock read. Shared by `resolveUpdatedAt()` (a `state.updatedAt`) and `buildSnapshotFromHistory()` (a HistoryEvent's `at`). */
function parseEpochMs(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 0;
}

/** Parse `state.updatedAt` (ISO string or epoch number) into epoch ms, or `0` if absent/unparsable -- a visible sentinel, never a wall-clock read. */
function resolveUpdatedAt(state) {
  if (!state || typeof state !== 'object') return 0;
  return parseEpochMs(state.updatedAt);
}

// Event names recorded by apra-fleet-se's terminal-event history log
// (packages/apra-fleet-se/src/supervisor/history.mjs's HISTORY_EVENTS,
// READ-ONLY reference -- not imported: that module is internal to the
// supervisor package, and this bridge already treats every field it reads
// off a `sprint` object as a documented but foreign wire contract, never an
// in-process dependency). Only the two whose fields `buildSnapshotFromHistory()`
// actually reads are named here; the others ('launch-failed',
// 'aborted-by-restart', 'force-released') are legitimate entries in
// `history` too, they just carry nothing this module surfaces today.
const HISTORY_EVENT_FINISHED = 'finished';
const HISTORY_EVENT_CHILD_EXITED = 'child-exited';

/**
 * The most recent entry in a HistoryEvent array whose `event` matches
 * `eventName`, or `null` -- never throws on a malformed/absent array or a
 * malformed entry. Searches from the end because a sprint's history is
 * append-only and chronological (history.mjs's own file header), so the
 * LAST matching entry is the most recent one, matching history.mjs's own
 * `latestFor()`/`latestForIssueRoot()` search direction.
 * @param {any[]|null|undefined} history
 * @param {string} eventName
 * @returns {object|null}
 */
function findLastHistoryEvent(history, eventName) {
  if (!Array.isArray(history)) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry && typeof entry === 'object' && entry.event === eventName) return entry;
  }
  return null;
}

/**
 * Build the ProgressSnapshot for `getSprint()`'s third response shape --
 * `{live:false, history, latest}`, no `state` at all -- the shape returned
 * once the ledger has released a sprint but its durable history log still
 * remembers it (see this module's file-header "CORRECTED PREMISE" section
 * for the incident this fixes). Unlike `buildTerminalFromEvidence()`
 * (built for the genuinely-404 case, one flat `{outcome, reason}` already
 * classified by the caller), this reads STRUCTURED fields the supervisor
 * itself recorded, spread across more than one event.
 *
 * MERGE PRECEDENCE (deliberate, not "just read `latest`" -- `latest` is
 * whichever event happened chronologically last, which in the observed
 * incident was 'auto-released', carrying neither a verdict nor a
 * terminalReason at all):
 *   - `verdict` and `reason` (the engine's own `terminalReason`, surfaced
 *     VERBATIM -- same rule `classifyTerminalLog()`'s doc comment states for
 *     a scraped log line) come from the most recent 'finished' event ONLY --
 *     that is the one and only event watchdog.mjs's recordFinished() stamps
 *     them onto. Both are absent (verdict `undefined`, reason `null`) when
 *     no 'finished' event was ever recorded, e.g. a 'launch-failed'
 *     incarnation -- never backfilled from `latest`'s own supervisor-authored
 *     `reason` text (that is this package's OWN prose describing what the
 *     watchdog did, not the engine's words, and must never be presented as
 *     if it were `terminalReason`).
 *   - `exitCode` and `logPath` come from the most recent 'child-exited'
 *     event ONLY -- the one event the spawner's own exit listener stamps
 *     them onto (see this module's file header). With the raw-log HTTP
 *     route requiring a live/still-reserved child or a history-recorded
 *     path to resolve at all, this `logPath` is frequently the only
 *     surviving route to the sprint's full output once it is gone.
 *   - `updatedAt` is the LATEST event's own timestamp (`latest.at`),
 *     falling back to the last entry in `history` if `latest` itself is
 *     absent -- whichever event happened last is the freshest truth for
 *     "when did this snapshot's information change", independent of which
 *     event carried the fields above.
 *
 * `health` is unconditionally `'terminal'`: `getSprint()` only returns this
 * shape once the ledger reservation for this id is gone (module header),
 * so simply landing here -- with ANY history for this id -- is itself
 * decisive terminal evidence; there is no "history present but still
 * running" case to guard against. `cycle` is `null`, never `0`, for the
 * same reason `buildTerminalFromEvidence()` documents: this constructor has
 * no phase tree to read a cycle off, and `0` would misrepresent that as
 * "cycle zero happened".
 *
 * @param {string} sprintId
 * @param {any[]|null|undefined} history
 * @param {any|null|undefined} latest
 * @returns {object} a frozen ProgressSnapshot with health:'terminal'
 * @throws {import('./errors.mjs').BridgeError} CONFIG_INVALID via
 *   `validateProgressSnapshot()` if `sprintId` is missing/blank.
 */
function buildSnapshotFromHistory(sprintId, history, latest) {
  const finished = findLastHistoryEvent(history, HISTORY_EVENT_FINISHED);
  const childExited = findLastHistoryEvent(history, HISTORY_EVENT_CHILD_EXITED);

  const verdict = finished && typeof finished.verdict === 'string' ? finished.verdict : undefined;
  const reason = finished && typeof finished.terminalReason === 'string' ? finished.terminalReason : null;
  const exitCode = childExited && typeof childExited.exitCode === 'number' ? childExited.exitCode : null;
  const logPath = childExited && typeof childExited.logPath === 'string' ? childExited.logPath : null;

  const latestAt = latest && typeof latest === 'object' && typeof latest.at === 'string' ? latest.at : undefined;
  const lastHistoryEntry = Array.isArray(history) && history.length > 0 ? history[history.length - 1] : null;
  const fallbackAt = lastHistoryEntry && typeof lastHistoryEntry.at === 'string' ? lastHistoryEntry.at : undefined;

  const snapshot = {
    sprintId,
    phase: UNKNOWN_PHASE,
    cycle: null,
    health: 'terminal',
    verdict,
    reason,
    exitCode,
    logPath,
    updatedAt: parseEpochMs(latestAt ?? fallbackAt),
  };
  validateProgressSnapshot(snapshot);
  return Object.freeze(snapshot);
}

/**
 * Is this sprint over? THE single answer to that question for the whole
 * package.
 *
 * WHY THIS EXISTS AS A SHARED HELPER, AND NOT AS A SECOND `sprint.terminal`
 * CHECK SOMEWHERE ELSE.
 *
 * `getSprint()` has three response shapes, and only the middle one carries a
 * `terminal` flag:
 *
 *   1. `{live: true,  state}`                  -- running
 *   2. `{live: false, terminal: true, state}`  -- the dashboard-linger window,
 *                                                 served from a persisted
 *                                                 `old_runs/*.json`
 *   3. `{live: false, history, latest}`        -- no `state`, no `terminal`:
 *                                                 the ledger reservation is
 *                                                 gone and only the durable
 *                                                 history log remembers it
 *
 * Shape 3 is the ORDINARY steady state of any finished sprint -- shape 2 is
 * the brief window right after exit. So a `!sprint.terminal` test reads as
 * "still running" for essentially every sprint anyone would actually ask
 * about, forever.
 *
 * `verbs/finalize.mjs` shipped exactly that test and therefore refused to
 * finalize a completed sprint, reporting it as "still live" while `live` was
 * plainly `false` -- two verbs in this package giving opposite answers about
 * the same sprint at the same moment. The cause was not the test being
 * subtly wrong; it was the rule having two implementations, so teaching one
 * of them about shape 3 left the other behind. One rule, one function.
 *
 * Deliberately CONSERVATIVE for the history shape: it requires an explicit
 * terminal event, not merely "the reservation is gone". Callers act on this
 * answer irreversibly -- finalize publishes carry-over to a real tracker --
 * and "I cannot see this sprint any more" is not the same fact as "this
 * sprint finished".
 *
 * @param {{live?: boolean, terminal?: boolean, history?: any}} sprint
 * @returns {boolean}
 */
export function isSprintTerminal(sprint) {
  if (!sprint || typeof sprint !== 'object') return false;
  // Shape 2: the supervisor said so outright.
  if (sprint.terminal === true) return true;
  // Shape 1: definitively still running.
  if (sprint.live === true) return false;
  // Shape 3: believe it only on an explicit end-of-life event. `auto-released`
  // and `force-released` are reservation bookkeeping -- they say the slot was
  // freed, which can also happen to a sprint nobody ever confirmed finished --
  // so they do NOT count on their own.
  const history = Array.isArray(sprint.history) ? sprint.history : [];
  return history.some(
    (entry) => entry
      && (entry.event === 'finished'
        || entry.event === 'child-exited'
        || entry.event === 'launch-failed'
        || entry.event === 'aborted-by-restart'),
  );
}

/**
 * Derive a `ProgressSnapshot` (contracts.mjs) from a sprint object as
 * `supervisor-client.mjs`'s `getSprint()` returns it. Every field is
 * optional-safe on the way in; `makeProgressSnapshot()` still enforces the
 * OUTPUT shape (so a sprint object missing even `sprintId` is a genuinely
 * malformed input, not a leaned-but-valid one, and correctly throws
 * `CONFIG_INVALID` via contracts.mjs -- this module adds no throw of its
 * own here, per the package's error rule).
 *
 * @param {{sprintId?: string, live?: boolean, terminal?: boolean, state?: any, history?: any, latest?: any}} sprint
 * @returns {object} a frozen ProgressSnapshot
 * @throws {import('./errors.mjs').BridgeError} CONFIG_INVALID if the derived shape is invalid (e.g. missing sprintId)
 */
export function toProgressSnapshot(sprint) {
  const state = readSprintState(sprint);

  // getSprint()'s third shape -- `{live:false, history, latest}`, no `state`
  // at all -- see this module's file-header "CORRECTED PREMISE" section.
  // Guarded on `!sprint.live` (never taken for the live-running shape,
  // `{live:true, state:null}`, which falls through to the ordinary path
  // below and keeps reporting health:'running' exactly as before -- rule 4
  // of this task's brief: live behaviour must not change at all) and on
  // actually having SOME history/latest evidence (an all-empty/absent
  // `{live:false, state:null, history:null, latest:null}` is not a shape
  // the real endpoint ever returns, but if one ever reached here, falling
  // through to `health:'unknown'` below is the honest answer, not a guess).
  if (!state && sprint && typeof sprint === 'object' && !sprint.live
      && ((Array.isArray(sprint.history) && sprint.history.length > 0)
        || (sprint.latest && typeof sprint.latest === 'object'))) {
    const sprintId = typeof sprint.sprintId === 'string' ? sprint.sprintId : undefined;
    return buildSnapshotFromHistory(sprintId, sprint.history, sprint.latest);
  }

  const phase = currentPhase(state);

  // The engine publishes `{sprintTasks, backlogTasks?, goalMax,
  // decomposedParentIds}` on `state.extensions.beads` (runner.js's
  // publishState('beads', payload)) -- it has never carried closed/required/
  // fraction directly. Those three are DERIVED via computeSprintProgress(),
  // the same pure reduction the sprint dashboard embeds client-side, so this
  // bridge's numbers can never drift from what the dashboard shows for the
  // same state.
  const beads = state && state.extensions && typeof state.extensions === 'object'
    ? state.extensions.beads
    : undefined;
  const sprintTasks = beads && typeof beads === 'object' ? beads.sprintTasks : undefined;
  const progress = beads && typeof beads === 'object'
    ? computeSprintProgress(sprintTasks, { goalMax: beads.goalMax, decomposedParentIds: beads.decomposedParentIds })
    : undefined;
  const closed = progress && typeof progress.closed === 'number' ? progress.closed : undefined;
  const required = progress && typeof progress.required === 'number' ? progress.required : undefined;
  const fraction = progress && typeof progress.fraction === 'number' ? progress.fraction : undefined;

  const spendUsd = spendUsdFromSprint(sprint);

  const health = sprint && sprint.terminal
    ? 'terminal'
    : (sprint && sprint.live ? 'running' : 'unknown');

  return makeProgressSnapshot({
    sprintId: sprint && typeof sprint.sprintId === 'string' ? sprint.sprintId : undefined,
    phase: phase && typeof phase.title === 'string' ? phase.title : UNKNOWN_PHASE,
    cycle: phase && typeof phase.cycle === 'number' ? phase.cycle : 0,
    health,
    closed,
    required,
    fraction,
    spendUsd,
    verdict: verdictFromSprint(sprint),
    updatedAt: resolveUpdatedAt(state),
  });
}
