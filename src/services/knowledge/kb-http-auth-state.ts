/**
 * Per-remote-KB auth signals, recorded by HttpKbProvider and read by
 * fleet_status (src/tools/check-status.ts): when this process last had a KB
 * call accepted by the remote server, and when one was last rejected for auth
 * (HTTP 401). Process memory only -- a restart starts with "never" for both,
 * which is what fleet_status shows until the first call.
 *
 * Keyed by the remote KB URL (trailing slash dropped), not by provider object:
 * a config change replaces the HttpKbProvider instance, but fleet_status only
 * knows the URL from the config file. Nothing here ever holds a token.
 */

export interface KbHttpAuthState {
  /** ISO time of the last request the remote KB server answered with a success (status below 400). */
  lastSuccessAt?: string;
  /** ISO time of the last request the remote KB server rejected with HTTP 401. */
  lastRejectedAt?: string;
}

const _states = new Map<string, KbHttpAuthState>();

/** The key a remote KB URL is recorded under. */
export function kbHttpAuthStateKey(url: string): string {
  return url.replace(/\/+$/, '');
}

function slot(url: string): KbHttpAuthState {
  const key = kbHttpAuthStateKey(url);
  let state = _states.get(key);
  if (!state) {
    state = {};
    _states.set(key, state);
  }
  return state;
}

export function recordKbHttpSuccess(url: string, at: Date = new Date()): void {
  slot(url).lastSuccessAt = at.toISOString();
}

export function recordKbHttpRejected(url: string, at: Date = new Date()): void {
  slot(url).lastRejectedAt = at.toISOString();
}

/** A copy of the recorded signals for a remote KB URL; empty when none yet. */
export function getKbHttpAuthState(url: string): KbHttpAuthState {
  return { ..._states.get(kbHttpAuthStateKey(url)) };
}

/** Test helper: forget every recorded signal. */
export function resetKbHttpAuthState(): void {
  _states.clear();
}
