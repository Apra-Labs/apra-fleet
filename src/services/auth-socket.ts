import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { FLEET_DIR } from '../paths.js';
import { encryptPassword } from '../utils/crypto.js';

const SOCKET_PATH = path.join(FLEET_DIR, 'auth.sock');
const PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_BUFFER_SIZE = 64 * 1024; // 64KB — reject oversized messages

interface PendingAuth {
  encryptedPassword?: string;
  createdAt: number;
}

interface PasswordWaiter {
  resolve: (encryptedPassword: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingRequests = new Map<string, PendingAuth>();
const passwordWaiters = new Map<string, PasswordWaiter>();
let socketServer: net.Server | null = null;

export function getSocketPath(): string {
  if (process.platform === 'win32') {
    const username = process.env.USERNAME ?? 'user';
    return `\\\\.\\pipe\\apra-fleet-auth-${username}`;
  }
  return SOCKET_PATH;
}

export async function ensureAuthSocket(): Promise<void> {
  if (socketServer) return;

  const sockPath = getSocketPath();

  // Ensure parent directory exists
  const sockDir = path.dirname(sockPath);
  if (!fs.existsSync(sockDir)) {
    fs.mkdirSync(sockDir, { recursive: true, mode: 0o700 });
  }

  // Unlink stale socket (Unix only — named pipes don't leave stale files)
  if (process.platform !== 'win32') {
    try { fs.unlinkSync(sockPath); } catch { /* not present */ }
  }

  return new Promise((resolve, reject) => {
    const server = net.createServer((conn) => {
      let buffer = '';
      conn.on('data', (chunk) => {
        buffer += chunk.toString();
        if (buffer.length > MAX_BUFFER_SIZE) {
          conn.write(JSON.stringify({ type: 'ack', ok: false, error: 'Message too large' }) + '\n');
          conn.end();
          return;
        }
        const newlineIdx = buffer.indexOf('\n');
        if (newlineIdx === -1) return;

        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);

        try {
          const msg = JSON.parse(line);
          if (msg.type === 'auth' && msg.member_name && msg.password) {
            const pending = pendingRequests.get(msg.member_name);
            if (!pending) {
              conn.write(JSON.stringify({ type: 'ack', ok: false, error: `No pending auth for "${msg.member_name}"` }) + '\n');
              return;
            }
            // Encrypt immediately, discard plaintext
            pending.encryptedPassword = encryptPassword(msg.password);
            msg.password = '';
            conn.write(JSON.stringify({ type: 'ack', ok: true }) + '\n');
            // Resolve any waiting tool handler
            const waiter = passwordWaiters.get(msg.member_name);
            if (waiter) {
              clearTimeout(waiter.timer);
              passwordWaiters.delete(msg.member_name);
              waiter.resolve(pending.encryptedPassword);
            }
          } else {
            conn.write(JSON.stringify({ type: 'ack', ok: false, error: 'Invalid message' }) + '\n');
          }
        } catch {
          conn.write(JSON.stringify({ type: 'ack', ok: false, error: 'Invalid JSON' }) + '\n');
        }
      });
    });

    server.on('error', reject);
    server.listen(sockPath, () => {
      // Set socket file permissions (Unix only)
      if (process.platform !== 'win32') {
        try { fs.chmodSync(sockPath, 0o600); } catch { /* best effort */ }
      }
      socketServer = server;
      resolve();
    });
  });
}

export function createPendingAuth(memberName: string): void {
  // Clean expired entries
  const now = Date.now();
  for (const [name, entry] of pendingRequests) {
    if (now - entry.createdAt > PENDING_TTL_MS) {
      pendingRequests.delete(name);
    }
  }
  pendingRequests.set(memberName, { createdAt: now });
}

export function getPendingPassword(memberName: string): string | null {
  const entry = pendingRequests.get(memberName);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > PENDING_TTL_MS) {
    pendingRequests.delete(memberName);
    return null;
  }
  if (!entry.encryptedPassword) return null;
  // Consume the entry
  const pw = entry.encryptedPassword;
  pendingRequests.delete(memberName);
  return pw;
}

/**
 * Wait for a pending auth password to arrive over the socket.
 * Returns the encrypted password, or rejects on timeout.
 */
export function waitForPassword(memberName: string, timeoutMs: number = 300_000): Promise<string> {
  // Race: password may have arrived before we started waiting
  const existing = getPendingPassword(memberName);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      passwordWaiters.delete(memberName);
      pendingRequests.delete(memberName);
      reject(new Error(`Password entry timed out for "${memberName}"`));
    }, timeoutMs);

    passwordWaiters.set(memberName, { resolve, reject, timer });
  });
}

export function hasPendingAuth(memberName: string): boolean {
  const entry = pendingRequests.get(memberName);
  if (!entry) return false;
  if (Date.now() - entry.createdAt > PENDING_TTL_MS) {
    pendingRequests.delete(memberName);
    return false;
  }
  return true;
}

export function cleanupAuthSocket(): void {
  // Reject any pending waiters
  for (const [, waiter] of passwordWaiters) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error('Auth socket closed'));
  }
  passwordWaiters.clear();

  if (socketServer) {
    socketServer.close();
    socketServer = null;
  }
  if (process.platform !== 'win32') {
    try { fs.unlinkSync(getSocketPath()); } catch { /* already gone */ }
  }
  pendingRequests.clear();
}

/**
 * Collect a password out-of-band: launch a terminal prompt and block until
 * the password arrives over the socket, or return a fallback message for
 * headless environments. Returns `{ password }` on success or `{ fallback }`
 * with a user-facing message if the terminal couldn't be launched.
 */
export async function collectOobPassword(
  memberName: string,
  toolName: string,
): Promise<{ password: string } | { fallback: string }> {
  if (hasPendingAuth(memberName)) {
    const encPw = getPendingPassword(memberName);
    if (encPw) return { password: encPw };
    try {
      return { password: await waitForPassword(memberName) };
    } catch {
      return { fallback: `❌ Password entry timed out for "${memberName}". Call ${toolName} again to retry.` };
    }
  }

  await ensureAuthSocket();
  createPendingAuth(memberName);
  const result = launchAuthTerminal(memberName);

  if (result.startsWith('fallback:')) {
    const manualMsg = result.slice('fallback:'.length);
    return { fallback: `🔐 ${manualMsg}\n\nOnce the user has entered the password, call ${toolName} again with the same parameters (without password).` };
  }

  try {
    return { password: await waitForPassword(memberName) };
  } catch {
    return { fallback: `❌ Password entry timed out for "${memberName}". Call ${toolName} again to retry.` };
  }
}

/**
 * Resolve the command to invoke this binary's `auth` subcommand.
 * Returns [command, ...args] suitable for spawn().
 */
function getAuthCommand(memberName: string): { cmd: string; args: string[] } {
  // SEA binary: process.execPath is the binary itself
  try {
    const sea = require('node:sea');
    if (sea.isSea()) {
      return { cmd: process.execPath, args: ['auth', memberName] };
    }
  } catch { /* not SEA */ }

  // Dev mode: node <path-to-index.js> auth <name>
  const indexJs = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'index.js');
  return { cmd: process.argv[0], args: [indexJs, 'auth', memberName] };
}

/**
 * Detect available terminal emulator on Linux.
 */
function findLinuxTerminal(): string | null {
  for (const term of ['gnome-terminal', 'xterm', 'x-terminal-emulator']) {
    try {
      execSync(`which ${term}`, { stdio: 'ignore' });
      return term;
    } catch { /* not found */ }
  }
  return null;
}

/**
 * Launch a new terminal window running `apra-fleet auth <memberName>`.
 * Returns a user-facing message describing what happened.
 */
export function launchAuthTerminal(memberName: string): string {
  const { cmd, args } = getAuthCommand(memberName);
  const fullArgs = [cmd, ...args];

  try {
    const platform = process.platform;

    if (platform === 'darwin') {
      // macOS: use osascript to open a new Terminal.app window
      const script = `tell application "Terminal" to do script "${fullArgs.map(a => a.replace(/"/g, '\\"')).join(' ')}"`;
      spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref();
    } else if (platform === 'win32') {
      // Windows: start a new cmd window
      spawn('cmd', ['/c', 'start', 'cmd', '/c', ...fullArgs], { detached: true, stdio: 'ignore' }).unref();
    } else {
      // Linux: find available terminal emulator
      const terminal = findLinuxTerminal();
      if (!terminal) {
        return `fallback:Could not find a terminal emulator. Ask the user to run manually:\n  ${fullArgs.join(' ')}`;
      }
      if (terminal === 'gnome-terminal') {
        spawn(terminal, ['--', ...fullArgs], { detached: true, stdio: 'ignore' }).unref();
      } else {
        // xterm, x-terminal-emulator
        spawn(terminal, ['-e', ...fullArgs], { detached: true, stdio: 'ignore' }).unref();
      }
    }

    return 'launched';
  } catch {
    return `fallback:Could not open a terminal window. Ask the user to run manually:\n  ${fullArgs.join(' ')}`;
  }
}
