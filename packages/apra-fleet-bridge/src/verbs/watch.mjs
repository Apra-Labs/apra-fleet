// watch.mjs -- fleet-bridge-implementation-plan.md Part B ("`fleet-bridge
// watch`") and fleet-bridge-design.md Section 6 ("`fleet-bridge watch`") /
// Section 7 (Observability).
//
// WHY THIS VERB EXISTS: the pipeline job that launched a sprint exits in
// minutes; the sprint itself runs for up to two days. `watch` is the process
// that keeps observing it after the job is gone -- polling the supervisor,
// handing every tick to the sink fan (7.3, the durable remote record) and to
// the platform adapter (7.4 layer 1, the work-item comment trail), and
// returning only when the sprint reaches a terminal state.
//
// INJECTED I/O ONLY (this package's rule, restated in the build log and in
// every sibling verb): `deps.supervisorClient`, `deps.adapter`, `deps.sinks`,
// `deps.spool`, `deps.sleep`, `deps.now`, `deps.log` all arrive via `deps`.
// `deps.adapter` in particular is the per-sprint facade from
// ../adapters/facade.mjs (createAdapterFacade()), not the raw registry
// adapter -- see that file's header for why a facade exists at all (the
// "adapter.comment has three incompatible signatures" fix) and for the
// work-item-targeting rule it now owns on this verb's behalf. This module
// only calls `adapter.emitProgress(snapshot)` / `adapter.comment(markdown)`,
// duck-typed against whatever it is handed.
// This module never imports `node:fs`, never calls a real `fetch`, and --
// load-bearing for a poll loop that runs for up to two days in a test process
// -- NEVER calls a real `setTimeout`/`setInterval`. Every wait goes through
// the injected `deps.sleep(ms)`; a real timer here would hang the suite.
//
// COOPERATIVE CANCELLATION (`deps.signal`, optional): a standard
// `AbortSignal`, not a bespoke flag -- `daemon.mjs` needs to interrupt a
// `runWatch` call that may otherwise run for up to two days (see that
// module's "CLEAN STOP" section), and `AbortSignal` is the platform's own
// answer to exactly that shape of problem, with no bespoke listener wiring
// for callers to get wrong. The signal is checked at the top of every loop
// iteration (so an abort mid-tick is caught before the next `getSprint`) and
// races the backoff `sleep()` (so an abort DURING a long sleep wakes the
// loop immediately rather than waiting out the rest of the backoff). An
// abort is an ORDERLY STOP, not a failure: this verb returns normally with
// whatever snapshot it last had (`null` if aborted before ever obtaining
// one), never throws, and never counts the abort itself as a WATCH_LOST
// failure tick. `deps.signal` is optional and duck-typed (only `.aborted`
// and `addEventListener`/`removeEventListener` are used); when absent,
// behaviour is exactly as before -- no existing caller needs to change.
//
// THE ERROR RULE (build-log.md): every throw crossing this module's boundary
// is a BridgeError. A missing/malformed `opts` field is CONFIG_MISSING /
// CONFIG_INVALID; a missing injected dependency is CONFIG_MISSING (a wiring
// defect, never a retryable code); the one deliberate exception this verb
// adds to the taxonomy is WATCH_LOST (already reserved in errors.mjs), thrown
// only after `opts.giveUpMs` of CONTINUOUS supervisor failure -- see "give up
// only on persistent failure" below.
//
// -----------------------------------------------------------------------------
// FOUR BEHAVIOURS THAT MATTER MORE THAN THE HAPPY PATH
// -----------------------------------------------------------------------------
//
// 1. ADAPTER AND SINK FAILURES ARE NEVER FATAL. `sinks/index.mjs`'s fan
//    already isolates one sink's failure from the others; this module goes
//    one step further and isolates the FAN ITSELF (its `emit()`/`flushNow()`
//    calls are wrapped too, defensively, even though neither is documented to
//    throw) and the adapter's `emitProgress`/`comment` calls, each in their
//    own try/catch. A failing comment API must never end a two-day
//    observation run.
//
// 2. FALLBACK TO THE RAW LOG. When `getSprint` returns null or throws, this
//    loop falls back to `getLog(sprintId, {tail})` -- the one surface that
//    still answers when a sprint died before writing structured state. A
//    successful `getLog` call (even one that returns no text -- see
//    supervisor-client.mjs: 404 there means "no log file", not "supervisor
//    down") still counts as a reachable supervisor and yields a snapshot
//    carrying the log tail with `health: 'unknown'`.
//
// 3. GIVE UP ONLY ON PERSISTENT FAILURE. A tick fails only when BOTH
//    `getSprint` and its `getLog` fallback fail to produce anything (either
//    threw, or `getSprint` found nothing and `getLog` also threw). The first
//    such tick starts a failure-streak clock; a LATER tick that produces
//    anything at all (a sprint, or merely a reachable-but-empty log) resets
//    it. Only `opts.giveUpMs` (default 15 min) of UNBROKEN failure throws
//    WATCH_LOST -- one transient blip must never end the run.
//
// 4. SINGLE-WRITER ENFORCEMENT (the blob-sink gate). See `applySinkGate()`
//    below for the exact contract this verb assumes for `deps.sinks` entries.
//
// ASCII only.

import { BridgeError, BRIDGE_ERROR_CODES } from '../errors.mjs';
import { createSinkFan } from '../sinks/index.mjs';
import { createSinkHealthMonitor } from '../sinks/health.mjs';
import { createBackoff, createPhaseGate } from '../throttle.mjs';
import { toProgressSnapshot, buildFallbackSnapshot, UNKNOWN_PHASE } from '../snapshot.mjs';

/** Give-up threshold: how long the supervisor may be UNREACHABLE (never
 *  merely "sprint not found yet") before this verb throws WATCH_LOST. */
export const DEFAULT_GIVE_UP_MS = 15 * 60 * 1000; // 15 min

/** Default `tail` passed to the `getLog()` fallback. */
export const DEFAULT_LOG_TAIL_LINES = 200;

function safeMessage(err) {
  return err && err.message ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Step 0: validate this verb's own inputs -- see ingest.mjs/preflight.mjs for
// the same split (a pure opts validator, a pure deps validator).
// ---------------------------------------------------------------------------

/**
 * @param {{ sprintId?: string, giveUpMs?: number, logTailLines?: number }} opts
 * @returns {{ sprintId: string, giveUpMs: number, logTailLines: number }} frozen, normalized
 * @throws {BridgeError} CONFIG_MISSING / CONFIG_INVALID
 */
export function validateWatchOpts(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};

  if (typeof o.sprintId !== 'string' || o.sprintId.length === 0) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'watch: opts.sprintId is required (non-empty string)',
      { field: 'sprintId' }
    );
  }

  let giveUpMs = DEFAULT_GIVE_UP_MS;
  if (o.giveUpMs !== undefined) {
    if (typeof o.giveUpMs !== 'number' || !Number.isFinite(o.giveUpMs) || o.giveUpMs < 0) {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.CONFIG_INVALID,
        'watch: opts.giveUpMs must be a non-negative finite number when provided',
        { field: 'giveUpMs' }
      );
    }
    giveUpMs = o.giveUpMs;
  }

  let logTailLines = DEFAULT_LOG_TAIL_LINES;
  if (o.logTailLines !== undefined) {
    if (typeof o.logTailLines !== 'number' || !Number.isInteger(o.logTailLines) || o.logTailLines <= 0) {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.CONFIG_INVALID,
        'watch: opts.logTailLines must be a positive integer when provided',
        { field: 'logTailLines' }
      );
    }
    logTailLines = o.logTailLines;
  }

  return Object.freeze({ sprintId: o.sprintId, giveUpMs, logTailLines });
}

/**
 * Validates the collaborators every tick unconditionally needs. `deps.spool`
 * is validated separately, and only when `deps.sinks` actually contains a
 * `shared: true` entry -- see `applySinkGate()`.
 *
 * @param {object} deps
 * @returns {{ supervisorClient: object, sinkEntries: object[], sleep: Function, now: Function, adapter: object|null, spool: object|null, log: Function, signal: object|null }}
 * @throws {BridgeError} CONFIG_MISSING
 */
function validateWatchDeps(deps) {
  const d = deps && typeof deps === 'object' ? deps : {};

  const supervisorClient = d.supervisorClient;
  if (!supervisorClient || typeof supervisorClient.getSprint !== 'function' || typeof supervisorClient.getLog !== 'function') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'watch: deps.supervisorClient must expose getSprint() and getLog() -- none was provided',
      { param: 'deps.supervisorClient' }
    );
  }

  if (!Array.isArray(d.sinks)) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'watch: deps.sinks must be an array of { name, sink, shared? } entries -- none was provided',
      { param: 'deps.sinks' }
    );
  }

  if (typeof d.sleep !== 'function') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'watch: deps.sleep is required (never a real timer -- see the file header)',
      { param: 'deps.sleep' }
    );
  }
  if (typeof d.now !== 'function') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'watch: deps.now is required (injected clock)',
      { param: 'deps.now' }
    );
  }

  const adapter = d.adapter && typeof d.adapter === 'object' ? d.adapter : null;
  const spool = d.spool && typeof d.spool.read === 'function' ? d.spool : null;
  const log = typeof d.log === 'function' ? d.log : () => {};

  // Optional, duck-typed: any object exposing `.aborted` plus
  // `addEventListener`/`removeEventListener` works, not only a real
  // `AbortSignal` -- but the real thing is what every caller actually hands
  // in. Absent entirely, this verb behaves exactly as it did before
  // cancellation existed (see the file header).
  const signal = d.signal && typeof d.signal === 'object' ? d.signal : null;

  return { supervisorClient, sinkEntries: d.sinks, sleep: d.sleep, now: d.now, adapter, spool, log, signal };
}

// ---------------------------------------------------------------------------
// The blob-sink gate (single-writer enforcement).
// ---------------------------------------------------------------------------
//
// THE CONTRACT THIS VERB ASSUMES FOR `deps.sinks` ENTRIES (the append-blob
// sink does not exist yet -- fleet-bridge-implementation-plan.md Part B lists
// it as a future file under `src/sinks/`; this is the contract it must
// conform to when it lands):
//
//   { name: string, sink: { emit, start?, flushNow?, stop? }, shared?: true }
//
// `shared: true` marks a sink whose backing store is a SINGLE remote resource
// two writers could both advance (the append-blob sink's `appendpos`
// cursor is the motivating case -- two daemons both believing they own a
// sprint corrupt it silently, per spool.mjs's file-level doc comment and
// `claim()`'s fail-safe default). A sink with no `shared` marker (or
// `shared: false`) is LOCAL-ONLY (e.g. a per-process JSONL mirror) and is
// never gated, no matter what `deps.spool` reports.
//
// The gate: if ANY entry in `deps.sinks` is marked `shared: true`, this verb
// reads the spool's claim record for this sprint via the injected
// `deps.spool.read(sprintId)`. If a claim is present (non-null) --
// interpreted here as "a live watcher/daemon already owns this sprint's
// remote log", since `watch` itself has no liveness probe to second-guess
// that claim (spool.mjs's own `claim()` refuses to make that call without
// one) -- every `shared: true` entry is dropped from the fan BEFORE
// `createSinkFan()` is ever called, so the shared sink can never be enabled
// for this run at all. Every other entry (local-only) still runs.
//
// A `deps.spool` with no `read()` method is only an error if a shared sink
// actually needs gating; a run with no shared sinks configured never touches
// the spool.

/**
 * @param {object[]} sinkEntries
 * @param {{ sprintId: string }} opts
 * @param {{ spool: object|null, log: Function }} deps
 * @returns {Promise<object[]>} the entries to actually fan out to
 * @throws {BridgeError} CONFIG_MISSING if a shared sink is present but no spool was injected
 */
async function applySinkGate(sinkEntries, opts, deps) {
  const sharedEntries = sinkEntries.filter((e) => e && e.shared === true);
  if (sharedEntries.length === 0) return sinkEntries;

  if (!deps.spool) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'watch: deps.sinks includes a shared:true sink but no deps.spool was provided to check for a live claim',
      { param: 'deps.spool' }
    );
  }

  const doc = await deps.spool.read(opts.sprintId);
  const liveClaimExists = Boolean(doc && doc.claim);
  if (!liveClaimExists) return sinkEntries;

  const sharedNames = sharedEntries.map((e) => e.name).join(', ');
  deps.log(`[watch] a live spool claim exists for sprint "${opts.sprintId}" -- disabling shared sink(s) [${sharedNames}] to protect the single-writer invariant; local-only sinks remain enabled`);
  return sinkEntries.filter((e) => !(e && e.shared === true));
}

/**
 * The short markdown comment posted at a phase transition -- content per
 * fleet-bridge-design.md Section 7.4 layer 1: "phase, cycle, closed/required,
 * spend, health".
 * @param {object} snapshot
 * @returns {string}
 */
export function buildPhaseComment(snapshot) {
  const lines = [
    `**Phase:** ${snapshot.phase}`,
    `**Cycle:** ${snapshot.cycle}`,
  ];
  if (typeof snapshot.closed === 'number' || typeof snapshot.required === 'number') {
    const closed = typeof snapshot.closed === 'number' ? snapshot.closed : '?';
    const required = typeof snapshot.required === 'number' ? snapshot.required : '?';
    lines.push(`**Progress:** ${closed}/${required}`);
  }
  if (typeof snapshot.spendUsd === 'number') {
    lines.push(`**Spend:** $${snapshot.spendUsd.toFixed(2)}`);
  }
  lines.push(`**Health:** ${snapshot.health ?? 'unknown'}`);
  if (typeof snapshot.verdict === 'string' && snapshot.verdict.length > 0) {
    lines.push(`**Verdict:** ${snapshot.verdict}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Cooperative cancellation helper.
// ---------------------------------------------------------------------------

/**
 * `sleep(ms)`, but resolves the instant `signal` fires abort, whichever
 * comes first. Always removes its abort listener before returning (whichever
 * side won the race) so a loop calling this every tick for up to two days
 * never accumulates listeners on a long-lived signal. A no-op passthrough to
 * `sleep(ms)` when `signal` is absent -- this is the one place besides the
 * top-of-loop check that needs to know about cancellation at all.
 * @param {number} ms
 * @param {(ms: number) => Promise<void>} sleep
 * @param {{aborted: boolean, addEventListener: Function, removeEventListener: Function}|null} signal
 * @returns {Promise<void>}
 */
async function sleepInterruptible(ms, sleep, signal) {
  if (!signal) {
    await sleep(ms);
    return;
  }
  if (signal.aborted) return;

  let onAbort;
  const abortPromise = new Promise((resolve) => {
    onAbort = resolve;
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([sleep(ms), abortPromise]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

// ---------------------------------------------------------------------------
// The loop.
// ---------------------------------------------------------------------------

/**
 * Poll `supervisorClient.getSprint(sprintId)` on a widening backoff (5s
 * early, up to 60s -- `throttle.mjs`'s `createBackoff()` defaults already
 * match), building a `ProgressSnapshot` per tick and handing it to the sink
 * fan and to `adapter.emitProgress()`. On a phase transition (`createPhaseGate()`),
 * additionally `flushNow()`s the fan and posts a throttled comment via
 * `adapter.comment()` -- phase transitions ONLY, never per tick.
 *
 * Returns the terminal `ProgressSnapshot` once the sprint reaches a terminal
 * state. See the file header for the four behaviours (adapter/sink isolation,
 * log-tail fallback, give-up-on-persistent-failure, the blob-sink gate) that
 * matter more than this happy path.
 *
 * @param {{ sprintId: string, giveUpMs?: number, logTailLines?: number }} opts
 * @param {{
 *   supervisorClient: { getSprint: (sprintId: string) => Promise<any>, getLog: (sprintId: string, opts?: { tail?: number }) => Promise<string|null> },
 *   adapter?: { emitProgress?: (snapshot: object) => Promise<any>, comment?: (markdown: string) => Promise<any> },
 *     -- in practice this is the per-sprint facade built by
 *        ../adapters/facade.mjs (createAdapterFacade()), never the raw
 *        registry adapter: the facade is what normalizes `comment` to this
 *        single-string shape and degrades it to a no-op when the tracker
 *        cannot comment. See that file's header for why (the
 *        "adapter.comment has three incompatible signatures" fix). This
 *        verb only ever calls the two methods named above, duck-typed, so
 *        any object exposing them still works -- but the facade is the
 *        one that is actually wired in.
 *   sinks: Array<{ name: string, sink: object, shared?: boolean }>,
 *   spool?: { read: (sprintId: string) => Promise<object|undefined> },
 *   sleep: (ms: number) => Promise<void>,
 *   now: () => number,
 *   log?: (msg: string) => void,
 *   signal?: {aborted: boolean, addEventListener: Function, removeEventListener: Function},
 *     -- optional cooperative cancellation (see the file header). When it
 *        fires, this call returns normally with the last snapshot obtained
 *        so far (`null` if none yet) instead of continuing to poll.
 * }} deps
 * @returns {Promise<object|null>} the terminal ProgressSnapshot, or (only on
 *   cancellation via `deps.signal`) the last snapshot obtained before the
 *   abort, which may be `null`.
 * @throws {BridgeError} CONFIG_MISSING / CONFIG_INVALID for bad inputs;
 *   WATCH_LOST after `giveUpMs` of continuous supervisor failure. Never
 *   thrown for cancellation -- see `deps.signal` above.
 */
export async function runWatch(opts, deps) {
  const { sprintId, giveUpMs, logTailLines } = validateWatchOpts(opts);
  const { supervisorClient, sinkEntries, sleep, now, adapter, spool, log, signal } = validateWatchDeps(deps);

  const gatedEntries = await applySinkGate(sinkEntries, { sprintId }, { spool, log });
  const sinkFan = createSinkFan({ sinks: gatedEntries, log });

  // WHY A HEALTH MONITOR AND NOT JUST THE FAN'S stats(): the fan counts an
  // emit as a success the moment the sink accepts the record, and a
  // batching sink (sinks/append-blob.mjs) accepts every record instantly
  // whether or not a single byte ever reaches the remote. So a remote sink
  // that is failing for the whole sprint looks perfect in stats(). The
  // monitor asks each sink that publishes one for its OWN verdict on
  // whether its writes are landing, and escalates a sustained failure
  // loudly -- banner plus a work-item comment -- without ever ending the
  // run. See sinks/health.mjs's header for the full reasoning; the short
  // version is that "never kill the sprint" must not be allowed to become
  // "report success while doing nothing".
  //
  // The alert channel is the SAME adapter.comment() this verb already uses
  // for phase announcements: the pipeline job that launched the sprint
  // exited minutes in, so the work item is the only place an operator will
  // actually see this.
  const sinkHealth = createSinkHealthMonitor({
    log,
    now,
    alert: adapter && typeof adapter.comment === 'function'
      ? (text) => adapter.comment(text)
      : undefined,
  });

  const backoff = createBackoff();
  const phaseGate = createPhaseGate();

  let firstFailureAt = null;
  let lastSnapshot = null;

  try {
    for (;;) {
      if (signal && signal.aborted) {
        // Orderly stop, not a failure: return whatever we last had (possibly
        // `null`, if abort landed before the very first tick) without
        // touching the supervisor again and without throwing WATCH_LOST.
        log(`[watch] aborted via deps.signal for sprint "${sprintId}" -- stopping the poll loop and returning the last known snapshot`);
        return lastSnapshot;
      }

      let sprint;
      try {
        // eslint-disable-next-line no-await-in-loop
        sprint = await supervisorClient.getSprint(sprintId);
      } catch (err) {
        log(`[watch] getSprint("${sprintId}") failed: ${safeMessage(err)}`);
        sprint = null;
      }

      let snapshot = null;
      let gotData = false;

      if (sprint) {
        // toProgressSnapshot() never throws on malformed sprint STATE (see
        // snapshot.mjs's file header) -- it can only throw CONFIG_INVALID if
        // the sprint object itself lacks a sprintId, which would mean the
        // supervisor's own normalisation (supervisor-client.mjs's getSprint)
        // is broken. That is a genuine defect, not a transient failure this
        // loop should swallow, so it is deliberately NOT caught here.
        snapshot = toProgressSnapshot(sprint);
        gotData = true;
      } else {
        // Fallback: the one surface that still answers when a sprint died
        // before writing structured state (implementation-plan.md Part B).
        let logTail;
        let logCallFailed = false;
        try {
          // eslint-disable-next-line no-await-in-loop
          logTail = await supervisorClient.getLog(sprintId, { tail: logTailLines });
        } catch (err) {
          log(`[watch] getLog("${sprintId}") fallback failed: ${safeMessage(err)}`);
          logCallFailed = true;
        }
        if (!logCallFailed) {
          // The supervisor answered (even a 404-as-null "no log file yet" is
          // an answer, per supervisor-client.mjs) -- that is reachability,
          // whether or not there is any text to show.
          gotData = true;
          snapshot = buildFallbackSnapshot(sprintId, logTail ?? null, now());
        }
      }

      if (gotData) {
        firstFailureAt = null;
      } else {
        if (firstFailureAt === null) firstFailureAt = now();
        if (now() - firstFailureAt >= giveUpMs) {
          throw new BridgeError(
            BRIDGE_ERROR_CODES.WATCH_LOST,
            `watch: supervisor has been unreachable for sprint "${sprintId}" for at least ${giveUpMs}ms (both getSprint and the getLog fallback failed on every tick since); giving up`,
            { sprintId, giveUpMs }
          );
        }
      }

      if (snapshot) {
        lastSnapshot = snapshot;

        // Behaviour 1: isolate the fan and the adapter, individually, from
        // this loop. The fan already isolates per-sink internally; these
        // try/catches are this verb's own defence on top of that.
        try {
          // eslint-disable-next-line no-await-in-loop
          await sinkFan.emit(snapshot);
        } catch (err) {
          log(`[watch] sink fan emit() threw (isolated, continuing): ${safeMessage(err)}`);
        }

        // Checked on every tick, immediately after the emit that may have
        // filled a failing sink's buffer further. Cheap (a pure read of
        // already-recorded counters) and non-throwing by contract, but
        // isolated anyway -- this loop's whole discipline is that nothing
        // observational can end a sprint.
        try {
          // eslint-disable-next-line no-await-in-loop
          await sinkHealth.check(gatedEntries);
        } catch (err) {
          log(`[watch] sink health check threw (isolated, continuing): ${safeMessage(err)}`);
        }

        if (adapter && typeof adapter.emitProgress === 'function') {
          try {
            // eslint-disable-next-line no-await-in-loop
            await adapter.emitProgress(snapshot);
          } catch (err) {
            log(`[watch] adapter.emitProgress() threw (isolated, continuing): ${safeMessage(err)}`);
          }
        }

        if (phaseGate.shouldAnnounce(snapshot)) {
          try {
            // eslint-disable-next-line no-await-in-loop
            await sinkFan.flushNow();
          } catch (err) {
            log(`[watch] sink fan flushNow() threw (isolated, continuing): ${safeMessage(err)}`);
          }

          if (adapter && typeof adapter.comment === 'function') {
            try {
              // eslint-disable-next-line no-await-in-loop
              await adapter.comment(buildPhaseComment(snapshot));
            } catch (err) {
              log(`[watch] adapter.comment() threw (isolated, continuing): ${safeMessage(err)}`);
            }
          }
        }

        if (sprint && sprint.terminal === true) {
          return snapshot;
        }
      }

      // eslint-disable-next-line no-await-in-loop
      await sleepInterruptible(backoff.next(), sleep, signal);
    }
  } finally {
    // Best-effort: this verb created the fan, so it is the one that closes
    // it. `stop()` is itself isolated per-sink (sinks/index.mjs) and never
    // throws.
    await sinkFan.stop();

    // AFTER stop(), deliberately: stop() performs each sink's final flush,
    // so this is the only moment the report can state what truly never
    // reached the remote. A sink that failed only in the last minutes of a
    // sprint would otherwise never be escalated at all -- the tick that
    // would have noticed never comes.
    try {
      sinkHealth.finalReport(gatedEntries);
    } catch (err) {
      log(`[watch] sink health final report threw (isolated): ${safeMessage(err)}`);
    }
  }
}

export default runWatch;
