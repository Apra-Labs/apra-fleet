import type { ProviderAdapter, PromptOptions, ParsedResponse } from './provider.js';
import type { LlmProvider, SSHExecResult } from '../types.js';
import type { PromptErrorCategory } from '../utils/prompt-errors.js';
import { classifyPromptError } from '../utils/prompt-errors.js';
import { escapeDoubleQuoted } from '../os/os-commands.js';
import { stripAnsi } from '../utils/ansi.js';

const AGY_MODEL_FOR_TIER: Record<'cheap'|'standard'|'premium', string> = {
  cheap:    'Gemini 3.5 Flash (Medium)',
  standard: 'Gemini 3.1 Pro (Low)',
  premium:  'Claude Opus 4.6 (Thinking)',
};

// NODE_TRANSCRIPT_SCRIPT: tries two strategies to locate the agy transcript.
// 1. Direct UUID lookup: brain/<convId>/...transcript.jsonl (when agy honors --conversation)
// 2. Folder-based lookup: last_conversations.json[workFolder] (when agy ignores --conversation
//    and registers under its work folder, which happens for local members in a git repo)
// argv[1] = conversation UUID that fleet minted and passed via --conversation
// argv[2] = work folder path (Windows absolute path) for the fallback lookup
const NODE_TRANSCRIPT_SCRIPT = `const fs=require(\`fs\`),path=require(\`path\`);try{const home=process.env.USERPROFILE||process.env.HOME||\`\`;const convId=process.argv[1];const workDir=process.argv[2]||"";function readTranscript(id){const tp=path.join(home,\`.gemini\`,\`antigravity-cli\`,\`brain\`,id,\`.system_generated\`,\`logs\`,\`transcript.jsonl\`);if(fs.existsSync(tp)){console.log(\`FLEET_TRANSCRIPT_START\`);console.log(fs.readFileSync(tp,\`utf8\`));console.log(\`FLEET_TRANSCRIPT_END\`);return true;}return false;}if(convId&&readTranscript(convId)){process.exit(0);}const cachePath=path.join(home,\`.gemini\`,\`antigravity-cli\`,\`cache\`,\`last_conversations.json\`);if(workDir&&fs.existsSync(cachePath)){const cache=JSON.parse(fs.readFileSync(cachePath,\`utf8\`));const norm=p=>path.resolve(p).toLowerCase().split(path.sep).join(\`/\`);const target=norm(workDir);for(const k of Object.keys(cache)){if(norm(k)===target){if(readTranscript(cache[k])){process.exit(0);}break;}}console.log(\`FLEET_TRANSCRIPT_MISSING:NOT_IN_CACHE:\`+target);}else{console.log(\`FLEET_TRANSCRIPT_MISSING:\`+(convId||\`NO_ID\`));}}catch(e){console.log(\`FLEET_TRANSCRIPT_ERROR:\`+e.message);}`;

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
    return 'npm install -g @google/antigravity-cli';
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
    const { folder, promptFile, sessionId, resuming, unattended, inv, model } = opts;
    const escapedFolder = escapeDoubleQuoted(folder);
    let instruction = `Your task is described in ${promptFile} in the current directory. Read that file first, then execute the task.`;
    if (inv) {
      instruction = `[${inv}] ${instruction}`;
    }

    // Write per-workspace model override before launching agy.
    // The node -e snippet runs on the target machine (works for both local and remote).
    const tier = this.resolveTierFromModel(model);
    const displayModel = AGY_MODEL_FOR_TIER[tier];
    const modelWriteScript = `const p=require(\`path\`),f=require(\`fs\`);const sp=p.join(\`.gemini\`,\`antigravity-cli\`,\`settings.json\`);f.mkdirSync(p.dirname(sp),{recursive:true});let s={};try{s=JSON.parse(f.readFileSync(sp,\`utf8\`));}catch{}s.model=\`${displayModel}\`;f.writeFileSync(sp,JSON.stringify(s,null,2)+\`\\n\`);`;

    let cmd = `cd "${escapedFolder}" && node -e '${modelWriteScript}' && agy -p "${instruction}"`;

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
    // Pass both the UUID (argv[1]) and the work folder (argv[2]) so the script can
    // try UUID lookup first, then fall back to folder-based lookup in last_conversations.json.
    const convArg = sessionId ? `"${escapeDoubleQuoted(sessionId)}"` : '""';
    const folderArg = `"${escapeDoubleQuoted(folder)}"`;
    cmd += `; node -e '${NODE_TRANSCRIPT_SCRIPT}' ${convArg} ${folderArg}`;

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

  wrapWindowsPrompt(setupCmd: string, filePath: string, argList: string, sessionId?: string): string {
    let cmd = `${setupCmd}Write-Output "FLEET_PID:$pid"; ${filePath} ${argList}`;

    // After agy exits, read its conversation transcript (primary output channel --
    // agy writes LLM responses to CONOUT$, not stdout). Try UUID lookup first,
    // then fall back to folder-based lookup via last_conversations.json.
    // Extract work folder from argList: it appears after --add-dir or in setupCmd's cd.
    // Since wrapWindowsPrompt doesn't receive folder directly, pass empty string for argv[2]
    // so the script falls back gracefully (UUID lookup still works when agy honors --conversation).
    const convArg = sessionId ? `"${escapeDoubleQuoted(sessionId)}"` : '""';
    cmd += `; node -e '${NODE_TRANSCRIPT_SCRIPT}' ${convArg} ""`;

    return cmd;
  }

  jsonOutputFlag(): string {
    return '';
  }

  headlessInvocation(promptLiteral: string): string {
    return `-p "${promptLiteral}"`;
  }
}
