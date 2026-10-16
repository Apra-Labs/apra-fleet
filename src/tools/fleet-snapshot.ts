import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { FLEET_DIR } from '../paths.js';
import { getAllAgents } from '../services/registry.js';
import { DEFAULT_ICON } from '../services/icons.js';
import { getStallDetector } from '../services/stall/index.js';
import { serverVersion } from '../version.js';

// fleet_snapshot: the cheap, read-only fleet view the Claude Code fleet-status
// mod polls (plugins/claude-code/fleet-status). Built only from what is already on
// this host -- the registry, the last-known per-member states the statusline
// writer persists, and this process's stall detector. It never probes a
// member over SSH and never writes anything, so polling it every few seconds
// costs a file read. fleet_status stays the live (probing) view.

export const fleetSnapshotSchema = z.object({});

export type SnapshotStatus = 'busy' | 'idle' | 'offline' | 'unknown';

export interface SnapshotMember {
  id: string;
  name: string;
  icon: string;
  category: string | null;
  status: SnapshotStatus;
  /** While busy: seconds since the member's task last showed activity (the
   *  stall detector's clock -- the same figure as statusline's busy(mm:ss)). */
  quietForS?: number;
  reservedBy?: string;
}

export interface FleetSnapshot {
  version: string;
  members: SnapshotMember[];
}

const STATE_PATH = path.join(FLEET_DIR, 'statusline-state.json');

function readStates(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')) as Record<string, string>;
  } catch {
    return {};
  }
}

/** "busy(02:14)" -> busy; anything unrecognised -> unknown. */
function normalizeStatus(raw: string | undefined): SnapshotStatus {
  const base = (raw ?? 'idle').replace(/\(.*\)$/, '').trim().toLowerCase();
  if (base === 'busy' || base === 'idle' || base === 'offline' || base === 'unknown') return base;
  return 'unknown';
}

/** "busy(02:14)" -> 134, "busy(1:02:05)" -> 3725; undefined when absent. */
function parseClock(raw: string | undefined): number | undefined {
  const m = /\((\d+(?::\d{1,2}){1,2})\)$/.exec(raw ?? '');
  if (!m) return undefined;
  return m[1].split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
}

export function buildFleetSnapshot(now: number = Date.now()): FleetSnapshot {
  const states = readStates();
  const stall = getStallDetector();
  const members = getAllAgents().map((a): SnapshotMember => {
    let status = normalizeStatus(states[a.id]);
    const entry = stall.getEntry(a.id);
    if (entry?.stallReported) status = 'unknown';
    const m: SnapshotMember = {
      id: a.id,
      name: a.friendlyName,
      icon: a.icon ?? DEFAULT_ICON,
      category: a.category?.trim() || null,
      status,
    };
    if (status === 'busy' && entry && !entry.provisional) {
      m.quietForS = Math.max(0, Math.round((now - entry.lastActivityAt) / 1000));
    } else if (status === 'busy') {
      // No live entry in this process (the task runs under another server
      // process): fall back to the persisted busy(mm:ss) label.
      const q = parseClock(states[a.id]);
      if (q !== undefined) m.quietForS = q;
    }
    if (a.reservedBy) m.reservedBy = a.reservedBy;
    return m;
  });
  return { version: serverVersion, members };
}

export async function fleetSnapshot(): Promise<string> {
  return JSON.stringify(buildFleetSnapshot());
}
