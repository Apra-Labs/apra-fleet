import fs from 'node:fs';
import path from 'node:path';
import { FLEET_DIR } from '../paths.js';

let _stream: fs.WriteStream | null = null;
let _activeLogFile: string | null = null;

/** Returns the resolved path of the active log file, or null if logging is unavailable. */
export function getActiveLogFile(): string | null {
  getStream(); // ensure initialised
  return _activeLogFile;
}

function getStream(): fs.WriteStream | null {
  if (_stream) return _stream;
  try {
    const logsDir = path.join(FLEET_DIR, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const logFile = path.join(logsDir, `fleet-${process.pid}.log`);
    _stream = fs.createWriteStream(logFile, { flags: 'a' });
    _activeLogFile = logFile;
  } catch {
    // data dir not available
  }
  return _stream;
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
    const stream = getStream();
    if (!stream) return;
    const line: Record<string, unknown> = { ts: localISOString(), level, tag };
    if (inv !== undefined) line.inv = inv;
    if (agent !== undefined) {
      line.mid = agent.id;
      if (agent.friendlyName) line.mem = agent.friendlyName;
    }
    line.msg = maskedMsg;
    stream.write(JSON.stringify(line) + '\n');
  } catch { /* ignore */ }
}

export function logLine(tag: string, msg: string, agent?: LogAgent): void {
  const maskedMsg = maskSecrets(msg);
  try { console.error(`[fleet] ${tag} ${maskedMsg}`); } catch { /* ignore */ }
  writeLog('info', tag, maskedMsg, agent);
}

export function logWarn(tag: string, msg: string, agent?: LogAgent): void {
  const maskedMsg = maskSecrets(msg);
  try { console.error(`[fleet:warn] ${tag} ${maskedMsg}`); } catch { /* ignore */ }
  writeLog('warn', tag, maskedMsg, agent);
}

export function logError(tag: string, msg: string, agent?: LogAgent): void {
  const maskedMsg = maskSecrets(msg);
  try { console.error(`[fleet:error] ${tag} ${maskedMsg}`); } catch { /* ignore */ }
  writeLog('error', tag, maskedMsg, agent);
}

const LEVEL_PREFIX: Record<'info' | 'warn' | 'error', string> = {
  info:  '[fleet]',
  warn:  '[fleet:warn]',
  error: '[fleet:error]',
};

export class LogScope {
  private readonly inv: string;
  private readonly start: number;
  private readonly tag: string;
  private readonly agent?: LogAgent;

  constructor(tag: string, entryMsg: string, agent?: LogAgent) {
    this.inv   = Math.random().toString(36).slice(2, 7);
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
    try { console.error(`${LEVEL_PREFIX[level]} ${this.tag} ${masked}`); } catch { /* ignore */ }
    writeLog(level, this.tag, masked, this.agent, this.inv);
  }

  private _exit(level: 'info' | 'warn' | 'error', msg: string): void {
    this._emit(level, `${msg} elapsed=${Date.now() - this.start}ms`);
  }
}

export function maskSecrets(text: string): string {
  try {
    return text
      .replace(/\{\{secure\.[a-zA-Z0-9_]{1,64}\}\}/g, '[REDACTED]')
      .replace(/sec:\/\/[a-zA-Z0-9_]+/g, '[REDACTED]');
  } catch {
    return text;
  }
}

export function truncateForLog(text: string, maxLen = 80): string {
  const single = text.replace(/[\n\t]/g, ' ');
  return single.length <= maxLen ? single : single.slice(0, maxLen) + '...';
}
