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
import { uploadFiles } from './file-transfer.js';

export interface AgentStrategy {
  execCommand(command: string, timeoutMs?: number): Promise<SSHExecResult>;
  transferFiles(localPaths: string[], remoteSubfolder?: string): Promise<TransferResult>;
  testConnection(): Promise<{ ok: boolean; latencyMs: number; error?: string }>;
  close(): void;
}

class RemoteStrategy implements AgentStrategy {
  constructor(private agent: Agent) {}

  async execCommand(command: string, timeoutMs = 30000): Promise<SSHExecResult> {
    return sshExecCommand(this.agent, command, timeoutMs);
  }

  async transferFiles(localPaths: string[], remoteSubfolder?: string): Promise<TransferResult> {
    return uploadFiles(this.agent, localPaths, remoteSubfolder);
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

  async transferFiles(localPaths: string[], remoteSubfolder?: string): Promise<TransferResult> {
    let destBase = this.agent.workFolder;
    if (remoteSubfolder) {
      destBase = path.join(destBase, remoteSubfolder);
    }

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
