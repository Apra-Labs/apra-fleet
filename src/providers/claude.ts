import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defaultWindowsPidWrapper } from '../os/windows-wrapper.js';
import type { ProviderAdapter, PromptOptions, ParsedResponse, RegisterMcpEndpointOptions, RegisterMcpEndpointResult, WorkspaceTrustExecFn, EnsureWorkspaceTrustedResult, SessionIdStrategy, TargetOS } from './provider.js';
import { buildResumeFlag, buildSessionIdFlag, encodeClaudeProjectDir, joinForOS, resolveHomeDir } from './provider.js';
import type { LlmProvider, SSHExecResult } from '../types.js';
import type { PromptErrorCategory } from '../utils/prompt-errors.js';
import { classifyPromptError } from '../utils/prompt-errors.js';
import { escapeDoubleQuoted } from '../os/os-commands.js';

const execFileAsync = promisify(execFile);

// apra-fleet-iuc.1 / apra-fleet-ekm: reliable max_turns detection in the CLI
// transcript. A max_turns-terminated session must ALWAYS classify as max_turns,
// but the Claude Code CLI signals it INCONSISTENTLY across versions/streams:
//   - the `type:result` event's `subtype` is `error_max_turns`, and/or
//   - that same event carries `terminal_reason: "max_turns"`, and/or
//   - a distinct transcript event of `type: "max_turns_reached"` is emitted
//     (with no result-event terminal_reason at all).
// The old parser recorded ONLY `terminal_reason`, so a transcript that carried
// the signal solely via `subtype`/the standalone event was silently missed --
// the ekm forensics show one such session run to a 38.5-min hard timeout + cold
// restart because it was never classified. Detect ANY of these signals on ANY
// transcript event so the result the parser returns always normalizes to
// terminalReason 'max_turns' when the session was turn-limit terminated.
export function isMaxTurnsSignal(obj: any): boolean {
  if (!obj || typeof obj !== 'object') return false;
  return (
    obj.terminal_reason === 'max_turns' ||
    obj.subtype === 'error_max_turns' ||
    obj.type === 'max_turns_reached' ||
    obj.stop_reason === 'max_turns'
  );
}

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
    } else {
      // apra-fleet-eft.65.1: interactive-session parity for the work folder.
      // A headless `-p` dispatch cannot present a permission prompt, so with no
      // permission-mode flag the CLI HARD-BLOCKS Edit/Write of a brand-new file
      // in its own work folder -- even though an interactive session in the same
      // trusted workspace would simply accept it. `acceptEdits` auto-approves
      // file-edit tools (Edit/Write/MultiEdit/NotebookEdit) for the working
      // directory only; it does NOT auto-approve Bash, network, or edits outside
      // the workspace, so this restores work-folder Edit/Write parity without
      // broadening the permission model (unlike --dangerously-skip-permissions).
      cmd += ` ${this.workspaceEditPermissionFlag()}`;
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

  workspaceEditPermissionFlag(): string | null {
    // apra-fleet-eft.65.1: grants Edit/Write parity for the dispatched agent's
    // own work folder in a headless dispatch (which cannot show a trust/permission
    // prompt) WITHOUT the broad --dangerously-skip-permissions bypass.
    return '--permission-mode acceptEdits';
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

    const fromEvent = (obj: any, assistantFallback: string, maxTurnsSeen: boolean): ParsedResponse | null => {
      if (obj.type !== 'result') return null;
      // Normalize terminalReason to 'max_turns' whenever the transcript carried
      // the turn-limit signal via ANY channel (this event's terminal_reason,
      // this or a preceding event's subtype/standalone max_turns_reached event)
      // so downstream classification (execute-prompt) is version-independent.
      const maxTurns = maxTurnsSeen || isMaxTurnsSignal(obj);
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
        terminalReason: obj.terminal_reason ?? (maxTurns ? 'max_turns' : undefined),
      };
    };

    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // JSON array of events (some Claude Code versions collect JSONL into an array)
        let assistantText = '';
        let maxTurnsSeen = false;
        for (const obj of parsed) {
          assistantText += assistantTextOf(obj);
          maxTurnsSeen = maxTurnsSeen || isMaxTurnsSignal(obj);
          const r = fromEvent(obj, assistantText, maxTurnsSeen);
          if (r) return r;
        }
      } else {
        // Single object - old Claude Code format
        const maxTurns = isMaxTurnsSignal(parsed);
        return {
          result: parsed.result ?? parsed.response ?? raw,
          sessionId: parsed.session_id,
          isError: parsed.is_error === true || result.code !== 0,
          raw,
          usage: extractUsage(parsed.usage),
          subtype: parsed.subtype,
          terminalReason: parsed.terminal_reason ?? (maxTurns ? 'max_turns' : undefined),
        };
      }
    } catch { /* not valid JSON - try line-by-line JSONL below */ }

    // JSONL format (Claude Code 2.1.113+): one JSON object per line
    let assistantText = '';
    let maxTurnsSeen = false;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        assistantText += assistantTextOf(obj);
        maxTurnsSeen = maxTurnsSeen || isMaxTurnsSignal(obj);
        const r = fromEvent(obj, assistantText, maxTurnsSeen);
        if (r) return r;
      } catch { /* skip non-JSON lines */ }
    }

    // Fallback: plain text output. A stream that emitted a standalone
    // max_turns_reached event but no terminating `type:result` event still
    // reaches here -- preserve the turn-limit signal so it is never lost.
    return {
      result: raw,
      sessionId: undefined,
      isError: result.code !== 0,
      raw,
      usage: undefined,
      terminalReason: maxTurnsSeen ? 'max_turns' : undefined,
    };
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

  sessionIdStrategy(): SessionIdStrategy {
    return { type: 'caller-minted' };
  }

  resolveSessionLogPath(sessionId: string, workFolder: string, homeDir?: string | null, targetOs?: TargetOS): string {
    const home = resolveHomeDir(homeDir);
    if (!home) return '';
    const encoded = encodeClaudeProjectDir(workFolder);
    return joinForOS(targetOs, home, '.claude', 'projects', encoded, `${sessionId}.jsonl`);
  }

  resolveSessionLogDir(workFolder: string, homeDir?: string | null, targetOs?: TargetOS): string | null {
    const home = resolveHomeDir(homeDir);
    if (!home) return null;
    const encoded = encodeClaudeProjectDir(workFolder);
    return joinForOS(targetOs, home, '.claude', 'projects', encoded);
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

  modelForTier(tier: 'cheap' | 'standard' | 'premium'): string {
    if (tier === 'cheap') return 'haiku';
    if (tier === 'standard') return 'sonnet';
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

  async ensureWorkspaceTrusted(workFolder: string, execCommand: WorkspaceTrustExecFn, agentOs: 'linux' | 'macos' | 'windows' = 'linux'): Promise<EnsureWorkspaceTrustedResult> {
    // apra-fleet-eft.40: Claude gates project-scoped permissions.allow entries on
    // projects[<key>].hasTrustDialogAccepted in the member-side ~/.claude.json -- an
    // untrusted workspace silently DROPS them (not merely a cosmetic warning), degrading
    // unattended dispatches. There is no surgical --skip-trust equivalent for Claude
    // (only the overbroad --dangerously-skip-permissions), so seeding this flag directly
    // is the only viable fix.
    //
    // Live-verified format ground truth (apra-fleet-eft.40 notes, real ~/.claude.json):
    // project keys are ABSOLUTE PATHS WITH FORWARD SLASHES even on Windows. Normalize so
    // a folder passed with backslashes, or with a trailing slash, still hits the SAME
    // entry -- that is also what makes re-running this idempotent.
    const key = workFolder.replace(/\\/g, '/').replace(/\/+$/, '');

    const isWindows = agentOs === 'windows';
    const homeFile = isWindows ? '$env:USERPROFILE\\.claude.json' : '$HOME/.claude.json';
    const tmpFile = isWindows ? '$env:USERPROFILE\\.claude.json.fleet-trust-tmp' : '$HOME/.claude.json.fleet-trust-tmp';

    // apra-fleet-9oo: the project's .mcp.json lives in the MEMBER's work folder, not on
    // the orchestrator host, so it must be read through the same execCommand channel --
    // never local node:fs. It rides along in the SAME read command as ~/.claude.json:
    // one round-trip, and (crucially) the already-satisfied case still costs exactly one
    // exec, so the "no write when nothing to do" contract is observable as before.
    const mcpFile = `${key}/.mcp.json`;
    const SPLIT = '---FLEET_MCP_SPLIT---';

    const readCmd = isWindows
      ? `Get-Content -Raw "${homeFile}" -ErrorAction SilentlyContinue; Write-Output "${SPLIT}"; Get-Content -Raw "${mcpFile}" -ErrorAction SilentlyContinue`
      : `cat "${homeFile}" 2>/dev/null || true; echo "${SPLIT}"; cat "${mcpFile}" 2>/dev/null || true`;
    const readResult = await execCommand(readCmd, 10000);

    // Substring split (not line-split): if ~/.claude.json has no trailing newline the
    // marker glues onto its closing brace, and only a substring split separates cleanly.
    // No marker at all -> treat the whole payload as ~/.claude.json with no .mcp.json.
    const rawStdout = readResult.stdout;
    const splitIdx = rawStdout.indexOf(SPLIT);
    const homeRaw = (splitIdx === -1 ? rawStdout : rawStdout.slice(0, splitIdx)).trim();
    const mcpRaw = (splitIdx === -1 ? '' : rawStdout.slice(splitIdx + SPLIT.length)).trim();

    let existing: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(homeRaw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed;
    } catch {
      // File missing, empty, or not JSON -- a member that has never run Claude
      // interactively has no ~/.claude.json at all yet. Start from an empty object.
    }

    // A missing / unparseable / server-less .mcp.json is NOT an error: seed nothing
    // extra and fall through to the pre-existing trust-only behaviour.
    let declaredServers: string[] = [];
    try {
      const mcpParsed = JSON.parse(mcpRaw);
      const servers = mcpParsed?.mcpServers;
      if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
        declaredServers = Object.keys(servers);
      }
    } catch {
      // no .mcp.json (or garbage in it) -- trust-only path.
    }

    const rawProjects = existing.projects;
    const projects: Record<string, unknown> = (rawProjects && typeof rawProjects === 'object' && !Array.isArray(rawProjects))
      ? rawProjects as Record<string, unknown>
      : {};
    const rawEntry = projects[key];
    const existingEntry: Record<string, unknown> = (rawEntry && typeof rawEntry === 'object' && !Array.isArray(rawEntry))
      ? rawEntry as Record<string, unknown>
      : {};

    // apra-fleet-9oo: trust and MCP-server enablement are computed INDEPENDENTLY, because
    // an already-trusted member (hasTrustDialogAccepted true) can still be missing its
    // enabledMcpjsonServers entries -- the old unconditional early return here is exactly
    // why members never got project MCP servers auto-approved. Short-circuit only when
    // BOTH are already satisfied.
    const trustNeeded = existingEntry.hasTrustDialogAccepted !== true;

    const enabled = Array.isArray(existingEntry.enabledMcpjsonServers)
      ? (existingEntry.enabledMcpjsonServers as unknown[]).filter((n): n is string => typeof n === 'string')
      : [];
    const disabled = Array.isArray(existingEntry.disabledMcpjsonServers)
      ? (existingEntry.disabledMcpjsonServers as unknown[]).filter((n): n is string => typeof n === 'string')
      : [];
    // Union-merge, deny wins: keep every existing entry in its existing order, append
    // only names that are missing (in .mcp.json declaration order, so re-runs are
    // byte-identical), and NEVER add a name a human explicitly disabled.
    const serversToAdd = declaredServers.filter(n => !enabled.includes(n) && !disabled.includes(n));

    if (!trustNeeded && serversToAdd.length === 0) {
      console.error(`[claude] workspace trust: already present for "${key}"`);
      return { seeded: false, detail: `already trusted: ${key}`, mcpServersSeeded: [] };
    }

    // MERGE: preserve every sibling field already on the project entry (history,
    // allowedTools, etc.) and every other project's entry in the file -- never replace
    // the entry, or the file, wholesale. Note enabledMcpjsonServers is only written when
    // something is actually being added -- an absent array is never "tidied" into [].
    const mergedEntry: Record<string, unknown> = { ...existingEntry, hasTrustDialogAccepted: true };
    if (serversToAdd.length > 0) mergedEntry.enabledMcpjsonServers = [...enabled, ...serversToAdd];
    const mergedProjects = { ...projects, [key]: mergedEntry };
    const merged = { ...existing, projects: mergedProjects };
    const contentStr = JSON.stringify(merged, null, 2);

    // ATOMIC write: stage the full merged content in a temp file, then rename over the
    // real file in one filesystem operation -- a crash or concurrent read mid-write can
    // never observe a partially-written ~/.claude.json.
    const writeCmd = isWindows
      ? `[System.IO.File]::WriteAllText("${tmpFile}", '${contentStr.replace(/'/g, "''")}', (New-Object System.Text.UTF8Encoding($false))); Move-Item -Force "${tmpFile}" "${homeFile}"`
      : `cat > "${tmpFile}" << 'FLEET_TRUST_EOF'\n${contentStr}\nFLEET_TRUST_EOF\nmv "${tmpFile}" "${homeFile}"`;
    await execCommand(writeCmd, 10000);

    const mcpNote = serversToAdd.length > 0 ? `; enabled MCP servers: ${serversToAdd.join(', ')}` : '';
    // eft.40.1 requires logging distinctly when trust is SEEDED vs already present --
    // `detail` already encodes that distinction, so log it verbatim rather than
    // hard-coding "seeded" for the already-trusted/servers-only case.
    const detail = trustNeeded
      ? `seeded trust: ${key}${mcpNote}`
      : `already trusted: ${key}${mcpNote}`;
    console.error(`[claude] workspace trust: ${detail}`);
    return { seeded: trustNeeded, detail, mcpServersSeeded: serversToAdd };
  }
}

