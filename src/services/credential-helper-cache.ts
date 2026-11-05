import { runCredentialHelper, CredentialHelperError } from './credential-helper-runner.js';
import type { HelperRecord } from './credential-store.js';
import { jwtExpiry } from '../utils/jwt-expiry.js';

/**
 * Token cache for credential helpers, keyed by {credential, audience}.
 *
 * - A token is reused until its refresh point: expires_at minus the smaller of
 *   5 minutes and 10% of the token's lifetime (measured from when the helper
 *   returned it). A helper is never run per request.
 * - Concurrent callers share one in-flight helper run.
 * - After a failed run the helper is not run again until a backoff window has
 *   passed (10 s, doubling per consecutive failure, capped at 5 minutes).
 *   Inside the window every caller gets the failure again, without a run. A
 *   token that is past its refresh point but not yet expired is still served
 *   while the refresh keeps failing.
 * - Re-registering the helper (a new program, argv or created_at) starts a
 *   fresh entry: no cached token, no backoff.
 *
 * Process memory only. Nothing here logs; the token never leaves getHelperToken.
 */

export const HELPER_REFRESH_MAX_MARGIN_MS = 5 * 60_000;
export const HELPER_REFRESH_LIFETIME_FRACTION = 0.1;
export const HELPER_BACKOFF_BASE_MS = 10_000;
export const HELPER_BACKOFF_MAX_MS = 5 * 60_000;

interface CacheEntry {
  fingerprint: string;
  token?: string;
  expiresAtMs?: number;
  refreshAtMs?: number;
  /** The helper's expires_at for the cached token, as printed. */
  expiresAt?: string;
  /** exp of the cached token when it is a JWT, decoded locally. */
  jwtExp?: string | null;
  lastRefreshAt?: string;
  lastFailureAt?: string;
  lastFailureReason?: string;
  consecutiveFailures: number;
  backoffUntilMs?: number;
  inFlight?: Promise<string>;
}

const _entries = new Map<string, CacheEntry>();

function cacheKey(credential: string, audience: string): string {
  return `${credential}\u0000${audience}`;
}

function fingerprintOf(helper: HelperRecord): string {
  return JSON.stringify([helper.program, helper.args, helper.created_at]);
}

/** The entry for this key, replaced by a fresh one when the helper was re-registered. */
function entryFor(credential: string, audience: string, helper: HelperRecord): CacheEntry {
  const key = cacheKey(credential, audience);
  const fingerprint = fingerprintOf(helper);
  let entry = _entries.get(key);
  if (!entry || entry.fingerprint !== fingerprint) {
    entry = { fingerprint, consecutiveFailures: 0 };
    _entries.set(key, entry);
  }
  return entry;
}

/** The time a token should be replaced: expires_at minus min(5 min, 10% of its lifetime). */
export function helperRefreshAt(obtainedAtMs: number, expiresAtMs: number): number {
  const lifetime = Math.max(0, expiresAtMs - obtainedAtMs);
  const margin = Math.min(HELPER_REFRESH_MAX_MARGIN_MS, lifetime * HELPER_REFRESH_LIFETIME_FRACTION);
  return expiresAtMs - margin;
}

/** Backoff after the n-th consecutive failure (n >= 1). */
export function helperBackoffMs(consecutiveFailures: number): number {
  const exponent = Math.min(Math.max(consecutiveFailures, 1) - 1, 16);
  return Math.min(HELPER_BACKOFF_MAX_MS, HELPER_BACKOFF_BASE_MS * 2 ** exponent);
}

function hasUnexpiredToken(entry: CacheEntry, nowMs: number): boolean {
  return entry.token !== undefined && entry.expiresAtMs !== undefined && nowMs < entry.expiresAtMs;
}

function backoffError(credential: string, entry: CacheEntry): CredentialHelperError {
  const retryAt = new Date(entry.backoffUntilMs ?? Date.now()).toISOString();
  return new CredentialHelperError(
    credential,
    `the last run at ${entry.lastFailureAt} failed (${entry.lastFailureReason}); not run again until ${retryAt}`,
  );
}

function startRefresh(credential: string, audience: string, helper: HelperRecord, entry: CacheEntry): Promise<string> {
  const run = runCredentialHelper({ credential, audience, program: helper.program, args: helper.args })
    .then((minted) => {
      const obtainedAtMs = Date.now();
      const expiresAtMs = Date.parse(minted.expiresAt);
      entry.token = minted.token;
      entry.expiresAt = minted.expiresAt;
      entry.expiresAtMs = expiresAtMs;
      entry.refreshAtMs = helperRefreshAt(obtainedAtMs, expiresAtMs);
      entry.jwtExp = jwtExpiry(minted.token);
      entry.lastRefreshAt = new Date(obtainedAtMs).toISOString();
      entry.consecutiveFailures = 0;
      entry.backoffUntilMs = undefined;
      return minted.token;
    }, (err: unknown) => {
      const failedAtMs = Date.now();
      // A non-helper error is not quoted: only the runner's reasons are known leak-free.
      const reason = err instanceof CredentialHelperError ? err.reason : 'unexpected error while running the helper';
      entry.consecutiveFailures += 1;
      entry.lastFailureAt = new Date(failedAtMs).toISOString();
      entry.lastFailureReason = reason;
      entry.backoffUntilMs = failedAtMs + helperBackoffMs(entry.consecutiveFailures);
      if (hasUnexpiredToken(entry, failedAtMs)) return entry.token as string;
      throw err instanceof CredentialHelperError ? err : new CredentialHelperError(credential, reason);
    });
  const shared = run.finally(() => {
    if (entry.inFlight === shared) entry.inFlight = undefined;
  });
  entry.inFlight = shared;
  return shared;
}

/**
 * A token for `credential` sent to `audience`, from the cache or from one
 * helper run shared by every concurrent caller. Rejects with a
 * CredentialHelperError (leak-free) when the helper fails or is backing off.
 */
export function getHelperToken(credential: string, audience: string, helper: HelperRecord): Promise<string> {
  const entry = entryFor(credential, audience, helper);
  if (entry.inFlight) return entry.inFlight;
  const nowMs = Date.now();
  if (entry.token !== undefined && entry.refreshAtMs !== undefined && nowMs < entry.refreshAtMs) {
    return Promise.resolve(entry.token);
  }
  if (entry.backoffUntilMs !== undefined && nowMs < entry.backoffUntilMs) {
    if (hasUnexpiredToken(entry, nowMs)) return Promise.resolve(entry.token as string);
    return Promise.reject(backoffError(credential, entry));
  }
  return startRefresh(credential, audience, helper, entry);
}

/**
 * Forget the cached token after the server rejected it (HTTP 401), so the next
 * getHelperToken runs the helper. Only drops the token the caller sent: when a
 * concurrent caller already replaced it, the newer token is kept and no extra
 * helper run happens.
 */
export function dropHelperToken(credential: string, audience: string, rejectedToken: string): void {
  const entry = _entries.get(cacheKey(credential, audience));
  if (!entry || entry.token !== rejectedToken) return;
  entry.token = undefined;
  entry.expiresAt = undefined;
  entry.expiresAtMs = undefined;
  entry.refreshAtMs = undefined;
  entry.jwtExp = undefined;
}

export type HelperTokenState = 'not run' | 'ok' | 'refreshing' | 'failed' | 'expired';

/** What fleet_status shows for a helper. Never the token. */
export interface HelperTokenStatus {
  /**
   * not run: no run yet in this process (or since re-registration); refreshing:
   * a run is in progress; failed: the last run failed; ok: the last run
   * succeeded and its token has not expired; expired: it has.
   */
  state: HelperTokenState;
  /** When the helper last returned a token; null when never. */
  lastRefreshAt: string | null;
  /** The cached token's expires_at as the helper printed it; null when none is cached. */
  expiresAt: string | null;
  /** exp of the cached token when it is a JWT, decoded locally; null otherwise. */
  tokenExpiry: string | null;
  /** When the last run failed; null when none failed since the last success. */
  lastFailureAt: string | null;
  /** Why the last run failed (the runner's leak-free reason). */
  lastFailureReason: string | null;
  /** Inside a backoff window: when the helper may run again; null otherwise. */
  retryAfter: string | null;
}

export function getHelperTokenStatus(credential: string, audience: string, helper: HelperRecord): HelperTokenStatus {
  const entry = _entries.get(cacheKey(credential, audience));
  const nowMs = Date.now();
  if (!entry || entry.fingerprint !== fingerprintOf(helper)) {
    return {
      state: 'not run', lastRefreshAt: null, expiresAt: null, tokenExpiry: null,
      lastFailureAt: null, lastFailureReason: null, retryAfter: null,
    };
  }
  const failing = entry.consecutiveFailures > 0;
  let state: HelperTokenState;
  if (entry.inFlight) state = 'refreshing';
  else if (failing) state = 'failed';
  else if (hasUnexpiredToken(entry, nowMs)) state = 'ok';
  else if (entry.lastRefreshAt) state = 'expired';
  else state = 'not run';
  const inBackoff = entry.backoffUntilMs !== undefined && nowMs < entry.backoffUntilMs;
  return {
    state,
    lastRefreshAt: entry.lastRefreshAt ?? null,
    expiresAt: entry.expiresAt ?? null,
    tokenExpiry: entry.jwtExp ?? null,
    lastFailureAt: failing ? entry.lastFailureAt ?? null : null,
    lastFailureReason: failing ? entry.lastFailureReason ?? null : null,
    retryAfter: inBackoff ? new Date(entry.backoffUntilMs as number).toISOString() : null,
  };
}

/** Test helper: forget every cached token and backoff. */
export function resetHelperTokenCache(): void {
  _entries.clear();
}
