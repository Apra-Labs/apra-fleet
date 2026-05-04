import net from 'node:net';
import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execSync, ChildProcess } from 'node:child_process';
import { FLEET_DIR } from '../paths.js';
import { encryptPassword } from '../utils/crypto.js';
import { logError, logLine } from '../utils/log-helpers.js';

const SOCKET_PATH = path.join(FLEET_DIR, 'auth.sock');
const PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_BUFFER_SIZE = 64 * 1024; // 64KB — reject oversized messages

interface PendingAuth {
  encryptedPassword?: string;
  createdAt: number;
  spawned_pid?: number;
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
    // Note: this path is automatically scoped to the user session by Windows.
    const username = process.env.USERNAME ?? 'user';
    return `\\\\.\\pipe\\apra-fleet-auth-${username}`;
  }
  return SOCKET_PATH;
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

  const tryListen = (retriesLeft: number): Promise<void> => new Promise((resolve, reject) => {
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
              conn.write(JSON.stringify({ type: 'ack', ok: false, error: `No pending auth for ${msg.member_name}` }) + '\n');
              return;
            }
            // Encrypt immediately, discard plaintext
            pending.encryptedPassword = encryptPassword(msg.password);
            // Best-effort: JS strings are immutable; original may persist in V8 heap until GC
            (msg as any).password = '';
            conn.write(JSON.stringify({ type: 'ack', ok: true }) + '\n');
            // Kill the spawned terminal process if one was launched
            if (pending.spawned_pid) {
              killProcess(pending.spawned_pid);
              pending.spawned_pid = undefined;
            }
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

    server.on('error', (err: NodeJS.ErrnoException) => {
      server.close();
      // On Windows, named pipes may not be released immediately after close.
      // Retry a few times with a short delay before giving up.
      if (err.code === 'EADDRINUSE' && process.platform === 'win32' && retriesLeft > 0) {
        setTimeout(() => tryListen(retriesLeft - 1).then(resolve, reject), 100);
      } else {
        reject(err);
      }
    });
    server.listen(sockPath, () => {
      // Set socket file permissions (Unix only)
      if (process.platform !== 'win32') {
        try { fs.chmodSync(sockPath, 0o600); } catch { /* best effort */ }
      }
      socketServer = server;
      resolve();
    });
  });

  return tryListen(5);
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
      reject(new Error(`Password entry timed out for ${memberName}`));
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

type OobLaunchFn = (
  name: string,
  extraArgs: string[] | undefined,
  onExit: (code: number | null) => void,
) => string;


/**
 * Core logic for out-of-band credential collection.
 * Launches a terminal, then races a password waiter against a cancellation signal.
 */
async function collectOobInput(
  mode: 'password' | 'api-key' | 'confirm',
  memberName: string,
  toolName: string,
  _opts?: { waitTimeoutMs?: number; launchFn?: OobLaunchFn; prompt?: string },
): Promise<{ password?: string; fallback?: string }> {
  const launch = _opts?.launchFn ?? launchAuthTerminal;
  const waitTimeoutMs = _opts?.waitTimeoutMs;

  const modeArgs = mode === 'api-key' ? ['--api-key'] : mode === 'confirm' ? ['--confirm'] : [];
  const promptArgs = _opts?.prompt ? ['--prompt', _opts.prompt] : [];
  const extraArgs = [...modeArgs, ...promptArgs];
  const inputType = mode === 'api-key' ? 'API key' : mode === 'confirm' ? 'confirmation' : 'Password';

  const timeoutMessage = `❌ Password entry timed out for ${memberName}. Call ${toolName} again to retry.`;
  const cancelledMessage = `❌ Password entry cancelled. Call ${toolName} again to retry.`;

  // Re-entrant case
  if (hasPendingAuth(memberName)) {
    const encPw = getPendingPassword(memberName);
    if (encPw) return { password: encPw };
    try {
      // Another process already launched the terminal, just wait for the result.
      return { password: await waitForPassword(memberName, waitTimeoutMs ?? 300_000) };
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
        // If exit is 0, passwordPromise will win the race.
        // We can resolve this with null to signal completion without a fallback.
        resolve(null);
      });

      if (result.startsWith('fallback:')) {
        const manualMsg = result.slice('fallback:'.length);
        resolve({ fallback: `🔐 ${manualMsg}\n\nOnce the user has entered the ${inputType}, call ${toolName} again with the same parameters.` });
      }
    });

    const raceResult = await Promise.race([passwordPromise, cancellationPromise]);

    if (raceResult === null) {
      // This case should not be hit if passwordPromise always wins on success,
      // but as a safeguard, we wait for the password again.
      const pw = await passwordPromise;
      pendingRequests.delete(memberName);
      return { password: pw };
    }

    // Handle the fallback case from the cancellation promise
    if (typeof raceResult === 'object' && raceResult?.fallback) {
      // Clean up stale state so a retry can launch a fresh terminal.
      // Without this, hasPendingAuth() returns true on the next call,
      // the re-entrant path skips launchAuthTerminal, and the call hangs.
      const waiter = passwordWaiters.get(memberName);
      if (waiter) {
        clearTimeout(waiter.timer);
        passwordWaiters.delete(memberName);
      }
      pendingRequests.delete(memberName);
      return raceResult;
    }

    pendingRequests.delete(memberName);
    return { password: raceResult as string };
  } catch (err: any) {
    // Clean up the pending request if the user cancelled.
    const waiter = passwordWaiters.get(memberName);
    if (waiter) {
      clearTimeout(waiter.timer);
      passwordWaiters.delete(memberName);
    }
    pendingRequests.delete(memberName);

    if (err.message === 'cancelled') {
      return { fallback: cancelledMessage };
    }
    // It must be a timeout from waitForPassword
    return { fallback: timeoutMessage };
  }
}


/**
 * Collect a password out-of-band.
 * @see collectOobInput
 */
export async function collectOobPassword(
  memberName: string,
  toolName: string,
  _opts?: { waitTimeoutMs?: number; launchFn?: OobLaunchFn },
): Promise<{ password?: string; fallback?: string }> {
  return collectOobInput('password', memberName, toolName, _opts);
}

/**
 * Collect an API key out-of-band.
 * @see collectOobInput
 */
export async function collectOobApiKey(
  memberName: string,
  toolName: string,
  _opts?: { waitTimeoutMs?: number; launchFn?: OobLaunchFn; prompt?: string },
): Promise<{ password?: string; fallback?: string }> {
  return collectOobInput('api-key', memberName, toolName, _opts);
}


/**
 * Prompt the user out-of-band to confirm a network-egress operation.
 * Returns true if the user confirmed, false if they cancelled or timed out.
 */
export async function collectOobConfirm(
  credentialName: string,
  _opts?: { waitTimeoutMs?: number; launchFn?: OobLaunchFn },
): Promise<{ confirmed: boolean; terminalUnavailable: boolean }> {
  const result = await collectOobInput('confirm', credentialName, 'execute_command', _opts);
  if (result.fallback) return { confirmed: false, terminalUnavailable: true };
  return { confirmed: Boolean(result.password), terminalUnavailable: false };
}

/**
 * Resolve the command to invoke this binary's `auth` or `secret` subcommand.
 * For API key mode (--api-key in extraArgs), uses `secret --set`.
 * Returns [command, ...args] suitable for spawn().
 */
function getAuthCommand(memberName: string, extraArgs?: string[]): { cmd: string; args: string[] } {
  const extra = extraArgs ?? [];
  const isApiKeyMode = extra.includes('--api-key');

  // For API key mode, use `secret --set` instead of `auth --api-key`
  let cmdArgs: string[];
  if (isApiKeyMode) {
    // Remove --api-key and --prompt args, use simple `secret --set <name>`
    cmdArgs = ['secret', '--set', memberName];
  } else {
    // For password/confirm modes, use original `auth <mode> <name>` command
    cmdArgs = ['auth', ...extra, memberName];
  }

  // SEA binary: process.execPath is the binary itself
  try {
    const sea = require('node:sea');
    if (sea.isSea()) {
      return { cmd: process.execPath, args: cmdArgs };
    }
  } catch { /* not SEA */ }

  // Dev mode: node <path-to-index.js> <command>
  const indexJs = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'index.js');
  return { cmd: process.argv[0], args: [indexJs, ...cmdArgs] };
}

function buildHeadlessFallback(memberName: string, reason: string): string {
  return `fallback:${reason}\n\nRun this in a separate terminal:\n  ! apra-fleet auth ${memberName}\n\nAlternatively, pre-store the value with credential_store_set and reference it as {{secure.NAME}} in the credential field.`;
}

/**
 * Returns true when a graphical display is available on Linux/BSD.
 * Checks $DISPLAY (X11) and $WAYLAND_DISPLAY (Wayland).
 */
export function hasGraphicalDisplay(): boolean {
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/**
 * Returns true when the process is running inside an SSH session.
 * SSH_TTY is set by the SSH daemon on both Linux and macOS when stdin is a tty.
 */
export function isSSHSession(): boolean {
  return !!process.env.SSH_TTY;
}

/**
 * Returns true when running on an interactive Windows desktop session.
 * SSH and headless service sessions have SESSIONNAME !== 'Console'.
 */
export function hasInteractiveDesktop(): boolean {
  return process.env.SESSIONNAME === 'Console';
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
 * Launch a new terminal window running `apra-fleet secret --set <memberName>` or `apra-fleet auth <memberName>`.
 * Records the spawned PID in the pending request so it can be killed when credential is received.
 * Returns a user-facing message describing what happened and executes a
 * callback when the spawned terminal process exits.
 */
export function launchAuthTerminal(
  memberName: string,
  extraArgs: string[] | undefined,
  onExit: (code: number | null) => void,
): string {
  const { cmd, args } = getAuthCommand(memberName, extraArgs);
  const fullArgs = [cmd, ...args];
  let child: ChildProcess;
  const isApiKeyMode = extraArgs?.includes('--api-key') ?? false;

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
      // macOS: Use a complex AppleScript to wait for the window to close and get an exit code.
      // This is memory-hardened by writing the exit code to a temp file.
      (async () => {
        let exitCode = 1; // Default to cancellation
        const tmpFile = path.join(os.tmpdir(), `fleet-auth-exit-${Date.now()}`);
        try {
          // The command to run in the terminal. It must be a single string.
          // It writes its own exit code to a temp file so we can read it later.
          const command = [...fullArgs, `; echo $? > "${tmpFile}"`].join(' ');

          // AppleScript to launch terminal, run command, and wait for it to be "not busy".
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
              // osascript itself failed.
              onExit(1);
              return;
            }
            try {
              const codeStr = await fsPromises.readFile(tmpFile, 'utf-8');
              exitCode = parseInt(codeStr.trim(), 10);
              if (isNaN(exitCode)) exitCode = 1;
            } catch {
              exitCode = 1; // Assume cancellation if file not found (e.g., window closed manually)
            } finally {
              await fsPromises.unlink(tmpFile).catch(() => {});
              onExit(exitCode);
            }
          });
          child.on('error', (err) => {
            logError('auth_socket', `Failed to launch osascript for auth: ${err.message}`);
            onExit(1);
          });
        } catch (e) {
          onExit(1); // Default to cancellation on any unexpected error.
        }
      })();
      return 'launched';
    } else if (platform === 'win32') {
      // Windows: start /wait ensures that the parent cmd.exe process waits for the new
      // terminal window to be closed. This allows us to capture the exit event.
      // The title argument to start is required.
      const spawnArgs = ['/c', 'start', 'Fleet Password Entry', '/wait', ...fullArgs];
      child = spawn('cmd', spawnArgs, { detached: true, stdio: 'ignore' });
      if (child.pid && isApiKeyMode) {
        const pending = pendingRequests.get(memberName);
        if (pending) pending.spawned_pid = child.pid;
      }
    } else {
      // Linux: find available terminal emulator. Most support an execute flag.
      const terminal = findLinuxTerminal();
      if (!terminal) {
        return `fallback:Could not find a terminal emulator. Ask the user to run manually:\n  ${[cmd, ...args].join(' ')}\nAlternatively, pre-store the value with credential_store_set and reference it as {{secure.NAME}} in the credential field.`;
      }
      if (terminal === 'gnome-terminal') {
        child = spawn(terminal, ['--', ...fullArgs], { detached: true, stdio: 'ignore' });
      } else {
        // xterm, x-terminal-emulator etc.
        child = spawn(terminal, ['-e', ...fullArgs], { detached: true, stdio: 'ignore' });
      }
      if (child.pid && isApiKeyMode) {
        const pending = pendingRequests.get(memberName);
        if (pending) pending.spawned_pid = child.pid;
      }
    }

    child.on('close', onExit);
    child.on('error', (err) => {
      logError('auth_socket', `Failed to launch terminal for ${memberName}: ${err.message}`);
      onExit(1); // Treat spawn error as a non-zero exit.
    });
    child.unref();

    return 'launched';
  } catch (err: any) {
    return `fallback:Could not open a terminal window. Ask the user to run manually:\n  ${[cmd, ...args].join(' ')}\nError: ${err.message}\nAlternatively, pre-store the value with credential_store_set and reference it as {{secure.NAME}} in the credential field.`;
  }
}