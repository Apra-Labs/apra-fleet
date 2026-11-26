// The LLM credential label list_members (llm_auth) and member_detail
// (llm_cli.auth) report for a member -- one probe, shared by both tools.
//
// Label: 'none', or the sources present joined with '+' in this fixed order:
//   api-key     -- an API-key env var (ProviderAdapter.authEnvVarKind -> 'api-key';
//                  the default for a provider that does not classify its vars)
//   oauth-token -- an OAuth/setup-token env var (e.g. Claude's CLAUDE_CODE_OAUTH_TOKEN)
//   oauth-login -- the provider's OAuth credentials file (the CLI's /login)
// e.g. 'oauth-token', 'api-key+oauth-login', 'oauth-token+oauth-login'.
// The order is also the precedence the CLIs apply, so with more than one
// source the first is the one used; precedenceNote says so.

import type { OsCommands } from '../os/os-commands.js';
import type { ProviderAdapter } from '../providers/provider.js';
import type { SSHExecResult } from '../types.js';

export type LlmAuthSource = 'api-key' | 'oauth-token' | 'oauth-login';

const SOURCE_ORDER: readonly LlmAuthSource[] = ['api-key', 'oauth-token', 'oauth-login'];

export interface LlmAuthStatus {
  sources: LlmAuthSource[];
  label: string;
  /** With more than one source: which one the CLI uses; null otherwise. */
  precedenceNote: string | null;
}

type Exec = (cmd: string, timeoutMs: number) => Promise<SSHExecResult>;

/** Every non-empty auth env var name the provider reads (never an empty name). */
export function providerAuthEnvVars(provider: ProviderAdapter): string[] {
  const names = provider.authEnvVarNames?.() ?? [provider.authEnvVar];
  return [...new Set(names.filter((n): n is string => typeof n === 'string' && n.length > 0))];
}

export function llmAuthStatusFromSources(present: Iterable<LlmAuthSource>): LlmAuthStatus {
  const set = new Set(present);
  const sources = SOURCE_ORDER.filter(s => set.has(s));
  const label = sources.length ? sources.join('+') : 'none';
  const precedenceNote = sources.length > 1
    ? `${sources[0]} takes precedence over ${sources.slice(1).join(' and ')}`
    : null;
  return { sources, label, precedenceNote };
}

/** Probe the member for every credential source (all env vars, not the first hit). */
export async function probeLlmAuthStatus(
  provider: ProviderAdapter,
  cmds: OsCommands,
  exec: Exec,
  timeoutMs: number,
): Promise<LlmAuthStatus> {
  const present = new Set<LlmAuthSource>();

  const oauthFiles = provider.oauthCredentialFiles?.();
  if (oauthFiles && oauthFiles.length > 0) {
    try {
      // The first file stands for the set.
      const r = await exec(cmds.credentialFileCheck(oauthFiles[0].remotePath), timeoutMs);
      if (r.stdout.trim() === 'found') present.add('oauth-login');
    } catch { /* unreadable: not counted */ }
  }

  for (const envVar of providerAuthEnvVars(provider)) {
    try {
      const r = await exec(cmds.apiKeyCheck(envVar), timeoutMs);
      if (r.stdout.trim().length > 5) present.add(provider.authEnvVarKind?.(envVar) ?? 'api-key');
    } catch { /* unreadable: not counted */ }
  }

  return llmAuthStatusFromSources(present);
}
