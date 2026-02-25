import { Client } from 'ssh2';
import fs from 'node:fs';
import type { Agent, SSHExecResult } from '../types.js';
import { decryptPassword } from '../utils/crypto.js';

interface PoolEntry {
  client: Client;
  lastUsed: number;
  timer: ReturnType<typeof setTimeout>;
}

const pool = new Map<string, PoolEntry>();
const IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes

function poolKey(agent: Agent): string {
  return `${agent.username}@${agent.host}:${agent.port}`;
}

function cleanupEntry(key: string): void {
  const entry = pool.get(key);
  if (entry) {
    try { entry.client.end(); } catch {}
    clearTimeout(entry.timer);
    pool.delete(key);
  }
}

function resetIdleTimer(key: string): void {
  const entry = pool.get(key);
  if (entry) {
    clearTimeout(entry.timer);
    entry.lastUsed = Date.now();
    const timer = setTimeout(() => cleanupEntry(key), IDLE_TIMEOUT);
    timer.unref();
    entry.timer = timer;
  }
}

export function getSSHConfig(agent: Agent): object {
  const config: Record<string, unknown> = {
    host: agent.host,
    port: agent.port,
    username: agent.username,
    readyTimeout: 15000,
  };

  if (agent.authType === 'key' && agent.keyPath) {
    config.privateKey = fs.readFileSync(agent.keyPath);
  } else if (agent.authType === 'password' && agent.encryptedPassword) {
    config.password = decryptPassword(agent.encryptedPassword);
  }

  return config;
}

export async function getConnection(agent: Agent): Promise<Client> {
  const key = poolKey(agent);
  const entry = pool.get(key);

  if (entry) {
    resetIdleTimer(key);
    return entry.client;
  }

  return new Promise<Client>((resolve, reject) => {
    const client = new Client();
    const config = getSSHConfig(agent);

    client.on('ready', () => {
      const timer = setTimeout(() => cleanupEntry(key), IDLE_TIMEOUT);
      timer.unref();
      pool.set(key, { client, lastUsed: Date.now(), timer });

      client.on('close', () => {
        pool.delete(key);
      });
      client.on('error', () => {
        cleanupEntry(key);
      });

      resolve(client);
    });

    client.on('error', (err) => {
      reject(err);
    });

    client.connect(config as any);
  });
}

export async function execCommand(
  agent: Agent,
  command: string,
  timeoutMs: number = 30000
): Promise<SSHExecResult> {
  const client = await getConnection(agent);
  resetIdleTimer(poolKey(agent));

  return new Promise<SSHExecResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    client.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }

      let stdout = '';
      let stderr = '';

      stream.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      stream.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
      stream.on('close', (code: number) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code: code ?? 0 });
      });
      stream.on('error', (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  });
}

export async function testConnection(agent: Agent): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    const client = await getConnection(agent);
    const latencyMs = Date.now() - start;
    return { ok: true, latencyMs };
  } catch (err: any) {
    return { ok: false, latencyMs: Date.now() - start, error: err.message };
  }
}

export function closeConnection(agent: Agent): void {
  cleanupEntry(poolKey(agent));
}

export function closeAllConnections(): void {
  for (const key of pool.keys()) {
    cleanupEntry(key);
  }
}
