import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuid } from 'uuid';
import type { Agent, SSHExecResult, TransferResult } from '../types.js';
import { getOsCommands } from '../os/index.js';
import { getAgentOS, setStoredPid, clearStoredPid } from '../utils/agent-helpers.js';
import { escapeDoubleQuoted, escapeWindowsArg } from '../utils/shell-escape.js';

/**
 * Scan stdout for a FLEET_PID:<pid> line, store the PID, and strip the line.
 * The PID wrapper always emits this as the first stdout line before LLM output.
 */
export function extractAndStorePid(agentId: string, result: SSHExecResult): SSHExecResult {
  const lines = result.stdout.split('\n');
  const idx = lines.findIndex(l => /^FLEET_PID:\d+\r?$/.test(l));
  if (idx === -1) return result;
  const pid = parseInt(lines[idx].replace(/\r$/, '').slice('FLEET_PID:'.length), 10);
  setStoredPid(agentId, pid);
  lines.splice(idx, 1);
  return { ...result, stdout: lines.join('\n') };
}

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MB
import { execCommand as sshExecCommand, testConnection as sshTestConnection, closeConnection as sshCloseConnection } from './ssh.js';
import { uploadFiles, downloadFiles } from './file-transfer.js';

export interface AgentStrategy {
  execCommand(command: string, timeoutMs?: number, maxTotalMs?: number): Promise<SSHExecResult>;
  transferFiles(localPaths: string[], destinationPath?: string): Promise<TransferResult>;
  receiveFiles(remotePaths: string[], localDestination: string): Promise<TransferResult>;
  /** Delete files relative to the agent's workFolder. Best-effort — errors are silently ignored. */
  deleteFiles(relativePaths: string[]): Promise<void>;
  testConnection(): Promise<{ ok: boolean; latencyMs: number; error?: string }>;
  close(): void;
}

class RemoteStrategy implements AgentStrategy {
  constructor(private agent: Agent) {}

  async execCommand(command: string, timeoutMs = 30000, maxTotalMs?: number): Promise<SSHExecResult> {
    return sshExecCommand(this.agent, command, timeoutMs, maxTotalMs);
  }

  async transferFiles(localPaths: string[], destinationPath?: string): Promise<TransferResult> {
    return uploadFiles(this.agent, localPaths, destinationPath);
  }

  async receiveFiles(remotePaths: string[], localDestination: string): Promise<TransferResult> {
    return downloadFiles(this.agent, remotePaths, localDestination);
  }

  async deleteFiles(relativePaths: string[]): Promise<void> {
    if (relativePaths.length === 0) return;
    const agentOs = getAgentOS(this.agent);
    const folder = this.agent.workFolder;
    try {
      if (agentOs === 'windows') {
        const files = relativePaths.map(p => `"${escapeWindowsArg(p)}"`).join(', ');
        const psScript = `Set-Location "${escapeWindowsArg(folder)}"; Remove-Item ${files} -Force -ErrorAction SilentlyContinue`;
        const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
        await this.execCommand(`powershell -EncodedCommand ${encoded}`, 10000);
      } else {
        const files = relativePaths.map(p => `"${escapeDoubleQuoted(p)}"`).join(' ');
        await this.execCommand(`cd "${escapeDoubleQuoted(folder)}" && rm -f ${files}`, 10000);
      }
    } catch { /* ignore — best-effort cleanup */ }
  }

  async testConnection(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    return sshTestConnection(this.agent);
  }

  close(): void {
    sshCloseConnection(this.agent);
  }
}

class LocalStrategy implements AgentStrategy {
  constructor(private agent: Agent) {}

  async execCommand(command: string, timeoutMs = 30000, maxTotalMs?: number): Promise<SSHExecResult> {
    let pidExtracted = false;
    const result = await new Promise<SSHExecResult>((resolve, reject) => {
      const cmds = getOsCommands(getAgentOS(this.agent));
      const { command: wrapped, env, shell } = cmds.cleanExec(command);
      const child = spawn(wrapped, { shell: shell ?? true, cwd: this.agent.workFolder, env, windowsHide: true });

      let settled = false;
      function settle(fn: () => void) {
        if (settled) return;
        settled = true;
        clearTimeout(inactivityTimer);
        if (maxTotalTimer) clearTimeout(maxTotalTimer);
        fn();
      }

      // Rolling inactivity timer — resets on each stdout/stderr data event
      let inactivityTimer: ReturnType<typeof setTimeout>;
      function resetInactivityTimer() {
        clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
          child.kill('SIGKILL'); // maps to TerminateProcess() on Windows via Node.js — intentional cross-platform
          settle(() => reject(new Error(`Command timed out after ${timeoutMs}ms of inactivity`)));
        }, timeoutMs);
        inactivityTimer.unref();
      }
      resetInactivityTimer();

      // Hard ceiling — never reset regardless of activity
      let maxTotalTimer: ReturnType<typeof setTimeout> | undefined;
      if (maxTotalMs !== undefined) {
        maxTotalTimer = setTimeout(() => {
          child.kill('SIGKILL'); // maps to TerminateProcess() on Windows via Node.js — intentional cross-platform
          settle(() => reject(new Error(`Command exceeded max total time of ${maxTotalMs}ms`)));
        }, maxTotalMs);
        maxTotalTimer.unref();
      }

      let stdout = '';
      let stderr = '';
      let stdoutLen = 0;
      let stderrLen = 0;
      let stdoutSpillStream: fs.WriteStream | null = null;
      let stderrSpillStream: fs.WriteStream | null = null;
      let stdoutSpillPath: string | null = null;
      let stderrSpillPath: string | null = null;

      child.stdout?.on('data', (data: Buffer) => {
        resetInactivityTimer();
        let chunk = data.toString();
        if (!pidExtracted) {
          const m = /^FLEET_PID:(\d+)\r?$/m.exec(chunk);
          if (m) {
            const pid = parseInt(m[1], 10);
            setStoredPid(this.agent.id, pid);
            chunk = chunk.replace(/^FLEET_PID:\d+\r?(?:\n|$)/m, '');
            pidExtracted = true;
          }
        }
        stdoutLen += data.length;
        if (stdoutLen <= MAX_OUTPUT_BYTES) {
          stdout += chunk;
        } else {
          if (!stdoutSpillStream) {
            stdoutSpillPath = path.join(os.tmpdir(), `fleet-local-stdout-${uuid()}.txt`);
            stdoutSpillStream = fs.createWriteStream(stdoutSpillPath);
            stdoutSpillStream.write(stdout);
          }
          stdoutSpillStream.write(chunk);
        }
      });

      child.stderr?.on('data', (data: Buffer) => {
        resetInactivityTimer();
        stderrLen += data.length;
        if (stderrLen <= MAX_OUTPUT_BYTES) {
          stderr += data.toString();
        } else {
          if (!stderrSpillStream) {
            stderrSpillPath = path.join(os.tmpdir(), `fleet-local-stderr-${uuid()}.txt`);
            stderrSpillStream = fs.createWriteStream(stderrSpillPath);
            stderrSpillStream.write(stderr);
          }
          stderrSpillStream.write(data);
        }
      });

      child.on('close', (code) => {
        clearStoredPid(this.agent.id);
        if (stdoutSpillStream) stdoutSpillStream.end();
        if (stderrSpillStream) stderrSpillStream.end();
        if (stdoutSpillPath) {
          stdout = `[OUTPUT TRUNCATED — full stdout saved to ${stdoutSpillPath}]\n${stdout}`;
        }
        if (stderrSpillPath) {
          stderr = `[OUTPUT TRUNCATED — full stderr saved to ${stderrSpillPath}]\n${stderr}`;
        }
        settle(() => resolve({ stdout, stderr, code: code ?? 0 }));
      });

      child.on('error', (err) => {
        clearStoredPid(this.agent.id);
        settle(() => reject(err));
      });

      child.stdin?.end();
    });
    return result;
  }

  async transferFiles(localPaths: string[], destinationPath?: string): Promise<TransferResult> {
    const destBase = destinationPath
      ? path.resolve(this.agent.workFolder, destinationPath)
      : this.agent.workFolder;

    // Ensure destination exists
    fs.mkdirSync(destBase, { recursive: true });

    const success: string[] = [];
    const failed: { path: string; error: string }[] = [];

    for (const localPath of localPaths) {
      const fileName = path.basename(localPath);
      const destPath = path.join(destBase, fileName);
      try {
        fs.copyFileSync(localPath, destPath);
        success.push(fileName);
      } catch (err: any) {
        failed.push({ path: fileName, error: err.message });
      }
    }

    return { success, failed };
  }

  async receiveFiles(remotePaths: string[], localDestination: string): Promise<TransferResult> {
    fs.mkdirSync(localDestination, { recursive: true });

    const success: string[] = [];
    const failed: { path: string; error: string }[] = [];

    for (const remotePath of remotePaths) {
      const srcPath = path.resolve(this.agent.workFolder, remotePath);
      const fileName = path.basename(srcPath);
      const destPath = path.join(localDestination, fileName);
      try {
        fs.copyFileSync(srcPath, destPath);
        success.push(fileName);
      } catch (err: any) {
        failed.push({ path: fileName, error: err.message });
      }
    }

    return { success, failed };
  }

  async deleteFiles(relativePaths: string[]): Promise<void> {
    for (const rel of relativePaths) {
      try { fs.unlinkSync(path.resolve(this.agent.workFolder, rel)); } catch { /* ignore */ }
    }
  }

  async testConnection(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    if (!fs.existsSync(this.agent.workFolder)) {
      return { ok: false, latencyMs: 0, error: `work_folder missing: ${this.agent.workFolder}` };
    }
    return { ok: true, latencyMs: 0 };
  }

  close(): void {
    // No-op for local agents
  }
}

export function getStrategy(agent: Agent): AgentStrategy {
  if (agent.agentType === 'local') {
    return new LocalStrategy(agent);
  }
  return new RemoteStrategy(agent);
}
