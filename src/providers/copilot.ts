import type { ProviderAdapter, PromptOptions, ParsedResponse } from './provider.js';
import type { LlmProvider, SSHExecResult } from '../types.js';
import type { PromptErrorCategory } from '../utils/prompt-errors.js';
import { escapeDoubleQuoted } from '../os/os-commands.js';

export class CopilotProvider implements ProviderAdapter {
  readonly name: LlmProvider = 'copilot';
  readonly processName = 'copilot';
  readonly authEnvVar = 'COPILOT_GITHUB_TOKEN';
  readonly credentialPath = '~/.copilot/';
  readonly instructionFileName = 'COPILOT.md';

  cliCommand(args: string): string {
    return `copilot ${args}`;
  }

  versionCommand(): string {
    return 'copilot --version 2>&1';
  }

  installCommand(os: 'linux' | 'macos' | 'windows'): string {
    if (os === 'macos') {
      return 'brew install --cask copilot';
    }
    if (os === 'windows') {
      return 'winget install GitHub.CopilotCLI';
    }
    return 'curl -fsSL https://gh.io/copilot-install | bash';
  }

  updateCommand(): string {
    return 'copilot update';
  }

  buildPromptCommand(opts: PromptOptions): string {
    const { folder, b64Prompt, sessionId, dangerouslySkipPermissions, model } = opts;
    const escapedFolder = escapeDoubleQuoted(folder);
    let cmd = `cd "${escapedFolder}" && copilot -p "$(echo '${b64Prompt}' | base64 -d)" --format json`;
    if (sessionId) {
      cmd += ' --continue';
    }
    if (dangerouslySkipPermissions) {
      cmd += ' --allow-all-tools';
    }
    if (model) {
      cmd += ` --model "${escapeDoubleQuoted(model)}"`;
    }
    return cmd;
  }

  skipPermissionsFlag(): string {
    return '--allow-all-tools';
  }

  parseResponse(result: SSHExecResult): ParsedResponse {
    const raw = result.stdout.trim();
    try {
      const parsed = JSON.parse(raw);
      return {
        result: parsed.result ?? parsed.response ?? raw,
        sessionId: undefined,  // Copilot uses --continue (no ID), store boolean in registry
        isError: result.code !== 0,
        raw,
      };
    } catch {
      return {
        result: raw,
        sessionId: undefined,
        isError: result.code !== 0,
        raw,
      };
    }
  }

  supportsResume(): boolean {
    return true;
  }

  supportsMaxTurns(): boolean {
    return false;
  }

  resumeFlag(_sessionId?: string): string {
    return '--continue';
  }

  modelForTier(tier: 'cheap' | 'mid' | 'premium'): string {
    if (tier === 'cheap') return 'claude-haiku-4-5';
    if (tier === 'mid') return 'claude-sonnet-4-5';
    return 'claude-opus-4-5';
  }

  modelFlag(model: string): string {
    return `--model "${escapeDoubleQuoted(model)}"`;
  }

  classifyError(output: string): PromptErrorCategory {
    if (/not logged in|unauthorized|\b401\b|authentication_error|expired.*token|permission_error|invalid.*token/i.test(output)) {
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

  supportsOAuthCopy(): boolean {
    return false;
  }

  supportsApiKey(): boolean {
    return true;
  }

  jsonOutputFlag(): string {
    return '--format json';
  }

  headlessInvocation(promptExpr: string): string {
    return `-p ${promptExpr}`;
  }
}
