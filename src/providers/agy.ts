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
    let instruction = `Your task is described in ${promptFile} in the current directory. Read that file first, then execute the task.`;
    if (inv) {
      instruction = `[${inv}] ${instruction}`;
    }


    // Write per-workspace model override before launching agy.
    const tier = inputTier ?? this.resolveTierFromModel(model);
    const displayModel = getModelOverride('agy', tier) ?? AGY_MODEL_FOR_TIER[tier];

    let cmd = `cd "${escapedFolder}" && agy --model "${escapeDoubleQuoted(displayModel)}"`;
    if (agentName) {
      cmd += ` --agent "${escapeDoubleQuoted(agentName)}"`;
    }
    cmd += ` -p "${instruction}"`;

    // Only pass --conversation when resuming an existing session. For fresh sessions,
    // agy ignores the UUID we pass and creates its own -- use folder lookup instead.
    if (sessionId && resuming) {
      cmd += ` --conversation "${escapeDoubleQuoted(sessionId)}"`;
    }

    if (unattended === 'dangerous') {
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

    // Primary path: extract response from the transcript JSONL that agy writes after
    // completing its task. This is more reliable than PTY/ANSI capture because agy
    // writes its LLM response to CONOUT$ (not stdout), but always writes a transcript file.
    const startMarker = 'FLEET_TRANSCRIPT_START';
    const endMarker = 'FLEET_TRANSCRIPT_END';
    const startIdx = raw.indexOf(startMarker);
    const endIdx = raw.indexOf(endMarker);

    if (startIdx !== -1 && endIdx !== -1) {
      const section = raw.substring(startIdx + startMarker.length, endIdx);
      const lines = section.split('\n').map(l => l.trim()).filter(Boolean);
      let lastResponse = '';
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as { type?: string; status?: string; content?: string };
          if (
            entry.type === 'PLANNER_RESPONSE' &&
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
          sessionId: undefined,
          isError: result.code !== 0,
          raw,
          usage: undefined,
        };
      }
    }

    // Fallback: ANSI-strip stdout (covers cases where transcript is missing or incomplete)
    console.error('[agy] warning: transcript markers not found -- falling back to raw ANSI-stripped output');
    const stripped = stripAnsi(raw)
      .replace(/^FLEET_PID:\d+\r?\n/m, '')
      .replace(/\r/g, '')
      .trim();
    return {
      result: stripped,
      sessionId: undefined,
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

  modelForTier(tier: 'cheap' | 'mid' | 'premium'): string {
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
    return [{ permissions: { allow }, mcpServers: { 'apra-fleet': { disabled: true } }, skillOverrides: { pm: 'off', fleet: 'off' } }];
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
    return '';
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
