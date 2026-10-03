import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { getProvider } from '../providers/index.js';
import { escapeDoubleQuoted } from '../utils/shell-escape.js';
import { getAgentOS, getAgentShell, touchAgent } from '../utils/agent-helpers.js';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { validateCredentials, credentialStatusNote } from '../utils/credential-validation.js';
import { credentialResolve } from '../services/credential-store.js';
import { encryptPassword, decryptPassword } from '../utils/crypto.js';
import { updateAgent } from '../services/registry.js';
import { collectOobApiKey } from '../services/auth-socket.js';
import { logLine, logWarn } from '../utils/log-helpers.js';
import { findSecretTokens, legacyTokenWarning } from '../services/secret-token.js';
import { invalidatePreflightCache } from '../services/preflight-check.js';
import type { Agent, SSHExecResult } from '../types.js';
import type { ProviderAdapter } from '../providers/index.js';

export const provisionAuthSchema = z.object({
  ...memberIdentifier,
  api_key: z.string().optional().describe(
    `Your AI provider API key. If omitted, your local OAuth session is copied to the member instead. Supports {{secret.NAME}} token -- value is resolved from the credential store before use.`
  ),
});

export type ProvisionAuthInput = z.infer<typeof provisionAuthSchema>;

/**
 * Machine-readable reason code for every distinct outcome provision_llm_auth
 * previously expressed only as prose (apra-fleet-3swo.7.2). A programmatic
 * caller branches on `structuredContent.reason`; the human summary in `text`
 * stays the human-facing form and only its ASCII decoration changed.
 */
export type ProvisionAuthReason =
  /** Credentials deployed and verified. */
  | 'ok'
  /** Deployed, but the post-deploy auth verification did not confirm. ok=true. */
  | 'deployed_unverified'
  /** API key deployed, but one or more shell-profile writes reported errors. ok=true. */
  | 'deployed_with_errors'
  /** Local members use this machine's own session; nothing to provision. ok=true. */
  | 'skipped_local_member'
  /** No member matched member_id/member_name. */
  | 'member_not_found'
  /** The member is unreachable. */
  | 'member_offline'
  /** A {{secret.NAME}} token in api_key names no stored credential. */
  | 'secret_variable_not_found'
  /** A {{secret.NAME}} token resolved to a credential this member may not use. */
  | 'secret_variable_denied'
  /** A {{secret.NAME}} token resolved to an expired credential. */
  | 'secret_variable_expired'
  /** This provider exposes no OAuth credential files to copy. */
  | 'oauth_not_supported'
  /** The local OAuth token is expired and carries no refresh token. */
  | 'oauth_token_expired_no_refresh'
  /** A local credential file named by the provider does not exist. */
  | 'oauth_credential_file_missing'
  /** Writing a credential file onto the member failed. */
  | 'oauth_credential_write_failed'
  /** Merging provider settings on the member failed. */
  | 'oauth_settings_merge_failed'
  /** Reading/copying a local credential file threw. */
  | 'oauth_copy_failed'
  /** Out-of-band API-key collection was cancelled or returned no key. */
  | 'oob_cancelled';

interface ProvisionAuthFields {
  /** True when credentials were deployed (verified or not). */
  ok: boolean;
  /** Machine-readable outcome code. Branch on this, never on `text`. */
  reason: ProvisionAuthReason;
  /**
   * The resolved ProviderAdapter's own name (src/providers/index.ts registers
   * claude, codex, copilot, agy, opencode and none -- there is no gemini
   * adapter), or null when no member/provider could be resolved.
   */
  provider: string | null;
  /**
   * What was deployed, never the secret itself: the environment-variable name
   * for the API-key flow (e.g. ANTHROPIC_API_KEY) or 'oauth' for the
   * credential-file copy flow. Null when nothing was deployed.
   */
  credentialLabel: string | null;
  /**
   * Credential expiry as an ISO timestamp, or null meaning "no expiry tracked
   * -> OK" (the same reading checkVcsTokenExpiry applies server-side).
   * Populated only when the copied OAuth credential file exposes one; the
   * ProviderAdapter interface has no expiry hook, so a provider whose
   * credential file carries no expiry always reports null.
   */
  expiresAt: string | null;
  /** True when the post-deploy auth check actually confirmed working auth. */
  verified: boolean;
  /** Registry id of the resolved member, or null. */
  memberId: string | null;
  /** Friendly name of the resolved member, or null. */
  memberName: string | null;
}

export interface ProvisionAuthStructured extends ProvisionAuthFields {
  [key: string]: unknown;
}

export interface ProvisionAuthResult {
  text: string;
  structuredContent: ProvisionAuthStructured;
}

const OK_REASONS: ProvisionAuthReason[] = ['ok', 'deployed_unverified', 'deployed_with_errors', 'skipped_local_member'];

/**
 * Resolve a provider's display name for the structured payload without ever
 * throwing (apra-fleet-3swo.9). getProvider() throws a TypeError for any
 * llmProvider value outside the six registered adapters, and only defaults
 * to claude when the value is null/undefined -- so a registry entry carrying
 * a retired or hand-edited provider string would otherwise turn the
 * local-member skip and offline early-returns below into a thrown MCP
 * protocol error (wrapTool has no try/catch) instead of their intended clean
 * message. Falls back to the raw stored value, or null when there is none.
 */
function safeProviderName(llmProvider: Agent['llmProvider']): string | null {
  try {
    return getProvider(llmProvider).name;
  } catch {
    return llmProvider ?? null;
  }
}

function authResult(
  text: string,
  fields: Partial<ProvisionAuthFields> & { reason: ProvisionAuthReason },
): ProvisionAuthResult {
  return {
    text,
    structuredContent: {
      ok: fields.ok ?? OK_REASONS.includes(fields.reason),
      reason: fields.reason,
      provider: fields.provider ?? null,
      credentialLabel: fields.credentialLabel ?? null,
      expiresAt: fields.expiresAt ?? null,
      verified: fields.verified ?? false,
      memberId: fields.memberId ?? null,
      memberName: fields.memberName ?? null,
    },
  };
}

/**
 * Credential-file expiry, normalized to ISO, or null when the file exposes
 * none. Mirrors validateCredentials()'s own (Claude-shaped) parse rather than
 * inventing a second convention; any provider whose credential JSON has no
 * such field simply yields null, which reads as "no expiry tracked -> OK".
 */
function extractCredentialExpiresAt(json: string): string | null {
  try {
    const parsed = JSON.parse(json);
    const raw = parsed?.claudeAiOauth?.expiresAt;
    if (raw === undefined || raw === null) return null;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
}

/** Post-provision auth test bounds: inactivity timeout and hard wall-clock cap. */
export const AUTH_TEST_IDLE_TIMEOUT_MS = 60_000;
export const AUTH_TEST_MAX_TOTAL_MS = 90_000;
const AUTH_ERROR_DETAIL_MAX_CHARS = 300;

/** Suffix a superseded credential file is renamed to (never deleted). */
export const SUPERSEDED_CREDENTIAL_SUFFIX = '.fleet-superseded';

/** Outcome of a post-provision auth test; `detail` is the CLI's own error text on failure. */
export interface AuthCheck {
  ok: boolean;
  detail: string | null;
}

/**
 * Make CLI error text safe and short enough for a tool result: strip the
 * provisioned secret (a shell error can echo the command line that carries it)
 * and anything shaped like an Anthropic credential, force ASCII, collapse
 * whitespace and truncate.
 */
export function sanitizeAuthErrorDetail(text: string, secret?: string): string {
  let out = text;
  if (secret && secret.length >= 4) out = out.split(secret).join('[REDACTED]');
  out = out.replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-[REDACTED]');
  out = out.replace(/[^\x20-\x7E]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (out.length > AUTH_ERROR_DETAIL_MAX_CHARS) out = `${out.slice(0, AUTH_ERROR_DETAIL_MAX_CHARS)}...`;
  return out;
}

/**
 * Turn a `claude -p --output-format json` run into an AuthCheck. A run can
 * exit 0 yet report `is_error: true` (e.g. an invalid key), so both are
 * checked; on failure the CLI's own message (JSON `result`, else stderr,
 * else stdout) becomes the detail.
 */
export function interpretClaudeAuthResult(result: SSHExecResult, secret?: string): AuthCheck {
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  let jsonError: string | null = null;
  let isError = false;
  const jsonLine = stdout.split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith('{')).pop();
  if (jsonLine) {
    try {
      const parsed = JSON.parse(jsonLine);
      if (parsed && (parsed.is_error === true || (typeof parsed.subtype === 'string' && parsed.subtype.startsWith('error')))) {
        isError = true;
        jsonError = typeof parsed.result === 'string' && parsed.result.trim() ? parsed.result : String(parsed.subtype ?? 'error');
      }
    } catch { /* not JSON -- fall back to the raw streams */ }
  }
  if (result.code === 0 && !isError) return { ok: true, detail: null };
  const raw = jsonError ?? (stderr.trim() || stdout.trim() || `CLI exited with code ${result.code}`);
  return { ok: false, detail: sanitizeAuthErrorDetail(raw, secret) };
}

/**
 * Real auth check via `claude -p "hello"` -- makes an actual API call.
 * This is the only reliable validation for both OAuth and API key auth,
 * since `claude auth status` doesn't actually validate API keys.
 * Claude-only: other providers use a version check for verification.
 * Bounded by AUTH_TEST_IDLE_TIMEOUT_MS / AUTH_TEST_MAX_TOTAL_MS so a CLI that
 * stalls on a bad credential can never hang the tool.
 */
async function verifyWithClaudePrompt(agent: Agent, envPrefix?: string, secret?: string): Promise<AuthCheck> {
  const cmds = getOsCommands(getAgentOS(agent), getAgentShell(agent));
  const provider = getProvider('claude');
  const strategy = getStrategy(agent);
  const escapedFolder = escapeDoubleQuoted(agent.workFolder);
  const prefix = envPrefix ? `${envPrefix} ` : '';
  const cmd = `cd "${escapedFolder}" && ${prefix}${cmds.agentCommand(provider, '-p "hello" --output-format json --max-turns 1')}`;
  try {
    const result = await strategy.execCommand(cmd, AUTH_TEST_IDLE_TIMEOUT_MS, AUTH_TEST_MAX_TOTAL_MS);
    return interpretClaudeAuthResult(result, secret);
  } catch (err: any) {
    return { ok: false, detail: sanitizeAuthErrorDetail(String(err?.message ?? err), secret) };
  }
}

/**
 * Version-based CLI check with optional env prefix.
 * Used to verify non-Claude providers after API key provisioning.
 */
async function verifyWithVersion(agent: Agent, provider: ProviderAdapter, envPrefix?: string, secret?: string): Promise<AuthCheck> {
  const cmds = getOsCommands(getAgentOS(agent), getAgentShell(agent));
  const strategy = getStrategy(agent);
  const prefix = envPrefix ? `${envPrefix} ` : '';
  const cmd = `${prefix}${cmds.agentVersion(provider)}`;
  try {
    const result = await strategy.execCommand(cmd, 30000, AUTH_TEST_MAX_TOTAL_MS);
    if (result.code === 0) return { ok: true, detail: null };
    const raw = (result.stderr ?? '').trim() || (result.stdout ?? '').trim() || `CLI exited with code ${result.code}`;
    return { ok: false, detail: sanitizeAuthErrorDetail(raw, secret) };
  } catch (err: any) {
    return { ok: false, detail: sanitizeAuthErrorDetail(String(err?.message ?? err), secret) };
  }
}

/**
 * Drop the named auth env vars from the member's stored encryptedEnvVars
 * (dispatch exports every stored var), keeping every unrelated entry, then
 * merge `extra` in.
 */
function storeAuthEnvVars(agent: Agent, drop: string[], extra?: Record<string, string>): void {
  const current = agent.encryptedEnvVars ?? {};
  const kept = Object.fromEntries(Object.entries(current).filter(([k]) => !drop.includes(k)));
  const next = { ...kept, ...(extra ?? {}) };
  const changed = Object.keys(current).length !== Object.keys(next).length
    || Object.entries(next).some(([k, v]) => current[k] !== v);
  if (changed) updateAgent(agent.id, { encryptedEnvVars: next });
}

// ---------------------------------------------------------------------------
// Flow A: Copy OAuth credentials using the provider interface
// ---------------------------------------------------------------------------
async function provisionOAuthCopy(agent: Agent, provider: ProviderAdapter): Promise<ProvisionAuthResult> {
  const cmds = getOsCommands(getAgentOS(agent), getAgentShell(agent));
  const strategy = getStrategy(agent);
  // Identity fields every return path below shares. `credentialLabel: 'oauth'`
  // names the FLOW, never the secret -- no plaintext credential is ever placed
  // in the structured payload.
  const who = { provider: provider.name, memberId: agent.id, memberName: agent.friendlyName };

  const credentialFiles = provider.oauthCredentialFiles();
  if (!credentialFiles || credentialFiles.length === 0) {
    return authResult(`[FAIL] Provider "${provider.name}" does not support OAuth credential copy.`,
      { ...who, reason: 'oauth_not_supported' });
  }

  // 1. Copy credential files
  let credStatus: ReturnType<typeof validateCredentials> | null = null;
  let expiresAt: string | null = null;
  for (const file of credentialFiles) {
    try {
      const localPath = file.localPath.replace('~', os.homedir());
      if (fs.existsSync(localPath)) {
        const content = fs.readFileSync(localPath, 'utf-8');
        // Validate credentials before sending
        if (file.localPath.includes('.json')) {
            credStatus = validateCredentials(content);
            expiresAt = extractCredentialExpiresAt(content) ?? expiresAt;
            if (credStatus?.status === 'expired-no-refresh') {
              return authResult(`[FAIL] OAuth token in ${file.localPath} is expired with no refresh token.
`
                + `  Run /login in your ${provider.name} session, then re-run provision_llm_auth.`,
                { ...who, reason: 'oauth_token_expired_no_refresh', expiresAt });
            }
        }
        const result = await strategy.execCommand(cmds.credentialFileWrite(content, file.remotePath), 10000);
        if (result.code !== 0 && result.stderr) {
          return authResult(`[FAIL] Failed to write ${file.remotePath} on "${agent.friendlyName}": ${result.stderr}`,
            { ...who, reason: 'oauth_credential_write_failed', expiresAt });
        }
      } else {
        return authResult(`[FAIL] Could not find local credential file: ${localPath}`,
          { ...who, reason: 'oauth_credential_file_missing' });
      }
    } catch (err: any) {
      return authResult(`[FAIL] Failed to copy ${file.localPath} to "${agent.friendlyName}": ${err.message}`,
        { ...who, reason: 'oauth_copy_failed', expiresAt });
    }
  }

  // 2. Merge settings
  const mergeObj = provider.oauthSettingsMerge();
  if (mergeObj) {
    const settingsFile = credentialFiles.find(f => f.remotePath.includes('settings.json'));
    const remoteSettingsPath = settingsFile ? settingsFile.remotePath : `${provider.credentialPath.replace(/\/$/, '')}/settings.json`;
    try {
      const result = await strategy.execCommand(cmds.deepMergeJson(remoteSettingsPath, mergeObj), 10000);
      if (result.code !== 0 && result.stderr) {
        return authResult(`[FAIL] Failed to merge settings on "${agent.friendlyName}": ${result.stderr}`,
          { ...who, reason: 'oauth_settings_merge_failed', expiresAt });
      }
    } catch (err: any) {
      return authResult(`[FAIL] Failed to merge settings on "${agent.friendlyName}": ${err.message}`,
        { ...who, reason: 'oauth_settings_merge_failed', expiresAt });
    }
  }

  // 3. Unset env vars
  const varsToUnset = provider.oauthEnvVarsToUnset() ?? [];
  for (const envVar of varsToUnset) {
    const unsetCmds = cmds.unsetEnv(envVar);
    for (const cmd of unsetCmds) {
      // Best effort, fire and forget
      await strategy.execCommand(cmd, 15000).catch(() => {});
    }
  }
  // Also drop the provider's env-token credentials from the stored member
  // config: dispatch exports them, and an env token outranks the copied file.
  const envKinds = provider.authEnvVarNames?.() ?? [];
  if (envKinds.length > 0) storeAuthEnvVars(agent, envKinds);

  // 4. Verify auth
  const authCheck = provider.name === 'claude'
    ? await verifyWithClaudePrompt(agent)
    : await verifyWithVersion(agent, provider);
  const authWorks = authCheck.ok;

  touchAgent(agent.id);

  const statusNote = credentialStatusNote(credStatus);
  const suffix = statusNote ? `\n  ${statusNote}` : '';

  if (authWorks) {
    return authResult(`[OK] OAuth credentials for ${provider.name} deployed to "${agent.friendlyName}"
`
      + `  Auth: verified with a successful ${provider.name} API call.${suffix}`,
      { ...who, reason: 'ok', credentialLabel: 'oauth', expiresAt, verified: true });
  }

  return authResult(`[WARN] ${provider.name} OAuth credentials deployed to "${agent.friendlyName}" but could not verify auth.
`
    + `  Credential files were written -- try running a prompt to confirm.${suffix}`
    + (authCheck.detail ? `\n  Auth test error: ${authCheck.detail}` : ''),
    { ...who, reason: 'deployed_unverified', credentialLabel: 'oauth', expiresAt, verified: false });
}


// ---------------------------------------------------------------------------
// Flow B -- API Key Override (all providers)
// ---------------------------------------------------------------------------

async function provisionApiKey(agent: Agent, apiKey: string, provider: ProviderAdapter): Promise<ProvisionAuthResult> {
  const cmds = getOsCommands(getAgentOS(agent), getAgentShell(agent));
  const strategy = getStrategy(agent);
  // Credential kind decides the env var (e.g. a Claude Code OAuth token goes
  // to CLAUDE_CODE_OAUTH_TOKEN, an API key to ANTHROPIC_API_KEY).
  const envVarName = provider.authEnvVarForToken(apiKey);
  const kindWarning = provider.authTokenKindWarning?.(apiKey) ?? null;
  const otherKinds = (provider.authEnvVarNames?.() ?? []).filter(n => n !== envVarName);
  const commands = cmds.setEnv(envVarName, apiKey);

  const errors: string[] = [];
  const run = async (cmd: string): Promise<void> => {
    try {
      const result = await strategy.execCommand(cmd, 15000);
      if (result.code !== 0 && result.stderr) {
        errors.push(sanitizeAuthErrorDetail(`Command "${cmd.substring(0, 40)}..." stderr: ${result.stderr}`, apiKey));
      }
    } catch (err: any) {
      errors.push(sanitizeAuthErrorDetail(`Command failed: ${err.message}`, apiKey));
    }
  };

  // Clear the other credential kind first so the CLI cannot pick it up.
  for (const other of otherKinds) {
    for (const cmd of cmds.unsetEnv(other)) await run(cmd);
  }
  for (const cmd of commands) await run(cmd);

  // Store the encrypted credential in the member's registry entry, dropping any
  // stored credential of the other kind (dispatch exports every stored var).
  storeAuthEnvVars(agent, otherKinds, { [envVarName]: encryptPassword(apiKey) });

  // An env token supersedes a copied login file; move a stale one aside
  // (renamed, never deleted) so it cannot shadow or confuse the new credential.
  const movedAside: string[] = [];
  for (const file of provider.credentialFilesSupersededByEnvToken?.() ?? []) {
    try {
      const r = await strategy.execCommand(cmds.credentialFileMoveAside(file, SUPERSEDED_CREDENTIAL_SUFFIX), 15000);
      if (r.code === 0 && r.stdout.includes('moved')) movedAside.push(file);
      else if (r.code !== 0 && r.stderr) errors.push(sanitizeAuthErrorDetail(`Could not move aside ${file}: ${r.stderr}`, apiKey));
    } catch (err: any) {
      errors.push(sanitizeAuthErrorDetail(`Could not move aside ${file}: ${err.message}`, apiKey));
    }
  }

  // Verify the key was persisted in a new shell
  let verified = false;
  try {
    const verifyResult = await strategy.execCommand(cmds.apiKeyCheck(envVarName), 10000);
    verified = verifyResult.stdout.trim().length > 5;
  } catch {
    // May still work after re-login
  }

  // Verify with a real CLI call
  const envPrefix = cmds.envPrefix(envVarName, apiKey);
  const authCheck = provider.name === 'claude'
    ? await verifyWithClaudePrompt(agent, envPrefix, apiKey)
    : await verifyWithVersion(agent, provider, envPrefix, apiKey);
  const authWorks = authCheck.ok;

  touchAgent(agent.id);

  const kindLabel = /OAUTH/i.test(envVarName) ? 'OAuth token' : 'API key';
  let result = '';
  if (errors.length === 0) {
    result += `[OK] ${kindLabel} provisioned on "${agent.friendlyName}"
`;
  } else {
    result += `[WARN] ${kindLabel} provisioned with some issues on "${agent.friendlyName}":
`;
    for (const e of errors) {
      result += `  - ${e}
`;
    }
  }

  result += `
  Environment: ${envVarName} set in shell profiles and stored in member config
`;
  result += `  Verification: ${verified ? 'Key visible in new shell' : 'Key will be available after re-login'}
`;
  if (otherKinds.length > 0) {
    result += `  Cleared: ${otherKinds.join(', ')} removed from shell profiles and member config (other credential kind)
`;
  }
  for (const file of movedAside) {
    result += `  Superseded: ${file} moved to ${file}${SUPERSEDED_CREDENTIAL_SUFFIX} (the env credential now applies)
`;
  }
  if (kindWarning) {
    result += `  [WARN] ${kindWarning}
`;
  }
  result += `  Auth test: ${authWorks
    ? `${provider.name} CLI authenticated successfully`
    : `FAILED -- ${authCheck.detail ?? 'no error text from the CLI'}`}
`;

  // credentialLabel is the env var the key was deployed under (e.g.
  // ANTHROPIC_API_KEY) -- a name, never the key itself. An API key carries no
  // expiry the server can observe, so expiresAt stays null ("no expiry
  // tracked -> OK").
  return authResult(result, {
    provider: provider.name,
    memberId: agent.id,
    memberName: agent.friendlyName,
    reason: errors.length > 0 ? 'deployed_with_errors' : authWorks ? 'ok' : 'deployed_unverified',
    credentialLabel: envVarName,
    expiresAt: null,
    verified: authWorks,
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function provisionAuth(input: ProvisionAuthInput): Promise<ProvisionAuthResult> {
  const agentOrError = resolveMember(input.member_id, input.member_name);
  if (typeof agentOrError === 'string') {
    return authResult(agentOrError, {
      reason: 'member_not_found',
      memberId: input.member_id ?? null,
      memberName: input.member_name ?? null,
    });
  }
  const agent = agentOrError as Agent;
  const who = { memberId: agent.id, memberName: agent.friendlyName };

  if (agent.agentType === 'local') {
    return authResult(`[SKIP] Skipping "${agent.friendlyName}" -- local members use this machine's credentials directly.`,
      { ...who, reason: 'skipped_local_member', provider: safeProviderName(agent.llmProvider) });
  }

  const strategy = getStrategy(agent);
  const conn = await strategy.testConnection();
  if (!conn.ok) {
    return authResult(`[FAIL] Member "${agent.friendlyName}" is offline: ${conn.error}`,
      { ...who, reason: 'member_offline', provider: safeProviderName(agent.llmProvider) });
  }

  // getProvider() defaults to claude ONLY when llmProvider is null/undefined;
  // every registered adapter (claude, codex, copilot, agy, opencode, none)
  // reports its own `name` into the structured payload below, so nothing here
  // assumes Claude-specific credential fields.
  const provider = getProvider(agent.llmProvider);

  // Every success path logs and invalidates the preflight cache; the
  // `ok` discriminator replaces the old "does the text start with the failure
  // emoji" test, which was the only signal before apra-fleet-3swo.7.2.
  const onSuccess = (result: ProvisionAuthResult): ProvisionAuthResult => {
    if (result.structuredContent.ok) {
      logLine('provision_llm_auth', `provider=${provider.name}`, agent);
      invalidatePreflightCache(agent.id);
    }
    return result;
  };

  // Flow B: API key is provided directly
  if (input.api_key) {
    const tokens = findSecretTokens(input.api_key);
    const tokenNames = new Set(tokens.map((t) => t.name));
    const legacyNames = tokens.filter((t) => t.legacy).map((t) => t.name);
    let resolvedKey = input.api_key;
    for (const name of tokenNames) {
      const entry = credentialResolve(name, agent.friendlyName);
      const secretFailure = { ...who, provider: provider.name };
      if (!entry) {
        return authResult(`[FAIL] Credential "${name}" not found. Run credential_store_set first.`,
          { ...secretFailure, reason: 'secret_variable_not_found' });
      }
      if ('denied' in entry) {
        return authResult(`[FAIL] ${entry.denied}`, { ...secretFailure, reason: 'secret_variable_denied' });
      }
      if ('expired' in entry) {
        return authResult(`[FAIL] ${entry.expired}`, { ...secretFailure, reason: 'secret_variable_expired' });
      }
      resolvedKey = resolvedKey.replaceAll(`{{secret.${name}}}`, entry.plaintext);
      resolvedKey = resolvedKey.replaceAll(`{{secure.${name}}}`, entry.plaintext); // legacy spelling
    }
    if (legacyNames.length > 0) {
      logWarn('provision_llm_auth', legacyTokenWarning(legacyNames), agent);
    }
    const apiKeyResult = await provisionApiKey(agent, resolvedKey, provider);
    if (legacyNames.length > 0) {
      apiKeyResult.text += `\n${legacyTokenWarning(legacyNames)}`;
    }
    return onSuccess(apiKeyResult);
  }

  // Flow A: OAuth credentials copy
  if (provider.oauthCredentialFiles()?.length) {
    return onSuccess(await provisionOAuthCopy(agent, provider));
  }

  // Fallback: OOB key collection for non-OAuth or non-copyable providers
  const oob = await collectOobApiKey(agent.friendlyName, 'provision_llm_auth', {
    prompt: `Enter API key for ${provider.name} on ${agent.friendlyName}`,
  });
  if ('fallback' in oob) {
    return authResult(oob.fallback ?? 'Error: OOB operation cancelled.',
      { ...who, provider: provider.name, reason: 'oob_cancelled' });
  }
  return onSuccess(await provisionApiKey(agent, decryptPassword(oob.password!), provider));
}
