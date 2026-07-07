import type { ProviderAdapter, PromptOptions, ParsedResponse } from './provider.js';
import type { LlmProvider, SSHExecResult } from '../types.js';
import type { PromptErrorCategory } from '../utils/prompt-errors.js';
import { escapeDoubleQuoted } from '../os/os-commands.js';
import { sanitizeSessionId } from '../os/os-commands.js';

export class OpenCodeProvider implements ProviderAdapter {
  readonly name: LlmProvider = 'opencode';
  readonly processName = 'opencode';
  readonly authEnvVar = '';
  readonly credentialPath = '~/.config/opencode/';
  readonly instructionFileName = 'AGENTS.md';

  cliCommand(args: string): string {
    return `opencode ${args}`;
  }

  versionCommand(): string {
    return 'opencode --version 2>&1';
  }

  installCommand(os: 'linux' | 'macos' | 'windows'): string {
    if (os === 'linux') {
      return 'curl -fsSL https://opencode.ai/install | bash';
    }
    return 'npm install -g opencode-ai';
  }

  updateCommand(): string {
    return 'npm update -g opencode-ai';
  }

  skipPermissionsFlag(): string {
    return '--dangerously-skip-permissions';
  }

  permissionModeAutoFlag(): string | null {
    return null;
  }

  modelTiers(): Record<'cheap' | 'standard' | 'premium', string> {
    return {
      cheap: 'opencode/north-mini-code-free',
      standard: 'opencode/deepseek-v4-flash-free',
      premium: 'opencode/nemotron-3-ultra-free',
    };
  }

  modelForTier(tier: 'cheap' | 'mid' | 'premium'): string {
    if (tier === 'premium') return 'opencode/nemotron-3-ultra-free';
    if (tier === 'cheap') return 'opencode/north-mini-code-free';
    return 'opencode/deepseek-v4-flash-free';
  }

  modelFlag(model: string): string {
    return `-m "${escapeDoubleQuoted(model)}"`;
  }

  classifyError(output: string): PromptErrorCategory {
    if (/command not found|is not recognized as an internal or external command/i.test(output)) return 'unknown';
    if (/connection refused|ECONNREFUSED/i.test(output)) return 'server';
    if (/timeout|ETIMEDOUT/i.test(output)) return 'server';
    if (/rate limit|\b429\b/i.test(output)) return 'overloaded';
    return 'unknown';
  }

  headlessInvocation(promptLiteral: string): string {
    return `run "${promptLiteral}"`;
  }

  jsonOutputFlag(): string {
    return '--format json';
  }

  buildPromptCommand(opts: PromptOptions): string {
    const { folder, promptFile, sessionId, resuming, unattended, model, inv } = opts;
    const escapedFolder = escapeDoubleQuoted(folder);
    let instruction = `Your task is described in ${promptFile} in the current directory. Read that file first, then execute the task.`;
    if (inv) {
      instruction = `[${inv}] ${instruction}`;
    }
    let cmd = `cd "${escapedFolder}" && opencode run`;
    if (model) {
      cmd += ` ${this.modelFlag(model)}`;
    }
    if (unattended === 'dangerous') {
      cmd += ` ${this.skipPermissionsFlag()}`;
    }
    cmd += ` ${this.jsonOutputFlag()}`;
    const resume = this.resumeFlag(sessionId, resuming);
    if (resume) {
      cmd += ` ${resume}`;
    }
    cmd += ` "${escapeDoubleQuoted(instruction)}"`;
    return cmd;
  }

  supportsResume(): boolean {
    return true;
  }

  supportsMaxTurns(): boolean {
    return false;
  }

  resumeFlag(sessionId?: string, resuming?: boolean): string {
    if (resuming && sessionId) {
      return `--session "${sanitizeSessionId(sessionId)}"`;
    }
    if (resuming) {
      return '--continue';
    }
    return '';
  }

  parseResponse(result: SSHExecResult): ParsedResponse {
    const raw = result.stdout.trim();
    const lines = raw.split('\n').filter(l => l.trim().startsWith('{'));
    let textResult = '';
    let sessionId: string | undefined;
    let isError = result.code !== 0;
    let errorMessage = '';
    let usage: { input_tokens: number; output_tokens: number } | undefined;

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.sessionID && !sessionId) {
          sessionId = event.sessionID;
        }

        if (event.type === 'text' && event.part?.text) {
          textResult += event.part.text;
        } else if (event.type === 'error') {
          isError = true;
          errorMessage = event.error?.data?.message ?? event.error?.name ?? errorMessage;
        } else if (event.type === 'step_finish' && event.part) {
          const reason = event.part.reason;
          if (reason && reason !== 'stop' && reason !== 'tool-calls') {
            isError = true;
          }
          if (event.part.tokens) {
            usage = {
              input_tokens: event.part.tokens.input ?? 0,
              output_tokens: event.part.tokens.output ?? 0,
            };
          }
        }
      } catch {
        isError = true;
      }
    }

    return {
      result: textResult || errorMessage || raw,
      sessionId,
      isError,
      raw,
      usage,
    };
  }

  permissionConfigPaths(): string[] {
    return ['.opencode/settings.json'];
  }

  composePermissionConfig(role: 'doer' | 'reviewer', _allow: string[] = []): Array<Record<string, unknown> | string> {
    if (role === 'doer') {
      return [{ permission: { edit: 'allow', write: 'allow', bash: 'allow' } }];
    }
    return [{ permission: { edit: 'deny', write: 'allow', bash: 'allow' } }];
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

  wrapWindowsPrompt(setupCmd: string, filePath: string, argList: string, _sessionId?: string, _model?: string): string {
    return `${setupCmd}Write-Output "FLEET_PID:$pid"; ${filePath} ${argList}`;
  }
}
