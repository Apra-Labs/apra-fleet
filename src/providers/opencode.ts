import type { ProviderAdapter, PromptOptions, ParsedResponse, UsageLimitSignal, MemberMcpSyncContext, MemberMcpSyncResult, WorkspaceTrustExecFn, EnsureWorkspaceTrustedResult, SessionIdStrategy, ExecTimeoutSource, TargetOS } from './provider.js';
import { joinForOS, resolveHomeDir, defaultUsageLimitSignal } from './provider.js';
import type { LlmProvider, SSHExecResult } from '../types.js';
import type { PromptErrorCategory } from '../utils/prompt-errors.js';
import { escapeDoubleQuoted } from '../os/os-commands.js';
import type { MemberShell } from '../os/os-commands.js';
import { logWarn } from '../utils/log-helpers.js';
import { sanitizeSessionId } from '../os/os-commands.js';
import { transformAgentForOpenCode } from '../cli/agent-transform.js';
import { isPosixShell } from '../utils/agent-helpers.js';
import {
  deleteMemberFile,
  joinMemberPath,
  pruneLegacyMcpInMemberFile,
  readMemberJson,
  MemberConfigError,
  MemberConfigNotJsonError,
  isGitTracked,
  memberFileExists,
  writeMemberJson,
  LEGACY_MEMBER_MCP_SERVER_NAME,
  MEMBER_MCP_SERVER_NAME,
} from '../services/member-config-io.js';

/** Work-folder-relative project config opencode reads MCP servers from. */
export const OPENCODE_PROJECT_CONFIG = 'opencode.json';

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

  // `shell` is intentionally unused: no windows branch exists here -- `npm
  // install -g` runs unchanged from any shell (apra-fleet-7dir.2.7: named
  // here as an adapter needing no per-shell variant, not skipped silently).
  installCommand(os: 'linux' | 'macos' | 'windows', _shell?: MemberShell): string {
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
    return '--auto';
  }

  resolvePermissionFlag(unattended: false | 'auto' | 'dangerous' | undefined): string {
    if (unattended === 'auto' || unattended === 'dangerous') {
      if (unattended === 'dangerous') {
        logWarn('opencode', "WARNING: unattended='dangerous' is not supported for opencode -- falling back to --auto (no classifier safety). Ensure deny rules are configured.");
      }
      return this.permissionModeAutoFlag() ?? '';
    }
    return '';
  }

  modelTiers(): Record<'cheap' | 'standard' | 'premium', string> {
    return {
      cheap: 'opencode/north-mini-code-free',
      standard: 'opencode/deepseek-v4-flash-free',
      premium: 'opencode/nemotron-3-ultra-free',
    };
  }

  modelForTier(tier: 'cheap' | 'standard' | 'premium'): string {
    if (tier === 'premium') return 'opencode/nemotron-3-ultra-free';
    if (tier === 'cheap') return 'opencode/north-mini-code-free';
    return 'opencode/deepseek-v4-flash-free';
  }

  modelFlag(model: string): string {
    return `-m "${escapeDoubleQuoted(model)}"`;
  }

  agentDirectories(agentName: string): { project: string; home: string } {
    return {
      project: `.opencode/agents/${agentName}.md`,
      home: `.config/opencode/agents/${agentName}.md`,
    };
  }

  transformAgent(content: string, relPath: string): string {
    return transformAgentForOpenCode(content, relPath);
  }

  agentNameFlag(_agentName: string): string {
    return '';
  }

  classifyError(output: string): PromptErrorCategory {
    if (/command not found|is not recognized as an internal or external command/i.test(output)) return 'unknown';
    if (/connection refused|ECONNREFUSED/i.test(output)) return 'server';
    if (/timeout|ETIMEDOUT/i.test(output)) return 'server';
    // apra-fleet-hzeb.1: widened to the shared overloaded/quota set (previously
    // lacked 529, quota/usage/credit-limit, resource_exhausted) so opencode
    // quota exhaustion classifies consistently with the other adapters.
    if (/\b429\b|\b529\b|overloaded|rate limit|quota exceeded|resource_exhausted|credit limit|usage limit/i.test(output)) return 'overloaded';
    return 'unknown';
  }

  // apra-fleet-hzeb.1: OpenCode has no distinct usage-limit event surface, so key off
  // the raw output using the shared quota detector (guessed resume window).
  detectUsageLimit(result: SSHExecResult, parsed: ParsedResponse): UsageLimitSignal | null {
    return defaultUsageLimitSignal(result.stderr || result.stdout || parsed.result);
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
    const permFlag = this.resolvePermissionFlag(unattended);
    if (permFlag) cmd += ` ${permFlag}`;
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

  sessionIdStrategy(): SessionIdStrategy {
    return { type: 'provider-minted' };
  }

  // apra-fleet-25yl.2.1: keep BOTH signals armed for OpenCode, with OR
  // semantics -- either the exec channel advancing or the log-directory mtime
  // advancing means not-stalled. resolveSessionLogPath() below returns '' while
  // resolveSessionLogDir() returns a real directory, so OpenCode's file-side
  // signal is coarse directory polling only; keeping the exec-level timer as
  // well is the conservative default. Narrowing this to one mechanism (i.e.
  // flipping to 'total_ceiling') requires a separate LIVE responsiveness check
  // of what OpenCode actually emits mid-turn -- it was deliberately not
  // attempted here, so do not flip it on reasoning alone.
  execTimeoutSource(): ExecTimeoutSource {
    return 'inactivity_timeout';
  }

  resolveSessionLogPath(_sessionId: string, _workFolder: string, _homeDir?: string | null, _targetOs?: TargetOS): string {
    return '';
  }

  resolveSessionLogDir(_workFolder: string, homeDir?: string | null, targetOs?: TargetOS): string | null {
    const home = resolveHomeDir(homeDir);
    if (!home) return null;
    return joinForOS(targetOs, home, '.local', 'share', 'opencode', 'log');
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

  // `_allow` (the composed Claude-format permission list, including any
  // `mcp__<server>__<tool>` entries) has no destination here: OpenCode's own
  // `permission:` schema only has the three coarse categories below (edit/write/bash)
  // -- no per-tool or per-server MCP granularity exists to map onto (confirmed against
  // docs/opencode-exploration.md's live investigation). MCP tool access under OpenCode
  // is all-or-nothing at the SERVER level: the member's per-folder apra-fleet entry in
  // <workFolder>/opencode.json (syncMemberMcpEntry) is enabled outright, and the fleet
  // server itself serves a ?member= session only the member allowlist. Do not add MCP
  // entries to the returned permission object; OpenCode's schema would not understand them.
  composePermissionConfig(role: 'doer' | 'reviewer', _allow: string[] = []): Array<Record<string, unknown> | string> {
    if (role === 'doer') {
      return [{ permission: { edit: 'allow', write: 'allow', bash: 'allow' } }];
    }
    return [{ permission: { edit: 'deny', write: 'allow', bash: 'allow' } }];
  }

  /** Writes (or removes) mcp['apra-fleet'] in <workFolder>/opencode.json -- the
   *  project-scope config opencode reads -- and prunes the retired
   *  apra-fleet-member entry there and in the global
   *  ~/.config/opencode/opencode.json. opencode gets no MCP deny rules: the
   *  server already serves a member session only the member allowlist. On
   *  removal the file is deleted when nothing else remains in it. */
  async syncMemberMcpEntry(ctx: MemberMcpSyncContext): Promise<MemberMcpSyncResult> {
    const { agent, url } = ctx;
    const isWindows = ctx.agentOs === 'windows';
    const posix = isPosixShell(isWindows, ctx.shell);
    const file = joinMemberPath(agent.workFolder, OPENCODE_PROJECT_CONFIG, isWindows, ctx.shell);

    let config: Record<string, unknown>;
    try {
      config = await readMemberJson(ctx.execCommand, file, posix);
    } catch (e) {
      // JSONC (comments / trailing commas) is common in opencode.json: report it
      // as a typed, recoverable status and never rewrite the file.
      if (e instanceof MemberConfigNotJsonError) {
        throw new MemberConfigNotJsonError(file, 'is not strict JSON (JSONC comments or trailing commas?)', 'opencode-config-unparseable');
      }
      throw e;
    }
    const mcp: Record<string, unknown> = (config.mcp && typeof config.mcp === 'object' && !Array.isArray(config.mcp))
      ? config.mcp as Record<string, unknown>
      : {};
    const hadLegacy = LEGACY_MEMBER_MCP_SERVER_NAME in mcp;
    delete mcp[LEGACY_MEMBER_MCP_SERVER_NAME];
    // Check if the file actually exists on disk (even if empty or {})
    const fileExists = await memberFileExists(ctx.execCommand, file, posix);
    let detail: string;
    if (url !== null) {
      const cur = mcp[MEMBER_MCP_SERVER_NAME] as Record<string, unknown> | undefined;
      const current = !!cur && typeof cur === 'object' && cur.type === 'remote' && cur.url === url && cur.enabled === true && Object.keys(cur).length === 3;
      if (current && !hadLegacy) {
        detail = `opencode: ${file} already up to date`;
      } else {
        if (fileExists && await isGitTracked(ctx.execCommand, agent.workFolder, OPENCODE_PROJECT_CONFIG, isWindows, posix)) {
          throw new MemberConfigError(
            'E-OPENCODE-CONFIG-TRACKED',
            'opencode-config-tracked',
            file,
            `E-OPENCODE-CONFIG-TRACKED: ${file} is tracked by git; compose left it untouched (writing the member URL would dirty the repo). Untrack it or add the apra-fleet MCP entry to it yourself.`,
          );
        }
        mcp[MEMBER_MCP_SERVER_NAME] = { type: 'remote', url, enabled: true };
        config.mcp = mcp;
        await writeMemberJson(ctx.execCommand, file, config, posix);
        detail = `opencode: wrote ${MEMBER_MCP_SERVER_NAME} in ${file}`;
      }
    } else if (fileExists && await isGitTracked(ctx.execCommand, agent.workFolder, OPENCODE_PROJECT_CONFIG, isWindows, posix)) {
      detail = `opencode: ${file} is tracked by git; left untouched`;
    } else {
      delete mcp[MEMBER_MCP_SERVER_NAME];
      if (Object.keys(mcp).length > 0) config.mcp = mcp; else delete config.mcp;
      if (Object.keys(config).length === 0) {
        await deleteMemberFile(ctx.execCommand, file, posix);
        detail = `opencode: removed ${file}`;
      } else {
        await writeMemberJson(ctx.execCommand, file, config, posix);
        detail = `opencode: removed ${MEMBER_MCP_SERVER_NAME} from ${file}`;
      }
    }

    if (ctx.memberHomeDir) {
      const globalFile = joinMemberPath(ctx.memberHomeDir.trim(), '.config/opencode/opencode.json', isWindows, ctx.shell);
      try {
        if (await pruneLegacyMcpInMemberFile(ctx.execCommand, globalFile, posix)) {
          detail += `; pruned apra-fleet-member from ${globalFile}`;
        }
      } catch (e) {
        // The global config is only pruned best-effort (it is often JSONC):
        // an unreadable/unparseable one is left alone and never fails compose.
        if (!(e instanceof MemberConfigError)) throw e;
        detail += `; skipped pruning ${globalFile} (${e.code})`;
      }
    }
    return { workFolderFiles: [OPENCODE_PROJECT_CONFIG], detail };
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

  async ensureWorkspaceTrusted(_workFolder: string, _execCommand: WorkspaceTrustExecFn, _agentOs?: 'linux' | 'macos' | 'windows', _shell?: MemberShell): Promise<EnsureWorkspaceTrustedResult> {
    // apra-fleet-eft.40 provider trust matrix: OpenCode has a first-run trust/onboarding
    // gate too (docs/opencode-exploration.md:92-97), but it is ALREADY handled via the
    // validated --dangerously-skip-permissions flag on `opencode run` (same doc, checklist
    // item 1). No-op.
    return { seeded: false, detail: 'opencode: trust gate already bypassed via --dangerously-skip-permissions on opencode run' };
  }
}
