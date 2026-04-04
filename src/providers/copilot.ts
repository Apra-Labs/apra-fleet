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
    const { folder, promptFile, sessionId, dangerouslySkipPermissions, model } = opts;
    const escapedFolder = escapeDoubleQuoted(folder);
    const instruction = `Your task is described in ${promptFile} in the current directory. Read that file first, then execute the task.`;
    let cmd = `cd "${escapedFolder}" && copilot -p "${instruction}" --format json`;
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
        usage: undefined,
      };
    } catch {
      return {
        result: raw,
        sessionId: undefined,
        isError: result.code !== 0,
        raw,
        usage: undefined,
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

  modelTiers(): Record<'cheap' | 'standard' | 'premium', string> {
    return {
      cheap: 'claude-haiku-4-5',
      standard: 'claude-sonnet-4-5',
      premium: 'claude-opus-4-5',
    };
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

  permissionConfigPaths(): string[] {
    return ['.github/copilot/settings.local.json'];
  }

  composePermissionConfig(role: 'doer' | 'reviewer', allow: string[] = []): Array<Record<string, unknown> | string> {
    if (role === 'doer') {
      const config: Record<string, unknown> = { 'allow-all-tools': true };
      if (allow.length > 0) config.tools = { allow };
      return [config];
    }
    // reviewer: read + feedback only
    const reviewerAllow = allow.length > 0
      ? allow
      : ['read_file', 'list_files', 'search_files', 'run_tests'];
    return [{
      'allow-all-tools': false,
      tools: {
        allow: reviewerAllow,
        deny: ['write_file', 'edit_file', 'run_command'],
      },
    }];
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

  headlessInvocation(promptLiteral: string): string {
    return `-p "${promptLiteral}"`;
  }
}
