/**
 * Backoff for service-manager launches that keep failing (GitHub #585
 * recovery). The Windows task has a repeating revive trigger, and every OS
 * service launches at logon; a server that refuses (port held by another app,
 * unresponsive holder -- exit 0 under the service marker, so no crash loop)
 * or crashes at startup would otherwise retry every interval forever, each
 * attempt a new fleet-<pid>.log.
 *
 * State lives in <data dir>/service-start-failures.json. Every service launch
 * counts as a failure until it is listening; a successful start (or finding
 * a healthy server already running) clears it. After MAX_CONSECUTIVE_FAILURES
 * failures in a row, launches are skipped (one line to stdout, exit 0) until
 * BACKOFF_MS has passed since the last attempt. An explicit user start
 * (apra-fleet start/install) clears the state first, so it is never skipped.
 */
import fs from 'node:fs';
import path from 'node:path';
import { FLEET_DIR } from '../paths.js';

export const MAX_CONSECUTIVE_FAILURES = 3;
export const BACKOFF_MS = 30 * 60 * 1000;

export const SERVICE_START_STATE_PATH = path.join(FLEET_DIR, 'service-start-failures.json');

interface GuardState {
  consecutive: number;
  lastAttemptAt: number;
}

function readState(file: string): GuardState | null {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof s?.consecutive === 'number' && typeof s?.lastAttemptAt === 'number') return s;
  } catch { /* absent or corrupt */ }
  return null;
}

/**
 * Skip this launch? Returns the one-line reason when skipping, else null.
 */
export function serviceStartBackoff(file = SERVICE_START_STATE_PATH, now = Date.now()): string | null {
  const s = readState(file);
  if (!s || s.consecutive < MAX_CONSECUTIVE_FAILURES) return null;
  const retryAt = s.lastAttemptAt + BACKOFF_MS;
  if (now >= retryAt) return null;
  return `apra-fleet service launch skipped: the last ${s.consecutive} service starts failed or were refused `
    + `(see the logs in ${path.dirname(file)}); next automatic attempt after ${new Date(retryAt).toISOString()}. `
    + `'apra-fleet start' retries immediately.`;
}

/** Count this launch as a failure until clearServiceStartFailures() runs. */
export function recordServiceStartAttempt(file = SERVICE_START_STATE_PATH, now = Date.now()): void {
  const s = readState(file);
  const next: GuardState = { consecutive: (s?.consecutive ?? 0) + 1, lastAttemptAt: now };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next));
  } catch { /* best-effort: never block a start on the guard */ }
}

export function clearServiceStartFailures(file = SERVICE_START_STATE_PATH): void {
  try { fs.unlinkSync(file); } catch { /* absent */ }
}

export const SERVICE_NOTICE_STATE_PATH = path.join(FLEET_DIR, 'service-notices.json');
export const SERVICE_NOTICE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Rate limit for routine service-launch notices ("already running", "stopped
 * by user -- not starting"): the Windows task's revive trigger fires every 5
 * minutes, which would otherwise append ~288 identical lines a day to the
 * service log. True at most once per interval per kind.
 */
export function shouldLogServiceNotice(
  kind: string, file = SERVICE_NOTICE_STATE_PATH, now = Date.now(), intervalMs = SERVICE_NOTICE_INTERVAL_MS,
): boolean {
  let state: Record<string, number> = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')) ?? {}; } catch { /* absent or corrupt */ }
  const last = state[kind];
  if (typeof last === 'number' && now - last < intervalMs) return false;
  state[kind] = now;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state));
  } catch { /* best-effort */ }
  return true;
}
