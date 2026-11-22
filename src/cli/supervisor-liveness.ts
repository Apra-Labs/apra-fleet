/**
 * Supervisor liveness for `apra-fleet status`, read OUTSIDE the supervisor
 * process from <dataDir>/supervisor.json (the heartbeat record the supervisor
 * rewrites every intervalMs; see packages/apra-fleet-se/src/supervisor/
 * heartbeat.mjs for the writer). Read with node:fs only -- core never imports
 * the fleet-se package, so the record shape is restated here:
 *   { pid, port, beadsDir, version, startedAt, updatedAt, intervalMs, stoppedAt? }
 * A hard kill leaves a record that goes stale / names a dead pid, which is the
 * case the supervisor cannot report itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveSupervisorDataDir } from './fleet-se-guard.js';

export const SUPERVISOR_HEARTBEAT_FILE = 'supervisor.json';
/** A heartbeat older than this many intervals is stale. */
export const STALE_INTERVALS = 3;
const FALLBACK_INTERVAL_MS = 15000;

export type SupervisorLiveness =
  | { state: 'never-started'; file: string }
  | { state: 'unreadable'; file: string; reason: string }
  | { state: 'stopped'; file: string; stoppedAt: string }
  | { state: 'up'; file: string; pid: number; port?: number; updatedAt: string; ageMs: number }
  | { state: 'down'; file: string; pid: number; port?: number; updatedAt: string; ageMs: number; reason: 'stale' | 'pid-dead' };

export interface LivenessDeps {
  dataDir?: string;
  now?: () => number;
  /** true when the pid exists; EPERM counts as alive. */
  isAlive?: (pid: number) => boolean;
}

export function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

export function readSupervisorLiveness(deps: LivenessDeps = {}): SupervisorLiveness {
  const file = path.join(deps.dataDir ?? resolveSupervisorDataDir(), SUPERVISOR_HEARTBEAT_FILE);
  const now = (deps.now ?? Date.now)();
  const isAlive = deps.isAlive ?? pidExists;
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { state: 'never-started', file };
    return { state: 'unreadable', file, reason: (err as Error).message };
  }
  let rec: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
    rec = parsed as Record<string, unknown>;
  } catch (err) {
    return { state: 'unreadable', file, reason: (err as Error).message };
  }
  const updatedMs = typeof rec.updatedAt === 'string' ? Date.parse(rec.updatedAt) : NaN;
  const pid = rec.pid;
  if (!Number.isInteger(pid) || (pid as number) <= 0 || !Number.isFinite(updatedMs)) {
    return { state: 'unreadable', file, reason: 'missing or invalid pid/updatedAt' };
  }
  if (typeof rec.stoppedAt === 'string' && rec.stoppedAt) {
    return { state: 'stopped', file, stoppedAt: rec.stoppedAt };
  }
  const interval = typeof rec.intervalMs === 'number' && rec.intervalMs > 0 ? rec.intervalMs : FALLBACK_INTERVAL_MS;
  const ageMs = Math.max(0, now - updatedMs);
  const port = Number.isInteger(rec.port) ? (rec.port as number) : undefined;
  const base = { file, pid: pid as number, port, updatedAt: rec.updatedAt as string, ageMs };
  if (ageMs > STALE_INTERVALS * interval) return { state: 'down', ...base, reason: 'stale' };
  if (!isAlive(pid as number)) return { state: 'down', ...base, reason: 'pid-dead' };
  return { state: 'up', ...base };
}

function ago(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

/** The single `Supervisor:` status line. */
export function formatSupervisorLine(l: SupervisorLiveness): string {
  const where = (x: { pid: number; port?: number }) => `pid ${x.pid}${x.port ? `, port ${x.port}` : ''}`;
  switch (l.state) {
    case 'never-started': return `  Supervisor: not running (never started; no ${l.file})`;
    case 'unreadable': return `  Supervisor: unreadable (${l.file}: ${l.reason})`;
    case 'stopped': return `  Supervisor: stopped cleanly at ${l.stoppedAt}`;
    case 'up': return `  Supervisor: UP (${where(l)}, last heartbeat ${ago(l.ageMs)})`;
    case 'down': return `  Supervisor: DOWN (${where(l)}; last heartbeat ${l.updatedAt}, ${ago(l.ageMs)}; ${l.reason === 'pid-dead' ? 'pid is no longer running' : 'heartbeat is stale'})`;
  }
}
