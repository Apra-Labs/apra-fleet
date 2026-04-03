import type { ProviderAdapter, PromptOptions, ParsedResponse } from './provider.js';
import { buildResumeFlag } from './provider.js';
import type { LlmProvider, SSHExecResult } from '../types.js';
import type { PromptErrorCategory } from '../utils/prompt-errors.js';
import { classifyPromptError } from '../utils/prompt-errors.js';
import { escapeDoubleQuoted } from '../os/os-commands.js';

export class ClaudeProvider implements ProviderAdapter {
  readonly name: LlmProvider = 'claude';
  readonly processName = 'claude';
  readonly authEnvVar = 'ANTHROPIC_API_KEY';
  readonly credentialPath = '~/.claude/.credentials.json';
  readonly instructionFileName = 'CLAUDE.md';

  cliCommand(args: string): string {
    return `claude ${args}`;
  }

  versionCommand(): string {
    return 'claude --version 2>&1';
  }

  installCommand(os: 'linux' | 'macos' | 'windows'): string {
    if (os === 'windows') {
      return 'irm https://claude.ai/install.ps1 | iex';
    }
    return 'curl -fsSL https://claude.ai/install.sh | bash';
  }

  updateCommand(): string {
    return 'claude update';
  }

  buildPromptCommand(opts: PromptOptions): string {
    const { folder, b64Prompt, sessionId, dangerouslySkipPermissions, model, maxTurns } = opts;
    const escapedFolder = escapeDoubleQuoted(folder);
    const turns = maxTurns ?? 50;
    let cmd = `cd "${escapedFolder}" && claude -p "$(echo '${b64Prompt}' | base64 -d)" --output-format json --max-turns ${turns}`;
    const rf = buildResumeFlag(sessionId);
    if (rf) {
      cmd += ` ${rf}`;
    }
    if (dangerouslySkipPermissions) {
      cmd += ' --dangerously-skip-permissions';
    }
    if (model) {
      cmd += ` --model "${escapeDoubleQuoted(model)}"`;
    }
    return cmd;
  }

  skipPermissionsFlag(): string {
    return '--dangerously-skip-permissions';
  }

  parseResponse(result: SSHExecResult): ParsedResponse {
    const raw = result.stdout.trim();
    try {
      const parsed = JSON.parse(raw);
      return {
        result: parsed.result ?? parsed.response ?? raw,
        sessionId: parsed.session_id,
        isError: parsed.is_error === true || result.code !== 0,
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
    return true;
  }

  resumeFlag(sessionId?: string): string {
    return buildResumeFlag(sessionId);
  }

  modelTiers(): Record<'cheap' | 'standard' | 'premium', string> {
    return {
      cheap: 'claude-haiku-4-5',
      standard: 'claude-sonnet-4-6',
      premium: 'claude-opus-4-6',
    };
  }

  modelForTier(tier: 'cheap' | 'mid' | 'premium'): string {
    if (tier === 'cheap') return 'claude-haiku-4-5';
    if (tier === 'mid') return 'claude-sonnet-4-6';
    return 'claude-opus-4-6';
  }

  modelFlag(model: string): string {
    return `--model "${escapeDoubleQuoted(model)}"`;
  }

  classifyError(output: string): PromptErrorCategory {
    return classifyPromptError(output);
  }

  permissionConfigPaths(): string[] {
    return ['.claude/settings.local.json'];
  }

  composePermissionConfig(_role: 'doer' | 'reviewer', allow: string[] = []): Array<Record<string, unknown> | string> {
    return [{ permissions: { allow } }];
  }

  supportsOAuthCopy(): boolean {
    return true;
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
