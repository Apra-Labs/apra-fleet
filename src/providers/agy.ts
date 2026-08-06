import type { ProviderAdapter, PromptOptions, ParsedResponse, RegisterMcpEndpointOptions, RegisterMcpEndpointResult, WorkspaceTrustExecFn, EnsureWorkspaceTrustedResult } from './provider.js';
import type { LlmProvider, SSHExecResult } from '../types.js';
import type { PromptErrorCategory } from '../utils/prompt-errors.js';
import { classifyPromptError } from '../utils/prompt-errors.js';
import { escapeDoubleQuoted } from '../os/os-commands.js';
import { stripAnsi } from '../utils/ansi.js';
import { getModelOverride } from '../services/user-config.js';
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

    if (unattended === 'dangerous') {
      cmd += ' --dangerously-skip-permissions';
    }

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
        .replace(/^FLEET_PID:\d+\r?\n/m, '')
        .replace(/^FLEET_SESSION_ID:[^\r\n]+\r?\n/m, '')
        .trim();

      const jsonMatch = strippedForJson.match(/\{[\s\S]*"conversation_id"[\s\S]*\}/);
      if (jsonMatch) {
        const parsedObj = JSON.parse(jsonMatch[0]) as {
          conversation_id?: string;
          status?: string;
          response?: string;
          error?: string;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            thinking_tokens?: number;
            cache_read_tokens?: number;
            total_tokens?: number;
          };
        };

        const convId = parsedObj.conversation_id && parsedObj.conversation_id.trim()
          ? parsedObj.conversation_id.trim()
          : undefined;

        const resultText = (parsedObj.response && parsedObj.response.trim()
          ? parsedObj.response.trim()
          : (parsedObj.error ?? '').trim());
        const isError = result.code !== 0 || parsedObj.status === 'ERROR';

        return {
          result: resultText,
          sessionId: convId ?? extractedSessionId,
          isError,
          raw,
          usage: parsedObj.usage ? {
            input_tokens: parsedObj.usage.input_tokens ?? 0,
            output_tokens: parsedObj.usage.output_tokens ?? 0,
          } : undefined,
        };
      }
    } catch { /* fallthrough to transcript/ANSI extraction */ }

    // Secondary path: transcript marker section
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
        } catch { /* skip */ }
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

    // Fallback: ANSI-strip stdout
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

  resumeFlag(sessionId?: string, resuming?: boolean): string {
    if (!sessionId || !resuming) return '';
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
    const resolvedTier = tier ?? this.resolveTierFromModel(model);
    const displayModel = getModelOverride('agy', resolvedTier) ?? AGY_MODEL_FOR_TIER[resolvedTier];
    return `${setupCmd}Write-Output "FLEET_PID:$pid"; ${filePath} --model "${escapeDoubleQuoted(displayModel)}" --output-format json ${argList}`;
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
