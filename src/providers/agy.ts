import type { ProviderAdapter, PromptOptions, ParsedResponse } from './provider.js';
import type { LlmProvider, SSHExecResult } from '../types.js';
import type { PromptErrorCategory } from '../utils/prompt-errors.js';
import { classifyPromptError } from '../utils/prompt-errors.js';
import { escapeDoubleQuoted } from '../os/os-commands.js';

export class AgyProvider implements ProviderAdapter {
  readonly name: LlmProvider = 'agy';
  readonly processName = 'agy';
  readonly authEnvVar = 'GEMINI_API_KEY';
  readonly credentialPath = '~/.gemini/antigravity-cli/settings.json';
  readonly instructionFileName = 'GEMINI.md';

  cliCommand(args: string): string {
    return `agy ${args}`;
  }

  versionCommand(): string {
    return 'agy --version 2>&1';
  }

  installCommand(os: 'linux' | 'macos' | 'windows'): string {
    return 'npm install -g @google/antigravity-cli';
  }

  updateCommand(): string {
    return 'agy update';
  }

  buildPromptCommand(opts: PromptOptions): string {
    const { folder, promptFile, sessionId, resuming, unattended, inv } = opts;
    const escapedFolder = escapeDoubleQuoted(folder);
    let instruction = `Your task is described in ${promptFile} in the current directory. Read that file first, then execute the task.`;
    if (inv) {
      instruction = `[${inv}] ${instruction}`;
    }

    let cmd = `cd "${escapedFolder}" && agy -p "${instruction}"`;

    if (resuming && sessionId) {
      cmd += ` --conversation "${escapeDoubleQuoted(sessionId)}"`;
    }

    if (unattended === 'dangerous') {
      cmd += ' --dangerously-skip-permissions';
    }

    return cmd;
  }

  skipPermissionsFlag(): string {
    return '--dangerously-skip-permissions';
  }

  permissionModeAutoFlag(): string | null {
    return null;
  }

  parseResponse(result: SSHExecResult): ParsedResponse {
    const raw = result.stdout.trim();
    return {
      result: raw,
      sessionId: undefined,
      isError: result.code !== 0,
      raw,
      usage: undefined,
    };
  }

  supportsResume(): boolean {
    return true;
  }

  supportsMaxTurns(): boolean {
    return false;
  }

  resumeFlag(sessionId?: string, resuming?: boolean): string {
    if (!sessionId) return '';
    return resuming ? `--conversation "${escapeDoubleQuoted(sessionId)}"` : '';
  }

  modelTiers(): Record<'cheap' | 'standard' | 'premium', string> {
    return {
      cheap: 'gemini-3.5-flash-lite',
      standard: 'gemini-3.5-flash',
      premium: 'claude-sonnet-4.6',
    };
  }

  modelForTier(tier: 'cheap' | 'mid' | 'premium'): string {
    if (tier === 'cheap') return 'gemini-3.5-flash-lite';
    if (tier === 'premium') return 'claude-sonnet-4.6';
    return 'gemini-3.5-flash';
  }

  modelFlag(model: string): string {
    return '';
  }

  classifyError(output: string): PromptErrorCategory {
    return classifyPromptError(output);
  }

  permissionConfigPaths(): string[] {
    return ['.gemini/antigravity-cli/settings.json'];
  }

  composePermissionConfig(_role: 'doer' | 'reviewer', allow: string[] = []): Array<Record<string, unknown> | string> {
    return [{ permissions: { allow }, mcpServers: { 'apra-fleet': { disabled: true } }, skillOverrides: { pm: 'off', fleet: 'off' } }];
  }

  supportsOAuthCopy(): boolean {
    return false;
  }

  supportsApiKey(): boolean {
    return true;
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

  authEnvVarForToken(token: string): string {
    return 'GEMINI_API_KEY';
  }

  wrapWindowsPrompt(setupCmd: string, filePath: string, argList: string): string {
    return `${setupCmd}Write-Output "FLEET_PID:$pid"; ${filePath} ${argList}`;
  }

  jsonOutputFlag(): string {
    return '';
  }

  headlessInvocation(promptLiteral: string): string {
    return `-p "${promptLiteral}"`;
  }
}
