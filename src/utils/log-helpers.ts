import fs from 'node:fs';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { FLEET_DIR, LOG_FILE_PATH } from '../paths.js';
import { redactSecretTokens } from '../services/secret-token.js';
import { ensureOwnerOnlyDir, openOwnerOnlyAppend, restrictToOwner, type OwnerOnlyDeps } from './owner-only-fs.js';

// The server log is written SYNCHRONOUSLY (append-mode fd + fs.writeSync), and
// before the stderr mirror (GitHub #562): a console in QuickEdit selection or
// an undrained stderr pipe blocks console.error forever, and an async
// WriteStream only flushes from the (now blocked) event loop -- the result was
// a frozen server with zero lines in fleet-<pid>.log. A sync append also makes
// a line written just before process.exit durable (shutdown records).
let _fd: number | null = null;
let _activeLogFile: string | null = null;

/** Returns the resolved path of the active log file, or null if logging is unavailable. */
export function getActiveLogFile(): string | null {
  getFd(); // ensure initialised
  return _activeLogFile;
}

/**
 * Open this process's log (<data dir>/logs/fleet-<pid>.log) owner-only, and
 * tighten the data dir, the logs dir and the service log (<data dir>/fleet.log,
 * written by `apra-fleet start` and the OS service manager) to the owner too.
 * Server logs carry member ids, paths and session handles, so they must not be
 * group/world-readable: POSIX dirs 0700 and files 0600 (pre-existing ones are
 * chmod-tightened); Windows strips inherited ACEs and grants only the current
 * user (see owner-only-fs.ts). Returns the open fd and every tightening
 * failure (never fatal: logging must keep working).
 */
export function openOwnerOnlyLog(dataDir: string, pid: number, deps: OwnerOnlyDeps = {}): { fd: number; logFile: string; problems: string[] } {
  const logsDir = path.join(dataDir, 'logs');
  const problems = [...ensureOwnerOnlyDir(dataDir, deps), ...ensureOwnerOnlyDir(logsDir, deps)];
  const logFile = path.join(logsDir, `fleet-${pid}.log`);
  const fd = openOwnerOnlyAppend(logFile, problems, deps);
  const serviceLog = path.join(dataDir, path.basename(LOG_FILE_PATH));
  if (fs.existsSync(serviceLog)) {
    const why = restrictToOwner(serviceLog, 'file', deps);
    if (why) problems.push(why);
  }
  return { fd, logFile, problems };
}

function getFd(): number | null {
  if (_fd !== null) return _fd;
  try {
    const { fd, logFile, problems } = openOwnerOnlyLog(FLEET_DIR, process.pid);
    _fd = fd;
    _activeLogFile = logFile;
    for (const why of problems) {
      appendLogRecord('warn', { tag: 'log', msg: `log permissions: ${why}` });
      try { console.error(`[fleet:warn] log log permissions: ${why}`); } catch { /* ignore */ }
    }
  } catch {
    // data dir not available
  }
  return _fd;
}

/** Close the log fd (the next write reopens it). Used by tests that rotate data dirs. */
export function closeLogFile(): void {
  if (_fd !== null) {
    try { fs.closeSync(_fd); } catch { /* ignore */ }
  }
  _fd = null;
  _activeLogFile = null;
}

function appendLine(text: string): void {
  try {
    const fd = getFd();
    if (fd === null) return;
    fs.writeSync(fd, text);
  } catch { /* ignore */ }
}

/**
 * Append one raw JSON record (ts + level are prepended) to the server log,
 * synchronously and WITHOUT the stderr mirror. For records that must land
 * even when stderr is blocked or the process is about to exit.
 */
export function appendLogRecord(level: 'info' | 'warn' | 'error', record: Record<string, unknown>): void {
  appendLine(JSON.stringify({ ts: localISOString(), level, ...record }) + '\n');
}

type LogAgent = { id: string; friendlyName: string };

function localISOString(): string {
  const now = new Date();
  const off = -now.getTimezoneOffset(); // minutes east of UTC
  const sign = off >= 0 ? '+' : '-';
  const absOff = Math.abs(off);
  const h = String(Math.floor(absOff / 60)).padStart(2, '0');
  const m = String(absOff % 60).padStart(2, '0');
  const local = new Date(now.getTime() + off * 60000);
  return local.toISOString().slice(0, -1) + `${sign}${h}:${m}`;
}

function writeLog(level: 'info' | 'warn' | 'error', tag: string, maskedMsg: string, agent?: LogAgent, inv?: string): void {
  try {
    const line: Record<string, unknown> = { ts: localISOString(), level, tag };
    if (inv !== undefined) line.inv = inv;
    if (agent !== undefined) {
      line.mid = agent.id;
      if (agent.friendlyName) line.mem = agent.friendlyName;
    }
    line.msg = maskedMsg;
    appendLine(JSON.stringify(line) + '\n');
  } catch { /* ignore */ }
}

// Every emitter writes the file line FIRST, then mirrors to stderr (which may block).
export function logLine(tag: string, msg: string, agent?: LogAgent, inv?: string): void {
  const maskedMsg = maskSecrets(msg);
  writeLog('info', tag, maskedMsg, agent, inv);
  try { console.error(`[fleet] ${tag} ${maskedMsg}`); } catch { /* ignore */ }
}

export function logWarn(tag: string, msg: string, agent?: LogAgent): void {
  const maskedMsg = maskSecrets(msg);
  writeLog('warn', tag, maskedMsg, agent);
  try { console.error(`[fleet:warn] ${tag} ${maskedMsg}`); } catch { /* ignore */ }
}

export function logError(tag: string, msg: string, agent?: LogAgent): void {
  const maskedMsg = maskSecrets(msg);
  writeLog('error', tag, maskedMsg, agent);
  try { console.error(`[fleet:error] ${tag} ${maskedMsg}`); } catch { /* ignore */ }
}

const LEVEL_PREFIX: Record<'info' | 'warn' | 'error', string> = {
  info:  '[fleet]',
  warn:  '[fleet:warn]',
  error: '[fleet:error]',
};

const INV_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const INV_LENGTH = 5;

/**
 * Per-invocation correlation id: 5 lowercase base36 chars. CSPRNG, not
 * Math.random -- besides tagging log lines and the prompt instruction, the
 * id names the durable output file a Linux member tees into under the
 * shared /tmp (see durableOutputPath), so it must not be predictable.
 */
export function newInvocationId(): string {
  let id = '';
  for (let i = 0; i < INV_LENGTH; i++) id += INV_ALPHABET[randomInt(INV_ALPHABET.length)];
  return id;
}

export class LogScope {
  private readonly inv: string;
  private readonly start: number;
  private readonly tag: string;
  private readonly agent?: LogAgent;

  constructor(tag: string, entryMsg: string, agent?: LogAgent) {
    this.inv   = newInvocationId();
    this.start = Date.now();
    this.tag   = tag;
    this.agent = agent;
    this._emit('info', entryMsg);
  }

  getInv(): string { return this.inv; }

  info(msg: string):  void { this._emit('info',  msg); }
  warn(msg: string):  void { this._emit('warn',  msg); }
  error(msg: string): void { this._emit('error', msg); }

  ok(msg = 'done'):   void { this._exit('info',  msg); }
  fail(msg: string):  void { this._exit('warn',  msg); }
  abort(msg: string): void { this._exit('error', msg); }

  private _emit(level: 'info' | 'warn' | 'error', msg: string): void {
    const masked = maskSecrets(msg);
    writeLog(level, this.tag, masked, this.agent, this.inv);
    try { console.error(`${LEVEL_PREFIX[level]} ${this.tag} ${masked}`); } catch { /* ignore */ }
  }

  private _exit(level: 'info' | 'warn' | 'error', msg: string): void {
    this._emit(level, `${msg} elapsed=${Date.now() - this.start}ms`);
  }
}

export function maskSecrets(text: string): string {
  try {
    return redactSecretTokens(text)
      .replace(/sec:\/\/[a-zA-Z0-9_]+/g, '[REDACTED]');
  } catch {
    return text;
  }
}

/**
 * Log form of an MCP session id: its first 8 characters. A session id is a
 * bearer-like handle (a full id addresses the session), so log lines carry
 * only this non-reversible prefix -- enough to correlate lines of one session.
 */
export function shortSid(sid: string | null | undefined): string {
  if (!sid) return 'none';
  return sid.length <= 8 ? sid : `${sid.slice(0, 8)}...`;
}

export function truncateForLog(text: string, maxLen = 80): string {
  const single = text.replace(/[\n\t]/g, ' ');
  return single.length <= maxLen ? single : single.slice(0, maxLen) + '...';
}
