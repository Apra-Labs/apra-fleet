/**
 * "Stopped by user" marker (GitHub #585 recovery). `apra-fleet stop` writes
 * <data dir>/stopped-by-user.json; `apra-fleet start`, `apra-fleet install`
 * and any successful server start clear it. While it is present, clients
 * (packages/apra-fleet-client auto-start, including a reconnecting
 * long-lived client) do NOT start the server: they fail with an actionable
 * error instead, so a deliberate stop is never silently undone. The client
 * reads the same file name and fields -- keep them in sync with
 * packages/apra-fleet-client/src/client/auto-start.mjs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FLEET_DIR } from '../paths.js';

export const STOPPED_BY_USER_FILE = 'stopped-by-user.json';
export const STOPPED_MARKER_PATH = path.join(FLEET_DIR, STOPPED_BY_USER_FILE);

export interface StoppedMarker {
  stoppedAt: string;
  /** The command that stopped it, e.g. "apra-fleet stop". */
  by: string;
  user: string;
  host: string;
  pid: number;
}

function currentUser(): string {
  try { return os.userInfo().username; } catch { return process.env.USERNAME || process.env.USER || 'unknown'; }
}

export function writeStoppedMarker(by = 'apra-fleet stop', file = STOPPED_MARKER_PATH, now = new Date()): StoppedMarker {
  const marker: StoppedMarker = { stoppedAt: now.toISOString(), by, user: currentUser(), host: os.hostname(), pid: process.pid };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(marker, null, 2));
  } catch { /* best-effort: never fail a stop on the marker */ }
  return marker;
}

export function readStoppedMarker(file = STOPPED_MARKER_PATH): StoppedMarker | null {
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    return m && typeof m.stoppedAt === 'string' ? m : null;
  } catch {
    return null;
  }
}

export function clearStoppedMarker(file = STOPPED_MARKER_PATH): void {
  try { fs.unlinkSync(file); } catch { /* absent */ }
}

/** One-line description for status output. */
export function describeStoppedMarker(m: StoppedMarker): string {
  return `stopped by ${m.user} at ${m.stoppedAt} via '${m.by}' -- run 'apra-fleet start'`;
}
