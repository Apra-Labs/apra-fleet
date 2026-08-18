import type { ProviderAdapter, PromptOptions, ParsedResponse, RegisterMcpEndpointOptions, RegisterMcpEndpointResult, WorkspaceTrustExecFn, EnsureWorkspaceTrustedResult, SessionIdStrategy, TargetOS } from './provider.js';
import { joinForOS, resolveHomeDir } from './provider.js';
import type { LlmProvider, SSHExecResult } from '../types.js';
import type { PromptErrorCategory } from '../utils/prompt-errors.js';
import { classifyPromptError } from '../utils/prompt-errors.js';
import { escapeDoubleQuoted } from '../os/os-commands.js';
import { stripAnsi } from '../utils/ansi.js';
import { logWarn } from '../utils/log-helpers.js';
import { getModelOverride } from '../services/user-config.js';
import { transformAgentForAgy } from '../cli/agent-transform.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const AGY_MODEL_FOR_TIER: Record<'cheap'|'standard'|'premium', string> = {
  cheap:    'Gemini 3.5 Flash (Medium)',
  standard: 'Gemini 3.1 Pro (Low)',
  premium:  'Claude Opus 4.6 (Thinking)',
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

  installCommand(os: 'linux' | 'macos' | 'windows'): string {
    if (os === 'windows') {
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

    let cmd = `cd "${escapedFolder}" && agy --model "${escapeDoubleQuoted(displayModel)}" --output-format json`;
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

    if (unattended === 'auto' || unattended === 'dangerous') {
      if (unattended === 'auto') {
        logWarn('agy', "WARNING: unattended='auto' is not supported for AGY -- falling back to --dangerously-skip-permissions (no classifier safety). Ensure deny rules are configured.");
      }
      cmd += ' --dangerously-skip-permissions';
    }

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

  permissionModeAutoFlag(): string | null {
    return null;
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

  supportsResume(): boolean {
    return true;
  }

  supportsMaxTurns(): boolean {
    return false;
  }

  sessionIdStrategy(): SessionIdStrategy {
    return { type: 'provider-minted' };
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
    return {
      cheap: 'gemini-3.5-flash-lite',
      standard: 'gemini-3.5-flash',
      premium: 'claude-sonnet-4.6',
    };
  }

  modelForTier(tier: 'cheap' | 'standard' | 'premium'): string {
    if (tier === 'cheap') return 'gemini-3.5-flash-lite';
    if (tier === 'premium') return 'claude-sonnet-4.6';
    return 'gemini-3.5-flash';
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

  permissionConfigPaths(): string[] {
    return ['.gemini/antigravity-cli/settings.json'];
  }

  composePermissionConfig(_role: 'doer' | 'reviewer', allow: string[] = []): Array<Record<string, unknown> | string> {
    const agyAllow = convertClaudeAllowToAgyPermissions(allow);
    return [{ permissions: { allow: agyAllow }, mcpServers: { 'apra-fleet': { disabled: true } }, skillOverrides: { pm: 'off', fleet: 'off' } }];
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

  async ensureWorkspaceTrusted(_workFolder: string, _execCommand: WorkspaceTrustExecFn, _agentOs?: 'linux' | 'macos' | 'windows'): Promise<EnsureWorkspaceTrustedResult> {
    // apra-fleet-eft.40 provider trust matrix: AGY has NO per-project trust concept -- its
    // config is machine-global (live-verified, docs/member-onboarding-journey.md section
    // 3a). No-op.
    return { seeded: false, detail: 'agy: no per-project trust concept -- machine-global config' };
  }
}

export interface AgyPermissionRule {
  action: 'command' | 'read_file' | 'write_file' | 'mcp' | 'read_url' | 'execute_url' | 'custom' | 'invoke_subagent' | 'send_message';
  target: string;
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
    } else if (item === 'Web' || item === 'Fetch' || item === 'WebSearch') {
      addRule('read_url', '*');
    } else {
      console.warn(`[agy] warning: unmapped permission token "${item}"`);
      addRule('custom', item);
    }
  }

  return rules;
}
