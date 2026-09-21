// daemon.mjs -- fleet-bridge-implementation-plan.md Part B ("`fleet-bridge
// daemon`"), implementation order item 12: "orchestration over already-tested
// pieces." This verb owns nothing of its own -- no HTTP, no bd invocation, no
// sink I/O -- it only decides WHICH sprint to work next and in WHAT order to
// call the two verbs that do the real work.
//
// INJECTED I/O ONLY (this package's rule, restated in every sibling verb):
// `deps.spool`, `deps.runWatch`, `deps.runFinalize`, `deps.sleep`, `deps.now`,
// `deps.isAlive`, `deps.log` all arrive via `deps`. This module never imports
// `node:fs`, never calls a real `fetch`, and -- load-bearing for a scan loop
// meant to run for days -- NEVER calls a real `setTimeout`/`setInterval`.
// Every wait goes through the injected `deps.sleep(ms)`, raced against an
// in-process (not a real timer) signal so `stop()` can interrupt it promptly.
//
// WHY `runWatch`/`runFinalize` ARE PLAIN `(handle[, signal]) => Promise`
// CALLBACKS, NOT THE REAL VERB FUNCTIONS' OWN `(opts, deps)` SIGNATURE:
// `verbs/watch.mjs`'s `runWatch` and `verbs/finalize.mjs`'s `runFinalize` each
// need their OWN large `deps` (supervisorClient, adapter, sinks, beads,
// secretName, ...) that this daemon has no business knowing about -- it is
// purely a scheduler. The caller that constructs a real daemon (the eventual
// `bin/fleet-bridge.mjs daemon` wiring) is expected to close over those real
// deps and hand this module two thin, pre-bound functions:
//   deps.runWatch(handle, signal) -> Promise<ProgressSnapshot>  (whatever runWatch resolves to; `signal` is this worker's own AbortSignal -- see "CLEAN STOP" below -- and the real binding is expected to fold it into runWatch's own `deps.signal`)
//   deps.runFinalize(handle)      -> Promise<object>            (whatever runFinalize resolves to; deliberately NOT given a signal -- see "CLEAN STOP")
// where `handle` is the exact `SprintHandle` object stored at
// `spoolDoc.handle` (contracts.mjs's `makeSprintHandle()` shape). This is
// also exactly what "the daemon can be tested without driving the real
// verbs" (the task brief) means: a daemon test's fakes are two bare
// functions, never a hand-rolled supervisorClient/adapter/sinks stack.
//
// -----------------------------------------------------------------------------
// FOUR BEHAVIOURS THAT MATTER MORE THAN THE HAPPY PATH (see the task brief;
// restated here because they drove every design choice below)
// -----------------------------------------------------------------------------
//
// 1. PER-SPRINT ISOLATION. Every sprint's worker runs inside its own
//    try/catch (`runWorker`); a thrown error there is captured into
//    `spool.fail()` and logged, never allowed to reach the scan loop or any
//    other sprint's worker. `scanOnce()` wraps each spool entry's own
//    consideration in a try/catch too, so a single malformed/corrupt entry
//    (the spool module already quarantines genuinely corrupt files on disk,
//    but a fake spool in a test -- or a future spool implementation -- might
//    still hand back something unreadable) can never stop the rest of the
//    scan.
//
// 2. SINGLE-WRITER, ENFORCED NOT ASSUMED. This module never decides on its
//    own that a sprint is unclaimed -- it always calls `spool.claim()` and
//    respects the boolean it gets back. The one liveness JUDGEMENT this
//    module makes itself is restart recovery (see 3 below): whether an
//    EXISTING claim recorded in the spool belongs to a process that is still
//    alive, using the injected `deps.isAlive`. When no `isAlive` was
//    injected, this module fails safe exactly like `spool.mjs` does: every
//    existing claim is treated as unresolvable, hence "assume alive, never
//    steal." `{ force: true }` is never passed to `claim()` -- a claim this
//    module decides to take over is always released first (via
//    `spool.release()`) and then claimed fresh, which works against ANY
//    spool implementation's `claim()`, not just one that understands `force`.
//
// 3. RESTART RECOVERY. `start()` runs exactly one scan (`scanOnce`) to
//    completion BEFORE returning -- this IS the recovery pass: it lists
//    every non-terminal (not completed/failed) spool entry, and for each:
//      - already being tracked by THIS daemon instance -> left alone (no-op);
//      - carrying a claim whose owner `deps.isAlive()` reports alive (or
//        unresolvable, see 2 above) -> left alone, owned elsewhere;
//      - carrying a claim whose owner is reported DEAD -> the claim is
//        cleared (`spool.release`) and re-claimed as ours;
//      - carrying no claim at all -> claimed as ours (this is also the
//        ordinary "a new handle appeared" path every later periodic scan
//        takes for a fresh handle -- restart recovery and steady-state
//        scanning are the SAME code path, deliberately).
//    Once (re-)claimed, the state recorded on the doc decides where the
//    worker re-enters: `finalizing` resumes at finalize only (safe to repeat
//    per finalize's own idempotent-by-`external_ref` contract); anything
//    else (`unknown`, `active`, `watching`) resumes at watch, then finalize.
//    Only after this first scan does `start()` kick off the periodic
//    background loop (unawaited -- it runs for the daemon's whole lifetime).
//
// 4. CLEAN STOP -- COOPERATIVE CANCELLATION, NOT A HARD CANCEL, NOT A PLAIN
//    DRAIN EITHER. `stop()` still stops the scan loop immediately (no new
//    sprint is ever claimed after `stop()` is called), but it no longer just
//    waits out whatever `runWatch` happens to be doing: it first SIGNALS
//    every in-flight worker's own `AbortController` (one per worker, created
//    in `startWorker()`), THEN awaits each worker's natural completion. This
//    is what "clean" means here -- not "instant", but "bounded by roughly one
//    poll interval" instead of "bounded by the sprint" (which, in production,
//    can legitimately run for up to two days -- this was the actual bug a
//    plain drain-only `stop()` had: a foreman that cannot be restarted inside
//    two days is not operable). The single-writer safety property a hard
//    cancel would have broken is UNCHANGED: `runWorker` never releases (or
//    keeps) a claim until the worker has genuinely stopped -- an aborted
//    `runWatch` is required to return normally (never throw) with its last
//    snapshot, per that module's own contract, so `runWorker` always sees a
//    definite outcome to act on, never a promise it had to abandon.
//
//    What `runWorker` does with an aborted-but-not-throwing `runWatch` return
//    matters just as much as the signalling itself: it is NOT treated as "the
//    sprint finished," because it usually has not. The discriminator is the
//    snapshot's own `health` field (`toProgressSnapshot()`'s `'terminal'`),
//    not the abort flag by itself -- a sprint that happens to reach terminal
//    in the same tick `stop()` fires still finalizes normally, abort or not.
//    Only a NON-terminal return while the signal is aborted is treated as "we
//    stopped watching, the sprint did not stop": `runFinalize` is skipped
//    entirely (calling it on an unfinished sprint would be worse than the bug
//    this fixes -- a premature/partial finalize), the claim is left exactly
//    where it was (`state: 'watching'`, claim still ours), and the last
//    snapshot is persisted. This is deliberately the SAME resume path restart
//    recovery (behaviour 3) already uses for any other still-`'watching'`
//    entry with a claim: the next time this pid/host starts (or another
//    daemon's `isAlive()` finds this pid dead), the existing dead-claim
//    takeover picks the sprint back up and calls `runWatch` again from
//    scratch. No new resume mechanism was invented for this -- it reuses the
//    one already covered by behaviour 3 and its own tests.
//
//    `runFinalize` deliberately receives NO signal and is never interrupted:
//    finalize is short, and cutting it off mid-way through publishing
//    carry-over could leave a partially-published batch, which is worse than
//    `stop()` waiting for it to finish. This asymmetry (watch is
//    cancellable, finalize is not) is intentional, not an oversight.
//
// ASCII only.

import { BridgeError, BRIDGE_ERROR_CODES } from '../errors.mjs';

/** Default cadence for the spool scan, per fleet-bridge-implementation-plan.md Part B. */
export const DEFAULT_SCAN_INTERVAL_MS = 10 * 1000; // 10s

/** Spool doc states this daemon never (re-)claims or works. */
const TERMINAL_STATES = Object.freeze(['completed', 'failed']);

function isTerminalState(state) {
  return TERMINAL_STATES.includes(state);
}

function safeMessage(err) {
  return err && err.message ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Step 0: validate this verb's own inputs -- see ingest.mjs/watch.mjs for the
// same split (a pure opts validator, a pure deps validator).
// ---------------------------------------------------------------------------

/**
 * @param {{ scanIntervalMs?: number, pid?: number, host?: string }} opts
 * @returns {{ scanIntervalMs: number, pid: number, host: string }} frozen, normalized
 * @throws {BridgeError} CONFIG_MISSING / CONFIG_INVALID
 */
export function validateDaemonOpts(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};

  let scanIntervalMs = DEFAULT_SCAN_INTERVAL_MS;
  if (o.scanIntervalMs !== undefined) {
    if (typeof o.scanIntervalMs !== 'number' || !Number.isFinite(o.scanIntervalMs) || o.scanIntervalMs <= 0) {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.CONFIG_INVALID,
        'daemon: opts.scanIntervalMs must be a positive finite number when provided',
        { field: 'scanIntervalMs' }
      );
    }
    scanIntervalMs = o.scanIntervalMs;
  }

  if (typeof o.pid !== 'number' || !Number.isFinite(o.pid)) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'daemon: opts.pid is required (this daemon process\'s pid, used as claim identity) -- callers pass process.pid; never guessed here',
      { field: 'pid' }
    );
  }
  if (typeof o.host !== 'string' || o.host.length === 0) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'daemon: opts.host is required (this machine\'s identity, used as claim identity)',
      { field: 'host' }
    );
  }

  return Object.freeze({ scanIntervalMs, pid: o.pid, host: o.host });
}

/**
 * @param {object} deps
 * @returns {{ spool: object, runWatch: Function, runFinalize: Function, sleep: Function, now: Function, isAlive: Function|null, log: Function }}
 * @throws {BridgeError} CONFIG_MISSING
 */
function validateDaemonDeps(deps) {
  const d = deps && typeof deps === 'object' ? deps : {};

  const spool = d.spool;
  const spoolOk = spool
    && typeof spool.list === 'function'
    && typeof spool.claim === 'function'
    && typeof spool.release === 'function'
    && typeof spool.patch === 'function';
  if (!spoolOk) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'daemon: deps.spool must expose list(), claim(), release(), and patch() -- none/incomplete was provided',
      { param: 'deps.spool' }
    );
  }

  if (typeof d.runWatch !== 'function') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'daemon: deps.runWatch is required -- injected (a bound (handle) => Promise callback), never imported directly (see file header)',
      { param: 'deps.runWatch' }
    );
  }
  if (typeof d.runFinalize !== 'function') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'daemon: deps.runFinalize is required -- injected (a bound (handle) => Promise callback), never imported directly (see file header)',
      { param: 'deps.runFinalize' }
    );
  }
  if (typeof d.sleep !== 'function') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'daemon: deps.sleep is required (never a real timer -- see the file header)',
      { param: 'deps.sleep' }
    );
  }
  if (typeof d.now !== 'function') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'daemon: deps.now is required (injected clock)',
      { param: 'deps.now' }
    );
  }

  // No default probe -- see spool.mjs's own doc comment on deps.isAlive for
  // the identical reasoning. When absent, this module fails safe: every
  // existing claim it encounters is treated as unresolvable, hence "assume
  // alive, never steal" (see restart recovery in considerDoc() below).
  const isAlive = typeof d.isAlive === 'function' ? d.isAlive : null;
  const log = typeof d.log === 'function' ? d.log : () => {};

  return { spool, runWatch: d.runWatch, runFinalize: d.runFinalize, sleep: d.sleep, now: d.now, isAlive, log };
}

// ---------------------------------------------------------------------------
// The scan.
// ---------------------------------------------------------------------------

/**
 * One full pass over the spool: claims every claimable non-terminal handle
 * and starts (fire-and-forget) a worker for it. Never throws -- a failure
 * listing the spool, or considering any single entry, is logged and
 * swallowed so the rest of the scan (and the caller's loop) always proceeds.
 * @param {object} ctx
 * @returns {Promise<void>}
 */
async function scanOnce(ctx) {
  let docs;
  try {
    docs = await ctx.spool.list((doc) => Boolean(doc) && !isTerminalState(doc.state));
  } catch (err) {
    ctx.log(`[daemon] spool.list() failed -- scan skipped this tick: ${safeMessage(err)}`);
    return;
  }
  if (!Array.isArray(docs)) return;

  for (const doc of docs) {
    // eslint-disable-next-line no-await-in-loop -- sequential CLAIM decisions
    // only; the actual work each claim starts runs independently (see
    // startWorker()), so this loop stays fast regardless of worker duration.
    try {
      await considerDoc(doc, ctx);
    } catch (err) {
      // A single malformed/corrupt spool entry (or a defect in considering
      // it) must never stop the scan of every other entry -- behaviour 1.
      ctx.log(`[daemon] error while considering a spool entry (isolated, scan continues): ${safeMessage(err)}`);
    }
  }
}

/**
 * Decides what, if anything, to do about one spool document: skip (already
 * tracked by us, or claimed and alive elsewhere, or stopping), take over a
 * dead claim, or claim a fresh one -- then, on a successful claim, starts a
 * worker for it. See the file header's behaviour 2/3 for the exact rules.
 * @param {object} doc
 * @param {object} ctx
 * @returns {Promise<void>}
 */
async function considerDoc(doc, ctx) {
  if (ctx.stopping) return;

  const sprintId = doc && doc.sprintId;
  if (typeof sprintId !== 'string' || sprintId.length === 0) {
    // A doc with no usable id is not something this daemon can claim or
    // track -- log and move on, never throw out of scanOnce's loop for it.
    ctx.log('[daemon] skipping a spool entry with no usable sprintId');
    return;
  }

  if (ctx.workers.has(sprintId)) return; // already being worked by us

  const existingClaim = doc.claim;
  if (existingClaim) {
    let alive;
    if (ctx.isAlive) {
      try {
        alive = Boolean(ctx.isAlive(existingClaim.pid, existingClaim.host));
      } catch (err) {
        ctx.log(`[daemon] isAlive() threw for "${sprintId}" (treated as unresolvable -> assume alive, never steal): ${safeMessage(err)}`);
        alive = true;
      }
    } else {
      // No probe injected -- fail safe, exactly like spool.mjs's own claim().
      alive = true;
    }
    if (alive) return; // owned elsewhere (or unresolvable); leave it alone

    // Dead claim: clear it, then fall through to claim it fresh below. This
    // never passes { force: true } -- releasing first works against ANY
    // spool implementation's claim(), not only one that understands force.
    try {
      await ctx.spool.release(sprintId);
    } catch (err) {
      ctx.log(`[daemon] failed to release the dead claim on "${sprintId}" (will still try to claim): ${safeMessage(err)}`);
    }
  }

  let claimed;
  try {
    claimed = await ctx.spool.claim(sprintId, { pid: ctx.pid, host: ctx.host });
  } catch (err) {
    ctx.log(`[daemon] spool.claim("${sprintId}") failed (skipping this tick): ${safeMessage(err)}`);
    return;
  }
  if (!claimed) return; // lost the race to another claimant

  startWorker(doc, ctx);
}

// ---------------------------------------------------------------------------
// The worker.
// ---------------------------------------------------------------------------

/**
 * Fires (does NOT await) the independent worker for one just-claimed sprint,
 * tracking it in `ctx.workers` for the duration -- this is what makes
 * per-sprint isolation real: `scanOnce` moves on to the next doc immediately.
 * @param {object} doc
 * @param {object} ctx
 */
function startWorker(doc, ctx) {
  const sprintId = doc.sprintId;
  // One AbortController per worker, never shared -- this is what lets
  // stop() signal every in-flight sprint's own runWatch call independently
  // (see the file header's behaviour 4). Plain global.AbortController, no
  // polyfill: this package's supported Node baseline already has it.
  const controller = new AbortController();
  const record = {
    sprintId, state: doc.state || 'unknown', startedAt: ctx.now(), error: null, lastSnapshot: null, controller,
  };
  ctx.workers.set(sprintId, record);

  const promise = runWorker(doc, record, ctx, controller.signal)
    .catch((err) => {
      // runWorker() isolates every business failure itself (spool.fail +
      // release, see below) and does not rethrow -- reaching this catch
      // means a defect in that isolation itself, which is worth a loud,
      // distinct log line rather than silently vanishing.
      ctx.log(`[daemon] worker for "${sprintId}" escaped its own error handling (defect): ${safeMessage(err)}`);
    })
    .finally(() => {
      ctx.workers.delete(sprintId);
    });

  record.promise = promise;
}

/**
 * Runs one sprint's worker to completion: watch-then-finalize (resuming at
 * watch for any non-`finalizing` recorded state) or finalize-only (resuming
 * at `finalizing`). Never rejects -- every failure is captured, recorded on
 * `record`, reported via `spool.fail()`, and the claim released, so ONE
 * sprint's failure can never affect any other (behaviour 1).
 *
 * `signal` is this worker's own `AbortController.signal` (see
 * `startWorker()`), threaded into `ctx.runWatch(handle, signal)` only --
 * `ctx.runFinalize` never receives it, deliberately (see the file header's
 * behaviour 4). If `stop()` fires the signal while watch is still running,
 * `runWatch` is contracted to return normally (never throw) with its last
 * snapshot; this function then tells a genuine sprint completion apart from
 * an interrupted one by the snapshot's own `health` field, NOT by the abort
 * flag alone -- a snapshot that reached `'terminal'` in the very same tick
 * still proceeds to finalize. An interrupted, non-terminal return skips
 * finalize entirely and leaves the claim exactly where it was, for restart
 * recovery (behaviour 3) to resume later -- see the file header for why that
 * reuses the existing dead-claim takeover rather than a new mechanism.
 *
 * @param {object} doc
 * @param {object} record
 * @param {object} ctx
 * @param {{aborted: boolean}} signal
 * @returns {Promise<void>}
 */
async function runWorker(doc, record, ctx, signal) {
  const sprintId = doc.sprintId;
  const handle = doc.handle;
  const resumeAtFinalizeOnly = doc.state === 'finalizing';

  try {
    if (!resumeAtFinalizeOnly) {
      record.state = 'watching';
      await safePatch(sprintId, (draft) => { draft.state = 'watching'; }, ctx);

      const snapshot = await ctx.runWatch(handle, signal);
      record.lastSnapshot = snapshot ?? null;

      const reachedTerminal = Boolean(snapshot && snapshot.health === 'terminal');
      if (signal.aborted && !reachedTerminal) {
        // stop() cut this watch short before the sprint actually finished.
        // This is an orderly stop, not a failure and not a completion:
        // persist whatever progress we have and return WITHOUT finalizing
        // (the sprint is not done) and WITHOUT releasing the claim (the work
        // is still ours -- restart recovery's existing dead-claim takeover,
        // already covered by its own tests, is what resumes it later).
        ctx.log(`[daemon] worker for "${sprintId}" stopped mid-watch on signal (not a failure) -- claim retained, resumes at 'watching' next scan/restart`);
        await safePatch(sprintId, (draft) => {
          draft.progress = snapshot ?? draft.progress ?? null;
        }, ctx);
        return;
      }

      // Durable checkpoint the instant watch resolves: this is what lets
      // finalizing-resume work after a crash/restart, and what makes
      // stop()'s graceful drain meaningful (progress is on disk well before
      // stop() would ever be called, not written specially at stop time).
      record.state = 'finalizing';
      await safePatch(sprintId, (draft) => {
        draft.progress = snapshot ?? draft.progress ?? null;
        draft.state = 'finalizing';
      }, ctx);
    } else {
      record.state = 'finalizing';
    }

    await ctx.runFinalize(handle);
    record.state = 'completed';
    // Deliberately no spool.complete() call here -- the real runFinalize
    // already performs it as its own step 7 (finalize.mjs), and a fake
    // runFinalize used in a daemon test is expected to do the same if the
    // test wants the spool doc's `state` to read 'completed' afterward (see
    // daemon.test.mjs). Duplicating it here would be a second writer to the
    // very field claim/complete exist to protect.
  } catch (err) {
    record.state = 'failed';
    record.error = safeMessage(err);
    ctx.log(`[daemon] worker for "${sprintId}" failed (isolated -- no other sprint is affected): ${safeMessage(err)}`);
    try {
      await ctx.spool.fail(sprintId, err);
    } catch (err2) {
      ctx.log(`[daemon] spool.fail("${sprintId}") itself failed: ${safeMessage(err2)}`);
    }
    try {
      await ctx.spool.release(sprintId);
    } catch (err2) {
      ctx.log(`[daemon] failed to release the claim on "${sprintId}" after its failure: ${safeMessage(err2)}`);
    }
  }
}

/** Best-effort spool.patch(): logs and swallows a failure rather than aborting the worker over a telemetry write. */
async function safePatch(sprintId, mutateFn, ctx) {
  try {
    await ctx.spool.patch(sprintId, mutateFn);
  } catch (err) {
    ctx.log(`[daemon] spool.patch("${sprintId}") failed (continuing): ${safeMessage(err)}`);
  }
}

// ---------------------------------------------------------------------------
// createDaemon()
// ---------------------------------------------------------------------------

/**
 * `fleet-bridge daemon`: scans the spool on `opts.scanIntervalMs`, claims and
 * works every claimable non-terminal handle via the injected
 * `runWatch`/`runFinalize` callbacks. See the file header for the full
 * behaviour contract (isolation, single-writer, restart recovery, clean
 * stop) and its one open ambiguity (stop() drains rather than cancels).
 *
 * @param {{ scanIntervalMs?: number, pid: number, host: string }} opts
 * @param {{
 *   spool: { list: Function, read?: Function, claim: Function, release: Function, patch: Function, complete?: Function, fail: Function },
 *   runWatch: (handle: object) => Promise<any>,
 *   runFinalize: (handle: object) => Promise<any>,
 *   sleep: (ms: number) => Promise<void>,
 *   now: () => number,
 *   isAlive?: (pid: number, host: string) => boolean,
 *   log?: (msg: string) => void,
 * }} deps
 * @returns {{ start: () => Promise<void>, stop: () => Promise<void>, readonly tracked: object }}
 * @throws {BridgeError} CONFIG_MISSING / CONFIG_INVALID at construction time.
 */
export function createDaemon(opts, deps) {
  const { scanIntervalMs, pid, host } = validateDaemonOpts(opts);
  const d = validateDaemonDeps(deps);

  const workers = new Map(); // sprintId -> { state, startedAt, error, lastSnapshot, promise }
  let started = false;
  let stopping = false;
  let stopSignal = null; // { promise, resolve } -- lets stop() interrupt the idle wait promptly, without a real timer
  let loopPromise = null;

  const ctx = {
    spool: d.spool,
    runWatch: d.runWatch,
    runFinalize: d.runFinalize,
    now: d.now,
    isAlive: d.isAlive,
    log: d.log,
    pid,
    host,
    workers,
    get stopping() { return stopping; },
  };

  function makeStopSignal() {
    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    return { promise, resolve };
  }

  /** `deps.sleep(ms)`, but resolves immediately if stop() is called first -- no real timer either way. */
  async function interruptibleSleep(ms) {
    await Promise.race([d.sleep(ms), stopSignal.promise]);
  }

  async function runPeriodicLoop() {
    while (!stopping) {
      // eslint-disable-next-line no-await-in-loop
      await interruptibleSleep(scanIntervalMs);
      if (stopping) break;
      // eslint-disable-next-line no-await-in-loop
      await scanOnce(ctx);
    }
  }

  return {
    /**
     * Runs one full recovery/claim scan to completion (this IS restart
     * recovery -- see the file header's behaviour 3), then starts the
     * background periodic scan loop. Idempotent: a second call while already
     * started is a no-op.
     * @returns {Promise<void>}
     */
    async start() {
      if (started) return;
      started = true;
      stopping = false;
      stopSignal = makeStopSignal();

      await scanOnce(ctx);

      loopPromise = runPeriodicLoop().catch((err) => {
        // Every awaited step inside runPeriodicLoop (interruptibleSleep,
        // scanOnce) is itself failure-isolated; reaching here means a
        // defect in the loop's own control flow, not ordinary bad input.
        d.log(`[daemon] scan loop crashed (defect): ${safeMessage(err)}`);
      });
    },

    /**
     * Stops claiming new sprints immediately, then signals every currently
     * in-flight worker's own `AbortController` (interrupting a mid-watch
     * `runWatch` promptly -- see the file header's behaviour 4) and AWAITS
     * each one to reach its own genuine stop before resolving. Only after
     * every worker has stopped does this release/patch any stale tracked
     * claim below -- never before. A no-op if not started.
     * @returns {Promise<void>}
     */
    async stop() {
      if (!started) return;
      stopping = true;
      if (stopSignal) stopSignal.resolve();
      if (loopPromise) await loopPromise;

      // Signal first, await second: this is what turns "bounded by the
      // sprint" into "bounded by roughly one poll interval" without ever
      // releasing a claim out from under a call that is still executing.
      for (const record of workers.values()) {
        if (record.controller) record.controller.abort();
      }

      const inFlight = Array.from(workers.values())
        .map((record) => record.promise)
        .filter(Boolean);
      await Promise.allSettled(inFlight);

      // Defensive only: runWorker's own finally() already removes a worker
      // from `workers` the instant its promise settles, so by the time
      // Promise.allSettled above resolves this should always be empty. If a
      // future defect ever leaves an entry behind, never exit stop() holding
      // a claim silently -- release it and say so.
      for (const [sprintId] of workers) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await d.spool.release(sprintId);
        } catch (err) {
          d.log(`[daemon] stop(): failed to release a stale tracked claim for "${sprintId}": ${safeMessage(err)}`);
        }
        workers.delete(sprintId);
      }

      started = false;
    },

    /** A point-in-time snapshot of every sprint this daemon instance is currently working, keyed by sprintId. */
    get tracked() {
      const snapshot = {};
      for (const [sprintId, record] of workers) {
        snapshot[sprintId] = {
          state: record.state,
          startedAt: record.startedAt,
          error: record.error,
          lastSnapshot: record.lastSnapshot,
        };
      }
      return snapshot;
    },
  };
}

export default createDaemon;
