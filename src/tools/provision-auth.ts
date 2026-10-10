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
import { stageEnvVars, writeMemberSecretFile, removeMemberSecretFile, SecretDeliveryError } from '../services/member-secret-env.js';
import { ensureMemberLlmCli, type LlmCliNotFound } from '../services/llm-cli-resolver.js';
import type { Agent, SSHExecResult } from '../types.js';
import type { ProviderAdapter } from '../providers/index.js';

export const provisionAuthSchema = z.object({
  ...memberIdentifier,
  api_key: z.string().optional().describe(
    `Your AI provider API key or Claude Code OAuth token (sk-ant-oat..., from \`claude setup-token\`). If omitted, a credential already stored for the member is re-deployed, else your local OAuth session is copied to the member. Supports {{secret.NAME}} token -- value is resolved from the credential store before use.`
  ),
  force_oauth_copy: z.boolean().optional().describe(
    `Only without api_key: copy your local OAuth session even when the member has a stored env credential, and clear that credential (ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN) so the copied login applies. Default false.`
  ),
  clear_stored_credentials: z.boolean().optional().describe(
    'Remove ALL credential env vars stored for this member in the fleet registry (what every dispatch delivers to it), and do nothing else. '
    + 'Registry only: works for relay, offline and local members, and never contacts the member (values already written to its shell profile or user environment stay). '
    + 'Use it when a dispatch fails with reason secret_delivery_unavailable and the credential is provided on that machine itself. Cannot be combined with api_key or force_oauth_copy.'
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
  | 'oob_cancelled'
  /** The member has no channel that delivers a key without a command line
   *  (relay member, or SFTP unavailable); nothing was stored. */
  | 'secret_delivery_unavailable'
  /** clear_stored_credentials: the member's stored credential env vars were removed. ok=true. */
  | 'stored_credentials_cleared'
  /** clear_stored_credentials was combined with api_key or force_oauth_copy. */
  | 'invalid_arguments';

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
  /**
   * Present only when the post-deploy check could not run because the
   * member's LLM CLI was not found anywhere the resolver probed
   * (src/services/llm-cli-resolver.ts): the probed locations and a one-line
   * fix, instead of a raw shell "command not found".
   */
  llmCliNotFound?: LlmCliNotFound;
}

export interface ProvisionAuthStructured extends ProvisionAuthFields {
  [key: string]: unknown;
}

export interface ProvisionAuthResult {
  text: string;
  structuredContent: ProvisionAuthStructured;
}

const OK_REASONS: ProvisionAuthReason[] = ['ok', 'deployed_unverified', 'deployed_with_errors', 'skipped_local_member', 'stored_credentials_cleared'];

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
      ...(fields.llmCliNotFound ? { llmCliNotFound: fields.llmCliNotFound } : {}),
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
  /** Set when the member's LLM CLI could not be located (apra-fleet-fqkr.1.2). */
  llmCliNotFound?: LlmCliNotFound;
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
async function verifyWithClaudePrompt(agent: Agent, env?: Record<string, string>, secret?: string): Promise<AuthCheck> {
  const cmds = getOsCommands(getAgentOS(agent), getAgentShell(agent));
  const provider = getProvider('claude');
  const cli = await ensureMemberLlmCli(agent, provider);
  if (!cli.ok) return { ok: false, detail: cli.message, llmCliNotFound: cli.notFound };
  const strategy = getStrategy(agent);
  const escapedFolder = escapeDoubleQuoted(agent.workFolder);
  return runWithStagedEnv(agent, env, secret,
    (prefix) => strategy.execCommand(`${prefix}cd "${escapedFolder}" && ${cmds.agentCommand(provider, '-p "hello" --output-format json --max-turns 1', cli.path)}`, AUTH_TEST_IDLE_TIMEOUT_MS, AUTH_TEST_MAX_TOTAL_MS),
    (result) => interpretClaudeAuthResult(result, secret));
}

/**
 * Run one verification command with `env` delivered through a staged
 * owner-only file (never inline on the command line) and interpret the FULL
 * exec result (an exit-0 run can still be an auth failure). A delivery or
 * exec failure becomes a sanitized failed AuthCheck.
 */
async function runWithStagedEnv(
  agent: Agent,
  env: Record<string, string> | undefined,
  secret: string | undefined,
  run: (prefix: string) => Promise<SSHExecResult>,
  interpret: (result: SSHExecResult) => AuthCheck,
): Promise<AuthCheck> {
  let stagedPath: string | null = null;
  let consumed = false;
  try {
    const staged = await stageEnvVars(agent, env ?? {});
    stagedPath = staged.path;
    const result = await run(staged.prefix);
    consumed = result.code === 0;
    return interpret(result);
  } catch (err: any) {
    return { ok: false, detail: sanitizeAuthErrorDetail(String(err?.message ?? err), secret) };
  } finally {
    // The prefix deletes the file once loaded; a failed run may not have.
    if (stagedPath && !consumed) await removeMemberSecretFile(agent, stagedPath);
  }
}

/**
 * Version-based CLI check with optional staged env.
 * Used to verify non-Claude providers after API key provisioning.
 */
async function verifyWithVersion(agent: Agent, provider: ProviderAdapter, env?: Record<string, string>, secret?: string): Promise<AuthCheck> {
  const cmds = getOsCommands(getAgentOS(agent), getAgentShell(agent));
  const cli = await ensureMemberLlmCli(agent, provider);
  if (!cli.ok) return { ok: false, detail: cli.message, llmCliNotFound: cli.notFound };
  const strategy = getStrategy(agent);
  return runWithStagedEnv(agent, env, secret,
    (prefix) => strategy.execCommand(`${prefix}${cmds.agentVersion(provider, cli.path)}`, 30000, AUTH_TEST_MAX_TOTAL_MS),
    (result) => {
      if (result.code === 0) return { ok: true, detail: null };
      const raw = (result.stderr ?? '').trim() || (result.stdout ?? '').trim() || `CLI exited with code ${result.code}`;
      return { ok: false, detail: sanitizeAuthErrorDetail(raw, secret) };
    });
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
async function provisionOAuthCopy(agent: Agent, provider: ProviderAdapter, clearEnvCredentials = false): Promise<ProvisionAuthResult> {
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
        // Content (OAuth access + refresh token) travels over SFTP/fs into an
        // owner-only staged file; the install command carries only paths.
        const staged = await writeMemberSecretFile(agent, content, 'cred');
        const result = await strategy.execCommand(cmds.credentialFileInstall(staged, file.remotePath), 10000)
          .catch(async (err) => { await removeMemberSecretFile(agent, staged); throw err; });
        if (result.code !== 0) await removeMemberSecretFile(agent, staged);
        if (result.code !== 0 && result.stderr) {
          return authResult(`[FAIL] Failed to write ${file.remotePath} on "${agent.friendlyName}": ${result.stderr}`,
            { ...who, reason: 'oauth_credential_write_failed', expiresAt });
        }
      } else {
        return authResult(`[FAIL] Could not find local credential file: ${localPath}`,
          { ...who, reason: 'oauth_credential_file_missing' });
      }
    } catch (err: any) {
      if (err instanceof SecretDeliveryError) {
        return authResult(`[FAIL] ${err.message}`, { ...who, reason: 'secret_delivery_unavailable', expiresAt });
      }
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

  // 3. Unset env vars. Env credentials (e.g. CLAUDE_CODE_OAUTH_TOKEN /
  // ANTHROPIC_API_KEY) are cleared ONLY on an explicit force_oauth_copy:
  // this flow also runs automatically (cloud start, sprint self-heal) and must
  // never erase an operator-provisioned credential.
  const envKinds = clearEnvCredentials ? (provider.authEnvVarNames?.() ?? []) : [];
  const varsToUnset = [...new Set([...(provider.oauthEnvVarsToUnset() ?? []), ...envKinds])];
  for (const envVar of varsToUnset) {
    const unsetCmds = cmds.unsetEnv(envVar);
    for (const cmd of unsetCmds) {
      // Best effort, fire and forget
      await strategy.execCommand(cmd, 15000).catch(() => {});
    }
  }
  // Also drop them from the stored member config (dispatch exports it).
  if (envKinds.length > 0) storeAuthEnvVars(agent, envKinds);
  const clearedNote = envKinds.length > 0
    ? `\n  Cleared: ${envKinds.join(', ')} removed from shell profiles and member config (force_oauth_copy)`
    : '';

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
      + `  Auth: verified with a successful ${provider.name} API call.${suffix}${clearedNote}`,
      { ...who, reason: 'ok', credentialLabel: 'oauth', expiresAt, verified: true });
  }

  return authResult(`[WARN] ${provider.name} OAuth credentials deployed to "${agent.friendlyName}" but could not verify auth.
`
    + `  Credential files were written -- try running a prompt to confirm.${suffix}${clearedNote}`
    + (authCheck.detail ? `\n  Auth test error: ${authCheck.detail}` : ''),
    { ...who, reason: 'deployed_unverified', credentialLabel: 'oauth', expiresAt, verified: false, llmCliNotFound: authCheck.llmCliNotFound });
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

  // Persist into the member's profile / user env. The value travels in an
  // owner-only file (SFTP / fs); the command that applies it and deletes the
  // file carries only the path -- never the key (it would sit in the member
  // shell's argv, readable via ps). Error text never echoes a command.
  const errors: string[] = [];
  let persistFile: string | null = null;
  let persisted = false;
  // 1. Stage / refuse. No safe delivery channel (relay member, SFTP
  // unavailable): refuse BEFORE changing anything -- a stored key every later
  // dispatch cannot deliver would break the member instead of failing here.
  try {
    persistFile = await writeMemberSecretFile(agent, cmds.persistEnvFileContent(envVarName, apiKey), 'persist');
  } catch (err: any) {
    if (!(err instanceof SecretDeliveryError)) throw err;
    return authResult(`[FAIL] ${err.message}\n  This call changed nothing on the member or in its stored config.`, {
      provider: provider.name, memberId: agent.id, memberName: agent.friendlyName,
      reason: 'secret_delivery_unavailable', credentialLabel: envVarName,
    });
  }

  const run = async (cmd: string): Promise<void> => {
    try {
      const result = await strategy.execCommand(cmd, 15000);
      if (result.code !== 0 && result.stderr) errors.push(sanitizeAuthErrorDetail(`stderr: ${result.stderr}`, apiKey));
    } catch (err: any) {
      errors.push(sanitizeAuthErrorDetail(`Command failed: ${err.message}`, apiKey));
    }
  };

  // 2. Clear the other credential kind first so the CLI cannot pick it up.
  for (const other of otherKinds) {
    for (const cmd of cmds.unsetEnv(other)) await run(cmd);
  }

  // 3. Persist (path-only command; the staged file is deleted by it).
  try {
    const result = await strategy.execCommand(cmds.persistEnvFromFile(envVarName, persistFile), 15000);
    persisted = result.code === 0;
    if (!persisted) errors.push(sanitizeAuthErrorDetail(`Persisting ${envVarName} failed (exit ${result.code})${result.stderr ? `: ${result.stderr}` : ''}`, apiKey));
  } catch (err: any) {
    errors.push(sanitizeAuthErrorDetail(`Persisting ${envVarName} failed: ${err.message}`, apiKey));
  } finally {
    if (!persisted) await removeMemberSecretFile(agent, persistFile);
  }

  // 4. Store the encrypted credential in the member's registry entry, dropping any
  // stored credential of the other kind (dispatch delivers every stored var).
  storeAuthEnvVars(agent, otherKinds, { [envVarName]: encryptPassword(apiKey) });

  // 5. An env token supersedes a copied login file; move a stale one aside
  // (renamed, never deleted) so it cannot shadow or confuse the new credential.
  // Timestamped suffix so a later switch never overwrites an earlier backup.
  const backupSuffix = `${SUPERSEDED_CREDENTIAL_SUFFIX}-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
  const movedAside: string[] = [];
  for (const file of provider.credentialFilesSupersededByEnvToken?.(apiKey) ?? []) {
    try {
      const r = await strategy.execCommand(cmds.credentialFileMoveAside(file, backupSuffix), 15000);
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

  // 6. Verify with a real CLI call, the key delivered through a staged file.
  const verifyEnv = { [envVarName]: apiKey };
  const authCheck = provider.name === 'claude'
    ? await verifyWithClaudePrompt(agent, verifyEnv, apiKey)
    : await verifyWithVersion(agent, provider, verifyEnv, apiKey);
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
    result += `  Superseded: ${file} moved to ${file}${backupSuffix} (the env credential now applies)
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
    llmCliNotFound: authCheck.llmCliNotFound,
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

  // Registry-only recovery path: never contacts the member, so it works for
  // relay, offline and local members alike (the supported way out of
  // secret_delivery_unavailable).
  if (input.clear_stored_credentials) {
    if (input.api_key || input.force_oauth_copy) {
      return authResult('[FAIL] clear_stored_credentials cannot be combined with api_key or force_oauth_copy.',
        { ...who, reason: 'invalid_arguments', provider: safeProviderName(agent.llmProvider) });
    }
    const names = Object.keys(agent.encryptedEnvVars ?? {});
    updateAgent(agent.id, { encryptedEnvVars: undefined });
    invalidatePreflightCache(agent.id);
    logLine('provision_llm_auth', `cleared ${names.length} stored credential env var(s): ${names.join(', ') || '(none)'}`, agent);
    return authResult(names.length > 0
      ? `[OK] Cleared ${names.length} stored credential env var(s) for "${agent.friendlyName}": ${names.join(', ')}.\n`
        + '  Dispatches no longer deliver them; provide the credential in that machine\'s own environment (or re-run provision_llm_auth). '
        + 'Values already written to the member\'s shell profile / user environment were not touched.'
      : `[OK] "${agent.friendlyName}" has no stored credential env vars -- nothing to clear.`,
    { ...who, reason: 'stored_credentials_cleared', provider: safeProviderName(agent.llmProvider), credentialLabel: names.join(',') || null });
  }

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

  // No api_key: if the member holds a stored env credential (the operator's
  // chosen one, e.g. a CLAUDE_CODE_OAUTH_TOKEN), re-deploy THAT instead of
  // copying this machine's login over it. This path also runs automatically
  // (cloud start, sprint self-heal), so it must never replace or erase the
  // operator's credential; force_oauth_copy is the explicit way to switch.
  let storedNote = '';
  if (!input.force_oauth_copy) {
    const storedName = (provider.authEnvVarNames?.() ?? []).find(n => agent.encryptedEnvVars?.[n]);
    if (storedName) {
      let storedValue: string | null = null;
      try {
        storedValue = decryptPassword(agent.encryptedEnvVars![storedName]);
      } catch {
        storedNote = `\n  [WARN] Stored ${storedName} could not be decrypted; copied the local login instead (the stored value was left in place).`;
      }
      if (storedValue) {
        const redeployed = await provisionApiKey(agent, storedValue, provider);
        redeployed.text += redeployed.structuredContent.reason === 'secret_delivery_unavailable'
          ? `\n  The member's stored ${storedName} (re-deploy attempted, no api_key given) is still in its config and cannot be delivered; clear it with clear_stored_credentials: true, or pass force_oauth_copy: true to replace it with your local login.\n`
          : `\n  Re-deployed the member's stored ${storedName} (no api_key given). Pass force_oauth_copy: true to replace it with your local login.\n`;
        return onSuccess(redeployed);
      }
    }
  }

  // Flow A: OAuth credentials copy
  if (provider.oauthCredentialFiles()?.length) {
    const copied = await provisionOAuthCopy(agent, provider, input.force_oauth_copy === true);
    copied.text += storedNote;
    return onSuccess(copied);
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
