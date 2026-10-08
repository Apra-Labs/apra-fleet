import { escapeForDoubleQuotes } from '../utils/shell-escape.js';
import { randomBytes } from 'node:crypto';
import type { ProviderAdapter, PromptOptions, ParsedResponse, UsageLimitSignal, MemberMcpSyncContext, MemberMcpSyncResult, WorkspaceTrustExecFn, WorkspaceTrustTransport, MemberSecretFileChannel, EnsureWorkspaceTrustedResult, SessionIdStrategy, ExecTimeoutSource, TargetOS } from './provider.js';
import { buildResumeFlag, buildSessionIdFlag, buildForkFlag, encodeClaudeProjectDir, joinForOS, resolveHomeDir, guessedUsageLimitSignal } from './provider.js';
import type { LlmProvider, SSHExecResult } from '../types.js';
import type { PromptErrorCategory } from '../utils/prompt-errors.js';
import { classifyPromptError } from '../utils/prompt-errors.js';
import { escapeDoubleQuoted } from '../os/os-commands.js';
import type { MemberShell } from '../os/os-commands.js';
import { wrapPowerShellEncoded } from '../os/windows.js';
import { isPosixShell } from '../utils/agent-helpers.js';
import { transformAgentForClaude } from '../cli/agent-transform.js';
import {
  claudeMemberDenyRules,
  joinMemberPath,
  quotePosixPath,
  quotePwshPath,
  readMemberJson,
  resolveClaudeProjectKey,
  normalizeProjectKey,
  LEGACY_MEMBER_MCP_SERVER_NAME,
  MEMBER_MCP_SERVER_NAME,
} from '../services/member-config-io.js';


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

// apra-fleet-hzeb.1: the Claude result event's `api_error_status` carries the
// upstream HTTP status (e.g. 429) when the CLI terminated on an API error. The
// parser previously dropped it; capture it (coercing a numeric string) so
// detectUsageLimit can distinguish a 429 usage limit. Returns undefined when
// absent or non-numeric.
export function extractApiErrorStatus(obj: any): number | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const raw = obj.api_error_status;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) return Number(raw);
  return undefined;
}

// apra-fleet-hzeb.1: Claude's own usage-limit message shape, e.g.
// "You've hit your session limit", "hit your weekly limit", "hit your opus limit".
const CLAUDE_LIMIT_MESSAGE_RE = /hit your (session|weekly|opus|\w+) limit/i;

// apra-fleet-hzeb.1.2: Claude's usage-limit message sometimes exposes the actual
// reset time verbatim, e.g. "resets 8:20am (America/New_York)" or "resets at 8pm
// (America/New_York)". This wall-clock-plus-IANA-zone shape is the primary parse.
const CLAUDE_RESET_AT_RE = /resets\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(\s*([A-Za-z][A-Za-z0-9_+\-/]*)\s*\)/i;
// Best-effort relative shape, e.g. "resets in 45 minutes" / "resets in 2 hours".
const CLAUDE_RESET_IN_RE = /resets\s+in\s+(\d+)\s*(minute|hour)s?/i;

// Credential-kind prefixes (provision_llm_auth api_key routing).
const CLAUDE_OAUTH_TOKEN_PREFIX = 'sk-ant-oat';
const CLAUDE_API_KEY_PREFIX = 'sk-ant-api';
const CLAUDE_AUTH_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;

// apra-fleet-hzeb.1.2: the wall-clock fields of `instant` as observed in
// `timeZone`, via Intl (no external dependency). `hourCycle: 'h23'` yields
// 00-23; a few engines still emit '24' for midnight, so normalize it.
function claudeZoneParts(instant: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(instant)) map[p.type] = p.value;
  let hour = Number(map.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

// Offset (ms) between the wall clock in `timeZone` and UTC at `instant`
// (positive = zone ahead of UTC).
function claudeZoneOffsetMs(instant: Date, timeZone: string): number {
  const p = claudeZoneParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - instant.getTime();
}

// UTC epoch ms for a wall-clock time (`y`-`mo`-`d` `h`:`min`, mo 1-based) as it
// occurs in `timeZone`. The double-offset re-check handles DST boundaries where
// the offset that applies at the naive guess differs from the offset that
// actually applies at the resolved instant (spring-forward / fall-back).
function claudeZonedWallClockToUtc(y: number, mo: number, d: number, h: number, min: number, timeZone: string): number {
  const utcGuess = Date.UTC(y, mo - 1, d, h, min, 0);
  const offset1 = claudeZoneOffsetMs(new Date(utcGuess), timeZone);
  let ts = utcGuess - offset1;
  const offset2 = claudeZoneOffsetMs(new Date(ts), timeZone);
  if (offset2 !== offset1) ts = utcGuess - offset2;
  return ts;
}

/**
 * apra-fleet-hzeb.1.2: parse a Claude usage-limit reset time from its verbatim
 * message into a concrete instant, so the usage-limit signal can schedule a
 * precise resume instead of guessing now+1h. Pure and deterministic: `now` is
 * injected. Returns null when no reset time is readable -- the caller then falls
 * back to the guessed window (never to a null signal; a 429 is still a usage
 * limit even when its reset time is unreadable).
 *
 * Supported shapes (case-insensitive, best-effort):
 *   - "resets 8:20am (America/New_York)" -> the NEXT 08:20 wall-clock in that
 *     zone that is >= `now` (DST-correct via Intl offset projection).
 *   - "resets at 8pm (America/New_York)" -> same, with an optional "at" and no
 *     explicit minutes.
 *   - "resets in 45 minutes" / "resets in 2 hours" -> `now` + the stated delta.
 */
export function parseClaudeResetTime(text: string, now: Date): Date | null {
  if (!text) return null;

  const inM = CLAUDE_RESET_IN_RE.exec(text);
  if (inM) {
    const n = Number(inM[1]);
    if (Number.isFinite(n) && n >= 0) {
      const unitMs = /hour/i.test(inM[2]) ? 60 * 60 * 1000 : 60 * 1000;
      return new Date(now.getTime() + n * unitMs);
    }
  }

  const atM = CLAUDE_RESET_AT_RE.exec(text);
  if (atM) {
    let hour = Number(atM[1]);
    const minute = atM[2] ? Number(atM[2]) : 0;
    const ampm = atM[3].toLowerCase();
    const timeZone = atM[4].trim();
    if (hour < 1 || hour > 12 || minute > 59) return null;
    // 12-hour -> 24-hour: 12am -> 0, 12pm -> 12, otherwise +12 for pm.
    if (ampm === 'am') hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;

    // Reject an unknown IANA zone (Intl throws on construction) -> guessed.
    try {
      new Intl.DateTimeFormat('en-US', { timeZone });
    } catch {
      return null;
    }

    const today = claudeZoneParts(now, timeZone);
    let ts = claudeZonedWallClockToUtc(today.year, today.month, today.day, hour, minute, timeZone);
    if (ts < now.getTime()) {
      // Already passed today in that zone; advance to the next calendar day
      // (Date.UTC normalizes day overflow before we re-project through the zone).
      ts = claudeZonedWallClockToUtc(today.year, today.month, today.day + 1, hour, minute, timeZone);
    }
    return new Date(ts);
  }

  return null;
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

  installCommand(os: 'linux' | 'macos' | 'windows', shell?: MemberShell): string {
    if (os === 'windows') {
      // The raw `irm ... | iex` form is PowerShell-only syntax -- it only
      // works when the executing shell IS PowerShell. A gitbash member's
      // command strings run in bash directly (apra-fleet-7dir.2.4/2.7), so
      // route through the same base64 -EncodedCommand envelope every other
      // Windows-targeting PowerShell invocation in this codebase uses.
      if (shell === 'gitbash') {
        return wrapPowerShellEncoded('irm https://claude.ai/install.ps1 | iex');
      }
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
    const permFlag = this.resolvePermissionFlag(unattended);
    if (permFlag) cmd += ` ${permFlag}`;
    if (model) {
      cmd += ` --model "${escapeDoubleQuoted(model)}"`;
    }
    // Per-session member MCP config. Appended LAST: --mcp-config is variadic,
    // so it must never precede the positional prompt.
    if (opts.mcpConfigPath) {
      cmd += ` ${this.mcpConfigFlag(opts.mcpConfigPath, true)}`;
    }
    return cmd;
  }

  mcpConfigFlag(absPath: string, posix: boolean): string {
    return `--mcp-config ${posix ? quotePosixPath(absPath) : quotePwshPath(absPath.replace(/\//g, '\\'))}`;
  }

  /**
   * Claude Code defers MCP tools behind its tool-search tool, so a role
   * session would have to discover kb_* / code_* before calling them. A
   * `--mcp-config` server entry with `alwaysLoad: true` keeps that server's
   * tools loaded from the first turn (per server, so other servers keep
   * their deferral). The non-deferral mechanism therefore lives in the config
   * file the --mcp-config flag names -- no env var or extra flag in the
   * member command string. Relied on: Claude Code 2.1.291 (verified that its
   * --mcp-config schema accepts alwaysLoad and that the key is present in
   * 2.1.288-2.1.291); 2.1.288 is the oldest version verified, so it is the
   * floor. Older CLIs get the config without the key and a dispatch WARN.
   */
  mcpAlwaysLoadMinVersion(): string {
    return '2.1.288';
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

  resolvePermissionFlag(unattended: false | 'auto' | 'dangerous' | undefined): string {
    if (unattended === 'auto') return '--permission-mode auto';
    if (unattended === 'dangerous') return '--dangerously-skip-permissions';
    // apra-fleet-eft.65.1: interactive-session parity for the work folder.
    // A headless `-p` dispatch cannot present a permission prompt, so with no
    // permission-mode flag the CLI HARD-BLOCKS Edit/Write of a brand-new file
    // in its own work folder -- even though an interactive session in the same
    // trusted workspace would simply accept it. `acceptEdits` auto-approves
    // file-edit tools (Edit/Write/MultiEdit/NotebookEdit) for the working
    // directory only; it does NOT auto-approve Bash, network, or edits outside
    // the workspace, so this restores work-folder Edit/Write parity without
    // broadening the permission model (unlike --dangerously-skip-permissions).
    return this.workspaceEditPermissionFlag() ?? '';
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
        apiErrorStatus: extractApiErrorStatus(obj),
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
          apiErrorStatus: extractApiErrorStatus(parsed),
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

  // apra-fleet-hzeb.1 / hzeb.1.2: Claude signals a usage limit via a 429
  // api_error_status OR a terminal_reason of 'api_error' -- independent of process
  // exit code (exit 1 with is_error, OR exit 0 carrying the message as the result
  // text). A 429 is definitively a usage/quota limit on its own; the broader
  // 'api_error' terminal reason can mean other things, so there we additionally
  // require Claude's own "hit your <...> limit" message to avoid misclassifying an
  // unrelated API error. When the message exposes a real reset time we parse it
  // into a concrete `resumeAt` (source 'parsed'); otherwise we fall back to the
  // guessed window (source 'guessed') -- NEVER to null, since a 429 is still a
  // usage limit even when its reset time is unreadable.
  detectUsageLimit(_result: SSHExecResult, parsed: ParsedResponse): UsageLimitSignal | null {
    const is429 = parsed.apiErrorStatus === 429;
    const isApiErrorTerminal = parsed.terminalReason === 'api_error';
    if (!is429 && !isApiErrorTerminal) return null;
    const text = parsed.result ?? '';
    if (!is429 && !CLAUDE_LIMIT_MESSAGE_RE.test(text)) return null;

    const now = new Date();
    const parsedReset = parseClaudeResetTime(text, now);
    if (parsedReset) {
      return {
        type: 'usage_limit',
        resumeAt: parsedReset.toISOString(),
        resumeAtSource: 'parsed',
        message: text,
      };
    }
    return guessedUsageLimitSignal(text, now.getTime());
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

  // apra-fleet-25yl.2.1: a headless `claude -p` dispatch is batch-only -- it
  // emits nothing on the exec channel until the whole turn is done, so a
  // `timeout_s`-sized rolling deadline on that channel is a false kill, not a
  // stall signal. Claude's real mechanism is the StallDetector polling the
  // session transcript (resolveSessionLogPath below returns a real file), and
  // that still receives `timeout_s` as its thresholdMs.
  execTimeoutSource(): ExecTimeoutSource {
    return 'total_ceiling';
  }

  // apra-fleet-lmtg.1: Claude Code's CLI supports fork-mode dispatch natively
  // via `--resume <source> --fork-session` -- per `claude --help`, --fork-session
  // "When resuming, create a new session ID instead of reusing the original".
  // The CLI honors a caller-supplied `--session-id` even in fork mode, so we
  // pre-mint the forked session's id (same as a plain caller-minted dispatch)
  // and pass it explicitly rather than letting the CLI mint its own and
  // scraping it out of the response afterward. The source session is left
  // untouched; only the forked dispatch continues under the new id.
  supportsFork(): boolean {
    return true;
  }

  forkFlag(sourceSessionId: string, newSessionId: string): string {
    return buildForkFlag(sourceSessionId, newSessionId);
  }

  resolveSessionLogPath(sessionId: string, workFolder: string, homeDir?: string | null, targetOs?: TargetOS): string {
    const home = resolveHomeDir(homeDir);
    if (!home) return '';
    const encoded = encodeClaudeProjectDir(workFolder, targetOs ? targetOs === 'windows' : process.platform === 'win32');
    return joinForOS(targetOs, home, '.claude', 'projects', encoded, `${sessionId}.jsonl`);
  }

  resolveSessionLogDir(workFolder: string, homeDir?: string | null, targetOs?: TargetOS): string | null {
    const home = resolveHomeDir(homeDir);
    if (!home) return null;
    const encoded = encodeClaudeProjectDir(workFolder, targetOs ? targetOs === 'windows' : process.platform === 'win32');
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

  agentDirectories(agentName: string): { project: string; home: string } {
    const rel = `.claude/agents/${agentName}.md`;
    return { project: rel, home: rel };
  }

  transformAgent(content: string, relPath: string): string {
    // Same resolver the local install uses for this provider, so remote == local.
    return transformAgentForClaude(content, relPath);
  }

  agentNameFlag(agentName: string): string {
    return `--agent "${escapeDoubleQuoted(agentName)}"`;
  }

  classifyError(output: string): PromptErrorCategory {
    return classifyPromptError(output);
  }

  permissionConfigPaths(): string[] {
    return ['.claude/settings.local.json'];
  }

  // The member's apra-fleet MCP entry is NOT written here: it lives in Claude's
  // LOCAL scope (~/.claude.json projects[<repo root of workFolder>].mcpServers), written by
  // syncMemberMcpEntry. This file only carries the client-side deny rules for
  // every registered fleet tool outside the member allowlist.
  composePermissionConfig(_role: 'doer' | 'reviewer', allow: string[] = []): Array<Record<string, unknown> | string> {
    return [{ permissions: { allow, deny: claudeMemberDenyRules() }, skillOverrides: { pm: 'off', fleet: 'off' } }];
  }

  async syncMemberMcpEntry(ctx: MemberMcpSyncContext): Promise<MemberMcpSyncResult> {
    const { agent, url } = ctx;
    const posix = isPosixShell(ctx.agentOs, ctx.shell);
    const isWindows = ctx.agentOs === 'windows';
    const configDir = await probeMemberClaudeConfigDir(ctx.execCommand, ctx.agentOs, ctx.shell);
    const target = claudeLocalScopeConfigFile(configDir, ctx.memberHomeDir, isWindows, ctx.shell);
    const exec = checkedExec(ctx.execCommand);

    const config = await readMemberJson(ctx.execCommand, target.file, posix);
    // Claude Code keys local-scope servers by the git repository ROOT of the
    // folder (the exact folder only outside a git repo) -- the same resolver
    // the fleetMcp probe reads back with.
    const key = await resolveClaudeProjectKey(exec, agent.workFolder, isWindows, posix);
    let changed = false;

    // User-scope legacy entry (top-level mcpServers).
    const userServers = config.mcpServers;
    if (isRecord(userServers) && LEGACY_MEMBER_MCP_SERVER_NAME in userServers) {
      delete userServers[LEGACY_MEMBER_MCP_SERVER_NAME];
      changed = true;
    }

    const projects = isRecord(config.projects) ? config.projects : {};
    const entry = isRecord(projects[key]) ? projects[key] as Record<string, unknown> : null;
    if (url !== null || entry) {
      const project: Record<string, unknown> = entry ?? {};
      const servers: Record<string, unknown> = isRecord(project.mcpServers) ? project.mcpServers as Record<string, unknown> : {};
      if (LEGACY_MEMBER_MCP_SERVER_NAME in servers) {
        delete servers[LEGACY_MEMBER_MCP_SERVER_NAME];
        changed = true;
      }
      if (url !== null) {
        const current = servers[MEMBER_MCP_SERVER_NAME];
        const wanted: Record<string, unknown> = { type: 'http', url, ...(ctx.headers ? { headers: ctx.headers } : {}) };
        if (!isRecord(current) || JSON.stringify(current) !== JSON.stringify(wanted)) {
          servers[MEMBER_MCP_SERVER_NAME] = wanted;
          changed = true;
        }
      } else if (MEMBER_MCP_SERVER_NAME in servers) {
        const current = servers[MEMBER_MCP_SERVER_NAME];
        const own = isRecord(current) && typeof current.url === 'string'
          && current.url.endsWith(`?member=${encodeURIComponent(agent.id)}`);
        if (!ctx.removeOnlyOwnEntry || own) {
          delete servers[MEMBER_MCP_SERVER_NAME];
          changed = true;
        }
      }
      project.mcpServers = servers;
      projects[key] = project;
      config.projects = projects;
    }

    // An older compose keyed the entry by the work folder exactly as
    // registered. The resolved key differs when the folder sits below its
    // repository root, or when git reports the root symlink-resolved
    // (macOS /var -> /private/var). Clean up what this member left
    // under that spelling: the legacy entry and its OWN apra-fleet entry,
    // never someone else's.
    const folderKey = normalizeProjectKey(agent.workFolder);
    const aliased = folderKey !== key && isRecord(projects[folderKey]) ? projects[folderKey] as Record<string, unknown> : null;
    if (aliased && isRecord(aliased.mcpServers)) {
      const servers = aliased.mcpServers as Record<string, unknown>;
      if (LEGACY_MEMBER_MCP_SERVER_NAME in servers) {
        delete servers[LEGACY_MEMBER_MCP_SERVER_NAME];
        changed = true;
      }
      const stale = servers[MEMBER_MCP_SERVER_NAME];
      if (isRecord(stale) && typeof stale.url === 'string' && stale.url.endsWith(`?member=${encodeURIComponent(agent.id)}`)) {
        delete servers[MEMBER_MCP_SERVER_NAME];
        changed = true;
      }
      config.projects = projects;
    }

    if (!changed) {
      return { workFolderFiles: [], detail: `claude: ${target.file} already up to date for ${key}` };
    }

    const staging = workspaceTrustStagingNames();
    await deliverWorkspaceTrustFile(JSON.stringify(config, null, 2), {
      isWindows: !posix,
      agentOs: ctx.agentOs,
      execCommand: exec,
      // The file channel writes relative to the member's HOME, so it only fits
      // when the config file is home-anchored (not a CLAUDE_CONFIG_DIR override).
      transport: target.homeAnchored ? ctx.transport : undefined,
      // Embedded inside "..." in the delivery commands: escape what is live
      // there for the member's shell (the read above quotes the path itself).
      homeFile: escapeForDoubleQuotes(target.file, !posix),
      tmpFile: escapeForDoubleQuotes(joinMemberPath(target.dir, staging.tmpRel, isWindows, ctx.shell), !posix),
      staging,
      secretChannel: ctx.secretChannel,
    });
    const what = url !== null ? `wrote ${MEMBER_MCP_SERVER_NAME} (local scope)` : `removed ${MEMBER_MCP_SERVER_NAME}`;
    return { workFolderFiles: [], detail: `claude: ${what} for ${key} in ${target.file}` };
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

  // A plain OAuth-file copy leaves Claude env credentials alone: it also runs
  // automatically (cloud start, sprint self-heal) and must never erase an
  // operator-provisioned token. Clearing them is the explicit
  // force_oauth_copy path in provision_llm_auth (via authEnvVarNames).
  oauthEnvVarsToUnset(): string[] {
    return [];
  }

  // Kind is decided by prefix: sk-ant-oat... is a Claude Code OAuth token
  // (`claude setup-token`) and belongs in CLAUDE_CODE_OAUTH_TOKEN; sk-ant-api...
  // is an Anthropic API key (ANTHROPIC_API_KEY). Any other sk-ant- shape keeps
  // the legacy API-key routing and any non-sk-ant token the legacy OAuth
  // routing -- authTokenKindWarning flags both as guesses. Pure: preflight
  // probes this with fake tokens.
  authEnvVarForToken(token: string): string {
    const t = token.trim();
    if (t.startsWith(CLAUDE_OAUTH_TOKEN_PREFIX)) return 'CLAUDE_CODE_OAUTH_TOKEN';
    if (t.startsWith('sk-ant-')) return 'ANTHROPIC_API_KEY';
    return 'CLAUDE_CODE_OAUTH_TOKEN';
  }

  authEnvVarNames(): string[] {
    return [...CLAUDE_AUTH_ENV_VARS];
  }

  authTokenKindWarning(token: string): string | null {
    const t = token.trim();
    if (t.startsWith(CLAUDE_OAUTH_TOKEN_PREFIX) || t.startsWith(CLAUDE_API_KEY_PREFIX)) return null;
    return `Unrecognised Claude credential prefix -- expected ${CLAUDE_OAUTH_TOKEN_PREFIX}... (Claude Code OAuth token from \`claude setup-token\`, set as CLAUDE_CODE_OAUTH_TOKEN) or ${CLAUDE_API_KEY_PREFIX}... (Anthropic API key, set as ANTHROPIC_API_KEY). Deployed as ${this.authEnvVarForToken(t)}; check the value if auth fails.`;
  }

  // Only an OAuth token replaces the /login file. A real API key leaves it in
  // place: on a shared member it may be a human's own login, and either env
  // var outranks the file anyway.
  credentialFilesSupersededByEnvToken(token: string): string[] {
    return token.trim().startsWith(CLAUDE_OAUTH_TOKEN_PREFIX) ? ['~/.claude/.credentials.json'] : [];
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

  async ensureWorkspaceTrusted(workFolder: string, execCommand: WorkspaceTrustExecFn, agentOs: 'linux' | 'macos' | 'windows' = 'linux', shell?: MemberShell, transport?: WorkspaceTrustTransport, memberHomeDir?: string | null, secretChannel?: MemberSecretFileChannel): Promise<EnsureWorkspaceTrustedResult> {
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

    // A Windows member registered as Git-for-Windows bash speaks POSIX: the
    // PowerShell strings below are handed verbatim to bash.exe and fail with
    // "Get-Content: command not found" -- and because this method never
    // inspects the write's exit code, that failure surfaces as a FALSE
    // "seeded trust" while nothing lands on disk (apra-fleet-7dir.2.8).
    // Selecting the POSIX branch for a gitbash member is what fixes that;
    // every other Windows member (pwsh7/powershell5/unrecorded) keeps the
    // byte-identical PowerShell strings it got before.
    const usePosix = isPosixShell(agentOs, shell);
    const isWindows = !usePosix;
    const staging = workspaceTrustStagingNames();

    // Every member-side path is resolved HERE, from the JS-resolved member home
    // -- never left to the member shell ($env:USERPROFILE / $HOME). A shell
    // expansion can resolve a different home than the one the file channel
    // (getMemberHomeDir) writes to, so the read, the staged write and the move
    // would address different files. No resolved home -> refuse, loudly.
    const resolvedHome = memberHomeDir ? memberHomeDir.trim() : '';
    if (!resolvedHome) {
      const detail = 'E-MEMBER-HOME-UNRESOLVED: the member home directory could not be resolved, so its ~/.claude.json cannot be located; workspace trust NOT seeded';
      console.error(`[claude] workspace trust: ${detail}`);
      return { seeded: false, detail, mcpServersSeeded: [] };
    }
    // Every path below is embedded inside "..." in a member-bound command, and
    // the resolved home is environment-derived (os.homedir() for a local
    // member), so escape what is live inside double quotes for the target shell.
    const homeDir = escapeForDoubleQuotes(
      isWindows
        ? resolvedHome.replace(/\//g, '\\').replace(/\\+$/, '')
        : resolvedHome.replace(/\\/g, '/').replace(/\/+$/, ''),
      isWindows);
    const inHome = (rel: string) => (isWindows ? `${homeDir}\\${rel}` : `${homeDir}/${rel}`);
    const homeFile = inHome('.claude.json');
    const tmpFile = inHome(staging.tmpRel);

    // apra-fleet-9oo: the project's .mcp.json lives in the MEMBER's work folder, not on
    // the orchestrator host, so it must be read through the same execCommand channel --
    // never local node:fs. It rides along in the SAME read command as ~/.claude.json:
    // one round-trip, and (crucially) the already-satisfied case still costs exactly one
    // exec, so the "no write when nothing to do" contract is observable as before.
    const mcpFile = `${escapeForDoubleQuotes(key, isWindows)}/.mcp.json`;
    const SPLIT = '---FLEET_MCP_SPLIT---';
    const HOME_UNREADABLE = 'FLEET_HOME_CONFIG_UNREADABLE';

    // An EXISTING but unreadable ~/.claude.json must never be read as {} and then
    // atomically replaced with just the trust entry (that destroys the user's MCP
    // servers and state). The read stays a one-exec round trip; when the home
    // file exists and cat/Get-Content fails, a sentinel (printed without echo /
    // Write-Output, which the split-marker lookup keys on) is emitted instead
    // of the content, and nothing is written.
    const readCmd = isWindows
      ? `Get-Content -Raw "${homeFile}" -ErrorAction SilentlyContinue -ErrorVariable fleetHomeReadErr; if ($fleetHomeReadErr -and (Test-Path "${homeFile}")) { [Console]::Out.Write("${HOME_UNREADABLE}") }; Write-Output "${SPLIT}"; Get-Content -Raw "${mcpFile}" -ErrorAction SilentlyContinue`
      : `cat "${homeFile}" 2>/dev/null || { if test -e "${homeFile}"; then printf '%s' "${HOME_UNREADABLE}"; fi; }; echo "${SPLIT}"; cat "${mcpFile}" 2>/dev/null || true`;
    const readResult = await execCommand(readCmd, 10000);

    // Substring split (not line-split): if ~/.claude.json has no trailing newline the
    // marker glues onto its closing brace, and only a substring split separates cleanly.
    // No marker at all -> treat the whole payload as ~/.claude.json with no .mcp.json.
    const rawStdout = readResult.stdout;
    const splitIdx = rawStdout.indexOf(SPLIT);
    const homeRaw = (splitIdx === -1 ? rawStdout : rawStdout.slice(0, splitIdx)).trim();
    const mcpRaw = (splitIdx === -1 ? '' : rawStdout.slice(splitIdx + SPLIT.length)).trim();

    if (homeRaw.includes(HOME_UNREADABLE)) {
      const detail = `E-MEMBER-CONFIG-UNREADABLE: ${homeFile} exists but could not be read; workspace trust NOT seeded (the file is left untouched)`;
      console.error(`[claude] workspace trust: ${detail}`);
      return { seeded: false, detail, mcpServersSeeded: [] };
    }

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
    //
    // The merged content must NEVER ride a command line: ~/.claude.json can hold
    // other MCP servers' headers/tokens and OAuth state, and a command line is
    // visible in process listings (and is capped at 32767 chars on Windows).
    // Delivery is the file channel (node:fs / SFTP) or the owner-only secret
    // file, then a content-free move into place; with neither, it fails loudly.
    await deliverWorkspaceTrustFile(contentStr, { isWindows, agentOs, execCommand, transport, homeFile, tmpFile, staging, secretChannel });

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

/** Member-side staging file names for one ensureWorkspaceTrusted call, relative to
 *  the member's home. Unique per call (pid + random) so concurrent seeds of the same
 *  home never share a staging file; shared by the out-of-band (node:fs / SFTP)
 *  channel and the exec-based fallbacks so every path stages in the same place. */
export interface WorkspaceTrustStagingNames {
  tmpRel: string;
}

export function workspaceTrustStagingNames(): WorkspaceTrustStagingNames {
  // CSPRNG, not Math.random: the names sit in the member's home next to
  // .claude.json, so they should not be predictable.
  const token = `${process.pid}-${randomBytes(4).toString('hex')}`;
  return {
    tmpRel: `.claude.json.fleet-trust-${token}.tmp`,
  };
}

export interface WorkspaceTrustWritePlan {
  /** How the content reached the member. */
  mechanism: 'file-channel' | 'secret-file';
  /** Every command string handed to execCommand, in order. None of them carries
   *  the delivered content: only a move of an already-staged file. */
  commands: string[];
}

/**
 * Deliver `contentStr` (a merged ~/.claude.json) to `homeFile` on the member
 * WITHOUT it ever appearing in an exec string -- not raw, not base64, not
 * chunked, not inside -EncodedCommand. Two channels only:
 *   1. transport.writeHomeFile (node:fs for a local member, SFTP for SSH)
 *      stages it next to the target, then a content-free move lands it;
 *   2. the owner-only secret file (opts.secretChannel), then the same move.
 * Neither available (or both failing) -> throws an error naming the missing
 * channel; there is no inline fallback.
 */
export async function deliverWorkspaceTrustFile(
  contentStr: string,
  opts: {
    isWindows: boolean;
    agentOs: 'linux' | 'macos' | 'windows';
    execCommand: WorkspaceTrustExecFn;
    transport?: WorkspaceTrustTransport;
    homeFile: string;
    tmpFile: string;
    staging: WorkspaceTrustStagingNames;
    homeRel?: string;
    secretChannel?: MemberSecretFileChannel;
  },
): Promise<WorkspaceTrustWritePlan> {
  const { isWindows, execCommand, transport, homeFile, tmpFile, staging, homeRel, secretChannel } = opts;
  const moveCmd = (from: string) => (isWindows
    ? `Move-Item -Force "${from}" "${homeFile}"`
    : `mv "${from}" "${homeFile}"`);
  const failures: string[] = [];

  // 1. Out-of-band file channel: content never touches a command line.
  if (transport?.writeHomeFile) {
    try {
      const targetRel = homeRel ?? staging.tmpRel;
      await transport.writeHomeFile(targetRel, contentStr);
      if (homeRel) {
        return { mechanism: 'file-channel', commands: [] };
      }
      const cmd = moveCmd(tmpFile);
      const r = await execCommand(cmd, 10000);
      if (r.code !== 0) throw new Error(`move into place failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
      return { mechanism: 'file-channel', commands: [cmd] };
    } catch (err: unknown) {
      failures.push(`file channel: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    failures.push('file channel (SFTP / local file copy): not available for this member');
  }

  // 2. Owner-only secret file, then a content-free move.
  if (secretChannel) {
    let staged: string | null = null;
    try {
      staged = await secretChannel.write(contentStr);
      const cmd = moveCmd(escapeForDoubleQuotes(staged, isWindows));
      const r = await execCommand(cmd, 10000);
      if (r.code !== 0) throw new Error(`move into place failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
      return { mechanism: 'secret-file', commands: [cmd] };
    } catch (err: unknown) {
      if (staged) { try { await secretChannel.remove(staged); } catch { /* best-effort */ } }
      failures.push(`secret-file channel: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    failures.push('secret-file channel: not available for this member');
  }

  throw new Error(`E-MEMBER-CONFIG-NO-FILE-CHANNEL: cannot write ${homeFile} on the member without putting its content on a command line (it can carry other MCP servers' tokens); ${failures.join('; ')}. Enable the SFTP subsystem on the member's sshd, or use a member type with a file channel.`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Wraps an exec fn so a nonzero exit throws instead of passing silently. */
function checkedExec(exec: WorkspaceTrustExecFn): WorkspaceTrustExecFn {
  return async (cmd, timeoutMs) => {
    const r = await exec(cmd, timeoutMs);
    if (r.code !== 0) {
      throw new Error(`member command failed (exit ${r.code}): ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
    }
    return r;
  };
}

/**
 * Reads CLAUDE_CONFIG_DIR as the MEMBER's own shell sees it -- the environment
 * a dispatched claude actually runs with (for a local member that is the
 * clean login env LocalStrategy builds, not this server's env). Returns null
 * when unset or not an absolute path. Same probe shape as member-home.ts:
 * POSIX printf, or base64-encoded PowerShell so no outer shell re-expands it.
 */
export async function probeMemberClaudeConfigDir(
  exec: WorkspaceTrustExecFn,
  agentOs: 'linux' | 'macos' | 'windows',
  shell?: MemberShell,
): Promise<string | null> {
  const posix = isPosixShell(agentOs, shell);
  const cmd = posix
    ? 'printf \'%s\' "${CLAUDE_CONFIG_DIR:-}"'
    : wrapPowerShellEncoded('[Console]::Out.Write($env:CLAUDE_CONFIG_DIR)');
  let out = '';
  try {
    const r = await exec(cmd, 10000);
    if (r.code !== 0) return null;
    out = (r.stdout ?? '').trim();
  } catch {
    return null;
  }
  if (!out) return null;
  const absolute = out.startsWith('/') || /^[A-Za-z]:[\\/]/.test(out) || out.startsWith('\\\\');
  return absolute ? out : null;
}

/**
 * The member-side Claude config file that holds LOCAL-scope MCP servers
 * (projects[<folder>].mcpServers): $CLAUDE_CONFIG_DIR/.claude.json when the
 * member's environment sets that variable (see probeMemberClaudeConfigDir),
 * else ~/.claude.json. Throws when the member's home could not be resolved --
 * never guesses a path.
 */
export function claudeLocalScopeConfigFile(
  configDirOverride: string | null,
  memberHomeDir: string | null,
  isWindows: boolean,
  shell?: MemberShell,
): { file: string; dir: string; homeAnchored: boolean } {
  const normalize = (p: string) => (isWindows && !isPosixShell(isWindows, shell)
    ? p.trim().replace(/\//g, '\\').replace(/\\+$/, '')
    : p.trim().replace(/\\/g, '/').replace(/\/+$/, ''));
  if (configDirOverride) {
    const dir = normalize(configDirOverride);
    const homeAnchored = !!memberHomeDir && normalize(memberHomeDir) === dir;
    return { file: joinMemberPath(dir, '.claude.json', isWindows, shell), dir, homeAnchored };
  }
  if (!memberHomeDir) {
    throw new Error('claude: the member home directory could not be resolved, so its ~/.claude.json cannot be located');
  }
  const dir = normalize(memberHomeDir);
  return { file: joinMemberPath(dir, '.claude.json', isWindows, shell), dir, homeAnchored: true };
}
