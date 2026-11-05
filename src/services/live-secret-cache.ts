import path from 'node:path';
import {
  buildLiveInvocation,
  LiveSecretError,
  runLiveSecret,
  type LiveToken,
} from './live-secret-runner.js';
import {
  credentialDataDir,
  credentialResolve,
  lookupLiveSecret,
  readBoundSecret,
  type CredentialMeta,
  type LiveSecretRecord,
} from './credential-store.js';
import { getLiveSecretRefreshConfig } from './user-config.js';
import { jwtExpiry } from '../utils/jwt-expiry.js';
import { appendLogRecord } from '../utils/log-helpers.js';

/**
 * The orchestrator's in-memory cache of live secret tokens, keyed by name.
 *
 * - On access: while remaining >= T the current token is handed off; below T,
 *   or expired, a new one is minted and replaces it. T = min(refreshFraction x
 *   lifetime, refreshMaxSeconds), from config.json liveSecrets.*. A script is
 *   never run per request.
 * - Concurrent callers share one in-flight mint.
 * - After a failed mint the script is not run again until a backoff window has
 *   passed (10 s, doubling per consecutive failure, capped at 5 minutes).
 *   Inside the window every caller gets the failure again, without a run. A
 *   token that is below T but not yet expired is still served while the
 *   refresh keeps failing.
 * - Re-registering the live secret (a new script, program, args, bindings or
 *   created_at) starts a fresh entry: no cached token, no backoff. Updating a
 *   bound secret's value or the record's policy fields does not: the token
 *   stays cached until it is replaced.
 *
 * Process memory only, never a file. A restart means a new mint on next use.
 */

export const LIVE_BACKOFF_BASE_MS = 10_000;
export const LIVE_BACKOFF_MAX_MS = 5 * 60_000;

interface CacheEntry {
  fingerprint: string;
  token?: string;
  expiresAtMs?: number;
  refreshAtMs?: number;
  /** The script's expires_at for the cached token, as printed. */
  expiresAt?: string;
  /** exp of the cached token when it is a JWT, decoded locally. */
  jwtExp?: string | null;
  lastMintedAt?: string;
  lastFailureAt?: string;
  lastFailureReason?: string;
  consecutiveFailures: number;
  backoffUntilMs?: number;
  inFlight?: Promise<string>;
}

const _entries = new Map<string, CacheEntry>();

function fingerprintOf(record: LiveSecretRecord): string {
  return JSON.stringify([record.inline, record.program, record.args, record.bindings, record.created_at]);
}

/** The entry for this name, replaced by a fresh one when the live secret was re-registered. */
function entryFor(name: string, record: LiveSecretRecord): CacheEntry {
  const fingerprint = fingerprintOf(record);
  let entry = _entries.get(name);
  if (!entry || entry.fingerprint !== fingerprint) {
    entry = { fingerprint, consecutiveFailures: 0 };
    _entries.set(name, entry);
  }
  return entry;
}

/** The time a token should be replaced: expires_at minus T. */
export function liveRefreshAt(
  obtainedAtMs: number,
  expiresAtMs: number,
  config: { refreshFraction: number; refreshMaxSeconds: number } = getLiveSecretRefreshConfig(),
): number {
  const lifetime = Math.max(0, expiresAtMs - obtainedAtMs);
  return expiresAtMs - Math.min(config.refreshFraction * lifetime, config.refreshMaxSeconds * 1000);
}

/** Backoff after the n-th consecutive failure (n >= 1). */
export function liveBackoffMs(consecutiveFailures: number): number {
  const exponent = Math.min(Math.max(consecutiveFailures, 1) - 1, 16);
  return Math.min(LIVE_BACKOFF_MAX_MS, LIVE_BACKOFF_BASE_MS * 2 ** exponent);
}

function hasUnexpiredToken(entry: CacheEntry, nowMs: number): boolean {
  return entry.token !== undefined && entry.expiresAtMs !== undefined && nowMs < entry.expiresAtMs;
}

function backoffError(name: string, entry: CacheEntry): LiveSecretError {
  const retryAt = new Date(entry.backoffUntilMs ?? Date.now()).toISOString();
  return new LiveSecretError(
    name,
    'backoff',
    `the last run at ${entry.lastFailureAt} failed (${entry.lastFailureReason}); not run again until ${retryAt}`,
  );
}

/**
 * Run the live secret's script once, with its bound secrets in env. Used by the
 * registration test and by the cache. A bound secret that has expired is still
 * used (the binding is to the name, not the value), with a warning in the log;
 * the warning goes to the log file only, so the CLI prints nothing extra.
 */
export async function mintLiveSecret(record: LiveSecretRecord): Promise<LiveToken> {
  const name = record.name;
  const env: Record<string, string> = {};
  for (const { env: envName, secret } of record.bindings) {
    let bound: ReturnType<typeof readBoundSecret>;
    try {
      bound = readBoundSecret(secret);
    } catch {
      // The underlying message can quote ciphertext, so it is not repeated.
      throw new LiveSecretError(name, 'bound-secret-unreadable', `bound secret "${secret}" could not be read`);
    }
    if (bound.status !== 'ok') {
      throw new LiveSecretError(name, 'bound-secret-missing', `bound secret "${secret}" does not exist as a persistent static secret`);
    }
    if (bound.expiresAt && Date.now() > new Date(bound.expiresAt).getTime()) {
      appendLogRecord('warn', {
        tag: 'live-secret',
        msg: `live secret "${name}" used bound secret "${secret}", which expired at ${bound.expiresAt}. Update its value: apra-fleet secret --set ${secret} --persist`,
      });
    }
    env[envName] = bound.value;
  }
  let invocation: ReturnType<typeof buildLiveInvocation>;
  try {
    invocation = buildLiveInvocation(record, process.platform);
  } catch (err) {
    throw new LiveSecretError(name, 'start-failed', `cannot launch: ${(err as Error).message}`);
  }
  // A fixed working folder, so a run from the CLI and a run in the server see
  // the same relative paths, and neither runs from an arbitrary folder.
  return runLiveSecret({ credential: name, invocation, env, cwd: path.resolve(credentialDataDir()) });
}

function startMint(name: string, record: LiveSecretRecord, entry: CacheEntry): Promise<string> {
  const run = mintLiveSecret(record)
    .then((minted) => {
      const obtainedAtMs = Date.now();
      const expiresAtMs = Date.parse(minted.expiresAt);
      entry.token = minted.token;
      entry.expiresAt = minted.expiresAt;
      entry.expiresAtMs = expiresAtMs;
      entry.refreshAtMs = liveRefreshAt(obtainedAtMs, expiresAtMs);
      entry.jwtExp = jwtExpiry(minted.token);
      entry.lastMintedAt = new Date(obtainedAtMs).toISOString();
      entry.consecutiveFailures = 0;
      entry.backoffUntilMs = undefined;
      return minted.token;
    }, (err: unknown) => {
      const failedAtMs = Date.now();
      // A non-runner error is not quoted: only the runner's reasons are known leak-free.
      const reason = err instanceof LiveSecretError ? err.reason : 'unexpected error while running the script';
      entry.consecutiveFailures += 1;
      entry.lastFailureAt = new Date(failedAtMs).toISOString();
      entry.lastFailureReason = reason;
      entry.backoffUntilMs = failedAtMs + liveBackoffMs(entry.consecutiveFailures);
      if (hasUnexpiredToken(entry, failedAtMs)) return entry.token as string;
      throw err instanceof LiveSecretError ? err : new LiveSecretError(name, 'unexpected', reason);
    });
  const shared = run.finally(() => {
    if (entry.inFlight === shared) entry.inFlight = undefined;
  });
  entry.inFlight = shared;
  return shared;
}

/**
 * The token for live secret `name`, from the cache or from one mint shared by
 * every concurrent caller. Rejects with a LiveSecretError (leak-free) when the
 * script fails or is backing off.
 */
export function getLiveToken(name: string, record: LiveSecretRecord): Promise<string> {
  const entry = entryFor(name, record);
  if (entry.inFlight) return entry.inFlight;
  const nowMs = Date.now();
  if (entry.token !== undefined && entry.refreshAtMs !== undefined && nowMs <= entry.refreshAtMs) {
    return Promise.resolve(entry.token);
  }
  if (entry.backoffUntilMs !== undefined && nowMs < entry.backoffUntilMs) {
    if (hasUnexpiredToken(entry, nowMs)) return Promise.resolve(entry.token as string);
    return Promise.reject(backoffError(name, entry));
  }
  return startMint(name, record, entry);
}

/**
 * Forget the cached token after a server rejected it (HTTP 401), so the next
 * getLiveToken mints. Only drops the token the caller sent: when a concurrent
 * caller already replaced it, the newer token is kept and no extra mint happens.
 */
export function dropLiveToken(name: string, rejectedToken: string): void {
  const entry = _entries.get(name);
  if (!entry || entry.token !== rejectedToken) return;
  entry.token = undefined;
  entry.expiresAt = undefined;
  entry.expiresAtMs = undefined;
  entry.refreshAtMs = undefined;
  entry.jwtExp = undefined;
}

export type LiveTokenState = 'not run' | 'ok' | 'refreshing' | 'failed' | 'expired';

/** What fleet_status shows for a live secret. Never the token. */
export interface LiveTokenStatus {
  /**
   * not run: no mint yet in this process (or since re-registration); refreshing:
   * a mint is in progress; failed: the last mint failed; ok: the last mint
   * succeeded and its token has not expired; expired: it has.
   */
  state: LiveTokenState;
  /** When the script last returned a token; null when never. */
  lastMintedAt: string | null;
  /** The cached token's expires_at as the script printed it; null when none is cached. */
  expiresAt: string | null;
  /** exp of the cached token when it is a JWT, decoded locally; null otherwise. */
  tokenExpiry: string | null;
  /** When the last mint failed; null when none failed since the last success. */
  lastFailureAt: string | null;
  /** Why the last mint failed (the runner's leak-free reason). */
  lastFailureReason: string | null;
  /** Inside a backoff window: when the script may run again; null otherwise. */
  retryAfter: string | null;
}

export function getLiveTokenStatus(name: string, record: LiveSecretRecord): LiveTokenStatus {
  const entry = _entries.get(name);
  const nowMs = Date.now();
  if (!entry || entry.fingerprint !== fingerprintOf(record)) {
    return {
      state: 'not run', lastMintedAt: null, expiresAt: null, tokenExpiry: null,
      lastFailureAt: null, lastFailureReason: null, retryAfter: null,
    };
  }
  const failing = entry.consecutiveFailures > 0;
  let state: LiveTokenState;
  if (entry.inFlight) state = 'refreshing';
  else if (failing) state = 'failed';
  else if (hasUnexpiredToken(entry, nowMs)) state = 'ok';
  else if (entry.lastMintedAt) state = 'expired';
  else state = 'not run';
  const inBackoff = entry.backoffUntilMs !== undefined && nowMs < entry.backoffUntilMs;
  return {
    state,
    lastMintedAt: entry.lastMintedAt ?? null,
    expiresAt: entry.expiresAt ?? null,
    tokenExpiry: entry.jwtExp ?? null,
    lastFailureAt: failing ? entry.lastFailureAt ?? null : null,
    lastFailureReason: failing ? entry.lastFailureReason ?? null : null,
    retryAfter: inBackoff ? new Date(entry.backoffUntilMs as number).toISOString() : null,
  };
}

export type CommandSecretResolution =
  | { plaintext: string; meta: CredentialMeta }
  | { denied: string }
  | { expired: string }
  | { failed: string }
  | null;

/** True when `member` may use this live secret ('*' is the fleet-operator bypass). */
export function liveSecretAllowsMember(record: LiveSecretRecord, member: string): boolean {
  return member === '*' || record.allowedMembers === '*' || record.allowedMembers.includes(member);
}

/**
 * Resolve {{secret.NAME}} for a command on a member: a live secret mints (after
 * the allowedMembers check, so a refused member never causes a mint); anything
 * else is credentialResolve. A failed mint is a `failed` result, leak-free. The
 * caller checks network policy before calling, for the same reason.
 */
export async function resolveCommandSecret(name: string, callingMember: string): Promise<CommandSecretResolution> {
  const live = lookupLiveSecret(name);
  if (!live) return credentialResolve(name, callingMember);
  const allowedMembers = live.allowedMembers;
  if (!liveSecretAllowsMember(live, callingMember) && allowedMembers !== '*') {
    return { denied: `Credential '${name}' is not accessible to member '${callingMember}'. Allowed: ${allowedMembers.join(', ')}` };
  }
  try {
    const plaintext = await getLiveToken(name, live);
    return {
      plaintext,
      meta: {
        name, scope: 'persistent', kind: 'live', network_policy: live.network_policy,
        created_at: live.created_at, allowedMembers,
      },
    };
  } catch (err) {
    if (err instanceof LiveSecretError) return { failed: err.message };
    return { failed: new LiveSecretError(name, 'unexpected', 'unexpected error while running the script').message };
  }
}

/** Test helper: forget every cached token and backoff. */
export function resetLiveTokenCache(): void {
  _entries.clear();
}
