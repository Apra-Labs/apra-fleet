import type { OsCommands } from './os-commands.js';
import { escapeDoubleQuoted, escapeGrepPattern, sanitizeSessionId } from './os-commands.js';

const CLAUDE_PATH = 'export PATH="$HOME/.local/bin:$PATH" && ';

export class LinuxCommands implements OsCommands {
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

  scpCheck(): string {
    return 'which scp 2>/dev/null';
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
    const escaped = escapeDoubleQuoted(value);
    return [
      `echo 'export ${name}="${escaped}"' >> ~/.bashrc`,
      `echo 'export ${name}="${escaped}"' >> ~/.profile`,
      `export ${name}="${escaped}"`,
    ];
  }

  unsetEnv(name: string): string[] {
    return [
      `sed -i '/export ${name}=/d' ~/.bashrc 2>/dev/null || true`,
      `sed -i '/export ${name}=/d' ~/.profile 2>/dev/null || true`,
      `unset ${name}`,
    ];
  }

  envPrefix(name: string, value: string): string {
    return `${name}="${escapeDoubleQuoted(value)}"`;
  }

  // --- Shell ---

  shellWrap(command: string): string {
    return command;
  }

  // --- Prompt building ---

  buildPromptCommand(folder: string, b64Prompt: string, sessionId?: string): string {
    const escapedFolder = escapeDoubleQuoted(folder);
    let cmd = `cd "${escapedFolder}" && ${this.claudeCommand(`-p "$(echo '${b64Prompt}' | base64 -d)" --output-format json --max-turns 50`)}`;
    if (sessionId) {
      cmd += ` --resume "${sanitizeSessionId(sessionId)}"`;
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
