// health.mjs -- escalation for a sink that is failing quietly.
//
// WHY THIS FILE EXISTS
// -----------------------------------------------------------------------------
// Two rules in this package pull in opposite directions, and this module is
// where they are reconciled.
//
//   Rule 1: a sink must never kill the sprint. `sinks/index.mjs` isolates
//   every sink from the caller, and `append-blob.mjs` goes further -- it
//   batches, so `emit()` only appends to an in-memory array and cannot fail
//   at all. A sprint that is two days in is the valuable thing; losing it
//   because a storage account rotated its key would be indefensible.
//
//   Rule 2: a component must never report success while doing nothing. That
//   pattern has bitten this codebase repeatedly (carry-over publication
//   exiting 0 having published nothing; a PR step reporting PASS having
//   raised no PR), and rule 1 is exactly how a sink arrives at it: with
//   batching plus per-sink isolation, a sink whose every append is 403'ing
//   is indistinguishable, from the fan's `stats()`, from one that is
//   working perfectly -- every record "succeeded" the moment it was buffered.
//
// The reconciliation: failures stay non-fatal, but they stop being quiet.
// A sink that chooses to publish a `health()` surface (`append-blob.mjs`
// and `jsonl-file.mjs`) gets watched; once it has failed `unhealthyAfter`
// consecutive flushes -- or ONCE, if it reports `terminal: true`, meaning
// the failure cannot self-heal (a dead file descriptor, as opposed to a
// 500 the next flush retries) -- it is escalated through two channels that
// a human actually sees:
//
//   1. A MULTI-LINE BANNER on the injected log. Deliberately a banner and
//      not a one-liner: `watch` runs for days and logs on every tick, and a
//      single warning line in that stream is functionally invisible -- it
//      scrolls past and nobody ever reads it. The banner names the sink,
//      how long it has been down, how many records are stranded in memory,
//      the last (redacted) failure, and -- load-bearing -- which sink is
//      still known-good, so the reader knows whether they have lost data or
//      only lost the remote copy.
//   2. An `alert()` CALLBACK, which `watch` wires to the work-item comment.
//      That is the operator's own channel: the pipeline job that started the
//      sprint exited minutes in, so a log line on a machine they are not
//      watching reaches nobody. Alerting is rate-limited to
//      `reAlertEveryMs` so a two-day outage produces a steady heartbeat
//      rather than either one lost message or hundreds.
//
// Recovery is announced too. "It started working again" is the other half of
// a trustworthy signal -- without it, an operator who saw the degradation
// banner has no way to learn the remote log caught up, and will assume the
// worst about a sprint that was fine.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO: it never stops, disables, or
// reconfigures a sink, and it never throws out of `check()`. Escalation is
// reporting only. Deciding that a degraded sink should end a run is a policy
// this package does not hold -- see docs/setup.md ("how you know it is
// working") for the operator-facing side of the same decision.
//
// INJECTED I/O ONLY: no clock, no console, no network here -- `now` and
// `log` arrive from the caller like everywhere else under src/.

import { BridgeError, BRIDGE_ERROR_CODES } from '../errors.mjs';

/** Consecutive failed flushes before a sink is called degraded. Three, not one: a single 500 or a dropped connection is normal and self-heals on the next flush. */
export const DEFAULT_UNHEALTHY_AFTER = 3;

/** How often a still-degraded sink re-announces itself. 15 minutes is short enough to be noticed within one working session and long enough not to spam a work item over two days. */
export const DEFAULT_REALERT_EVERY_MS = 15 * 60 * 1000;

function safeMessage(err) {
  return err && err.message ? err.message : String(err);
}

/** Render a multi-line banner. Plain ASCII (this package is ASCII-only) and fixed-width so it is impossible to miss in a tick-per-second log. */
function banner(title, lines) {
  const rule = '='.repeat(72);
  return [rule, `  ${title}`, rule, ...lines.map((l) => `  ${l}`), rule].join('\n');
}

/** Human-readable elapsed time from two `now()` values, tolerating a non-numeric clock. */
function since(from, to) {
  if (typeof from !== 'number' || typeof to !== 'number' || !Number.isFinite(to - from)) return 'an unknown duration';
  const ms = Math.max(0, to - from);
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'less than a minute';
  if (mins < 60) return `${mins} minute(s)`;
  return `${Math.round(mins / 6) / 10} hour(s)`;
}

/**
 * Read one entry's `health()` without letting a malformed sink break the
 * monitor. A sink with no `health()` is not a failure -- it has simply not
 * opted in, and is skipped. (Both shipped sinks publish one: `append-blob`
 * for a failing remote, `jsonl-file` for a dead local append stream.)
 * @param {{name: string, sink: object}} entry
 * @returns {object|null}
 */
function readHealth(entry) {
  if (!entry || !entry.sink || typeof entry.sink.health !== 'function') return null;
  let h;
  try {
    h = entry.sink.health();
  } catch {
    return {
      name: entry.name,
      healthy: false,
      consecutiveFailures: Number.MAX_SAFE_INTEGER,
      lastFailure: 'health() itself threw',
      pendingRecords: null,
    };
  }
  if (!h || typeof h !== 'object') return null;
  return { name: entry.name, ...h };
}

function describePending(value) {
  return value === null || value === undefined ? 'unknown' : value;
}

/**
 * Watch a set of sink entries for sustained write failure and escalate it
 * loudly, without ever interfering with the run. See the module header for
 * the reasoning behind every threshold and both channels.
 *
 * @param {object} deps
 * @param {(msg: string) => void} deps.log - injected; the banner channel.
 * @param {() => number} deps.now - injected clock.
 * @param {(text: string) => any} [deps.alert] - injected; the operator channel (wired to the work-item
 *   comment by `watch`). Optional and isolated: an alert that throws is logged and never propagates.
 * @param {number} [deps.unhealthyAfter] - default DEFAULT_UNHEALTHY_AFTER.
 * @param {number} [deps.reAlertEveryMs] - default DEFAULT_REALERT_EVERY_MS.
 * @returns {{
 *   check: (entries: Array<{name: string, sink: object}>) => Promise<void>,
 *   finalReport: (entries: Array<{name: string, sink: object}>) => void,
 *   degradedNames: () => string[],
 * }}
 * @throws {BridgeError} CONFIG_MISSING for a missing `log`/`now`
 */
export function createSinkHealthMonitor({
  log,
  now,
  alert,
  unhealthyAfter = DEFAULT_UNHEALTHY_AFTER,
  reAlertEveryMs = DEFAULT_REALERT_EVERY_MS,
} = {}) {
  if (typeof log !== 'function') {
    throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_MISSING, 'createSinkHealthMonitor requires an injected log function', { param: 'log' });
  }
  if (typeof now !== 'function') {
    throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_MISSING, 'createSinkHealthMonitor requires an injected now()', { param: 'now' });
  }

  /** name -> { degraded, degradedSince, lastAlertAt, everDegraded } */
  const states = new Map();

  function stateFor(name) {
    if (!states.has(name)) states.set(name, { degraded: false, degradedSince: null, lastAlertAt: null, everDegraded: false });
    return states.get(name);
  }

  async function fire(text) {
    if (typeof alert !== 'function') return;
    try {
      await alert(text);
    } catch (err) {
      // The alert channel is best-effort by construction: it is usually a
      // work-item comment, and a tracker outage must not become a second
      // failure on top of the one being reported.
      log(`[sink-health] alert channel failed while reporting sink degradation (the banner above still stands): ${safeMessage(err)}`);
    }
  }

  /** Every OTHER entry's name -- the "you have not lost data" half of the message. */
  function peerNames(entries, degradedName) {
    return entries.filter((e) => e && e.name !== degradedName).map((e) => e.name);
  }

  return {
    /**
     * Inspect every entry once. Never throws, never blocks on anything but
     * the injected `alert`, and never mutates a sink.
     * @param {Array<{name: string, sink: object}>} entries
     * @returns {Promise<void>}
     */
    async check(entries) {
      const list = Array.isArray(entries) ? entries : [];
      for (const entry of list) {
        const h = readHealth(entry);
        if (!h) continue;
        const st = stateFor(h.name);
        const t = now();
        const failures = typeof h.consecutiveFailures === 'number' ? h.consecutiveFailures : 0;
        // `terminal` (published by `jsonl-file.mjs`) means the failure
        // CANNOT self-heal: the sink's file descriptor is dead, so there is
        // no "next flush" that might succeed. `unhealthyAfter` exists to
        // ride out a transient 500 on a retrying remote sink; applying it to
        // a terminal failure would mean a local mirror that has stopped
        // writing entirely is escalated only if it happens to fail three
        // more times -- which it never will, because it never tries again.
        const isDown = h.healthy === false && (h.terminal === true || failures >= unhealthyAfter);

        if (isDown) {
          const firstTime = !st.degraded;
          if (firstTime) {
            st.degraded = true;
            st.everDegraded = true;
            st.degradedSince = t;
          }
          const dueForRepeat = typeof st.lastAlertAt === 'number' && typeof t === 'number'
            && (t - st.lastAlertAt) >= reAlertEveryMs;
          if (!firstTime && !dueForRepeat) continue;

          const peers = peerNames(list, h.name);
          const terminal = h.terminal === true;
          log(banner(firstTime ? `PROGRESS SINK DEGRADED: ${h.name}` : `PROGRESS SINK STILL DEGRADED: ${h.name}`, [
            terminal
              ? `Sink "${h.name}" has FAILED PERMANENTLY (${failures} write error(s)); it will not retry by itself.`
              : `Sink "${h.name}" has failed ${failures} consecutive flush attempt(s).`,
            `Down for: ${since(st.degradedSince, t)}.`,
            `Records waiting in memory and NOT yet remote: ${describePending(h.pendingRecords)}.`,
            ...(typeof h.droppedRecords === 'number'
              ? [`Records DROPPED and unrecoverable since the failure: ${h.droppedRecords}.`]
              : []),
            `Last failure: ${h.lastFailure || 'not reported'}.`,
            h.target ? `Target: ${h.target}.` : 'Target: not reported.',
            peers.length > 0
              ? `Still writing normally: ${peers.join(', ')} -- the sprint log is NOT lost, only this copy of it is.`
              : 'NO other sink is running -- progress for this sprint is being recorded nowhere.',
            'The sprint itself is unaffected and continues. This is an observability failure, not a sprint failure.',
            terminal
              ? 'Fix: check free disk space and write permission on the path above, then restart watch/daemon'
              : 'Fix: check the SAS expiry, the container name, and this machine\'s network egress, then restart watch/daemon',
            terminal
              ? '(a restart reopens the file in append mode; records dropped while it was down are gone).'
              : '(the sink resumes from its cursor, so a restart does not duplicate records).',
          ]));
          st.lastAlertAt = t;
          // eslint-disable-next-line no-await-in-loop
          await fire([
            terminal
              ? `**Progress sink "${h.name}" has failed permanently and is writing nothing.**`
              : `**Remote progress sink "${h.name}" is failing.**`,
            '',
            terminal ? `- Write errors: ${failures} (the sink does not retry by itself)` : `- Consecutive failed flushes: ${failures}`,
            `- Down for: ${since(st.degradedSince, t)}`,
            `- Records not yet remote: ${describePending(h.pendingRecords)}`,
            ...(typeof h.droppedRecords === 'number' ? [`- Records dropped and unrecoverable: ${h.droppedRecords}`] : []),
            `- Last failure: ${h.lastFailure || 'not reported'}`,
            peers.length > 0 ? `- Still writing normally: ${peers.join(', ')}` : '- No other sink is running.',
            '',
            'The sprint is unaffected and is still running; only its remote log is stale.',
          ].join('\n'));
          continue;
        }

        if (st.degraded && h.healthy === true) {
          st.degraded = false;
          const recoveredAfter = since(st.degradedSince, t);
          st.degradedSince = null;
          st.lastAlertAt = null;
          log(banner(`PROGRESS SINK RECOVERED: ${h.name}`, [
            `Sink "${h.name}" is writing again after ${recoveredAfter} of failures.`,
            'Buffered records were retained and have now been flushed; the remote log has no gap.',
          ]));
          // eslint-disable-next-line no-await-in-loop
          await fire(`Remote progress sink "${h.name}" recovered after ${recoveredAfter}; the remote log is current again.`);
        }
      }
    },

    /**
     * One last banner at the end of a run for any sink that is failing when
     * the loop exits. Without it, a sink that goes down in the final minutes
     * of a sprint would only be escalated on the tick AFTER it crossed the
     * threshold -- which may never come.
     * @param {Array<{name: string, sink: object}>} entries
     */
    finalReport(entries) {
      const list = Array.isArray(entries) ? entries : [];
      for (const entry of list) {
        const h = readHealth(entry);
        if (!h) continue;
        const st = stateFor(h.name);
        if (h.healthy === false) {
          log(banner(`PROGRESS SINK ENDED DEGRADED: ${h.name}`, [
            `Sink "${h.name}" was still failing when this run ended (${h.consecutiveFailures} consecutive failure(s)).`,
            `Records never written remotely: ${describePending(h.pendingRecords)}.`,
            ...(typeof h.droppedRecords === 'number'
              ? [`Records dropped and unrecoverable: ${h.droppedRecords}.`]
              : []),
            `Last failure: ${h.lastFailure || 'not reported'}.`,
            h.terminal === true
              ? 'This sink\'s copy of the sprint log is INCOMPLETE. Check whether any OTHER sink above ended healthy.'
              : 'The remote log for this sprint is INCOMPLETE. Use the local JSONL mirror as the record of what happened.',
          ]));
        } else if (st.everDegraded) {
          log(`[sink-health] sink "${h.name}" recovered before the end of this run; ${h.successfulFlushes ?? 'some'} flush(es) landed in total.`);
        }
      }
    },

    /** Names currently considered degraded -- for a caller that wants to report it, not only log it. */
    degradedNames() {
      return [...states.entries()].filter(([, st]) => st.degraded).map(([name]) => name);
    },
  };
}

export default createSinkHealthMonitor;
