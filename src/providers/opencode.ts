import type { ProviderAdapter, PromptOptions, ParsedResponse, RegisterMcpEndpointOptions, RegisterMcpEndpointResult, WorkspaceTrustExecFn, EnsureWorkspaceTrustedResult, SessionIdStrategy, TargetOS } from './provider.js';
import { joinForOS, resolveHomeDir } from './provider.js';
import type { LlmProvider, SSHExecResult } from '../types.js';
import type { PromptErrorCategory } from '../utils/prompt-errors.js';
import { escapeDoubleQuoted } from '../os/os-commands.js';
import type { MemberShell } from '../os/os-commands.js';
import { logWarn } from '../utils/log-helpers.js';
import { sanitizeSessionId } from '../os/os-commands.js';
import { transformAgentForOpenCode } from '../cli/agent-transform.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
    if (/rate limit|\b429\b/i.test(output)) return 'overloaded';
    return 'unknown';
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
  // would be all-or-nothing at the SERVER level via registerMcpEndpoint's
  // `mcp.apra-fleet-member` registration (unconditionally enabled, no per-tool gate) --
  // not by this permission map. NOTE: registerMcpEndpoint is currently unreachable for
  // every provider (its one caller in register-member.ts is gated behind
  // interactiveBootstrapEnabled(), hardcoded to return false, and behind
  // memberProvider === 'claude' besides), so no MCP server is actually registered this
  // way for anyone today -- this comment describes the mechanism's shape, not a live
  // path. Either way, this is a genuine platform limitation, not a gap to fix here; do
  // not add MCP entries to the returned permission object, they would not be understood
  // by OpenCode's schema.
  composePermissionConfig(role: 'doer' | 'reviewer', _allow: string[] = []): Array<Record<string, unknown> | string> {
    if (role === 'doer') {
      return [{ permission: { edit: 'allow', write: 'allow', bash: 'allow' } }];
    }
    return [{ permission: { edit: 'deny', write: 'allow', bash: 'allow' } }];
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

  async registerMcpEndpoint(opts: RegisterMcpEndpointOptions): Promise<RegisterMcpEndpointResult> {
    // OpenCode has no non-interactive registration verb for token-based auth --
    // `opencode mcp auth <server>` is for interactive OAuth entry only, not a
    // pre-minted bearer token from the hub/local server. Its native config file
    // (opencode.json) supports remote MCP servers with bearer-auth headers
    // natively: { type: 'remote', url, headers: { Authorization: 'Bearer ...' } }.
    // Live-verified: a local HTTP listener confirmed OpenCode sends the
    // Authorization header exactly as configured (see docs/member-onboarding-journey.md
    // 3a and apra-fleet-fnz.3). Read-modify-write, same shape as AGY, scoped by
    // `opts.scope`: 'project' writes workFolder/opencode.json, 'user' writes the
    // global ~/.config/opencode/opencode.json.
    const configFile = opts.scope === 'project'
      ? path.join(opts.workFolder, 'opencode.json')
      : path.join(os.homedir(), '.config', 'opencode', 'opencode.json');

    fs.mkdirSync(path.dirname(configFile), { recursive: true });

    let settings: Record<string, unknown> = {};
    if (fs.existsSync(configFile)) {
      try {
        settings = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
      } catch {
        // malformed file -- start fresh rather than write on top of unparseable state
        settings = {};
      }
    }

    const mcp = (settings.mcp as Record<string, unknown> | undefined) ?? {};
    mcp['apra-fleet-member'] = {
      type: 'remote',
      url: opts.url,
      enabled: true,
      headers: { Authorization: `Bearer ${opts.token}` },
    };
    settings.mcp = mcp;

    fs.writeFileSync(configFile, JSON.stringify(settings, null, 2) + '\n');

    return {
      mechanism: 'config-file-merge',
      detail: `merged apra-fleet-member into ${configFile} (mcp.apra-fleet-member, remote+bearer-auth headers)`,
    };
  }

  async ensureWorkspaceTrusted(_workFolder: string, _execCommand: WorkspaceTrustExecFn, _agentOs?: 'linux' | 'macos' | 'windows'): Promise<EnsureWorkspaceTrustedResult> {
    // apra-fleet-eft.40 provider trust matrix: OpenCode has a first-run trust/onboarding
    // gate too (docs/opencode-exploration.md:92-97), but it is ALREADY handled via the
    // validated --dangerously-skip-permissions flag on `opencode run` (same doc, checklist
    // item 1). No-op.
    return { seeded: false, detail: 'opencode: trust gate already bypassed via --dangerously-skip-permissions on opencode run' };
  }
}
