import net from 'node:net';
import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execSync, ChildProcess } from 'node:child_process';
import { getDataDir, getConfig, getLogger } from './config.js';
import { encryptPassword } from './crypto.js';
import { getOobTimeoutMs } from './oob-timeout.js';

const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_BUFFER_SIZE = 64 * 1024;

interface PendingAuth {
  encryptedPassword?: string;
  createdAt: number;
  spawned_pid?: number;
  persist?: boolean;
}

interface PasswordWaiter {
  resolve: (encryptedPassword: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingRequests = new Map<string, PendingAuth>();
const passwordWaiters = new Map<string, PasswordWaiter>();
const activeSockets = new Set<net.Socket>();
let socketServer: net.Server | null = null;
let closingPromise: Promise<void> | null = null;
let testPipeGeneration = 0;

export function getSocketPath(): string {
  if (process.platform === 'win32') {
    const username = process.env.USERNAME ?? 'user';
    const config = getConfig();
    const pipeName = config.pipeName ?? 'blindfold-auth';
    const suffix = process.env.NODE_ENV === 'test' ? `-${testPipeGeneration}` : '';
    return `\\\\.\\pipe\\${pipeName}-${username}${suffix}`;
  }
  return path.join(getDataDir(), 'auth.sock');
}

function killProcess(pid: number): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    // Process may have already exited
  }
}

export async function ensureAuthSocket(): Promise<void> {
  if (closingPromise) {
    await closingPromise;
  }

  if (socketServer) return;

  const sockPath = getSocketPath();

  const sockDir = path.dirname(sockPath);
  if (!fs.existsSync(sockDir)) {
    fs.mkdirSync(sockDir, { recursive: true, mode: 0o700 });
  }

  if (process.platform !== 'win32') {
    try { fs.unlinkSync(sockPath); } catch { /* not present */ }
  }

  const tryListen = (retriesLeft: number): Promise<void> => new Promise((resolve, reject) => {
    const server = net.createServer((conn) => {
      activeSockets.add(conn);
      conn.on('close', () => activeSockets.delete(conn));
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
              conn.write(JSON.stringify({ type: 'ack', ok: false, error: `No pending auth for ${msg.member_name}` }) + '\n');
              return;
            }
            pending.encryptedPassword = encryptPassword(msg.password);
            if (msg.persist !== undefined) pending.persist = !!msg.persist;
            (msg as any).password = '';
            conn.write(JSON.stringify({ type: 'ack', ok: true }) + '\n');
            if (pending.spawned_pid) {
              killProcess(pending.spawned_pid);
              pending.spawned_pid = undefined;
            }
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

    server.on('error', (err: NodeJS.ErrnoException) => {
      server.close();
      if (err.code === 'EADDRINUSE' && process.platform === 'win32' && retriesLeft > 0) {
        const totalRetries = process.env.NODE_ENV === 'test' ? 15 : 5;
        const delayBase = process.env.NODE_ENV === 'test' ? 100 : 250;
        const delay = delayBase * (totalRetries - retriesLeft + 1);
        setTimeout(() => tryListen(retriesLeft - 1).then(resolve, reject), delay);
      } else {
        reject(err);
      }
    });
    server.listen(sockPath, () => {
      if (process.platform !== 'win32') {
        try { fs.chmodSync(sockPath, 0o600); } catch { /* best effort */ }
      }
      socketServer = server;
      resolve();
    });
  });

  const maxRetries = process.platform === 'win32' ? (process.env.NODE_ENV === 'test' ? 10 : 5) : 0;
  return tryListen(maxRetries);
}

export function createPendingAuth(memberName: string): void {
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
  const pw = entry.encryptedPassword;
  pendingRequests.delete(memberName);
  return pw;
}

export function waitForPassword(memberName: string, timeoutMs?: number): Promise<string> {
  const existing = getPendingPassword(memberName);
  if (existing) return Promise.resolve(existing);

  const timeout = timeoutMs ?? getOobTimeoutMs();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      passwordWaiters.delete(memberName);
      const pending = pendingRequests.get(memberName);
      if (pending?.spawned_pid) killProcess(pending.spawned_pid);
      pendingRequests.delete(memberName);
      reject(new Error(`Password entry timed out for ${memberName}`));
    }, timeout);

    passwordWaiters.set(memberName, { resolve, reject, timer });
  });
}

export function cancelPendingAuth(memberName: string): void {
  const pending = pendingRequests.get(memberName);
  if (pending?.spawned_pid) killProcess(pending.spawned_pid);
  const waiter = passwordWaiters.get(memberName);
  if (waiter) { clearTimeout(waiter.timer); waiter.reject(new Error('cancelled')); }
  passwordWaiters.delete(memberName);
  pendingRequests.delete(memberName);
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

export function cleanupAuthSocket(): Promise<void> {
  if (closingPromise) {
    return closingPromise;
  }

  for (const [, waiter] of passwordWaiters) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error('Auth socket closed'));
  }
  passwordWaiters.clear();
  pendingRequests.clear();

  for (const s of activeSockets) {
    s.destroy();
  }
  activeSockets.clear();

  if (!socketServer) {
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(getSocketPath()); } catch { /* ignore */ }
    }
    return Promise.resolve();
  }

  const server = socketServer;
  socketServer = null;

  closingPromise = new Promise((resolve) => {
    server.close(() => {
      const onComplete = () => {
        if (process.platform !== 'win32') {
          try { fs.unlinkSync(getSocketPath()); } catch { /* ignore */ }
        }
        if (process.platform === 'win32' && process.env.NODE_ENV === 'test') {
          testPipeGeneration++;
        }
        closingPromise = null;
        resolve();
      };

      if (process.platform === 'win32' && process.env.NODE_ENV !== 'test') {
        setTimeout(onComplete, 500);
      } else {
        onComplete();
      }
    });
  });

  return closingPromise;
}

type OobLaunchFn = (
  name: string,
  extraArgs: string[] | undefined,
  onExit: (code: number | null) => void,
) => string;


async function collectOobInput(
  mode: 'password' | 'api-key' | 'confirm',
  memberName: string,
  toolName: string,
  _opts?: { waitTimeoutMs?: number; launchFn?: OobLaunchFn; prompt?: string; additionalArgs?: string[] },
): Promise<{ password?: string; fallback?: string; persist?: boolean }> {
  const launch = _opts?.launchFn ?? launchAuthTerminal;
  const waitTimeoutMs = _opts?.waitTimeoutMs;

  const modeArgs = mode === 'api-key' ? ['--api-key'] : mode === 'confirm' ? ['--confirm'] : [];
  const promptArgs = _opts?.prompt ? ['--prompt', _opts.prompt] : [];
  const extraArgs = [...modeArgs, ...promptArgs, ...(_opts?.additionalArgs ?? [])];
  const inputType = mode === 'api-key' ? 'API key' : mode === 'confirm' ? 'confirmation' : 'Password';

  const timeoutMessage = `❌ Password entry timed out for ${memberName}. Call ${toolName} again to retry.`;
  const cancelledMessage = `❌ Password entry cancelled. Call ${toolName} again to retry.`;

  if (hasPendingAuth(memberName)) {
    const encPw = getPendingPassword(memberName);
    if (encPw) return { password: encPw };
    try {
      return { password: await waitForPassword(memberName, waitTimeoutMs ?? getOobTimeoutMs()) };
    } catch {
      return { fallback: timeoutMessage };
    }
  }

  await ensureAuthSocket();
  createPendingAuth(memberName);

  try {
    const passwordPromise = waitForPassword(memberName, waitTimeoutMs);

    const cancellationPromise = new Promise<{ fallback: string } | null>((resolve, reject) => {
      const result = launch(memberName, extraArgs, (exitCode) => {
        if (exitCode !== 0) {
          reject(new Error('cancelled'));
        }
        resolve(null);
      });

      if (result.startsWith('fallback:')) {
        const manualMsg = result.slice('fallback:'.length);
        resolve({ fallback: `🔐 ${manualMsg}\n\nOnce the user has entered the ${inputType}, call ${toolName} again with the same parameters.` });
      }
    });

    const raceResult = await Promise.race([passwordPromise, cancellationPromise]);

    if (raceResult === null) {
      try {
        const pw = await Promise.race([
          passwordPromise,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('cancelled')), 500)),
        ]);
        const persist = pendingRequests.get(memberName)?.persist;
        pendingRequests.delete(memberName);
        return { password: pw, persist };
      } catch {
        const waiter = passwordWaiters.get(memberName);
        if (waiter) { clearTimeout(waiter.timer); passwordWaiters.delete(memberName); }
        pendingRequests.delete(memberName);
        return { fallback: cancelledMessage };
      }
    }

    if (typeof raceResult === 'object' && raceResult?.fallback) {
      const waiter = passwordWaiters.get(memberName);
      if (waiter) {
        clearTimeout(waiter.timer);
        passwordWaiters.delete(memberName);
      }
      pendingRequests.delete(memberName);
      return raceResult;
    }

    const persist = pendingRequests.get(memberName)?.persist;
    pendingRequests.delete(memberName);
    return { password: raceResult as string, persist };
  } catch (err: any) {
    const waiter = passwordWaiters.get(memberName);
    if (waiter) {
      clearTimeout(waiter.timer);
      passwordWaiters.delete(memberName);
    }
    pendingRequests.delete(memberName);

    if (err.message === 'cancelled') {
      return { fallback: cancelledMessage };
    }
    return { fallback: timeoutMessage };
  }
}


export async function collectOobPassword(
  memberName: string,
  toolName: string,
  _opts?: { waitTimeoutMs?: number; launchFn?: OobLaunchFn; prompt?: string },
): Promise<{ password?: string; fallback?: string; persist?: boolean }> {
  return collectOobInput('password', memberName, toolName, _opts);
}

export async function collectOobApiKey(
  memberName: string,
  toolName: string,
  _opts?: { waitTimeoutMs?: number; launchFn?: OobLaunchFn; prompt?: string; askPersist?: boolean },
): Promise<{ password?: string; fallback?: string; persist?: boolean }> {
  const additionalArgs = _opts?.askPersist ? ['--ask-persist'] : [];
  return collectOobInput('api-key', memberName, toolName, { ...(_opts ?? {}), additionalArgs });
}

export async function collectOobConfirm(
  credentialName: string,
  _opts?: { waitTimeoutMs?: number; launchFn?: OobLaunchFn },
): Promise<{ confirmed: boolean; terminalUnavailable: boolean }> {
  const result = await collectOobInput('confirm', credentialName, 'execute_command', _opts);
  if (result.fallback) return { confirmed: false, terminalUnavailable: true };
  return { confirmed: Boolean(result.password), terminalUnavailable: false };
}

function getAuthCommand(memberName: string, extraArgs?: string[]): { cmd: string; args: string[] } {
  const extra = extraArgs ?? [];
  const isConfirm = extra.includes('--confirm');
  const productName = getConfig().productName;

  let cmdArgs: string[];
  if (isConfirm) {
    cmdArgs = ['auth', '--confirm', memberName];
  } else {
    cmdArgs = ['secret', '--set', memberName];
    const promptIdx = extra.indexOf('--prompt');
    if (promptIdx !== -1 && promptIdx + 1 < extra.length) {
      cmdArgs.push('--prompt', extra[promptIdx + 1]);
    }
    if (extra.includes('--ask-persist')) {
      cmdArgs.push('--ask-persist');
    }
  }

  try {
    const sea = require('node:sea');
    if (sea.isSea()) {
      return { cmd: process.execPath, args: cmdArgs };
    }
  } catch { /* not SEA */ }

  const indexJs = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'cli', 'index.js');
  return { cmd: process.argv[0], args: [indexJs, ...cmdArgs] };
}

function buildHeadlessFallback(memberName: string, reason: string): string {
  const productName = getConfig().productName;
  return `fallback:${reason}\n\nRun this in a separate terminal:\n  ! ${productName} auth ${memberName}\n\nAlternatively, pre-store the value with credential_store_set and reference it as {{secure.NAME}} in the credential field.`;
}

export function hasGraphicalDisplay(): boolean {
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

export function isSSHSession(): boolean {
  return !!process.env.SSH_TTY;
}

export function hasInteractiveDesktop(): boolean {
  return process.env.SESSIONNAME === 'Console';
}

function findLinuxTerminal(): string | null {
  for (const term of ['gnome-terminal', 'xterm', 'x-terminal-emulator']) {
    try {
      execSync(`which ${term}`, { stdio: 'ignore' });
      return term;
    } catch { /* not found */ }
  }
  return null;
}

export function launchAuthTerminal(
  memberName: string,
  extraArgs: string[] | undefined,
  onExit: (code: number | null) => void,
): string {
  const { cmd, args } = getAuthCommand(memberName, extraArgs);
  const fullArgs = [cmd, ...args];
  let child: ChildProcess;
  const productName = getConfig().productName;
  const log = getLogger();

  try {
    const platform = process.platform;

    if (platform === 'win32' && !hasInteractiveDesktop()) {
      return buildHeadlessFallback(memberName, 'No interactive desktop session detected (SSH or service context).');
    }

    if (platform === 'linux' && !hasGraphicalDisplay()) {
      return buildHeadlessFallback(memberName, 'No graphical display detected (SSH or headless session).');
    }

    if (platform === 'darwin' && isSSHSession()) {
      return buildHeadlessFallback(memberName, 'SSH session detected — no terminal emulator available (SSH_TTY is set).');
    }

    if (platform === 'darwin') {
      (async () => {
        let exitCode = 1;
        const tmpFile = path.join(os.tmpdir(), `${productName}-auth-exit-${Date.now()}`);
        try {
          const command = [...fullArgs, `; echo $? > "${tmpFile}"`].join(' ');
          const appleScript = `
            tell application "Terminal"
                activate
                set w to do script "${command.replace(/"/g, '\\"')}"
                delay 1
                repeat while busy of w
                    delay 0.5
                end repeat
            end tell
          `;

          const child = spawn('osascript', ['-']);
          child.stdin.write(appleScript);
          child.stdin.end();

          child.on('close', async (code) => {
            if (code !== 0) {
              onExit(1);
              return;
            }
            try {
              const codeStr = await fsPromises.readFile(tmpFile, 'utf-8');
              exitCode = parseInt(codeStr.trim(), 10);
              if (isNaN(exitCode)) exitCode = 1;
            } catch {
              exitCode = 1;
            } finally {
              await fsPromises.unlink(tmpFile).catch(() => {});
              onExit(exitCode);
            }
          });
          child.on('error', (err) => {
            log.error('auth_socket', `Failed to launch osascript for auth: ${err.message}`);
            onExit(1);
          });
        } catch (e) {
          onExit(1);
        }
      })();
      return 'launched';
    } else if (platform === 'win32') {
      const spawnArgs = ['/c', 'start', `${productName} Password Entry`, '/wait', ...fullArgs];
      child = spawn('cmd', spawnArgs, { stdio: 'ignore' });
      if (child.pid) {
        const pending = pendingRequests.get(memberName);
        if (pending) pending.spawned_pid = child.pid;
      }
    } else {
      const terminal = findLinuxTerminal();
      if (!terminal) {
        return `fallback:Could not find a terminal emulator. Ask the user to run manually:\n  ${[cmd, ...args].join(' ')}\nAlternatively, pre-store the value with credential_store_set and reference it as {{secure.NAME}} in the credential field.`;
      }
      if (terminal === 'gnome-terminal') {
        child = spawn(terminal, ['--', ...fullArgs], { detached: true, stdio: 'ignore' });
      } else {
        child = spawn(terminal, ['-e', ...fullArgs], { detached: true, stdio: 'ignore' });
      }
      if (child.pid) {
        const pending = pendingRequests.get(memberName);
        if (pending) pending.spawned_pid = child.pid;
      }
    }

    child.on('close', onExit);
    child.on('error', (err) => {
      log.error('auth_socket', `Failed to launch terminal for ${memberName}: ${err.message}`);
      onExit(1);
    });
    child.unref();

    return 'launched';
  } catch (err: any) {
    return `fallback:Could not open a terminal window. Ask the user to run manually:\n  ${[cmd, ...args].join(' ')}\nError: ${err.message}\nAlternatively, pre-store the value with credential_store_set and reference it as {{secure.NAME}} in the credential field.`;
  }
}
