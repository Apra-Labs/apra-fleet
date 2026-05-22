import type { ProviderAdapter, PromptOptions, ParsedResponse } from './provider.js';
import type { LlmProvider, SSHExecResult } from '../types.js';
import type { PromptErrorCategory } from '../utils/prompt-errors.js';
import { classifyPromptError } from '../utils/prompt-errors.js';
import { escapeDoubleQuoted } from '../os/os-commands.js';
import { stripAnsi } from '../utils/ansi.js';

// NODE_TRANSCRIPT_SCRIPT_BY_UUID: accepts a conversation UUID as argv[1] and reads
// the transcript directly from brain/<uuid>/.system_generated/logs/transcript.jsonl.
// This is robust against agy switching its working directory (e.g. to scratch) because
// we look up the transcript by the UUID we minted and passed via --conversation, not by
// folder path via last_conversations.json.
const NODE_TRANSCRIPT_SCRIPT = `const fs = require(\`fs\`); const path = require(\`path\`); try { const home = process.env.USERPROFILE || process.env.HOME || \`\`; const convId = process.argv[1]; if (!convId) { console.log(\`FLEET_TRANSCRIPT_MISSING:NO_CONV_ID\`); process.exit(0); } const transPath = path.join(home, \`.gemini\`, \`antigravity-cli\`, \`brain\`, convId, \`.system_generated\`, \`logs\`, \`transcript.jsonl\`); if (fs.existsSync(transPath)) { console.log(\`FLEET_TRANSCRIPT_START\`); console.log(fs.readFileSync(transPath, \`utf8\`)); console.log(\`FLEET_TRANSCRIPT_END\`); } else { console.log(\`FLEET_TRANSCRIPT_MISSING:\` + convId); } } catch (e) { console.log(\`FLEET_TRANSCRIPT_ERROR:\` + e.message); }`;

export class AgyProvider implements ProviderAdapter {
  readonly name: LlmProvider = 'agy';
  readonly processName = 'agy';
  readonly authEnvVar = 'GEMINI_API_KEY';
  readonly credentialPath = '~/.gemini/antigravity-cli/settings.json';
  readonly instructionFileName = 'AGY.md';

  cliCommand(args: string): string {
    return `agy ${args}`;
  }

  versionCommand(): string {
    return 'agy --version 2>&1';
  }

  installCommand(os: 'linux' | 'macos' | 'windows'): string {
    return 'npm install -g @google/antigravity-cli';
  }

  updateCommand(): string {
    return 'agy update';
  }

  buildPromptCommand(opts: PromptOptions): string {
    const { folder, promptFile, sessionId, unattended, inv } = opts;
    const escapedFolder = escapeDoubleQuoted(folder);
    let instruction = `Your task is described in ${promptFile} in the current directory. Read that file first, then execute the task.`;
    if (inv) {
      instruction = `[${inv}] ${instruction}`;
    }

    let cmd = `cd "${escapedFolder}" && agy -p "${instruction}"`;

    // Always pass --conversation so fleet knows where the transcript will be written.
    if (sessionId) {
      cmd += ` --conversation "${escapeDoubleQuoted(sessionId)}"`;
    }

    if (unattended === 'dangerous') {
      cmd += ' --dangerously-skip-permissions';
    }

    // After agy exits, read its transcript from disk by conversation UUID (primary output
    // channel -- agy writes its response to CONOUT$, not stdout, so file I/O is required).
    // We pass the UUID we minted via --conversation so the lookup is robust even if agy
    // switches its working directory (e.g. to scratch) on launch.
    const convArg = sessionId ? `"${escapeDoubleQuoted(sessionId)}"` : '""';
    cmd += `; node -e '${NODE_TRANSCRIPT_SCRIPT}' ${convArg}`;

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
    if (!sessionId) return '';
    // Always pass --conversation so fleet knows where to read the transcript.
    // When resuming=true this continues an existing session; otherwise starts fresh
    // with a pre-minted UUID that fleet uses to locate the transcript after exit.
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
    return ['GEMINI_API_KEY'];
  }

  authEnvVarForToken(token: string): string {
    return 'GEMINI_API_KEY';
  }

  wrapWindowsPrompt(setupCmd: string, filePath: string, argList: string, sessionId?: string): string {
    let cmd = `${setupCmd}Write-Output "FLEET_PID:$pid"; ${filePath} ${argList}`;

    // After agy exits, read its conversation transcript by UUID (primary output channel --
    // agy writes LLM responses to CONOUT$, not stdout; the transcript file is the
    // reliable way to capture the response text). We look up the transcript directly
    // by the conversation UUID we passed via --conversation, bypassing last_conversations.json
    // which would fail if agy switches its working directory (e.g. to scratch) on launch.
    const convArg = sessionId ? `"${sessionId}"` : '""';
    cmd += `; node -e '${NODE_TRANSCRIPT_SCRIPT}' ${convArg}`;

    return cmd;
  }

  jsonOutputFlag(): string {
    return '';
  }

  headlessInvocation(promptLiteral: string): string {
    return `-p "${promptLiteral}"`;
  }
}
