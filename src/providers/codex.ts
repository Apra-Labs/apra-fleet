import type { ProviderAdapter, PromptOptions, ParsedResponse } from './provider.js';
import type { LlmProvider, SSHExecResult } from '../types.js';
import type { PromptErrorCategory } from '../utils/prompt-errors.js';
import { escapeDoubleQuoted } from '../os/os-commands.js';

export class CodexProvider implements ProviderAdapter {
  readonly name: LlmProvider = 'codex';
  readonly processName = 'codex';
  readonly authEnvVar = 'OPENAI_API_KEY';
  readonly credentialPath = '~/.codex/';
  readonly instructionFileName = 'AGENTS.md';

  cliCommand(args: string): string {
    return `codex ${args}`;
  }

  versionCommand(): string {
    return 'codex --version 2>&1';
  }

  installCommand(os: 'linux' | 'macos' | 'windows'): string {
    if (os === 'macos') {
      return 'brew install --cask codex';
    }
    return 'npm install -g @openai/codex';
  }

  updateCommand(): string {
    return 'npm update -g @openai/codex';
  }

  buildPromptCommand(opts: PromptOptions): string {
    const { folder, promptFile, sessionId, unattended, model } = opts;
    const escapedFolder = escapeDoubleQuoted(folder);
    const instruction = `Your task is described in ${promptFile} in the current directory. Read that file first, then execute the task.`;
    let cmd = `cd "${escapedFolder}" && codex exec "${instruction}" --json`;
    if (sessionId) {
      cmd += ' resume';
    }
    if (unattended === 'auto') {
      cmd += ' --ask-for-approval auto-edit';
    } else if (unattended === 'dangerous') {
      cmd += ` ${this.skipPermissionsFlag()}`;
    }
    if (model) {
      cmd += ` --model "${escapeDoubleQuoted(model)}"`;
    }
    return cmd;
  }

  skipPermissionsFlag(): string {
    return '--sandbox danger-full-access --ask-for-approval never';
  }

  permissionModeAutoFlag(): string | null {
    return '--ask-for-approval auto-edit';
  }

  /**
   * Codex emits NDJSON: one JSON event per state change.
   * Parse all events, extract final result from last meaningful event.
   */
  parseResponse(result: SSHExecResult): ParsedResponse {
    const raw = result.stdout.trim();
    const lines = raw.split('\n').filter(l => l.trim().startsWith('{'));
    let lastResult = '';
    let isError = result.code !== 0;

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.type === 'message' && event.role === 'assistant' && event.content) {
          const text = Array.isArray(event.content)
            ? event.content.filter((c: { type: string }) => c.type === 'output_text').map((c: { text: string }) => c.text).join('')
            : String(event.content);
          if (text) lastResult = text;
        }
        if (event.type === 'error') {
          isError = true;
          lastResult = event.message ?? event.error ?? lastResult;
        }
      } catch {
        // skip malformed lines
      }
    }

    return {
      result: lastResult || raw,
      sessionId: undefined,
      isError,
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

  resumeFlag(_sessionId?: string): string {
    return 'resume';
  }

  modelTiers(): Record<'cheap' | 'standard' | 'premium', string> {
    return {
      cheap: 'gpt-5.4-mini',
      standard: 'gpt-5.4',
      premium: 'gpt-5.4',
    };
  }

  modelForTier(tier: 'cheap' | 'mid' | 'premium'): string {
    if (tier === 'cheap') return 'gpt-5.4-mini';
    return 'gpt-5.4';
  }

  modelFlag(model: string): string {
    return `--model "${escapeDoubleQuoted(model)}"`;
  }

  classifyError(output: string): PromptErrorCategory {
    if (/not logged in|unauthorized|\b401\b|authentication_error|expired.*token|invalid.*api.*key/i.test(output)) {
      return 'auth';
    }
    if (/\b500\b|\b502\b|\b503\b|internal server error|api_error/i.test(output)) {
      return 'server';
    }
    if (/\b429\b|\b529\b|overloaded|rate limit|quota/i.test(output)) {
      return 'overloaded';
    }
    return 'unknown';
  }

  permissionConfigPaths(): string[] {
    return ['.codex/config.toml'];
  }

  composePermissionConfig(role: 'doer' | 'reviewer', _allow: string[] = []): Array<Record<string, unknown> | string> {
    const approvalMode = role === 'doer' ? 'full-auto' : 'suggest';
    const networkAccess = role === 'doer';
    const toml = [
      `[agent]`,
      `approval_mode = "${approvalMode}"`,
      ``,
      `[sandbox]`,
      `enabled = true`,
      `network = ${networkAccess}`,
      ``,
    ].join('\n');
    return [toml];
  }

  supportsOAuthCopy(): boolean {
    return false;
  }

  supportsApiKey(): boolean {
    return true;
  }

  oauthCredentialFiles(): Array<{ localPath: string; remotePath: string }> | null {
    return null; // Codex uses API key only, no OAuth credential files
  }

  oauthSettingsMerge(): Record<string, unknown> | null {
    return null;
  }

  oauthEnvVarsToUnset(): string[] {
    return [];
  }

  jsonOutputFlag(): string {
    return '--json';
  }

  headlessInvocation(promptLiteral: string): string {
    return `exec "${promptLiteral}"`;
  }
}
