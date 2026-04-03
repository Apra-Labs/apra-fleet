import { execSync } from 'node:child_process';
import type { OsCommands, ProviderAdapter, PromptOptions } from './os-commands.js';
import { escapeDoubleQuoted, escapeGrepPattern, sanitizeSessionId } from './os-commands.js';
import { escapeShellArg } from '../utils/shell-escape.js';

const CLI_PATH = 'export PATH="$HOME/.local/bin:$PATH" && ';

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

  fleetProcessCheck(folder: string, sessionId?: string, processName?: string): string {
    const pname = processName ?? 'claude';
    // Use bracket trick to avoid pgrep matching its own grep process
    const bracketName = `[${pname[0]}]${pname.slice(1)}`;
    const folderPattern = escapeGrepPattern(folder);
    const fleetMatch = sessionId
      ? `grep -E "(${folderPattern}|${escapeGrepPattern(sanitizeSessionId(sessionId))})"`
      : `grep "${folderPattern}"`;

    return `AGENT_PIDS=$(pgrep -f "${bracketName}" 2>/dev/null); `
      + `if [ -z "$AGENT_PIDS" ]; then echo "idle"; `
      + `else CMDLINES=$(ps -o args= -p $AGENT_PIDS 2>/dev/null); `
      + `if echo "$CMDLINES" | ${fleetMatch} > /dev/null 2>&1; then echo "fleet-busy"; `
      + `else echo "other-busy"; fi; fi`;
  }

  // --- Generic agent CLI ---

  agentCommand(provider: ProviderAdapter, args: string): string {
    return `${CLI_PATH}${provider.cliCommand(args)}`;
  }

  agentVersion(provider: ProviderAdapter): string {
    return `${CLI_PATH}${provider.versionCommand()}`;
  }

  installAgent(provider: ProviderAdapter): string {
    return provider.installCommand('linux');
  }

  updateAgent(provider: ProviderAdapter): string {
    return `${CLI_PATH}${provider.updateCommand()}`;
  }

  buildAgentPromptCommand(provider: ProviderAdapter, opts: PromptOptions): string {
    const { folder } = opts;
    const escapedFolder = escapeDoubleQuoted(folder);
    const providerCmd = provider.buildPromptCommand(opts);
    // Provider command starts with `cd "folder" && <cli> ...`
    // Inject PATH prepend after the cd so the binary is findable
    const cdPrefix = `cd "${escapedFolder}" && `;
    if (providerCmd.startsWith(cdPrefix)) {
      return `${cdPrefix}${CLI_PATH}${providerCmd.slice(cdPrefix.length)}`;
    }
    return `${CLI_PATH}${providerCmd}`;
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

  apiKeyCheck(envVarName?: string): string {
    const varName = envVarName ?? 'ANTHROPIC_API_KEY';
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(varName)) throw new Error('Invalid env var name: ' + varName);
    return `bash -l -c 'echo "\${${varName}:0:10}"'`;
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
    return `printf '#!/bin/sh\\necho "protocol=https"\\necho "host=${escapedHost}"\\necho "username=${escapedUser}"\\necho "password=${escapedToken}"\\n' > ~/.fleet-git-credential && chmod 600 ~/.fleet-git-credential && chmod +x ~/.fleet-git-credential && git config --global --replace-all "credential.https://${escapedHost}.helper" "" && git config --global --add "credential.https://${escapedHost}.helper" ~/.fleet-git-credential`;
  }

  gitCredentialHelperRemove(host: string): string {
    const escapedHost = escapeDoubleQuoted(host);
    return `rm -f ~/.fleet-git-credential && git config --global --unset-all "credential.https://${escapedHost}.helper" 2>/dev/null || true`;
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

  // --- GPU activity ---

  gpuProcessCheck(): string {
    // Exits 2 if nvidia-smi not installed. If installed: outputs "busy" when GPU
    // compute processes are running, "idle" otherwise.
    return 'which nvidia-smi >/dev/null 2>&1 || exit 2; '
      + 'COUNT=$(nvidia-smi --query-compute-apps=pid --format=csv,noheader 2>/dev/null | wc -l | tr -d " "); '
      + '[ "${COUNT:-0}" -gt 0 ] && echo "busy" || echo "idle"';
  }

  gpuUtilization(): string {
    // Outputs GPU utilization % (0-100), or empty string if nvidia-smi not available.
    return 'nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d " "';
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
