import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defaultWindowsPidWrapper } from '../os/windows-wrapper.js';
import type { ProviderAdapter, PromptOptions, ParsedResponse, RegisterMcpEndpointOptions, RegisterMcpEndpointResult } from './provider.js';
import { buildResumeFlag, buildSessionIdFlag } from './provider.js';
import type { LlmProvider, SSHExecResult } from '../types.js';
import type { PromptErrorCategory } from '../utils/prompt-errors.js';
import { classifyPromptError } from '../utils/prompt-errors.js';
import { escapeDoubleQuoted } from '../os/os-commands.js';

const execFileAsync = promisify(execFile);

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
    const { folder, promptFile, sessionId, resuming, unattended, model, maxTurns, inv, agentName } = opts;
    const escapedFolder = escapeDoubleQuoted(folder);
    const turns = maxTurns ?? 50;
    let instruction = `Your task is described in ${promptFile} in the current directory. Read that file first, then execute the task.`;
    if (inv) {
      instruction = `[${inv}] ${instruction}`;
    }
    let cmd = `cd "${escapedFolder}" && claude`;
    if (agentName) {
      cmd += ` --agent "${escapeDoubleQuoted(agentName)}"`;
    }
    cmd += ` -p "${instruction}" --output-format json --max-turns ${turns}`;
    if (resuming && sessionId) {
      cmd += ` ${buildResumeFlag(sessionId)}`;
    } else if (sessionId) {
      cmd += ` ${buildSessionIdFlag(sessionId)}`;
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

    // apra-fleet-eft.28.6: first non-blank string wins. Used so an EMPTY
    // (present-but-blank) result field on the `type:result` event falls back to
    // the assistant text we harvested from the stream, instead of being kept as
    // '' (a plain `obj.result ?? ...` keeps '' because it is not nullish).
    const firstNonEmpty = (...candidates: any[]): string | undefined => {
      for (const c of candidates) {
        if (typeof c === 'string' && c.trim() !== '') return c;
      }
      return undefined;
    };

    // apra-fleet-eft.28.6: the assistant's reply text carried by a
    // `type:assistant` stream event (message.content[] text blocks). Real
    // capture (member 'trust-probe', eft.28 NEW EVIDENCE): the final
    // `type:result` event's own `result` field came back empty even though the
    // assistant reply -- including tool output -- was fully present in these
    // preceding events. Harvesting it here lets the server recover the reply
    // instead of dropping it and mislabelling the dispatch empty_response.
    const assistantTextOf = (obj: any): string => {
      const content = obj?.message?.content;
      if (obj?.type !== 'assistant' || !Array.isArray(content)) return '';
      return content
        .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
        .map((c: any) => c.text)
        .join('');
    };

    const fromEvent = (obj: any, assistantFallback: string): ParsedResponse | null => {
      if (obj.type !== 'result') return null;
      return {
        // Prefer the event's own result text; only when it is missing OR blank
        // do we substitute the harvested assistant text. The final `?? raw`
        // preserves the pre-existing behavior for a result event with no result
        // field at all and no recoverable assistant text.
        result: firstNonEmpty(obj.result, obj.response, assistantFallback) ?? obj.result ?? obj.response ?? raw,
        sessionId: obj.session_id,
        isError: obj.is_error === true || obj.subtype === 'error' || result.code !== 0,
        raw,
        usage: extractUsage(obj.usage),
        subtype: obj.subtype,
        terminalReason: obj.terminal_reason,
      };
    };

    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // JSON array of events (some Claude Code versions collect JSONL into an array)
        let assistantText = '';
        for (const obj of parsed) {
          assistantText += assistantTextOf(obj);
          const r = fromEvent(obj, assistantText);
          if (r) return r;
        }
      } else {
        // Single object - old Claude Code format
        return {
          result: parsed.result ?? parsed.response ?? raw,
          sessionId: parsed.session_id,
          isError: parsed.is_error === true || result.code !== 0,
          raw,
          usage: extractUsage(parsed.usage),
          subtype: parsed.subtype,
          terminalReason: parsed.terminal_reason,
        };
      }
    } catch { /* not valid JSON - try line-by-line JSONL below */ }

    // JSONL format (Claude Code 2.1.113+): one JSON object per line
    let assistantText = '';
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        assistantText += assistantTextOf(obj);
        const r = fromEvent(obj, assistantText);
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

  resumeFlag(sessionId?: string, resuming?: boolean): string {
    if (!sessionId) return '';
    return resuming ? buildResumeFlag(sessionId) : buildSessionIdFlag(sessionId);
  }

  // Bare family aliases -- the claude CLI resolves these to the current
  // generation automatically (`claude --help`: "Provide an alias for the
  // latest model (e.g. 'fable', 'opus', or 'sonnet')"), so these never go
  // stale as Anthropic ships new models. Do not pin to a dated model ID.
  modelTiers(): Record<'cheap' | 'standard' | 'premium', string> {
    return {
      cheap: 'haiku',
      standard: 'sonnet',
      premium: 'opus',
    };
  }

  modelForTier(tier: 'cheap' | 'mid' | 'premium'): string {
    if (tier === 'cheap') return 'haiku';
    if (tier === 'mid') return 'sonnet';
    return 'opus';
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
    return [{ permissions: { allow }, mcpServers: { 'apra-fleet': { disabled: true } }, skillOverrides: { pm: 'off', fleet: 'off' } }];
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

  authEnvVarForToken(token: string): string {
    return token.startsWith('sk-ant-') ? 'ANTHROPIC_API_KEY' : 'CLAUDE_CODE_OAUTH_TOKEN';
  }



  wrapWindowsPrompt(setupCmd: string, filePath: string, argList: string, _sessionId?: string, _model?: string): string {
    // Native claude.exe (2.1.113+) does not inherit stdout via ProcessStartInfo.
    // Direct shell execution ensures stdout is captured through the PowerShell pipe.
    // $pid is the shell PID - killing it also kills claude as a direct child.
    return `${setupCmd}Write-Output "FLEET_PID:$pid"; ${filePath} ${argList}`;
  }

  jsonOutputFlag(): string {
    return '--output-format json';
  }

  headlessInvocation(promptLiteral: string): string {
    return `-p "${promptLiteral}"`;
  }

  async registerMcpEndpoint(opts: RegisterMcpEndpointOptions): Promise<RegisterMcpEndpointResult> {
    // Live-verified (apra-fleet-2xs.5, docs/member-onboarding-journey.md 3a): `claude
    // mcp add` is Claude's own native registration mechanism -- it writes .mcp.json
    // (project scope) or the user-scope config itself, round-tripping the bearer
    // header intact. Shelling out here (rather than hand-writing .mcp.json) means
    // future changes to Claude Code's config format are Anthropic's problem, not
    // ours, and it composes correctly with whatever the user does afterward via the
    // same CLI.
    const args = [
      'mcp', 'add',
      '--transport', 'http',
      '--scope', opts.scope,
      'apra-fleet-member',
      opts.url,
      '--header', `Authorization: Bearer ${opts.token}`,
    ];
    await execFileAsync('claude', args, { cwd: opts.workFolder });
    return {
      mechanism: 'cli-verb',
      detail: `claude mcp add --transport http --scope ${opts.scope} apra-fleet-member <url> (cwd=${opts.workFolder})`,
    };
  }
}

