import { defaultWindowsPidWrapper } from '../os/windows-wrapper.js';
import type { ProviderAdapter, PromptOptions, ParsedResponse } from './provider.js';
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
    const { folder, promptFile, sessionId, unattended, model, maxTurns, inv } = opts;
    const escapedFolder = escapeDoubleQuoted(folder);
    const turns = maxTurns ?? 50;
    let instruction = `Your task is described in ${promptFile} in the current directory. Read that file first, then execute the task.`;
    if (inv) {
      instruction = `[${inv}] ${instruction}`;
    }
    let cmd = `cd "${escapedFolder}" && claude -p "${instruction}" --output-format json --max-turns ${turns}`;
    if (sessionId) {
      cmd += ' -c';
    }
    if (unattended === 'auto') {
      cmd += ' --permission-mode auto';
    } else if (unattended === 'dangerous') {
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

  permissionModeAutoFlag(): string | null {
    return '--permission-mode auto';
  }

  parseResponse(result: SSHExecResult): ParsedResponse {
    const raw = result.stdout.trim();

    const extractUsage = (u: any) =>
      u && typeof u.input_tokens === 'number' && typeof u.output_tokens === 'number'
        ? { input_tokens: u.input_tokens, output_tokens: u.output_tokens }
        : undefined;

    const fromEvent = (obj: any): ParsedResponse | null => {
      if (obj.type !== 'result') return null;
      return {
        result: obj.result ?? obj.response ?? raw,
        sessionId: obj.session_id,
        isError: obj.is_error === true || obj.subtype === 'error' || result.code !== 0,
        raw,
        usage: extractUsage(obj.usage),
      };
    };

    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // JSON array of events (some Claude Code versions collect JSONL into an array)
        for (const obj of parsed) {
          const r = fromEvent(obj);
          if (r) return r;
        }
      } else {
        // Single object — old Claude Code format
        return {
          result: parsed.result ?? parsed.response ?? raw,
          sessionId: parsed.session_id,
          isError: parsed.is_error === true || result.code !== 0,
          raw,
          usage: extractUsage(parsed.usage),
        };
      }
    } catch { /* not valid JSON — try line-by-line JSONL below */ }

    // JSONL format (Claude Code 2.1.113+): one JSON object per line
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const r = fromEvent(JSON.parse(trimmed));
        if (r) return r;
      } catch { /* skip non-JSON lines */ }
    }

    // Fallback: plain text output
    return { result: raw, sessionId: undefined, isError: result.code !== 0, raw, usage: undefined };
  }

  supportsResume(): boolean {
    return true;
  }

  supportsMaxTurns(): boolean {
    return true;
  }

  resumeFlag(sessionId?: string): string {
    return sessionId ? '-c' : '';
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
    return [{ permissions: { allow }, mcpServers: { 'apra-fleet': { disabled: true } } }];
  }

  supportsOAuthCopy(): boolean {
    return true;
  }

  supportsApiKey(): boolean {
    return true;
  }

  oauthCredentialFiles(): Array<{ localPath: string; remotePath: string }> | null {
    return [{ localPath: '~/.claude/.credentials.json', remotePath: '~/.claude/.credentials.json' }];
  }

  oauthSettingsMerge(): Record<string, unknown> | null {
    return null;
  }

  oauthEnvVarsToUnset(): string[] {
    return [];
  }



  wrapWindowsPrompt(setupCmd: string, filePath: string, argList: string): string {
    // Native claude.exe (2.1.113+) does not inherit stdout via ProcessStartInfo.
    // Direct shell execution ensures stdout is captured through the PowerShell pipe.
    // $pid is the shell PID — killing it also kills claude as a direct child.
    return `${setupCmd}Write-Output "FLEET_PID:$pid"; ${filePath} ${argList}`;
  }

  jsonOutputFlag(): string {
    return '--output-format json';
  }

  headlessInvocation(promptLiteral: string): string {
    return `-p "${promptLiteral}"`;
  }
}
