import { Client, type ConnectConfig } from 'ssh2';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuid } from 'uuid';
import type { Agent, SSHExecResult } from '../types.js';
import { decryptPassword } from '../utils/crypto.js';
import { verifyHostKey, replaceKnownHost, HostKeyMismatchError } from './known-hosts.js';

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MB

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

export function getSSHConfig(agent: Agent): ConnectConfig {
  const config: ConnectConfig = {
    host: agent.host,
    port: agent.port,
    username: agent.username,
    readyTimeout: 15000,
    hostVerifier: (key: Buffer) => {
      return verifyHostKey(agent.host!, agent.port!, key);
    },
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

    client.connect(config);
  });
}

/**
 * Connect with TOFU: on HostKeyMismatchError, auto-accept the new key and retry once.
 * Returns the client and an optional warning string if the key was updated.
 */
export async function connectWithTOFU(agent: Agent): Promise<{ client: Client; warning?: string }> {
  try {
    const client = await getConnection(agent);
    return { client };
  } catch (err) {
    if (err instanceof HostKeyMismatchError) {
      replaceKnownHost(err.host, err.port, err.newFingerprint);
      closeConnection(agent);
      const client = await getConnection(agent);
      return { client, warning: `Host key updated for ${err.host}:${err.port}` };
    }
    throw err;
  }
}

export async function execCommand(
  agent: Agent,
  command: string,
  timeoutMs: number = 30000
): Promise<SSHExecResult> {
  const { client, warning } = await connectWithTOFU(agent);
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

      // Close stdin so commands that read from it (e.g. claude -p) get EOF
      stream.end();

      let stdout = '';
      let stderr = '';
      let stdoutLen = 0;
      let stderrLen = 0;
      let stdoutSpillStream: fs.WriteStream | null = null;
      let stderrSpillStream: fs.WriteStream | null = null;
      let stdoutSpillPath: string | null = null;
      let stderrSpillPath: string | null = null;

      stream.on('data', (data: Buffer) => {
        stdoutLen += data.length;
        if (stdoutLen <= MAX_OUTPUT_BYTES) {
          stdout += data.toString();
        } else {
          if (!stdoutSpillStream) {
            stdoutSpillPath = path.join(os.tmpdir(), `fleet-stdout-${uuid()}.txt`);
            stdoutSpillStream = fs.createWriteStream(stdoutSpillPath);
            stdoutSpillStream.write(stdout);
          }
          stdoutSpillStream.write(data);
        }
      });
      stream.stderr.on('data', (data: Buffer) => {
        stderrLen += data.length;
        if (stderrLen <= MAX_OUTPUT_BYTES) {
          stderr += data.toString();
        } else {
          if (!stderrSpillStream) {
            stderrSpillPath = path.join(os.tmpdir(), `fleet-stderr-${uuid()}.txt`);
            stderrSpillStream = fs.createWriteStream(stderrSpillPath);
            stderrSpillStream.write(stderr);
          }
          stderrSpillStream.write(data);
        }
      });
      stream.on('close', (code: number) => {
        clearTimeout(timer);
        if (stdoutSpillStream) stdoutSpillStream.end();
        if (stderrSpillStream) stderrSpillStream.end();
        if (stdoutSpillPath) {
          stdout = `[OUTPUT TRUNCATED — full stdout saved to ${stdoutSpillPath}]\n${stdout}`;
        }
        if (stderrSpillPath) {
          stderr = `[OUTPUT TRUNCATED — full stderr saved to ${stderrSpillPath}]\n${stderr}`;
        }
        if (warning) {
          stderr = `⚠️ ${warning}\n${stderr}`;
        }
        resolve({ stdout, stderr, code: code ?? 0 });
      });
      stream.on('error', (err: Error) => {
        clearTimeout(timer);
        if (stdoutSpillStream) stdoutSpillStream.end();
        if (stderrSpillStream) stderrSpillStream.end();
        reject(err);
      });
    });
  });
}

export async function testConnection(agent: Agent): Promise<{ ok: boolean; latencyMs: number; error?: string; warning?: string }> {
  const start = Date.now();
  try {
    const { warning } = await connectWithTOFU(agent);
    const latencyMs = Date.now() - start;
    return { ok: true, latencyMs, warning };
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
