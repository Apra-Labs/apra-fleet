import fs from 'node:fs';
import path from 'node:path';
import { FLEET_DIR } from '../paths.js';
import { getAllAgents } from './registry.js';
import { DEFAULT_ICON } from './icons.js';
import { groupByCategory } from '../utils/agent-helpers.js';

const STATUSLINE_PATH = path.join(FLEET_DIR, 'statusline.txt');
const STATE_PATH = path.join(FLEET_DIR, 'statusline-state.json');
// Sidecar: agentId -> pid of the server process that last wrote a busy status
// for it. Lets a reader tell a live busy from one persisted by a server that
// has since died (crash/restart mid-task). Kept separate so the state file's
// Record<string, string> shape is unchanged for its readers.
const OWNERS_PATH = path.join(FLEET_DIR, 'statusline-owners.json');

// Status display emoji — keyed on base status (without parenthetical suffix)
const STATUS_EMOJI: Record<string, string> = {
  busy: '⚡', idle: '💤', offline: '❌', unknown: '❓',
};

// Sort priority: needs-attention first
// unknown sits above busy: stall detected, PM needs to act
const PRIORITY: Record<string, number> = { unknown: 0, busy: 1, idle: 2, offline: 3 };

/** Strip parenthetical suffix from status for emoji/priority lookup: "busy(02:14)" → "busy". */
function baseStatus(status: string): string {
  return status.replace(/\(.*\)$/, '');
}

/** Load last-known per-agent states from disk. */
function loadState(): Record<string, string> {
  try {
    if (fs.existsSync(STATE_PATH)) {
      return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
    }
  } catch { /* corrupted file, start fresh */ }
  return {};
}

/** Persist per-agent states to disk. */
function saveState(state: Record<string, string>): void {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state), { mode: 0o600 });
}

function loadOwners(): Record<string, number> {
  try {
    if (fs.existsSync(OWNERS_PATH)) {
      return JSON.parse(fs.readFileSync(OWNERS_PATH, 'utf-8'));
    }
  } catch { /* corrupted file, start fresh */ }
  return {};
}

function saveOwners(owners: Record<string, number>): void {
  fs.writeFileSync(OWNERS_PATH, JSON.stringify(owners), { mode: 0o600 });
}

function isBusyStatus(status: string | undefined): boolean {
  return status !== undefined && baseStatus(status) === 'busy';
}

/** True when a process with this pid exists (EPERM = exists, not ours). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

/**
 * True when the persisted status for `agentId` is busy but the server process
 * that wrote it is known to be dead -- a busy no live process can ever clear.
 * A busy with no recorded owner (written before owners were tracked) is not
 * judged here; startup reconciliation handles it.
 */
export function isOrphanedBusy(agentId: string): boolean {
  if (!isBusyStatus(loadState()[agentId])) return false;
  const owner = loadOwners()[agentId];
  return owner !== undefined && !isPidAlive(owner);
}

/**
 * Startup reconciliation: a fresh server holds no in-flight work, so any
 * persisted busy whose owner is missing, dead, or this very pid (reuse) was
 * left by a server that died mid-task. Reset those to idle. Busy entries
 * owned by another live server process are kept. Returns the reset ids.
 */
export function reconcileStaleBusy(): string[] {
  try {
    const state = loadState();
    const owners = loadOwners();
    const stale = Object.keys(state).filter(id => {
      if (!isBusyStatus(state[id])) return false;
      const owner = owners[id];
      return owner === undefined || owner === process.pid || !isPidAlive(owner);
    });
    if (stale.length > 0) writeStatusline(new Map(stale.map(id => [id, 'idle'])));
    return stale;
  } catch {
    return [];
  }
}

/** Return the last-known status for an agent (defaults to 'idle'). */
export function readMemberStatus(agentId: string): string {
  return loadState()[agentId] ?? 'idle';
}

/**
 * Update the statusline file.
 * - Overrides are merged into the persisted state (not a full reset).
 * - Agents not in overrides keep their last-known state.
 * - New agents default to 'idle'.
 *
 * Called with NO overrides it only RE-RENDERS (registry changes: names, icons,
 * added/removed members). It never clears a member's busy -- to end a busy
 * period pass an explicit status, or use markBusy() (member-busy.ts), whose
 * release always writes one.
 */
export function writeStatusline(overrides?: Map<string, string>): void {
  try {
    const agents = getAllAgents();
    if (agents.length === 0) {
      // #39: clear statusline + per-agent state when last member is removed,
      // otherwise the stale icon lingers under Claude's input.
      if (fs.existsSync(STATUSLINE_PATH)) {
        fs.writeFileSync(STATUSLINE_PATH, '\n', { mode: 0o600 });
      }
      if (fs.existsSync(STATE_PATH)) {
        fs.writeFileSync(STATE_PATH, '{}', { mode: 0o600 });
      }
      if (fs.existsSync(OWNERS_PATH)) saveOwners({});
      return;
    }

    const saved = loadState();
    const owners = loadOwners();
    let ownersChanged = false;

    // Merge overrides into saved state; a busy write records this process as
    // its owner, any other status drops the owner.
    if (overrides) {
      for (const [id, status] of overrides) {
        saved[id] = status;
        if (isBusyStatus(status)) {
          if (owners[id] !== process.pid) { owners[id] = process.pid; ownersChanged = true; }
        } else if (id in owners) {
          delete owners[id];
          ownersChanged = true;
        }
      }
    }

    // Prune agents no longer in registry
    const agentIds = new Set(agents.map(a => a.id));
    for (const id of Object.keys(saved)) {
      if (!agentIds.has(id)) delete saved[id];
    }
    for (const id of Object.keys(owners)) {
      if (!agentIds.has(id)) { delete owners[id]; ownersChanged = true; }
    }

    const states = agents.map(a => ({
      icon: a.icon ?? DEFAULT_ICON,
      name: a.friendlyName,
      status: saved[a.id] ?? 'idle',
      category: a.category?.trim() || '(uncategorized)',
    }));

    // Group by category, sort within each group by priority
    const { grouped, sortedKeys } = groupByCategory(states, s => s.category);
    for (const members of grouped.values()) {
      members.sort((a, b) => (PRIORITY[baseStatus(a.status)] ?? 99) - (PRIORITY[baseStatus(b.status)] ?? 99));
    }
    const categoryParts: string[] = [];
    for (const category of sortedKeys) {
      const members = grouped.get(category)!;
      const membersStr = members
        .map(s => `${s.icon} ${s.name}:${STATUS_EMOJI[baseStatus(s.status)] ?? '?'} ${s.status}`)
        .join('  ');
      categoryParts.push(`[${category}]: ${membersStr}`);
    }
    const line = categoryParts.join('  |  ');

    saveState(saved);
    if (ownersChanged) saveOwners(owners);
    fs.writeFileSync(STATUSLINE_PATH, line + '\n', { mode: 0o600 });
  } catch { /* best-effort, never break tool execution */ }
}
