import crypto from 'node:crypto';

/**
 * Console-hosted registry of pending one-time secret entries.
 *
 * WHY: the console's "Add credential" flow needs to hand back a URL that any
 * browser reaching the console (LAN, an SSH tunnel on the console port, a
 * remote install) can open -- not a loopback-bound ephemeral-port web server
 * that only a browser ON the server machine can reach (src/services/auth-web.ts
 * launchAuthWeb). This module is the storage/lifecycle half of that fix: it
 * hands out a console-relative path (never a scheme/host/port) whose token
 * lives in the URL FRAGMENT. A fragment is never sent to the server, so the
 * token cannot land in an access log or a Referer header; the console shell
 * page reads it from location.hash and sends it in a POST body instead.
 *
 * This module must never depend on src/console/** -- it is a plain service.
 */

// Deliberately the PENDING_TTL_MS-scale 10 minutes (see auth-socket.ts), not
// auth-web's 2-minute window: a human reaching the console over a tunnel
// needs longer than an on-box browser that was just auto-opened. Exported so
// callers derive expiry from this one constant instead of a second hardcoded
// value that could drift from it.
export const SECRET_ENTRY_TTL_MS = 10 * 60 * 1000;

interface PendingSecretEntry {
  name: string;
  prompt: string;
  onSubmit: (value: string) => { ok: boolean; error?: string };
  timer: ReturnType<typeof setTimeout>;
}

const registry = new Map<string, PendingSecretEntry>();

// True once this process is actually serving the console (createHttpTransport
// in src/services/http-transport.ts wires handleConsoleRequest). A token in
// this registry is only reachable through that console, so callers that would
// hand out a console-relative entry path must first check isConsoleHosted():
// under `--transport stdio` no console is mounted in this process and the
// path would resolve to nothing (or to a different process that 404s it).
let consoleHosted = false;

/** Record that this process serves the console (and so this registry). */
export function markConsoleHosted(): void {
  consoleHosted = true;
}

/** Whether this process serves the console that resolves secret-entry paths. */
export function isConsoleHosted(): boolean {
  return consoleHosted;
}

const TOKEN_SHAPE = /^[0-9a-f]{64}$/;

/**
 * Look up a stored token by attacker-supplied input in constant time.
 *
 * A plain `Map.get(token)` would compare the attacker-supplied string against
 * stored keys using ordinary string equality, which is not guaranteed to be
 * constant-time. Instead we validate the shape (a cheap, value-independent
 * check) and then compare the candidate against every stored token with
 * crypto.timingSafeEqual over equal-length 32-byte buffers -- never a
 * comparison that can short-circuit on the first differing byte of the
 * secret token itself.
 */
function findToken(token: string): string | undefined {
  if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) return undefined;
  const candidate = Buffer.from(token, 'hex');
  let found: string | undefined;
  for (const key of registry.keys()) {
    const stored = Buffer.from(key, 'hex');
    if (
      stored.length === candidate.length &&
      crypto.timingSafeEqual(stored, candidate)
    ) {
      found = key;
    }
  }
  return found;
}

/**
 * Register a new one-time secret entry and return the console-relative path
 * to it. The token lives only in this in-memory registry -- it never touches
 * disk or a keychain, and does not survive a process restart.
 */
export function createSecretEntry(opts: {
  name: string;
  prompt: string;
  onSubmit: (value: string) => { ok: boolean; error?: string };
}): { token: string; expiresAt: string; path: string } {
  const token = crypto.randomBytes(32).toString('hex');

  const timer = setTimeout(() => {
    registry.delete(token);
  }, SECRET_ENTRY_TTL_MS);
  // Must never keep the process alive on its own.
  timer.unref?.();

  registry.set(token, {
    name: opts.name,
    prompt: opts.prompt,
    onSubmit: opts.onSubmit,
    timer,
  });

  const expiresAt = new Date(Date.now() + SECRET_ENTRY_TTL_MS).toISOString();
  return { token, expiresAt, path: `/ui/#/secret-entry/${token}` };
}

/**
 * Metadata only -- there is no stored value to leak. Returns null for
 * unknown, already-consumed, and expired tokens alike (never distinguish
 * those to a caller: that is a token oracle).
 */
export function getSecretEntryPrompt(token: string): { name: string; prompt: string } | null {
  const key = findToken(token);
  if (!key) return null;
  const entry = registry.get(key);
  if (!entry) return null;
  return { name: entry.name, prompt: entry.prompt };
}

/**
 * Submit a value for a pending secret entry. The value is passed to the
 * entry's onSubmit callback and dropped -- it is never held in the registry,
 * never logged, and never included in a returned error message. On success
 * the entry is consumed (single use) and its timer cleared; on rejection the
 * entry survives so the caller can retry until the TTL.
 */
export function submitSecretEntry(
  token: string,
  value: string,
): { status: 'ok' } | { status: 'not_found' } | { status: 'rejected'; error: string } | { status: 'error' } {
  const key = findToken(token);
  if (!key) return { status: 'not_found' };
  const entry = registry.get(key);
  if (!entry) return { status: 'not_found' };

  let result: { ok: boolean; error?: string };
  try {
    result = entry.onSubmit(value);
  } catch {
    // A caller-supplied onSubmit (credential_store_set's credentialSet
    // wrapper, or submitPassword) that throws must never surface its
    // message here: the message could be derived from the submitted
    // secret value. Answer a fixed, generic outcome instead. The entry
    // survives (same as a `rejected` outcome) so the caller can retry.
    return { status: 'error' };
  }
  if (result.ok) {
    clearTimeout(entry.timer);
    registry.delete(key);
    return { status: 'ok' };
  }
  return { status: 'rejected', error: result.error ?? 'Submission failed.' };
}

/** Test-only: clear the registry and any pending timers. */
export function __resetSecretEntriesForTest(): void {
  for (const entry of registry.values()) {
    clearTimeout(entry.timer);
  }
  registry.clear();
}

/** Test-only: force the console-hosted flag (markConsoleHosted is one-way). */
export function __setConsoleHostedForTest(hosted: boolean): void {
  consoleHosted = hosted;
}
