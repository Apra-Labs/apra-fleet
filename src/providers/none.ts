import type { ProviderAdapter, PromptOptions, ParsedResponse, WorkspaceTrustExecFn, EnsureWorkspaceTrustedResult, SessionIdStrategy, TargetOS } from './provider.js';
import type { LlmProvider, SSHExecResult } from '../types.js';
import type { PromptErrorCategory } from '../utils/prompt-errors.js';
import type { MemberShell } from '../os/os-commands.js';

const NO_LLM_ERROR = 'This member has no LLM provider (llm_provider: "none") -- it is a plain command executor. Use execute_command instead of execute_prompt.';

/**
 * Null-object provider for no-LLM members (apra-fleet-us9.14): a plain
 * command executor with no CLI, no auth, no prompt/model concept at all.
 * execute_prompt rejects members on this provider immediately (both modes,
 * per apra-fleet-us9.8) -- every method here that would only ever be
 * reached via that path throws rather than returning a plausible-looking
 * fake value, so a caller that forgets the 'none' check fails loudly
 * instead of silently doing something wrong. execute_command is fully
 * provider-agnostic already and needs no changes to support this provider.
 */
export class NoneProvider implements ProviderAdapter {
  readonly name: LlmProvider = 'none';
  readonly processName = '';
  readonly authEnvVar = '';
  readonly credentialPath = '';
  readonly instructionFileName = '';

  cliCommand(_args: string): string {
    throw new Error(NO_LLM_ERROR);
  }

  versionCommand(): string {
    throw new Error(NO_LLM_ERROR);
  }

  // Still refuses by design (apra-fleet-7dir.2.7): the widened signature
  // gains no new behavior here -- there is no install path for a
  // no-LLM member regardless of shell.
  installCommand(_os: 'linux' | 'macos' | 'windows', _shell?: MemberShell): string {
    throw new Error(NO_LLM_ERROR);
  }

  updateCommand(): string {
    throw new Error(NO_LLM_ERROR);
  }

  buildPromptCommand(_opts: PromptOptions): string {
    throw new Error(NO_LLM_ERROR);
  }

  skipPermissionsFlag(): string {
    return '';
  }

  permissionModeAutoFlag(): string | null {
    return null;
  }

  resolvePermissionFlag(_unattended: false | 'auto' | 'dangerous' | undefined): string {
    throw new Error(NO_LLM_ERROR);
  }

  parseResponse(_result: SSHExecResult): ParsedResponse {
    throw new Error(NO_LLM_ERROR);
  }

  supportsResume(): boolean {
    return false;
  }

  supportsMaxTurns(): boolean {
    return false;
  }

  sessionIdStrategy(): SessionIdStrategy {
    return { type: 'provider-minted' };
  }

  resolveSessionLogPath(_sessionId: string, _workFolder: string, _homeDir?: string | null, _targetOs?: TargetOS): string {
    return '';
  }

  resolveSessionLogDir(_workFolder: string, _homeDir?: string | null, _targetOs?: TargetOS): string | null {
    return null;
  }

  resumeFlag(_sessionId?: string, _resuming?: boolean): string {
    return '';
  }

  modelTiers(): Record<'cheap' | 'standard' | 'premium', string> {
    return { cheap: '', standard: '', premium: '' };
  }

  modelForTier(_tier: 'cheap' | 'standard' | 'premium'): string {
    return '';
  }

  modelFlag(_model: string): string {
    return '';
  }

  agentDirectories(agentName: string): { project: string; home: string } {
    throw new Error('none provider has no agent directories');
  }

  transformAgent(content: string, _relPath: string): string {
    return content;
  }

  agentNameFlag(_agentName: string): string {
    return '';
  }

  classifyError(_output: string): PromptErrorCategory {
    return 'unknown';
  }

  permissionConfigPaths(): string[] {
    return [];
  }

  composePermissionConfig(_role: 'doer' | 'reviewer', _allow?: string[]): Array<Record<string, unknown> | string> {
    return [];
  }

  supportsOAuthCopy(): boolean {
    return false;
  }

  supportsApiKey(): boolean {
    return false;
  }

  oauthCredentialFiles(): Array<{ localPath: string; remotePath: string }> | null {
    return null;
  }

  oauthSettingsMerge(): Record<string, unknown> | null {
    return null;
  }

  oauthEnvVarsToUnset(): string[] {
    return [];
  }

  authEnvVarForToken(_token: string): string {
    return '';
  }

  wrapWindowsPrompt(_setupCmd: string, _filePath: string, _argList: string, _sessionId?: string, _model?: string): string {
    throw new Error(NO_LLM_ERROR);
  }

  jsonOutputFlag(): string {
    return '';
  }

  headlessInvocation(_promptLiteral: string): string {
    throw new Error(NO_LLM_ERROR);
  }

  async ensureWorkspaceTrusted(_workFolder: string, _execCommand: WorkspaceTrustExecFn, _agentOs?: 'linux' | 'macos' | 'windows'): Promise<EnsureWorkspaceTrustedResult> {
    // No-LLM members have no CLI and no trust concept whatsoever. No-op (unlike other
    // methods on this class, this one is reachable from call sites that iterate all
    // members regardless of provider, so it returns a plain no-op rather than throwing).
    return { seeded: false, detail: 'none: no LLM provider, no trust concept' };
  }
}
