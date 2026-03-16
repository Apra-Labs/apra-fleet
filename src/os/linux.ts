import { execSync } from 'node:child_process';
import type { OsCommands } from './os-commands.js';
import { escapeDoubleQuoted, escapeGrepPattern, sanitizeSessionId } from './os-commands.js';
import { escapeShellArg } from '../utils/shell-escape.js';

const CLAUDE_PATH = 'export PATH="$HOME/.local/bin:$PATH" && ';

export class LinuxCommands implements OsCommands {
  private cachedEnv: Record<string, string> | null = null;

  protected loginShell(): string { return 'bash'; }

  private getCleanEnv(): Record<string, string> {
    if (this.cachedEnv) return this.cachedEnv;
    // Rebuild a pristine env from system defaults + login profiles.
    // env -i strips everything; bash -l sources /etc/profile and ~/.profile
    // which reconstruct PATH etc. We seed HOME, USER, LOGNAME, SHELL so
    // profile scripts (like the ~/.local/bin guard) work correctly.
    const seed = ['HOME', 'USER', 'LOGNAME', 'SHELL']
      .filter(k => process.env[k])
      .map(k => `${k}=${escapeShellArg(process.env[k]!)}`)
      .join(' ');
    const script = `env -i ${seed} ${this.loginShell()} -l -c 'env -0'`;
    const raw = execSync(script, { encoding: 'utf-8' });
    const env: Record<string, string> = {};
    for (const entry of raw.split('\0')) {
      const idx = entry.indexOf('=');
      if (idx > 0) env[entry.slice(0, idx)] = entry.slice(idx + 1);
    }
    this.cachedEnv = env;
    return env;
  }

  // --- Resources ---

  cpuLoad(): string {
    return 'uptime';
  }

  memory(): string {
    return 'free -m';
  }

  disk(folder: string): string {
    return `df -h "${escapeDoubleQuoted(folder)}"`;
  }

  // --- Process check ---

  fleetProcessCheck(folder: string, sessionId?: string): string {
    const folderPattern = escapeGrepPattern(folder);
    const fleetMatch = sessionId
      ? `grep -E "(${folderPattern}|${escapeGrepPattern(sanitizeSessionId(sessionId))})"`
      : `grep "${folderPattern}"`;

    return `CLAUDE_PIDS=$(pgrep -f "[c]laude" 2>/dev/null); `
      + `if [ -z "$CLAUDE_PIDS" ]; then echo "idle"; `
      + `else CMDLINES=$(ps -o args= -p $CLAUDE_PIDS 2>/dev/null); `
      + `if echo "$CMDLINES" | ${fleetMatch} > /dev/null 2>&1; then echo "fleet-busy"; `
      + `else echo "other-busy"; fi; fi`;
  }

  // --- Claude CLI ---

  claudeCommand(args: string): string {
    return `${CLAUDE_PATH}claude ${args}`;
  }

  claudeVersion(): string {
    return this.claudeCommand('--version 2>&1');
  }

  claudeCheck(): string {
    return 'which claude 2>/dev/null';
  }

  installClaude(): string {
    return 'curl -fsSL https://claude.ai/install.sh | bash';
  }

  updateClaude(): string {
    return this.claudeCommand('update');
  }

  // --- Filesystem ---

  mkdir(folder: string): string {
    return `mkdir -p "${escapeDoubleQuoted(folder)}"`;
  }

  // --- Auth ---

  credentialFileCheck(): string {
    return 'test -f ~/.claude/.credentials.json && echo found || echo missing';
  }

  credentialFileWrite(json: string): string {
    const escaped = escapeDoubleQuoted(json);
    return `mkdir -p ~/.claude && printf '%s' "${escaped}" > ~/.claude/.credentials.json && chmod 600 ~/.claude/.credentials.json`;
  }

  credentialFileRemove(): string {
    return 'rm -f ~/.claude/.credentials.json';
  }

  apiKeyCheck(): string {
    return 'bash -l -c \'echo "${ANTHROPIC_API_KEY:0:10}"\'';
  }

  setEnv(name: string, value: string): string[] {
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(name)) throw new Error('Invalid env var name: ' + name);
    const escaped = escapeDoubleQuoted(value);
    return [
      `echo 'export ${name}="${escaped}"' >> ~/.bashrc`,
      `echo 'export ${name}="${escaped}"' >> ~/.profile`,
      `export ${name}="${escaped}"`,
    ];
  }

  unsetEnv(name: string): string[] {
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(name)) throw new Error('Invalid env var name: ' + name);
    return [
      `sed -i '/export ${name}=/d' ~/.bashrc 2>/dev/null || true`,
      `sed -i '/export ${name}=/d' ~/.profile 2>/dev/null || true`,
      `unset ${name}`,
    ];
  }

  envPrefix(name: string, value: string): string {
    return `${name}="${escapeDoubleQuoted(value)}"`;
  }

  // --- Git credential helper ---

  gitCredentialHelperWrite(host: string, username: string, token: string): string {
    const escapedHost = escapeDoubleQuoted(host);
    const escapedUser = escapeDoubleQuoted(username);
    const escapedToken = escapeDoubleQuoted(token);
    return `printf '#!/bin/sh\\necho "protocol=https"\\necho "host=${escapedHost}"\\necho "username=${escapedUser}"\\necho "password=${escapedToken}"\\n' > ~/.fleet-git-credential && chmod 600 ~/.fleet-git-credential && chmod +x ~/.fleet-git-credential && git config --global credential.helper ~/.fleet-git-credential`;
  }

  gitCredentialHelperRemove(): string {
    return 'rm -f ~/.fleet-git-credential && git config --global --unset credential.helper 2>/dev/null || true';
  }

  // --- SSH key deployment ---

  deploySSHPublicKey(publicKeyLine: string): string[] {
    const escaped = escapeShellArg(publicKeyLine);
    return [
      'mkdir -p ~/.ssh',
      'chmod 700 ~/.ssh',
      'touch ~/.ssh/authorized_keys',
      'chmod 600 ~/.ssh/authorized_keys',
      `echo ${escaped} >> ~/.ssh/authorized_keys`,
    ];
  }

  // --- Local exec ---

  cleanExec(command: string): { command: string; env?: Record<string, string>; shell?: string } {
    return { command, env: this.getCleanEnv() };
  }

  // --- Shell ---

  wrapInWorkFolder(folder: string, command: string): string {
    return `cd "${escapeDoubleQuoted(folder)}" && ${command}`;
  }

  // --- Prompt building ---

  buildPromptCommand(folder: string, b64Prompt: string, sessionId?: string, dangerouslySkipPermissions?: boolean, model?: string, maxTurns?: number): string {
    const escapedFolder = escapeDoubleQuoted(folder);
    const turns = maxTurns ?? 50;
    let cmd = `cd "${escapedFolder}" && ${this.claudeCommand(`-p "$(echo '${b64Prompt}' | base64 -d)" --output-format json --max-turns ${turns}`)}`;
    if (sessionId) {
      cmd += ` --resume "${sanitizeSessionId(sessionId)}"`;
    }
    if (dangerouslySkipPermissions) {
      cmd += ' --dangerously-skip-permissions';
    }
    if (model) {
      cmd += ` --model "${escapeDoubleQuoted(model)}"`;
    }
    return cmd;
  }

  // --- Resource output parsing ---

  parseMemory(stdout: string): string {
    const lines = stdout.trim().split('\n');
    const memLine = lines.find(l => l.startsWith('Mem:'));
    if (memLine) {
      const parts = memLine.split(/\s+/);
      return `${parts[2]} MB / ${parts[1]} MB`;
    }
    return stdout.trim();
  }

  parseDisk(stdout: string): string {
    const lines = stdout.trim().split('\n');
    if (lines.length >= 2) {
      return lines[1].trim();
    }
    return stdout.trim();
  }
}
