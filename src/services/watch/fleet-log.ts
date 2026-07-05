import fs from 'node:fs';
import path from 'node:path';
import { FLEET_DIR } from '../../paths.js';
import type { FormattedEvent } from './transcript-formatter.js';

/**
 * The fleet server writes a structured JSONL activity log per process at
 * FLEET_DIR/logs/fleet-<pid>.log. Every dispatch (execute_command,
 * execute_prompt, send_files, ...) is recorded there locally, tagged with the
 * member (mid/mem) -- for ALL members, local and remote, since the server logs
 * at dispatch time. This is the universal activity spine `watch` tails; remote
 * members' command activity appears here with no ssh2 needed.
 */

/** Operational tags that are noise for a human watching members work. */
const NOISE_TAGS = new Set([
  'stall_poll_tick', 'stall_add', 'stall_remove', 'stall_detector',
  'startup', 'update_check', 'update_available',
]);

/** Newest fleet-<pid>.log (the active server's log), or null. */
export function resolveFleetLogFile(): string | null {
  const logsDir = path.join(FLEET_DIR, 'logs');
  let entries: string[];
  try {
    entries = fs.readdirSync(logsDir).filter((f) => /^fleet-\d+\.log$/.test(f));
  } catch {
    return null;
  }
  let best: string | null = null;
  let bestM = -1;
  for (const f of entries) {
    const full = path.join(logsDir, f);
    try {
      const m = fs.statSync(full).mtimeMs;
      if (m > bestM) { bestM = m; best = full; }
    } catch { /* ignore */ }
  }
  return best;
}

function hhmmss(ts: unknown): string | null {
  if (typeof ts !== 'string') return null;
  const d = new Date(ts);
  if (isNaN(d.getTime())) return null;
  return d.toTimeString().slice(0, 8);
}

function msOf(ts: unknown): number {
  if (typeof ts !== 'string') return 0;
  const d = new Date(ts);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

const isLifecycle = (msg: string): boolean => /^(pid=|exit=|cancelled|done\b)/.test(msg);

/** A parsed fleet-log line: member attribution + rendered display lines. */
export interface FleetLogEntry {
  mid?: string;
  mem?: string;
  events: FormattedEvent[];
}

/**
 * Parse and format one fleet-log JSONL line. Returns null for noise/unparseable
 * lines. Command entries get a marker ($ for shell, > for prompt/transfer);
 * pid/exit lifecycle lines render as dim detail; config events render dim.
 */
export function formatFleetLogLine(raw: string, verbose = false): FleetLogEntry | null {
  const line = raw.trim();
  if (!line) return null;
  let ev: any;
  try { ev = JSON.parse(line); } catch { return null; }
  const tag = typeof ev.tag === 'string' ? ev.tag : '';
  if (!tag || NOISE_TAGS.has(tag)) return null;

  const time = hhmmss(ev.ts);
  const msg = typeof ev.msg === 'string' ? ev.msg : '';
  const isErr = ev.level === 'error';
  const attribution = { mid: typeof ev.mid === 'string' ? ev.mid : undefined, mem: typeof ev.mem === 'string' ? ev.mem : undefined };
  const events: FormattedEvent[] = [];

  const lifecycleDetail = (): void => {
    if (/^pid=/.test(msg)) return; // pid is an internal process detail -- never useful to watch
    events.push({ time: null, marker: '', kind: isErr ? 'del' : 'dim', detail: true, text: `-> ${msg}` });
  };

  switch (tag) {
    case 'execute_command':
      if (isLifecycle(msg)) lifecycleDetail();
      else events.push({ time, marker: '$', kind: 'info', text: msg });
      break;
    case 'execute_prompt':
      if (isLifecycle(msg)) lifecycleDetail();
      else events.push({ time, marker: '>', kind: 'info', text: `LLM ${msg}` });
      break;
    case 'command_output': {
      // Multiline command stdout/stderr, logged by execute_command. Render as
      // dim output detail lines beneath the command.
      const lines = msg.split('\n');
      const CAP = 20;
      for (const l of lines.slice(0, CAP)) {
        events.push({ time: null, marker: '', kind: 'out', detail: true, text: l });
      }
      if (lines.length > CAP) {
        events.push({ time: null, marker: '', kind: 'dim', detail: true, text: `... (${lines.length - CAP} more lines)` });
      }
      break;
    }
    case 'send_files':
    case 'receive_files':
      events.push({ time, marker: '>', kind: 'info', text: `${tag}: ${msg}` });
      break;
    default:
      // config/lifecycle events (register_member, update_member, compose_permissions, ...)
      events.push({ time, marker: '', kind: 'dim', text: `${tag}: ${msg}` });
  }

  return events.length > 0 ? { ...attribution, events } : null;
}

/** Most-recent activity per member from the tail of the fleet log, for the overview. */
export interface RecentActivity { ms: number; text: string; }

/**
 * Scan the tail of the fleet log and return the latest activity per member,
 * keyed by BOTH lowercased member name and member id. Used to show
 * working/idle + a status snippet in the overview (universal, unlike the
 * local-only transcript).
 */
export function readRecentActivity(file: string, tailBytes = 65536): Map<string, RecentActivity> {
  const out = new Map<string, RecentActivity>();
  let text: string;
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - tailBytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    text = buf.toString('utf-8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    const entry = formatFleetLogLine(line);
    if (!entry) continue;
    // recompute ms from the raw line's ts
    let ms = 0;
    try { ms = msOf(JSON.parse(line).ts); } catch { /* ignore */ }
    const snippet = entry.events[0]?.text ?? '';
    const rec: RecentActivity = { ms, text: snippet };
    for (const k of [entry.mem?.toLowerCase(), entry.mid]) {
      if (!k) continue;
      const prev = out.get(k);
      if (!prev || ms >= prev.ms) out.set(k, rec);
    }
  }
  return out;
}
