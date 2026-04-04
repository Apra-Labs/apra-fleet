import { exec } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuid } from 'uuid';
import type { Agent, SSHExecResult, TransferResult } from '../types.js';
import { getOsCommands } from '../os/index.js';
import { getAgentOS } from '../utils/agent-helpers.js';

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MB
import { execCommand as sshExecCommand, testConnection as sshTestConnection, closeConnection as sshCloseConnection } from './ssh.js';
import { uploadFiles, downloadFiles } from './file-transfer.js';

export interface AgentStrategy {
  execCommand(command: string, timeoutMs?: number): Promise<SSHExecResult>;
  transferFiles(localPaths: string[], destinationPath?: string): Promise<TransferResult>;
  receiveFiles(remotePaths: string[], localDestination: string): Promise<TransferResult>;
  /** Delete files relative to the agent's workFolder. Best-effort — errors are silently ignored. */
  deleteFiles(relativePaths: string[]): Promise<void>;
  testConnection(): Promise<{ ok: boolean; latencyMs: number; error?: string }>;
  close(): void;
}

class RemoteStrategy implements AgentStrategy {
  constructor(private agent: Agent) {}

  async execCommand(command: string, timeoutMs = 30000): Promise<SSHExecResult> {
    return sshExecCommand(this.agent, command, timeoutMs);
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
        const files = relativePaths.map(p => `"${p.replace(/"/g, '')}"`).join(', ');
        const psScript = `Set-Location "${folder.replace(/"/g, '')}"; Remove-Item ${files} -Force -ErrorAction SilentlyContinue`;
        const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
        await this.execCommand(`powershell -EncodedCommand ${encoded}`, 10000);
      } else {
        const escapedFolder = folder.replace(/"/g, '\\"');
        const files = relativePaths.map(p => `"${p.replace(/"/g, '\\"')}"`).join(' ');
        await this.execCommand(`cd "${escapedFolder}" && rm -f ${files}`, 10000);
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

  execCommand(command: string, timeoutMs = 30000): Promise<SSHExecResult> {
    return new Promise<SSHExecResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Command timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const cmds = getOsCommands(getAgentOS(this.agent));
      const { command: wrapped, env, shell } = cmds.cleanExec(command);
      const child = exec(wrapped, { cwd: this.agent.workFolder, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, env, shell }, (error, stdout, stderr) => {
        clearTimeout(timer);
        let out = stdout ?? '';
        let err = stderr ?? '';
        // On maxBuffer overflow, Node kills the process and sets error.code to 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        if (error && (error as any).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          const spillPath = path.join(os.tmpdir(), `fleet-local-output-${uuid()}.txt`);
          fs.writeFileSync(spillPath, out + err);
          out = `[OUTPUT TRUNCATED — full output saved to ${spillPath}]\n${out}`;
          resolve({ stdout: out, stderr: err, code: 1 });
          return;
        }
        resolve({
          stdout: out,
          stderr: err,
          code: error ? (error as any).code ?? 1 : 0,
        });
      });
      child.stdin?.end();
    });
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
