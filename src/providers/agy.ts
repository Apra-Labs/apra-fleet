import type { ProviderAdapter, PromptOptions, ParsedResponse, UsageLimitSignal, RegisterMcpEndpointOptions, RegisterMcpEndpointResult, WorkspaceTrustExecFn, EnsureWorkspaceTrustedResult, WorkspaceTrustTransport, SessionIdStrategy, ExecTimeoutSource, TargetOS } from './provider.js';
import { joinForOS, resolveHomeDir, defaultUsageLimitSignal } from './provider.js';
import type { LlmProvider, SSHExecResult, Agent } from '../types.js';
import type { PromptErrorCategory } from '../utils/prompt-errors.js';
import { classifyPromptError } from '../utils/prompt-errors.js';
import { escapeDoubleQuoted } from '../os/os-commands.js';
import type { MemberShell } from '../os/os-commands.js';
import { wrapPowerShellEncoded } from '../os/windows.js';
import { stripAnsi } from '../utils/ansi.js';
import { logWarn } from '../utils/log-helpers.js';
import { isPosixShell } from '../utils/agent-helpers.js';
import { getModelOverride } from '../services/user-config.js';
import { transformAgentForAgy } from '../cli/agent-transform.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * SINGLE source of truth for AGY's tier -> model mapping, keyed by the STABLE
 * slug ids `agy models` prints in its first column (verified accepted by
 * `agy --model <slug>` on 1.2.8).
 *
 * This used to be two maps that drifted: display names ("Gemini 3.5 Flash
 * (Medium)") for dispatch and slugs ("gemini-3.5-flash-lite") for
 * modelTiers()/modelForTier(). Both catalogs went stale, and because the doer
 * runs on the CHEAP tier, EVERY doer dispatch in an agy sprint came back as
 *   invalid model selection (--model "Gemini 3.5 Flash (Medium)"): model ...
 *   is not recognized as a known model or custom model in settings
 * -- which the engine then reported as unparseable structured output, three
 * rounds in a row, with no code ever written. Slugs are preferred over display
 * names precisely because they are the stable identifier, and keeping ONE map
 * removes the drift that caused this.
 */
export const AGY_MODEL_FOR_TIER: Record<'cheap'|'standard'|'premium', string> = {
  cheap:    'gemini-3.8-flash-low',
  standard: 'gemini-3.8-flash-high',
  premium:  'gemini-3.1-pro-high',
};

// Paths to the fleet-installed agy helper scripts on the member machine.
// Unix (bash): uses $HOME; Windows (PowerShell): uses $env:USERPROFILE.
const SCRIPTS_UNIX = '$HOME/.apra-fleet/scripts';
const SCRIPTS_WIN  = '$env:USERPROFILE\\.apra-fleet\\scripts';

export class AgyProvider implements ProviderAdapter {
  readonly name: LlmProvider = 'agy';
  readonly processName = 'agy';
  readonly authEnvVar = 'ANTIGRAVITY_API_KEY';
  readonly credentialPath = '~/.gemini/antigravity-cli/settings.json';
  readonly instructionFileName = 'AGY.md';

  cliCommand(args: string): string {
    return `agy ${args}`;
  }

  versionCommand(): string {
    return 'agy --version 2>&1';
  }

  installCommand(os: 'linux' | 'macos' | 'windows', shell?: MemberShell): string {
    if (os === 'windows') {
      // A gitbash member's command strings run in bash directly
      // (apra-fleet-7dir.2.4/2.7) -- route through the same base64
      // -EncodedCommand envelope every other Windows-targeting PowerShell
      // invocation in this codebase uses, instead of the raw `powershell
      // -Command "..."` form.
      if (shell === 'gitbash') {
        return wrapPowerShellEncoded('irm https://antigravity.google/cli/install.ps1 | iex');
      }
      return 'powershell -Command "irm https://antigravity.google/cli/install.ps1 | iex"';
    }
    return 'curl -fsSL https://antigravity.google/cli/install.sh | bash';
  }

  updateCommand(): string {
    return 'agy update';
  }

  private resolveTierFromModel(model?: string): 'cheap' | 'standard' | 'premium' {
    const tiers = this.modelTiers();
    if (model === tiers.cheap) return 'cheap';
    if (model === tiers.premium) return 'premium';
    return 'standard';
  }

  buildPromptCommand(opts: PromptOptions): string {
    const { folder, promptFile, sessionId, resuming, unattended, inv, model, tier: inputTier, agentName } = opts;
    const escapedFolder = escapeDoubleQuoted(folder);
    const normalizedFolder = folder.replace(/\\/g, '/');
    const fullPromptPath = path.posix.join(normalizedFolder, promptFile);
    let instruction = `Your task is described in ${fullPromptPath}. Read that file first, then execute the task.`;
    if (inv) {
      instruction = `[${inv}] ${instruction}`;
    }

    // Write per-workspace model override before launching agy.
    const tier = inputTier ?? this.resolveTierFromModel(model);
    const displayModel = getModelOverride('agy', tier) ?? AGY_MODEL_FOR_TIER[tier];

    // --add-dir is REQUIRED, not cosmetic: AGY does not adopt the process's
    // working directory as its workspace. A bare `cd <folder> && agy -p ...`
    // starts with NO active workspace, so the model cannot see the repo at all
    // and falls back to shelling out from ~/.gemini/antigravity-cli/scratch --
    // which then trips the headless permission wall on the first run_command.
    // (Live-verified on agy 1.2.8: the same prompt fails without --add-dir and
    // succeeds with it.) The `cd` is kept so relative paths a dispatched agent
    // builds itself still resolve.
    let cmd = `cd "${escapedFolder}" && agy ${this.workspaceDirFlag(escapedFolder)} --model "${escapeDoubleQuoted(displayModel)}" --output-format json`;
    if (agentName) {
      cmd += ` --agent "${escapeDoubleQuoted(agentName)}"`;
    }
    cmd += ` -p "${instruction}"`;

    if (resuming) {
      if (sessionId) {
        cmd += ` --conversation "${escapeDoubleQuoted(sessionId)}"`;
      } else {
        cmd += ` --continue`;
      }
    }

    const permFlag = this.resolvePermissionFlag(unattended);
    if (permFlag) cmd += ` ${permFlag}`;

    // After agy exits, read its transcript from disk (primary output channel --
    // agy writes its response to CONOUT$, not stdout, so file I/O is required).
    const transcriptScript = `${SCRIPTS_UNIX}/agy-transcript-reader.js`;
    const convArg = sessionId ? `"${escapeDoubleQuoted(sessionId)}"` : '""';
    const folderArg = `"${escapeDoubleQuoted(folder)}"`;
    cmd += `; node "${transcriptScript}" ${convArg} ${folderArg}`;

    return cmd;
  }

  skipPermissionsFlag(): string {
    return '--dangerously-skip-permissions';
  }

  /** AGY's workspace is set by --add-dir, never inherited from the process cwd.
   *  See the comment in buildPromptCommand for why this is load-bearing. */
  workspaceDirFlag(escapedFolder: string): string {
    return `--add-dir "${escapedFolder}"`;
  }

  permissionModeAutoFlag(): string | null {
    return '--mode accept-edits';
  }

  workspaceEditPermissionFlag(): string | null {
    // Mirrors claude.ts's acceptEdits: auto-approves file-edit tools for the
    // dispatched agent's own work folder only, without the broad
    // --dangerously-skip-permissions bypass. This is AGY's baseline for any
    // headless dispatch -- without it, doers cannot edit/write a new file at
    // all, since a headless `-p` run cannot show a permission prompt.
    return '--mode accept-edits';
  }

  resolvePermissionFlag(unattended: false | 'auto' | 'dangerous' | undefined): string {
    if (unattended === 'dangerous') return this.skipPermissionsFlag();
    if (unattended === 'auto') {
      // AGY has no broader-but-still-classifier-safe mode beyond baseline
      // edit parity, so 'auto' does NOT escalate to a permission bypass here
      // (that would silently grant more than the operator asked for -- see
      // unattended='dangerous' for an explicit full-bypass opt-in).
      logWarn('agy', "WARNING: unattended='auto' has no broader-than-baseline mode for AGY -- using --mode accept-edits (same as default). Use unattended='dangerous' for a full permission bypass.");
    }
    // default (false/undefined) and 'auto' both resolve to the same baseline.
    return this.workspaceEditPermissionFlag() ?? '';
  }

  parseResponse(result: SSHExecResult): ParsedResponse {
    const raw = result.stdout;
    let extractedSessionId: string | undefined;
    const sessionMatch = raw.match(/FLEET_SESSION_ID:([^\r\n]+)/);
    if (sessionMatch) {
      extractedSessionId = sessionMatch[1].trim();
    }

    // Primary path: parse AGY's native JSON envelope from stdout
    // Format: {"conversation_id":"...","status":"SUCCESS"|"ERROR","response":"...","usage":{"input_tokens":...,"output_tokens":...}}
    try {
      const strippedForJson = stripAnsi(raw)
        .replace(/FLEET_TRANSCRIPT_START[\s\S]*?FLEET_TRANSCRIPT_END/g, '')
        .replace(/^FLEET_PID:\d+\r?\n/m, '')
        .replace(/^FLEET_SESSION_ID:[^\r\n]+\r?\n/m, '')
        .trim();

      const lines = strippedForJson.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      let parsedObj: any = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (line.startsWith('{') && line.endsWith('}')) {
          try {
            const candidate = JSON.parse(line);
            const isEnvelopeStatus = candidate && (candidate.status === 'SUCCESS' || candidate.status === 'ERROR');
            const hasEnvelopeKeys = candidate && typeof candidate === 'object' && ('conversation_id' in candidate || isEnvelopeStatus) && ('response' in candidate || 'error' in candidate);
            if (hasEnvelopeKeys) {
              parsedObj = candidate;
              break;
            }
          } catch { /* keep looking */ }
        }
      }

      if (!parsedObj) {
        const jsonMatch = strippedForJson.match(/\{[\s\S]*?"response"\s*:[\s\S]*?\}/);
        if (jsonMatch) {
          try {
            parsedObj = JSON.parse(jsonMatch[0]);
          } catch { /* fallthrough */ }
        }
      }

      if (parsedObj) {
        const convId = parsedObj.conversation_id && typeof parsedObj.conversation_id === 'string' && parsedObj.conversation_id.trim()
          ? parsedObj.conversation_id.trim()
          : undefined;

        const errString = typeof parsedObj.error === 'string' ? parsedObj.error.trim() : '';
        const resultText = (parsedObj.response && typeof parsedObj.response === 'string' && parsedObj.response.trim())
          ? parsedObj.response.trim()
          : errString;
        const isError = result.code !== 0 || parsedObj.status === 'ERROR';

        return {
          result: resultText,
          sessionId: convId ?? extractedSessionId,
          isError,
          raw,
          usage: parsedObj.usage && typeof parsedObj.usage === 'object' ? {
            input_tokens: parsedObj.usage.input_tokens ?? 0,
            output_tokens: parsedObj.usage.output_tokens ?? 0,
          } : undefined,
        };
      }
    } catch { /* fallthrough */ }

    // Secondary path: diagnostic warning on non-JSON fallthrough
    logWarn('agy_provider', 'No valid native JSON envelope found in AGY output; falling back to transcript/ANSI parsing');

    const startMarker = 'FLEET_TRANSCRIPT_START';
    const endMarker = 'FLEET_TRANSCRIPT_END';
    const startIdx = raw.indexOf(startMarker);
    const endIdx = raw.indexOf(endMarker);

    if (startIdx !== -1 && endIdx !== -1) {
      const section = raw.substring(startIdx + startMarker.length, endIdx);
      const lines = section.split('\n').map(l => l.trim()).filter(Boolean);
      let lastResponse = '';
      let sessionId: string | undefined;
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as { type?: string; source?: string; status?: string; content?: string; conversation_id?: string };
          if (sessionId === undefined && typeof entry.conversation_id === 'string' && entry.conversation_id.trim()) {
            sessionId = entry.conversation_id.trim();
          }
          const isModelTurn = entry.source === 'MODEL' || entry.type === 'PLANNER_RESPONSE' || entry.type === 'GENERIC' || entry.type === 'MODEL_RESPONSE';
          if (
            isModelTurn &&
            entry.status === 'DONE' &&
            typeof entry.content === 'string' &&
            entry.content.trim()
          ) {
            lastResponse = entry.content.trim();
          }
        } catch { /* skip malformed JSON lines */ }
      }
      if (lastResponse) {
        return {
          result: lastResponse,
          sessionId: sessionId ?? extractedSessionId,
          isError: result.code !== 0,
          raw,
          usage: undefined,
        };
      }
    }

    // Fallback: ANSI-strip stdout (covers cases where transcript is missing or incomplete)
    console.error('[agy] warning: transcript markers not found -- falling back to raw ANSI-stripped output');
    const stripped = stripAnsi(raw)
      .replace(/FLEET_TRANSCRIPT_START[\s\S]*?FLEET_TRANSCRIPT_END/g, '')
      .replace(/^FLEET_PID:\d+\r?\n/m, '')
      .replace(/^FLEET_SESSION_ID:[^\r\n]+\r?\n/m, '')
      .replace(/\r/g, '')
      .trim();
    return {
      result: stripped,
      sessionId: extractedSessionId,
      isError: result.code !== 0,
      raw,
      usage: undefined,
    };
  }

  // apra-fleet-hzeb.1: AGY has no distinct usage-limit event surface, so key off
  // the raw output using the shared quota detector (guessed resume window).
  detectUsageLimit(result: SSHExecResult, parsed: ParsedResponse): UsageLimitSignal | null {
    return defaultUsageLimitSignal(result.stderr || result.stdout || parsed.result);
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

  // apra-fleet-25yl.2.1: like Claude, an AGY dispatch is batch/CONOUT$-only --
  // the exec channel carries no mid-turn signal, so a `timeout_s`-sized
  // rolling deadline there is a false kill. AGY's working mechanism is the
  // StallDetector watching its brain/transcript directory (resolveSessionLogDir
  // below returns a real path), which still gets `timeout_s` as thresholdMs.
  execTimeoutSource(): ExecTimeoutSource {
    return 'total_ceiling';
  }

  resolveSessionLogPath(sessionId: string, _workFolder: string, homeDir?: string | null, targetOs?: TargetOS): string {
    const home = resolveHomeDir(homeDir);
    if (!home) return '';
    return joinForOS(targetOs, home, '.gemini', 'antigravity-cli', 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl');
  }

  resolveSessionLogDir(_workFolder: string, homeDir?: string | null, targetOs?: TargetOS): string | null {
    const home = resolveHomeDir(homeDir);
    if (!home) return null;
    return joinForOS(targetOs, home, '.gemini', 'antigravity-cli', 'brain');
  }

  resumeFlag(sessionId?: string, resuming?: boolean): string {
    if (!sessionId || !resuming) return '';
    // Only pass --conversation when resuming an existing session (agy uses it to
    // reload conversation history). For fresh sessions, agy ignores any UUID we
    // pass and creates its own -- transcript is found via folder lookup instead.
    return `--conversation "${escapeDoubleQuoted(sessionId)}"`;
  }

  modelTiers(): Record<'cheap' | 'standard' | 'premium', string> {
    return { ...AGY_MODEL_FOR_TIER };
  }

  modelForTier(tier: 'cheap' | 'standard' | 'premium'): string {
    return AGY_MODEL_FOR_TIER[tier];
  }

  modelFlag(model: string): string {
    return '';
  }

  agentDirectories(agentName: string): { project: string; home: string } {
    const rel = `.gemini/antigravity-cli/agents/${agentName}.md`;
    return { project: rel, home: rel };
  }

  transformAgent(content: string, relPath: string): string {
    return transformAgentForAgy(content, relPath);
  }

  agentNameFlag(agentName: string): string {
    return `--agent "${escapeDoubleQuoted(agentName)}"`;
  }

  classifyError(output: string): PromptErrorCategory {
    return classifyPromptError(output);
  }

  permissionConfigPaths(agent?: Agent): string[] {
    const id = agent ? `fleet-${agent.id}` : 'fleet-default';
    return [`~/.gemini/config/projects/${id}.json`];
  }

  composePermissionConfig(
    _role: 'doer' | 'reviewer',
    allow: string[] = [],
    agent?: Agent,
    isGit = true,
  ): Array<Record<string, unknown> | string> {
    const agyAllow = formatAgyPermissionRules(convertClaudeAllowToAgyPermissions(allow));
    const workFolder = agent ? agent.workFolder.replace(/\\/g, '/').replace(/\/+$/, '') : '';
    const id = agent ? `fleet-${agent.id}` : 'fleet-default';
    const uri = `file://${workFolder}`;

    const resource = isGit
      ? { gitFolder: { folderUri: uri, allowWrite: true } }
      : { folderUri: uri };

    return [{
      id,
      name: workFolder,
      projectResources: {
        resources: [resource],
      },
      permissionGrants: {
        allow: agyAllow,
      },
    }];
  }

  /**
   * Sweeps ~/.gemini/config/projects/*.json on the member machine and deletes any
   * duplicate or stale project config file that claims the same workspace URI but
   * does not match fleet-${agent.id}.json. This prevents AGY from picking the wrong
   * project config or encountering conflicting permissions.
   */
  async purgeConflictingProjects(
    agent: Agent,
    execCommand: WorkspaceTrustExecFn,
    memberHomeDir?: string | null,
  ): Promise<string[]> {
    const normFolder = agent.workFolder.replace(/\\/g, '/').replace(/\/+$/, '');
    const targetUri = `file://${normFolder}`;
    const keepId = `fleet-${agent.id}`;

    const purgeScript = `const fs = require('fs'); const path = require('path'); const home = ${memberHomeDir ? JSON.stringify(memberHomeDir) : 'process.env.HOME || process.env.USERPROFILE'}; const dir = path.join(home, '.gemini', 'config', 'projects'); if (!fs.existsSync(dir)) { console.log('[]'); process.exit(0); } const targetUri = ${JSON.stringify(targetUri)}; const keepId = ${JSON.stringify(keepId)}; const files = fs.readdirSync(dir); const purged = []; for (const file of files) { if (!file.endsWith('.json') || file === keepId + '.json') continue; try { const raw = fs.readFileSync(path.join(dir, file), 'utf8'); const content = JSON.parse(raw); const resList = content.projectResources?.resources || []; let matches = false; for (const r of resList) { const uri = r.gitFolder?.folderUri || r.folderUri; if (uri && uri.replace(/\\/+$/, '') === targetUri) { matches = true; break; } } if (matches) { fs.unlinkSync(path.join(dir, file)); purged.push(file); } } catch (e) {} } console.log(JSON.stringify(purged));`;

    const cmd = `node -e ${JSON.stringify(purgeScript)}`;
    const result = await execCommand(cmd, 10000);
    if (result.code === 0 && result.stdout) {
      try {
        const purged = JSON.parse(result.stdout.trim());
        if (Array.isArray(purged) && purged.length > 0) {
          logWarn('agy', `Purged ${purged.length} conflicting project configs for ${normFolder}: ${purged.join(', ')}`);
          return purged;
        }
      } catch {}
    }
    return [];
  }

  async preparePermissionsDelivery(
    agent: Agent,
    execCommand: WorkspaceTrustExecFn,
    memberHomeDir?: string | null,
  ): Promise<void> {
    await this.purgeConflictingProjects(agent, execCommand, memberHomeDir);
  }

  supportsOAuthCopy(): boolean {
    return false;
  }

  supportsApiKey(): boolean {
    return true;
  }

  oauthCredentialFiles(): Array<{ localPath: string; remotePath: string }> | null {
    return [
      { localPath: '~/.gemini/oauth_creds.json', remotePath: '~/.gemini/oauth_creds.json' },
      { localPath: '~/.gemini/google_accounts.json', remotePath: '~/.gemini/google_accounts.json' },
    ];
  }

  oauthSettingsMerge(): Record<string, unknown> | null {
    return null;
  }

  oauthEnvVarsToUnset(): string[] {
    return ['ANTIGRAVITY_API_KEY'];
  }

  authEnvVarForToken(token: string): string {
    return 'ANTIGRAVITY_API_KEY';
  }

  wrapWindowsPrompt(setupCmd: string, filePath: string, argList: string, sessionId?: string, model?: string, tier?: 'cheap' | 'standard' | 'premium'): string {
    // Write per-workspace model override before launching agy (mirrors buildPromptCommand).
    const resolvedTier = tier ?? this.resolveTierFromModel(model);
    const displayModel = getModelOverride('agy', resolvedTier) ?? AGY_MODEL_FOR_TIER[resolvedTier];

    let cmd = `${setupCmd}Write-Output "FLEET_PID:$pid"; ${filePath} --model "${escapeDoubleQuoted(displayModel)}" ${argList}`;

    // After agy exits, read its conversation transcript via the installed helper script.
    // Since wrapWindowsPrompt doesn't receive folder directly, pass empty string for argv[2]
    // so the script falls back gracefully (UUID lookup still works when agy honors --conversation).
    const transcriptScript = `${SCRIPTS_WIN}\\agy-transcript-reader.js`;
    const convArg = sessionId ? `"${escapeDoubleQuoted(sessionId)}"` : '""';
    cmd += `; node "${transcriptScript}" ${convArg} ""`;

    return cmd;
  }

  jsonOutputFlag(): string {
    return '--output-format json';
  }

  headlessInvocation(promptLiteral: string): string {
    return `-p "${promptLiteral}"`;
  }

  async registerMcpEndpoint(opts: RegisterMcpEndpointOptions): Promise<RegisterMcpEndpointResult> {
    // AGY has no `agy mcp` CLI verb (`agy help` lists: changelog, help, install, models,
    // plugin(s), update -- no mcp verb) and no project/user scope distinction -- it reads
    // MCP server config from a single centralized, machine-global file. See
    // docs/member-onboarding-journey.md section 3a for the live-verified investigation.
    // Merge under mcpServers.<name>, preserving any sibling entries (mirrors the
    // uninstall-time precision-cleanup pattern in src/cli/uninstall.ts).
    const configDir = path.join(os.homedir(), '.gemini', 'config');
    const configFile = path.join(configDir, 'mcp_config.json');
    fs.mkdirSync(configDir, { recursive: true });

    let settings: Record<string, unknown> = {};
    if (fs.existsSync(configFile)) {
      try {
        settings = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
      } catch {
        // malformed file -- start fresh rather than write on top of unparseable state
        settings = {};
      }
    }

    const mcpServers = (settings.mcpServers as Record<string, unknown> | undefined) ?? {};
    mcpServers['apra-fleet-member'] = {
      type: 'http',
      url: opts.url,
      headers: { Authorization: `Bearer ${opts.token}` },
    };
    settings.mcpServers = mcpServers;

    fs.writeFileSync(configFile, JSON.stringify(settings, null, 2) + '\n');

    return {
      mechanism: 'config-file-merge',
      detail: `merged apra-fleet-member into ${configFile} (mcpServers.apra-fleet-member)`,
    };
  }

  async ensureWorkspaceTrusted(
    workFolder: string,
    execCommand: WorkspaceTrustExecFn,
    agentOs: 'linux' | 'macos' | 'windows' = 'linux',
    shell?: MemberShell,
    transport?: WorkspaceTrustTransport,
  ): Promise<EnsureWorkspaceTrustedResult> {
    const normFolder = workFolder.replace(/\\/g, '/').replace(/\/+$/, '');
    const usePosix = isPosixShell(agentOs, shell);
    const isWindows = !usePosix;
    const baseHome = isWindows ? '$env:USERPROFILE' : '$HOME';
    const homeRel = isWindows
      ? '.gemini\\antigravity-cli\\settings.json'
      : '.gemini/antigravity-cli/settings.json';
    const homeFile = isWindows
      ? `${baseHome}\\${homeRel}`
      : `${baseHome}/${homeRel}`;
    const settingsDir = isWindows
      ? `${baseHome}\\.gemini\\antigravity-cli`
      : `${baseHome}/.gemini/antigravity-cli`;

    let settings: Record<string, unknown> = {};

    let transportReadAttempted = false;
    if (transport?.readHomeFile) {
      try {
        const readRes = await transport.readHomeFile(homeRel);
        if (readRes !== undefined) {
          transportReadAttempted = true;
          if (readRes.found && readRes.content) {
            const parsed = JSON.parse(readRes.content.trim());
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              settings = parsed;
            }
          }
        }
      } catch {}
    }

    if (!transportReadAttempted) {
      const readCmd = isWindows
        ? `Get-Content -Raw "${homeFile}" -ErrorAction SilentlyContinue`
        : `cat "${homeFile}" 2>/dev/null || true`;

      const readResult = await execCommand(readCmd, 5000);
      try {
        const parsed = JSON.parse(readResult.stdout.trim());
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          settings = parsed;
        }
      } catch {
        // missing or invalid JSON
      }
    }

    const trusted = Array.isArray(settings.trustedWorkspaces)
      ? (settings.trustedWorkspaces as string[])
      : [];

    if (trusted.includes(normFolder)) {
      return { seeded: false, detail: `agy: workspace "${normFolder}" already in trustedWorkspaces` };
    }

    const updatedTrusted = [...trusted, normFolder];
    settings.trustedWorkspaces = updatedTrusted;
    const contentStr = JSON.stringify(settings, null, 2);

    let deliveredViaTransport = false;
    if (transport?.writeHomeFile) {
      try {
        await transport.writeHomeFile(homeRel, contentStr);
        deliveredViaTransport = true;
      } catch (err) {
        logWarn('agy', `transport.writeHomeFile failed: ${err}`);
      }
    }

    if (!deliveredViaTransport) {
      const mkdirCmd = isWindows
        ? `if (-not (Test-Path "${settingsDir}")) { New-Item -ItemType Directory -Force "${settingsDir}" }`
        : `mkdir -p "${settingsDir}"`;
      await execCommand(mkdirCmd, 5000);

      const writeCmd = isWindows
        ? `[System.IO.File]::WriteAllText("${homeFile}", '${contentStr.replace(/'/g, "''")}', (New-Object System.Text.UTF8Encoding($false)))`
        : `cat > "${homeFile}" << 'FLEET_AGY_SETTINGS_EOF'\n${contentStr}\nFLEET_AGY_SETTINGS_EOF`;

      const writeResult = await execCommand(writeCmd, 5000);
      if (writeResult.code !== 0) {
        throw new Error(`agy: failed to write trustedWorkspaces to settings.json (exit ${writeResult.code})`);
      }
    }

    return { seeded: true, detail: `agy: added "${normFolder}" to trustedWorkspaces in settings.json` };
  }
}

export interface AgyPermissionRule {
  action: 'command' | 'read_file' | 'write_file' | 'mcp' | 'read_url' | 'execute_url' | 'custom' | 'invoke_subagent' | 'send_message';
  target: string;
}

/** The ONLY actions AGY accepts in `permissions.allow`. Taken verbatim from the
 *  CLI's own validation regex (agy 1.2.8):
 *    ^(command|read_file|write_file|read_url|mcp|execute_url|unsandboxed)\s*\(.*\)$
 *  `custom`, `invoke_subagent` and `send_message` are NOT permission actions --
 *  the latter two are AGY *tool* names with no permission gate of their own --
 *  so rules carrying them are dropped at serialization time rather than written
 *  as entries AGY would reject. */
const AGY_PERMISSION_ACTIONS = new Set(['command', 'read_file', 'write_file', 'read_url', 'mcp', 'execute_url', 'unsandboxed']);

/**
 * Render structured rules into the ONLY shape AGY's permission parser
 * accepts: a flat array of `action(target)` STRINGS in permissionGrants.allow.
 *
 * Before this, fleet wrote the `{ action, target }` objects straight through.
 * AGY silently ignored every one of them, so a headless `-p` dispatch behaved
 * as if the member had no grants at all and died on the first tool call with
 * "a tool required the \"command\" permission that headless mode cannot prompt
 * for, so it was auto-denied" -- the failure this function exists to prevent.
 *
 * Rules whose action is outside AGY's vocabulary are dropped with a warning:
 * writing entries its parser rejects causes validation failure.
 * The dropped tokens are already surfaced by
 * convertClaudeAllowToAgyPermissions' own warnings for manual escalation.
 */
export function formatAgyPermissionRules(rules: AgyPermissionRule[]): string[] {
  const out: string[] = [];
  for (const rule of rules) {
    if (!AGY_PERMISSION_ACTIONS.has(rule.action)) {
      console.warn(`[agy] dropping permission rule "${rule.action}(${rule.target})": AGY's permissions.allow accepts only ${[...AGY_PERMISSION_ACTIONS].join(', ')}.`);
      continue;
    }
    const entry = `${rule.action}(${rule.target})`;
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

const PATH_SCOPED_READ_RE = /^(?:Read|Glob|Grep)\((.+)\)$/;
const PATH_SCOPED_WRITE_RE = /^(?:Write|Edit)\((.+)\)$/;

/** Reduces a Claude path pattern to the directory PREFIX form AGY's
 *  read_file/write_file targets use: trailing '/**', '/*' and a bare '*' tail
 *  are dropped, since AGY already matches by prefix. */
function agyPathTarget(item: string): string {
  const inner = item.slice(item.indexOf('(') + 1, -1).trim();
  const stripped = inner.replace(/\/\*{1,2}$/, '').replace(/\*+$/, '');
  const trimmed = stripped.replace(/\/+$/, '');
  return trimmed || '*';
}

export function convertClaudeAllowToAgyPermissions(allow: string[]): AgyPermissionRule[] {
  const rules: AgyPermissionRule[] = [];
  const added = new Set<string>();

  const addRule = (action: AgyPermissionRule['action'], target: string) => {
    const key = `${action}:${target}`;
    if (!added.has(key)) {
      added.add(key);
      rules.push({ action, target });
    }
  };

  for (const item of allow) {
    if (item === 'Read' || item === 'Glob' || item === 'Grep') {
      addRule('read_file', '*');
    } else if (item === 'Write' || item === 'Edit') {
      addRule('write_file', '*');
    } else if (PATH_SCOPED_READ_RE.test(item)) {
      // Path-scoped Claude grant, e.g. Read(/home/u/.claude/skills/**). AGY
      // targets are path PREFIXES (`read_file(/Users/alice/notes)`), so the
      // trailing glob is stripped; a bare `Read`/`Write` (no argument) is
      // unrestricted in Claude and keeps mapping to '*' above.
      addRule('read_file', agyPathTarget(item));
    } else if (PATH_SCOPED_WRITE_RE.test(item)) {
      addRule('write_file', agyPathTarget(item));
    } else if (item === 'Agent') {
      addRule('invoke_subagent', '*');
      addRule('send_message', '*');
    } else if (item.startsWith('Bash(')) {
      const match = item.match(/^Bash\(([^:*]+)(?::|\s|\*|\))/);
      if (match && match[1]) {
        const cmdName = match[1].trim();
        addRule('command', cmdName === '*' ? '*' : cmdName);
      } else {
        addRule('command', '*');
      }
    } else if (item === 'Bash') {
      addRule('command', '*');
    } else if (item.startsWith('Mcp(')) {
      const match = item.match(/^Mcp\(([^)]+)\)/);
      addRule('mcp', match ? match[1] : '*');
    } else if (item === 'Mcp') {
      addRule('mcp', '*');
    } else if (item.startsWith('mcp__')) {
      // Claude's real MCP permission-string format is `mcp__<server>__<tool>`
      // (e.g. "mcp__apra-fleet__kb_capture") -- NOT the fictional `Mcp(name)`
      // shape above. AGY expresses the SAME per-tool granularity as
      // `mcp(<server>/<tool>)` (its own docs: "mcp(<server_name>/<tool_name>)
      // e.g. mcp(buganizer/get_bugs)", and a denial reads
      // `user denied permission for mcp(apra-fleet/kb_session_prime)`), so the
      // two map across exactly, with no widening.
      //
      // This previously refused to map at all, on the belief that AGY was
      // server-granular only -- which WOULD have been a privilege escalation,
      // since the 'apra-fleet' server colocates safe read-only KB tools with
      // destructive fleet-admin ones (remove_member, shutdown_server,
      // credential_store_*; see src/services/tool-registry.ts). That belief is
      // wrong for AGY 1.2.8, and the cost of the workaround was real: the
      // deployer's Step 0 kb_session_prime was auto-denied in headless mode,
      // taking the whole Deploy phase down with it. Note what is NOT done here:
      // a bare server-level `mcp(apra-fleet)` is still never emitted.
      const rest = item.slice('mcp__'.length);
      const sep = rest.indexOf('__');
      if (sep < 0) {
        console.warn(`[agy] warning: unmapped mcp permission token "${item}" (expected mcp__<server>__<tool>)`);
        addRule('custom', item);
      } else {
        addRule('mcp', `${rest.slice(0, sep)}/${rest.slice(sep + 2)}`);
      }
    } else if (item === 'Web' || item === 'Fetch' || item === 'WebSearch') {
      addRule('read_url', '*');
    } else {
      console.warn(`[agy] warning: unmapped permission token "${item}"`);
      addRule('custom', item);
    }
  }

  return rules;
}
