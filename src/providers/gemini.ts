import type { ProviderAdapter, PromptOptions, ParsedResponse } from './provider.js';
import type { LlmProvider, SSHExecResult } from '../types.js';
import type { PromptErrorCategory } from '../utils/prompt-errors.js';
import { escapeDoubleQuoted } from '../os/os-commands.js';

export class GeminiProvider implements ProviderAdapter {
  readonly name: LlmProvider = 'gemini';
  readonly processName = 'gemini';
  readonly authEnvVar = 'GEMINI_API_KEY';
  readonly credentialPath = '~/.gemini/';
  readonly instructionFileName = 'GEMINI.md';

  cliCommand(args: string): string {
    return `gemini ${args}`;
  }

  versionCommand(): string {
    return 'gemini --version 2>&1';
  }

  installCommand(os: 'linux' | 'macos' | 'windows'): string {
    return 'npm install -g @google/gemini-cli';
  }

  updateCommand(): string {
    return 'npm update -g @google/gemini-cli';
  }

  buildPromptCommand(opts: PromptOptions): string {
    const { folder, b64Prompt, sessionId, dangerouslySkipPermissions, model } = opts;
    const escapedFolder = escapeDoubleQuoted(folder);
    let cmd = `cd "${escapedFolder}" && gemini -p "$(echo '${b64Prompt}' | base64 -d)" --output-format json`;
    if (sessionId) {
      cmd += ' --resume';
    }
    if (dangerouslySkipPermissions) {
      cmd += ' --yolo';
    }
    if (model) {
      cmd += ` --model "${escapeDoubleQuoted(model)}"`;
    }
    return cmd;
  }

  skipPermissionsFlag(): string {
    return '--yolo';
  }

  parseResponse(result: SSHExecResult): ParsedResponse {
    const raw = result.stdout.trim();
    try {
      const parsed = JSON.parse(raw);
      return {
        result: parsed.response ?? parsed.result ?? raw,
        sessionId: undefined,  // Gemini uses --resume (no ID), store boolean in registry
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
    return '--resume';
  }

  modelTiers(): Record<'cheap' | 'standard' | 'premium', string> {
    return {
      cheap: 'gemini-2.5-flash',
      standard: 'gemini-2.5-pro',
      premium: 'gemini-2.5-pro',
    };
  }

  modelForTier(tier: 'cheap' | 'mid' | 'premium'): string {
    if (tier === 'cheap') return 'gemini-2.5-flash';
    return 'gemini-2.5-pro';
  }

  modelFlag(model: string): string {
    return `--model "${escapeDoubleQuoted(model)}"`;
  }

  classifyError(output: string): PromptErrorCategory {
    const lower = output.toLowerCase();
    if (/not logged in|unauthorized|\b401\b|authentication_error|expired.*token|permission_error|invalid.*api.*key/i.test(lower)) {
      return 'auth';
    }
    if (/\b500\b|\b502\b|\b503\b|internal server error|api_error/i.test(lower)) {
      return 'server';
    }
    if (/\b429\b|\b529\b|overloaded|rate limit|quota/i.test(lower)) {
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
    return '--output-format json';
  }

  headlessInvocation(promptExpr: string): string {
    return `-p ${promptExpr}`;
  }
}
