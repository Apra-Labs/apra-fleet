/**
 * Pre-dispatch readiness check for fleet members.
 *
 * Validates connectivity and LLM authentication BEFORE the expensive prompt
 * dispatch (writePromptFile + CLI invocation), so auth failures surface in
 * <1s instead of burning a full round trip.
 *
 * The check is deliberately lightweight:
 *   1. SSH connectivity (strategy.testConnection) -- reuses the existing pooled
 *      connection, so this is essentially free for an already-warm member.
 *   2. Credential presence (file-exists check for OAuth files, or env-var check
 *      for API keys) -- a single short exec, not a full API call.
 *   3. OAuth token freshness (reads the credential JSON and checks expiresAt)
 *      -- only for providers that use OAuth and only when the credential file
 *      is present.
 *
 * Does NOT make a real LLM API call (that would defeat the purpose of being
 * cheap). A credential that EXISTS but is silently revoked server-side will
 * still pass the preflight and fail on the actual dispatch -- but the common
 * case (expired OAuth, missing credential file, member offline) is caught.
 *
 * @module preflight-check
 */
import type { Agent } from '../types.js';
import type { AgentStrategy } from './strategy.js';
import type { ProviderAdapter } from '../providers/index.js';
import { getStrategy } from './strategy.js';
import { getOsCommands } from '../os/index.js';
import { getProvider } from '../providers/index.js';
import { getAgentOS } from '../utils/agent-helpers.js';
import { validateCredentials, type CredentialStatus } from '../utils/credential-validation.js';
import { logLine } from '../utils/log-helpers.js';

export interface PreflightResult {
  ok: boolean;
  /** Connectivity test passed */
  connectivity: boolean;
  /** LLM auth appears valid (credential files present + not expired) */
  authValid: boolean;
  /** Human-readable explanation when ok=false */
  reason?: string;
  /** Structured reason code for programmatic consumers */
  code?: 'offline' | 'auth_missing' | 'auth_expired';
  /** Credential freshness detail (only for OAuth providers) */
  credentialStatus?: CredentialStatus;
  /** Latency of the connectivity check in ms */
  latencyMs?: number;
}

/** Members that passed preflight within the last CACHE_TTL_MS do not need a
 *  recheck -- avoids adding round-trip latency to back-to-back dispatches. */
const CACHE_TTL_MS = 60_000; // 1 minute
const preflightCache = new Map<string, { passedAt: number }>();

/** R2-F8: hard cap on cache size. When exceeded, the oldest entries (by
 *  passedAt) are evicted down to 80% of the cap. A fleet with 500 members
 *  running back-to-back dispatches would otherwise grow the Map unboundedly
 *  (entries only expire passively on lookup, never proactively). */
const CACHE_MAX_SIZE = 500;

function evictOldestEntries(): void {
  if (preflightCache.size <= CACHE_MAX_SIZE) return;
  const entries = [...preflightCache.entries()]
    .sort((a, b) => a[1].passedAt - b[1].passedAt);
  const evictCount = preflightCache.size - Math.floor(CACHE_MAX_SIZE * 0.8);
  for (let i = 0; i < evictCount && i < entries.length; i++) {
    preflightCache.delete(entries[i][0]);
  }
}

/** Clear a single member's cache entry (e.g. after a known auth change). */
export function invalidatePreflightCache(memberId: string): void {
  preflightCache.delete(`${memberId}:conn`);
  preflightCache.delete(`${memberId}:full`);
}

/** Clear the entire cache (e.g. on credential rotation). */
export function clearPreflightCache(): void {
  preflightCache.clear();
}

/**
 * Run a lightweight readiness check on a fleet member before dispatching work.
 *
 * @param agent    - The resolved Agent record
 * @param options  - skipCache: bypass the 60s cache; skipAuth: only check connectivity
 * @returns PreflightResult with ok=true when the member is ready for dispatch
 */
export async function preflightCheck(
  agent: Agent,
  options?: { skipCache?: boolean; skipAuth?: boolean },
): Promise<PreflightResult> {
  // Local members share this machine's credentials -- no remote check needed
  if (agent.agentType === 'local') {
    return { ok: true, connectivity: true, authValid: true };
  }

  // Cache hit: a recent successful preflight skips the remote probes.
  // Keys are scoped by auth level so a conn-only pass cannot satisfy a
  // full-auth lookup (F2 cache-poisoning fix). A full pass also covers
  // connectivity, so conn lookups check both keys.
  if (!options?.skipCache) {
    const level = options?.skipAuth ? 'conn' : 'full';
    const cached = preflightCache.get(`${agent.id}:${level}`);
    const fallback = level === 'conn' ? preflightCache.get(`${agent.id}:full`) : null;
    const effective = cached ?? fallback;
    if (effective && Date.now() - effective.passedAt < CACHE_TTL_MS) {
      return { ok: true, connectivity: true, authValid: true };
    }
  }

  const strategy = getStrategy(agent);
  const provider = getProvider(agent.llmProvider);

  // ---- Step 1: Connectivity ----
  let latencyMs: number;
  let connectivityTimer: ReturnType<typeof setTimeout> | undefined;
  // R2-F7: hoisted so the catch block can attach a no-op .catch to prevent
  // an unhandled rejection when the timeout wins the race.
  let connPromise: ReturnType<AgentStrategy['testConnection']> | undefined;
  try {
    connPromise = strategy.testConnection();
    const conn = await Promise.race([
      connPromise,
      new Promise<never>((_, reject) => {
        connectivityTimer = setTimeout(() => reject(new Error('preflight connectivity timeout (10s)')), 10_000);
      }),
    ]);
    clearTimeout(connectivityTimer);
    if (!conn.ok) {
      logLine('preflight', `FAIL connectivity: ${conn.error}`, agent);
      return {
        ok: false,
        connectivity: false,
        authValid: false,
        reason: `Member "${agent.friendlyName}" is offline: ${conn.error}. Check SSH connectivity before dispatching.`,
        code: 'offline',
        latencyMs: conn.latencyMs,
      };
    }
    latencyMs = conn.latencyMs;
  } catch (err: any) {
    clearTimeout(connectivityTimer);
    // R2-F7: when the timeout wins the race, testConnection() keeps running
    // with no await. Attach a no-op .catch so its eventual rejection does not
    // surface as an unhandled promise rejection.
    connPromise?.catch(() => {});
    logLine('preflight', `FAIL connectivity: ${err.message}`, agent);
    return {
      ok: false,
      connectivity: false,
      authValid: false,
      reason: `Member "${agent.friendlyName}" is unreachable: ${err.message}`,
      code: 'offline',
    };
  }

  // ---- Step 2: Auth presence (skip for no-LLM members or when caller opts out) ----
  if (options?.skipAuth || agent.llmProvider === 'none') {
    preflightCache.set(`${agent.id}:conn`, { passedAt: Date.now() });
    evictOldestEntries();
    return { ok: true, connectivity: true, authValid: true, latencyMs };
  }

  const cmds = getOsCommands(getAgentOS(agent));
  let oauthFilePresent = false;
  let apiKeyPresent = false;
  let credentialStatus: CredentialStatus | undefined;

  // Build the full set of env var names that could hold a valid credential.
  // provisionApiKey (provision-auth.ts) uses provider.authEnvVarForToken to
  // pick the var name, which for Claude returns ANTHROPIC_API_KEY for sk-ant-*
  // tokens and CLAUDE_CODE_OAUTH_TOKEN for everything else. Checking only
  // provider.authEnvVar (ANTHROPIC_API_KEY) misses the OAuth-token env var
  // path entirely. Derive the complete set by probing representative shapes.
  const authEnvVarSet = new Set<string>();
  if (provider.authEnvVar) authEnvVarSet.add(provider.authEnvVar);
  if (provider.authEnvVarForToken) {
    authEnvVarSet.add(provider.authEnvVarForToken('sk-ant-probe'));
    authEnvVarSet.add(provider.authEnvVarForToken('non-sk-ant-probe'));
  }
  // R3 regression fix: providers with no env-var-based auth (e.g. OpenCode,
  // whose authEnvVar/authEnvVarForToken always return '') would otherwise
  // populate authEnvVars with ''. getOsCommands(...).apiKeyCheck('') builds a
  // command via a var-name validator that THROWS synchronously on an invalid
  // name (see os/linux.ts and os/windows.ts's /^[A-Z_][A-Z0-9_]*$/ check) --
  // that throw happens before the .catch(() => null) below can attach, so it
  // rejects preflightCheck's returned promise instead of yielding a normal
  // {ok: false, code: 'auth_missing'} result. Filter out empty/invalid names
  // so such providers fall straight through to "no API key found".
  const authEnvVars = [...authEnvVarSet].filter(envVar => /^[A-Z_][A-Z0-9_]*$/i.test(envVar));

  // Parallelize OAuth file read and API key check into a single batch
  // (F8: reduces sequential SSH round trips). readRemoteJson combines
  // file-exists + content-read into one command (returns '{}' when missing).
  const oauthFiles = provider.oauthCredentialFiles?.();

  const oauthPromise = oauthFiles && oauthFiles.length > 0
    ? strategy.execCommand(cmds.readRemoteJson(oauthFiles[0].remotePath), 10_000).catch(() => null)
    : Promise.resolve(null);

  const apiKeyPromises = authEnvVars.map(envVar =>
    strategy.execCommand(cmds.apiKeyCheck(envVar), 10_000).catch(() => null)
  );

  const [oauthResult, ...apiKeyResults] = await Promise.all([oauthPromise, ...apiKeyPromises]);

  // Process API key results -- any env var hit counts
  for (const result of apiKeyResults) {
    if (result && result.stdout.trim().length > 5) {
      apiKeyPresent = true;
      break;
    }
  }

  // Also check stored encrypted env vars (provision-auth stores API keys here)
  if (!apiKeyPresent && agent.encryptedEnvVars) {
    for (const envVar of authEnvVars) {
      if (agent.encryptedEnvVars[envVar]) {
        apiKeyPresent = true;
        break;
      }
    }
  }

  // Process OAuth result
  if (oauthResult && oauthResult.code === 0) {
    const content = oauthResult.stdout.trim();
    // readRemoteJson returns '{}' when file is missing
    oauthFilePresent = content.length > 2 && content !== '{}';

    if (oauthFilePresent) {
      const cs = validateCredentials(content);
      if (cs) {
        credentialStatus = cs;
        if (cs.status === 'expired-no-refresh') {
          // R2-F4: if an API key is present, treat as pass -- the key is a
          // working fallback credential even though the OAuth token is expired.
          if (apiKeyPresent) {
            logLine('preflight', `OAuth expired (no refresh) but API key present -- treating as pass`, agent);
          } else {
            logLine('preflight', `FAIL auth: OAuth token expired with no refresh token`, agent);
            return {
              ok: false,
              connectivity: true,
              authValid: false,
              reason: `LLM auth on "${agent.friendlyName}" is expired (no refresh token). Run /login to refresh your credentials, then run provision_llm_auth to deploy them.`,
              code: 'auth_expired',
              credentialStatus: cs,
              latencyMs,
            };
          }
        }
        // expired-refreshable is OK -- the CLI will auto-refresh
        // near-expiry is OK -- still valid
      } else if (provider.name !== 'claude') {
        logLine('preflight', `OAuth freshness check not implemented for provider ${provider.name}, skipping`, agent);
      }
    }
  }

  if (!oauthFilePresent && !apiKeyPresent) {
    logLine('preflight', `FAIL auth: no credentials found (oauth=${oauthFilePresent}, apikey=${apiKeyPresent})`, agent);
    return {
      ok: false,
      connectivity: true,
      authValid: false,
      reason: `No LLM credentials found on "${agent.friendlyName}". Run provision_llm_auth to deploy authentication before dispatching.`,
      code: 'auth_missing',
      latencyMs,
    };
  }

  // All checks passed
  logLine('preflight', `OK (${latencyMs}ms, oauth=${oauthFilePresent}, apikey=${apiKeyPresent})`, agent);
  preflightCache.set(`${agent.id}:full`, { passedAt: Date.now() });
  evictOldestEntries();
  return {
    ok: true,
    connectivity: true,
    authValid: true,
    credentialStatus,
    latencyMs,
  };
}
