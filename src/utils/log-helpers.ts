import fs from 'node:fs';
import path from 'node:path';
import { FLEET_DIR } from '../paths.js';

let _stream: fs.WriteStream | null = null;

function getStream(): fs.WriteStream | null {
  if (_stream) return _stream;
  try {
    const logsDir = path.join(FLEET_DIR, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const logFile = path.join(logsDir, `fleet-${process.pid}.log`);
    _stream = fs.createWriteStream(logFile, { flags: 'a' });
  } catch {
    // data dir not available
  }
  return _stream;
}

function writeLog(level: 'info' | 'warn' | 'error', tag: string, maskedMsg: string, memberId?: string, memberName?: string): void {
  const stream = getStream();
  if (!stream) return;
  const line: Record<string, unknown> = { ts: new Date().toISOString(), level, tag };
  if (memberId !== undefined) line.mid = memberId;
  if (memberName !== undefined) line.mem = memberName;
  line.msg = maskedMsg;
  stream.write(JSON.stringify(line) + '\n');
}

export function logLine(tag: string, msg: string, memberId?: string, memberName?: string): void {
  const maskedMsg = maskSecrets(msg);
  console.error(`[fleet] ${tag} ${maskedMsg}`);
  writeLog('info', tag, maskedMsg, memberId, memberName);
}

export function logWarn(tag: string, msg: string, memberId?: string, memberName?: string): void {
  const maskedMsg = maskSecrets(msg);
  console.error(`[fleet:warn] ${tag} ${maskedMsg}`);
  writeLog('warn', tag, maskedMsg, memberId, memberName);
}

export function logError(tag: string, msg: string, memberId?: string, memberName?: string): void {
  const maskedMsg = maskSecrets(msg);
  console.error(`[fleet:error] ${tag} ${maskedMsg}`);
  writeLog('error', tag, maskedMsg, memberId, memberName);
}

export function maskSecrets(text: string): string {
  return text
    .replace(/\{\{secure\.[a-zA-Z0-9_]{1,64}\}\}/g, '[REDACTED]')
    .replace(/sec:\/\/[a-zA-Z0-9_]+/g, '[REDACTED]');
}

export function truncateForLog(text: string, maxLen = 80): string {
  const single = text.replace(/[\n\t]/g, ' ');
  return single.length <= maxLen ? single : single.slice(0, maxLen) + '...';
}
