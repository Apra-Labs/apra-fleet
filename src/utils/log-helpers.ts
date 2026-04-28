import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { FLEET_DIR } from '../paths.js';

let _logger: pino.Logger | null = null;

function getLogger(): pino.Logger | null {
  if (_logger) return _logger;
  try {
    const logsDir = path.join(FLEET_DIR, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const logFile = path.join(logsDir, `fleet-${process.pid}.log`);
    const transport = pino.transport({
      target: 'pino-roll',
      options: { file: logFile, size: '10m', limit: { count: 3 } },
    });
    _logger = pino(
      {
        level: 'trace',
        timestamp: () => `,"ts":"${new Date().toISOString()}"`,
        formatters: {
          level(label) { return { level: label }; },
          bindings(b) { return { pid: b.pid }; },
        },
      },
      transport,
    );
  } catch {
    // file logging unavailable (e.g. data dir not yet created during install)
  }
  return _logger;
}

function writeLog(level: 'info' | 'warn' | 'error', tag: string, maskedMsg: string, memberId?: string): void {
  const logger = getLogger();
  if (!logger) return;
  const fields: Record<string, string> = { tag };
  if (memberId !== undefined) fields.member_id = memberId;
  logger[level](fields, maskedMsg);
}

export function logLine(tag: string, msg: string, memberId?: string): void {
  const maskedMsg = maskSecrets(msg);
  console.error(`[fleet] ${tag} ${maskedMsg}`);
  writeLog('info', tag, maskedMsg, memberId);
}

export function logWarn(tag: string, msg: string, memberId?: string): void {
  const maskedMsg = maskSecrets(msg);
  console.error(`[fleet:warn] ${tag} ${maskedMsg}`);
  writeLog('warn', tag, maskedMsg, memberId);
}

export function logError(tag: string, msg: string, memberId?: string): void {
  const maskedMsg = maskSecrets(msg);
  console.error(`[fleet:error] ${tag} ${maskedMsg}`);
  writeLog('error', tag, maskedMsg, memberId);
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
