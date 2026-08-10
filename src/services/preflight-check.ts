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

/** Clear a single member's cache entry (e.g. after a known auth change). */
export function invalidatePreflightCache(memberId: string): void {
  preflightCache.delete(memberId);
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

  // Cache hit: a recent successful preflight skips the remote probes
  if (!options?.skipCache) {
    const cached = preflightCache.get(agent.id);
    if (cached && Date.now() - cached.passedAt < CACHE_TTL_MS) {
      return { ok: true, connectivity: true, authValid: true };
    }
  }

  const strategy = getStrategy(agent);
  const provider = getProvider(agent.llmProvider);

  // ---- Step 1: Connectivity ----
  let latencyMs: number;
  try {
    const conn = await Promise.race([
      strategy.testConnection(),
      new Promise<{ ok: false; latencyMs: 0; error: string }>((_, reject) =>
        setTimeout(() => reject(new Error('preflight connectivity timeout (10s)')), 10_000),
      ),
    ]);
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
    preflightCache.set(agent.id, { passedAt: Date.now() });
    return { ok: true, connectivity: true, authValid: true, latencyMs };
  }

  const cmds = getOsCommands(getAgentOS(agent));
  let oauthFilePresent = false;
  let apiKeyPresent = false;
  let credentialStatus: CredentialStatus | undefined;

  // Check OAuth credential files
  const oauthFiles = provider.oauthCredentialFiles?.();
  if (oauthFiles && oauthFiles.length > 0) {
    try {
      const checkResult = await strategy.execCommand(
        cmds.credentialFileCheck(oauthFiles[0].remotePath),
        10_000,
      );
      oauthFilePresent = checkResult.stdout.trim() === 'found';

      // If OAuth file exists, try to read and validate its freshness
      if (oauthFilePresent) {
        try {
          const catCmd = getAgentOS(agent) === 'windows'
            ? `powershell -Command "Get-Content '${oauthFiles[0].remotePath.replace(/'/g, "''")}' -Raw"`
            : `cat "${oauthFiles[0].remotePath}"`;
          const catResult = await strategy.execCommand(catCmd, 10_000);
          if (catResult.code === 0 && catResult.stdout.trim()) {
            const cs = validateCredentials(catResult.stdout.trim());
            if (cs) {
              credentialStatus = cs;
              if (cs.status === 'expired-no-refresh') {
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
              // expired-refreshable is OK -- the CLI will auto-refresh
              // near-expiry is OK -- still valid
            }
          }
        } catch {
          // Could not read the file contents -- the file-exists check passed,
          // so we proceed; actual auth validation happens on dispatch
        }
      }
    } catch {
      // credentialFileCheck itself failed -- proceed to API key check
    }
  }

  // Check API key env var
  if (provider.authEnvVar) {
    try {
      const apiKeyResult = await strategy.execCommand(
        cmds.apiKeyCheck(provider.authEnvVar),
        10_000,
      );
      apiKeyPresent = apiKeyResult.stdout.trim().length > 5;
    } catch {
      // ignore -- API key check failed
    }
  }

  // Also check stored encrypted env vars (provision-auth stores API keys here)
  if (!apiKeyPresent && agent.encryptedEnvVars) {
    const authEnvVar = provider.authEnvVar;
    if (authEnvVar && agent.encryptedEnvVars[authEnvVar]) {
      apiKeyPresent = true;
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
  preflightCache.set(agent.id, { passedAt: Date.now() });
  return {
    ok: true,
    connectivity: true,
    authValid: true,
    credentialStatus,
    latencyMs,
  };
}
