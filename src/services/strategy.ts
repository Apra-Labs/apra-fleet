import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Agent, SSHExecResult, TransferResult } from '../types.js';
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

      exec(command, { cwd: this.agent.remoteFolder, timeout: timeoutMs }, (error, stdout, stderr) => {
        clearTimeout(timer);
        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          code: error ? (error as any).code ?? 1 : 0,
        });
      });
    });
  }

  async transferFiles(localPaths: string[], remoteSubfolder?: string): Promise<TransferResult> {
    let destBase = this.agent.remoteFolder;
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
