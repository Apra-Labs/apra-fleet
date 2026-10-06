import fs from 'node:fs';
import path from 'node:path';
import { FLEET_DIR } from '../paths.js';

/**
 * Per-dispatch cost from a provider's CUMULATIVE session cost figure.
 *
 * Claude Code's result `total_cost_usd` is cumulative for the session, not
 * per invocation. Its own field docs (CLI 2.1.291): "a resumed or forked
 * session continues from the total its transcript saved, when it has one (so
 * the first result already carries the earlier turns) ... and a mid-session
 * /clear resets the running total." fleet dispatches resume the member's
 * session routinely, so taking the figure as-is would charge every earlier
 * turn again on each resume. The dispatch's own cost is the delta against the
 * last figure this server saw for the session (or, for a fork, for its source
 * session).
 *
 * The last-seen figures are persisted (a small JSON map under the fleet data
 * dir, newest MAX_ENTRIES kept) so a server restart does not lose the
 * baseline and charge a whole session's history to the next resume.
 */

const MAX_ENTRIES = 500;
const fileName = 'session-costs.json';

let cache: Map<string, number> | null = null;

function filePath(): string {
  return path.join(FLEET_DIR, fileName);
}

function load(): Map<string, number> {
  if (cache) return cache;
  cache = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(), 'utf-8'));
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) cache.set(k, v);
      }
    }
  } catch { /* missing or unreadable: start empty */ }
  return cache;
}

function save(map: Map<string, number>): void {
  try {
    fs.mkdirSync(FLEET_DIR, { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify(Object.fromEntries(map)) + '\n');
  } catch { /* best effort: an unwritable data dir only loses the baseline */ }
}

/** The last cumulative cost seen for a session, or undefined. */
export function lastSessionCost(sessionId: string | undefined): number | undefined {
  if (!sessionId) return undefined;
  return load().get(sessionId);
}

/** Records the latest cumulative cost seen for a session. */
export function recordSessionCost(sessionId: string | undefined, cumulativeUsd: number): void {
  if (!sessionId || !Number.isFinite(cumulativeUsd) || cumulativeUsd < 0) return;
  const map = load();
  map.delete(sessionId); // re-insert so insertion order tracks recency
  map.set(sessionId, cumulativeUsd);
  while (map.size > MAX_ENTRIES) {
    const oldest = map.keys().next().value as string;
    map.delete(oldest);
  }
  save(map);
}

/**
 * The cost of ONE dispatch, from the cumulative figure its result reported.
 *
 * @param cumulativeUsd the result's cumulative session cost
 * @param sessionId the session the result landed on
 * @param continuedFrom the session whose saved total this invocation started
 *   from: the resumed session id for a resume, the source id for a fork,
 *   undefined for a fresh session (baseline 0)
 * @returns the delta in USD, or undefined when the invocation continued a
 *   session whose earlier total this server never saw (the caller then falls
 *   back to pricing the token counts). The cumulative figure is recorded as
 *   the session's new baseline either way.
 */
export function dispatchCostFromCumulative(
  cumulativeUsd: number,
  sessionId: string | undefined,
  continuedFrom: string | undefined,
): number | undefined {
  let base: number | undefined = 0;
  if (continuedFrom) base = lastSessionCost(continuedFrom);
  recordSessionCost(sessionId, cumulativeUsd);
  if (base === undefined) return undefined;
  // A figure below the baseline means the total restarted (no saved total in
  // the transcript, or a /clear): the whole figure is this dispatch's.
  const delta = cumulativeUsd >= base ? cumulativeUsd - base : cumulativeUsd;
  return Math.round(delta * 1e10) / 1e10; // strip float noise from the subtraction
}

/** Test-only: drop the in-memory cache (the file is re-read on next use). */
export function _resetSessionCostCache(): void {
  cache = null;
}
