// The `--await-until` gate: `awaitMilestone()` polls the supervisor for one
// sprint until a configurable milestone is reached, the sprint goes terminal
// before reaching it, or a timeout elapses -- see the "`--await-until`: the
// configurable hold" section of
// `packages/apra-fleet-se/docs/fleet-bridge-implementation-plan.md`.
//
// Every I/O seam (the supervisor client, `sleep`, `now`, the optional log
// fetcher for `readPlanState`'s fallback) is INJECTED via `deps` -- this
// module never touches a real clock, a real timer, or a real network call,
// per this package's injected-I/O rule. `spec` comes from `parseAwaitUntil()`
// in `contracts.mjs`.
//
// HARD INVARIANT: a timeout NEVER stops the sprint. This module holds no
// reference to any stop/cancel API at all -- there is nothing here that
// COULD issue one.

import { BridgeError, BRIDGE_ERROR_CODES } from './errors.mjs';
import { createBackoff } from './throttle.mjs';

/** Initial poll interval (ms) -- "poll 5s early". */
export const INITIAL_POLL_MS = 5000;

/** Poll interval ceiling (ms) -- "widening to 60s". */
export const MAX_POLL_MS = 60000;

/** Multiplicative backoff applied to the poll interval after every poll. */
export const POLL_BACKOFF_FACTOR = 2;

/** Fallback default timeout (ms) for any spec kind not named below. */
export const DEFAULT_TIMEOUT_FALLBACK_MS = 20 * 60 * 1000; // 20 min

/**
 * Per-kind default timeouts. "The timeout default scales with the spec (20
 * min for the plan milestones) and is overridable per pipeline" -- `cycle:N`
 * defaults much longer ("hours") since it is meant to span multiple cycles.
 * `launch` needs no timeout at all: it resolves before the loop ever polls.
 */
export const DEFAULT_TIMEOUT_MS_BY_KIND = Object.freeze({
  launch: 0,
  'plan-round': 20 * 60 * 1000,
  'plan-approved': 20 * 60 * 1000,
  'plan-settled': 20 * 60 * 1000,
  phase: 20 * 60 * 1000,
  cycle: 4 * 60 * 60 * 1000, // 4 hours
});

/** Render a parsed `AWAIT_UNTIL` spec back into its canonical string form, for messages. */
export function describeSpec(spec) {
  if (!spec || typeof spec.kind !== 'string') return String(spec);
  if (spec.kind === 'phase') return `phase:${spec.pattern ? spec.pattern.source : ''}`;
  if (spec.kind === 'cycle') return `cycle:${spec.cycle}`;
  return spec.kind;
}

/**
 * Walk `state.tree` (groups -> phases -> title, the same shape
 * `apra-fleet-workflow/src/viewer/index.mjs` renders) and collect every
 * phase title present. Never throws on a malformed/partial tree -- a phase
 * or group missing its expected shape is skipped, not fatal.
 * @param {any} tree
 * @returns {string[]}
 */
export function collectPhaseTitles(tree) {
  const titles = [];
  if (!Array.isArray(tree)) return titles;
  for (const group of tree) {
    const phases = group && Array.isArray(group.phases) ? group.phases : [];
    for (const phase of phases) {
      if (phase && typeof phase.title === 'string') titles.push(phase.title);
    }
  }
  return titles;
}

/**
 * Best-effort scrape of a plan-reviewer verdict out of a raw log tail, used
 * ONLY as `readPlanState`'s fallback when the engine's `state.extensions.plan`
 * channel is absent. This is NOT a present-day second source of coverage:
 * verified against the engine, no code path today writes a matching verdict
 * string to the log that `log-view.mjs` serves -- `plan.mjs` deliberately
 * does not log the plan-reviewer verdict, which is the entire reason the
 * `state.extensions.plan` channel was added in the first place. As things
 * stand, this fallback can NEVER succeed; it exists purely as a defence
 * against a future regression (the `plan` channel going missing, or changing
 * shape, out from under this gate), so that `readPlanState` still has
 * somewhere to degrade to instead of a hard failure. Finding nothing here is
 * therefore the ONLY possible outcome today, and that is fine: it means
 * `readPlanState` returns `null` and the gate keeps waiting rather than
 * hard-blocking.
 * @param {string} text
 * @returns {{status: string, verdict: string, approved: boolean}|null}
 */
export function scrapeVerdictFromLog(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const match = text.match(/plan-reviewer[^\n]*?verdict[^\n]*?[:=]\s*(APPROVED|CHANGES_NEEDED)/i)
    ?? text.match(/verdict\s*[:=]\s*(APPROVED|CHANGES_NEEDED)/i);
  if (!match) return null;
  const verdict = match[1].toUpperCase();
  return {
    status: verdict === 'APPROVED' ? 'approved' : 'iterating',
    verdict,
    approved: verdict === 'APPROVED',
  };
}

/**
 * Read the engine's published plan state for a sprint, with a documented
 * degrade path. Prefers `state.extensions.plan` (the A1 channel published by
 * `packages/apra-fleet-se/fleet-sprint/phases/plan.mjs`'s `publishPlanState`)
 * verbatim -- `{cycle, planningRounds, status, verdict, approved,
 * deferredIds, findings, notesSummary, updatedAt}`. When that channel is
 * absent (A1 not yet landed, or a shape change), falls back to scraping a log
 * tail via the injected `fetchLogTail`, returning a partial, best-effort
 * shape. Returns `null` -- not a thrown error -- when neither source yields
 * anything: the gate must DEGRADE, never hard-block, on a missing channel.
 *
 * @param {any} state - a sprint's (un-leaned) state object, or null/undefined.
 * @param {{ sprintId?: string, fetchLogTail?: (sprintId: string) => Promise<string|null> }} [deps]
 * @returns {Promise<object|null>}
 */
export async function readPlanState(state, deps = {}) {
  const plan = state && typeof state === 'object' && state.extensions && typeof state.extensions === 'object'
    ? state.extensions.plan
    : undefined;
  if (plan && typeof plan === 'object') return plan;

  if (typeof deps.fetchLogTail !== 'function') return null;
  let text;
  try {
    text = await deps.fetchLogTail(deps.sprintId);
  } catch {
    // The fallback is best-effort; a failure to fetch the log degrades to
    // "no plan state known yet", not an error the gate must surface.
    return null;
  }
  return scrapeVerdictFromLog(text);
}

/** Whether `spec` is satisfied by the currently-known plan state. */
function planMilestoneReached(spec, planState) {
  if (!planState) return false;
  switch (spec.kind) {
    case 'plan-round':
      // ANY verdict -- a CHANGES_NEEDED round counts, same as APPROVED.
      return typeof planState.planningRounds === 'number' && planState.planningRounds >= 1;
    case 'plan-approved':
      // Must NOT be satisfied by a plan-cap deferral: `approved` is true
      // ONLY on a clean APPROVED (see plan.mjs's publishPlanState -- a
      // deferral publishes status:'deferred', approved:false). This is the
      // entire reason the engine channel exists; do not weaken this check
      // to `status === 'approved' || status === 'deferred'`.
      return planState.approved === true;
    case 'plan-settled':
      return planState.status === 'approved' || planState.status === 'deferred';
    case 'cycle':
      return typeof planState.cycle === 'number' && planState.cycle >= spec.cycle;
    default:
      return false;
  }
}

function buildTimeoutReason(spec, observedPhaseTitles) {
  const desc = describeSpec(spec);
  let reason = `milestone '${desc}' not reached, now detached`;
  if (spec.kind === 'phase') {
    const titles = [...observedPhaseTitles];
    reason += titles.length > 0
      ? `; observed phase titles: ${titles.map((t) => JSON.stringify(t)).join(', ')}`
      : '; no phase titles were observed';
  }
  return reason;
}

/**
 * Poll the supervisor for `handle.sprintId` until `spec` is reached, the
 * sprint goes terminal without reaching it, or `timeoutMs` elapses.
 *
 * Outcomes are UNIFORM across every spec kind:
 *  - `'reached'`  -> caller exits green.
 *  - `'terminal'` -> caller exits red, `reason` is the engine's own
 *    terminal reason, carried VERBATIM (never wrapped, reworded, or
 *    truncated).
 *  - `'timeout'`  -> caller exits green with "milestone not reached, now
 *    detached" -- **a timeout NEVER stops the sprint** (this function holds
 *    no stop/cancel API to call in the first place).
 *
 * @param {{ sprintId: string }} handle
 * @param {{ kind: string, pattern?: RegExp, cycle?: number }} spec - from `parseAwaitUntil()`.
 * @param {object} deps
 * @param {{ getSprint: (sprintId: string) => Promise<any> }} deps.supervisorClient
 * @param {(ms: number) => Promise<void>} deps.sleep - injected; never a real timer in tests.
 * @param {() => number} deps.now - injected; returns epoch milliseconds.
 * @param {(sprintId: string) => Promise<string|null>} [deps.fetchLogTail] - forwarded to `readPlanState`'s fallback.
 * @param {{ timeoutMs?: number, pollMs?: number }} [opts]
 * @returns {Promise<{ outcome: 'reached'|'terminal'|'timeout', milestone: string, reason: string|null, snapshot: any }>}
 */
export async function awaitMilestone(handle, spec, deps, opts = {}) {
  if (!handle || typeof handle.sprintId !== 'string' || handle.sprintId.length === 0) {
    throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_INVALID, 'awaitMilestone() requires handle.sprintId', { handle });
  }
  if (!spec || typeof spec.kind !== 'string') {
    throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_INVALID, 'awaitMilestone() requires a parsed await-until spec', { spec });
  }
  const { supervisorClient, sleep, now, fetchLogTail } = deps ?? {};
  if (typeof sleep !== 'function') {
    throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_MISSING, 'awaitMilestone() requires deps.sleep', {});
  }
  if (typeof now !== 'function') {
    throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_MISSING, 'awaitMilestone() requires deps.now', {});
  }

  const milestone = describeSpec(spec);

  // `launch` is reached the instant the caller has a handle at all -- the
  // 201 already came back before this function is ever called. No polling,
  // no supervisor call, no clock read.
  if (spec.kind === 'launch') {
    return { outcome: 'reached', milestone, reason: null, snapshot: null };
  }

  if (typeof supervisorClient !== 'object' || typeof supervisorClient.getSprint !== 'function') {
    throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_MISSING, 'awaitMilestone() requires deps.supervisorClient.getSprint', {});
  }

  const timeoutMs = Number.isFinite(opts.timeoutMs)
    ? opts.timeoutMs
    : (DEFAULT_TIMEOUT_MS_BY_KIND[spec.kind] ?? DEFAULT_TIMEOUT_FALLBACK_MS);

  // The widening-then-capped poll schedule is throttle.mjs's createBackoff()
  // -- see watch.mjs/append-blob.mjs, which already reuse it the same way.
  // createBackoff()'s own defaults (initialMs 5000, maxMs 60000, factor 2)
  // are numerically identical to this gate's INITIAL_POLL_MS/MAX_POLL_MS/
  // POLL_BACKOFF_FACTOR, but the options are passed explicitly rather than
  // relied on implicitly, so this gate's documented poll sequence and
  // timeout meaning cannot silently change if createBackoff's defaults ever
  // drift. `opts.pollMs` (when a test passes one) becomes the backoff's
  // *initial* value, clamped to MAX_POLL_MS first: createBackoff requires
  // maxMs >= initialMs, so a pollMs above the ceiling is capped up front --
  // previously such a value was used uncapped for the very first sleep only
  // and capped from the second sleep on; no caller in this codebase passes
  // opts.pollMs above MAX_POLL_MS today, so this narrows an edge case rather
  // than changing any observed behaviour.
  const requestedInitialPollMs = Number.isFinite(opts.pollMs) && opts.pollMs > 0 ? opts.pollMs : INITIAL_POLL_MS;
  const backoff = createBackoff({
    initialMs: Math.min(requestedInitialPollMs, MAX_POLL_MS),
    maxMs: MAX_POLL_MS,
    factor: POLL_BACKOFF_FACTOR,
  });

  const startedAt = now();
  const observedPhaseTitles = new Set();
  let lastSnapshot = null;

  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const sprint = await supervisorClient.getSprint(handle.sprintId);
    if (sprint) {
      lastSnapshot = sprint;

      if (spec.kind === 'phase') {
        for (const title of collectPhaseTitles(sprint.state && sprint.state.tree)) {
          observedPhaseTitles.add(title);
          if (spec.pattern.test(title)) {
            return { outcome: 'reached', milestone, reason: `matched phase title ${JSON.stringify(title)}`, snapshot: sprint };
          }
        }
      } else {
        // eslint-disable-next-line no-await-in-loop
        const planState = await readPlanState(sprint.state, { sprintId: handle.sprintId, fetchLogTail });
        if (planMilestoneReached(spec, planState)) {
          return { outcome: 'reached', milestone, reason: null, snapshot: sprint };
        }
      }

      // Only report terminal AFTER checking whether this same read already
      // satisfied the milestone above -- a milestone that held true right
      // up to termination still counts as reached, not terminal-before-it.
      if (sprint.terminal) {
        const reason = (sprint.state && typeof sprint.state.terminalReason === 'string')
          ? sprint.state.terminalReason
          : 'sprint ended without reaching the requested milestone';
        return { outcome: 'terminal', milestone, reason, snapshot: sprint };
      }
    }

    if (now() - startedAt >= timeoutMs) {
      return { outcome: 'timeout', milestone, reason: buildTimeoutReason(spec, observedPhaseTitles), snapshot: lastSnapshot };
    }

    // eslint-disable-next-line no-await-in-loop
    await sleep(backoff.next());
  }
}
