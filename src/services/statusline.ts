import fs from 'node:fs';
import path from 'node:path';
import { FLEET_DIR } from '../paths.js';
import { getAllAgents } from './registry.js';
import { DEFAULT_ICON } from './icons.js';

const STATUSLINE_PATH = path.join(FLEET_DIR, 'statusline.txt');
const STATE_PATH = path.join(FLEET_DIR, 'statusline-state.json');

// Status display emoji
const STATUS_EMOJI: Record<string, string> = {
  busy: '⚡', idle: '💤', verify: '🔍', blocked: '🚫', offline: '❌',
};

// Sort priority: needs-attention first
const PRIORITY: Record<string, number> = { blocked: 0, verify: 1, busy: 2, idle: 3, offline: 4 };

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

/**
 * Update the statusline file.
 * - Overrides are merged into the persisted state (not a full reset).
 * - Agents not in overrides keep their last-known state.
 * - New agents default to 'idle'.
 */
export function writeStatusline(overrides?: Map<string, string>): void {
  try {
    const agents = getAllAgents();
    if (agents.length === 0) return;

    const saved = loadState();

    // Merge overrides into saved state
    if (overrides) {
      for (const [id, status] of overrides) {
        saved[id] = status;
      }
    }

    // Prune agents no longer in registry
    const agentIds = new Set(agents.map(a => a.id));
    for (const id of Object.keys(saved)) {
      if (!agentIds.has(id)) delete saved[id];
    }

    const states = agents.map(a => ({
      icon: a.icon ?? DEFAULT_ICON,
      name: a.friendlyName,
      status: saved[a.id] ?? 'idle',
    }));

    states.sort((a, b) => (PRIORITY[a.status] ?? 99) - (PRIORITY[b.status] ?? 99));

    const line = states
      .map(s => `${s.icon} ${s.name}:${STATUS_EMOJI[s.status] ?? '?'} ${s.status}`)
      .join('  ');

    saveState(saved);
    fs.writeFileSync(STATUSLINE_PATH, line + '\n', { mode: 0o600 });
  } catch { /* best-effort, never break tool execution */ }
}
