import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Agent, FleetRegistry } from '../types.js';
import { encryptPassword } from '../utils/crypto.js';
import { enforceOwnerOnly } from '../utils/file-permissions.js';
import { FLEET_DIR } from '../paths.js';
import { assignIcon } from './icons.js';

const LEGACY_FLEET_DIR = path.join(os.homedir(), '.claude-fleet');
const REGISTRY_PATH = path.join(FLEET_DIR, 'registry.json');
const KEYS_DIR = path.join(FLEET_DIR, 'keys');

function ensureFleetDir(): void {
  if (!fs.existsSync(FLEET_DIR)) {
    fs.mkdirSync(FLEET_DIR, { recursive: true, mode: 0o700 });
  }
  if (!fs.existsSync(KEYS_DIR)) {
    fs.mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 });
  }
}


function migrateFromLegacyDir(): void {
  if (fs.existsSync(LEGACY_FLEET_DIR) && !fs.existsSync(FLEET_DIR)) {
    fs.mkdirSync(FLEET_DIR, { recursive: true, mode: 0o700 });
    const entries = fs.readdirSync(LEGACY_FLEET_DIR, { withFileTypes: true });
    for (const entry of entries) {
      const src = path.join(LEGACY_FLEET_DIR, entry.name);
      const dst = path.join(FLEET_DIR, entry.name);
      if (entry.isDirectory()) {
        fs.cpSync(src, dst, { recursive: true });
      } else {
        fs.copyFileSync(src, dst);
      }
    }
    // Fix stored paths that reference the old directory
    const regPath = path.join(FLEET_DIR, 'registry.json');
    if (fs.existsSync(regPath)) {
      const reg = JSON.parse(fs.readFileSync(regPath, 'utf-8')) as FleetRegistry;
      for (const agent of reg.agents) {
        for (const key of Object.keys(agent) as (keyof Agent)[]) {
          const val = agent[key];
          if (typeof val === 'string' && val.includes(LEGACY_FLEET_DIR)) {
            (agent as any)[key] = val.replace(LEGACY_FLEET_DIR, FLEET_DIR);
          }
        }
      }
      fs.writeFileSync(regPath, JSON.stringify(reg, null, 2), { mode: 0o600 });
    }
    process.stderr.write('Migrated data from ~/.claude-fleet/ to ~/.apra-fleet/data/\n');
  }
}

function loadRegistry(): FleetRegistry {
  migrateFromLegacyDir();
  ensureFleetDir();
  if (!fs.existsSync(REGISTRY_PATH)) {
    const empty: FleetRegistry = { version: '1.0', agents: [] };
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(empty, null, 2), { mode: 0o600 });
    enforceOwnerOnly(REGISTRY_PATH);
    return empty;
  }
  const raw = fs.readFileSync(REGISTRY_PATH, 'utf-8');
  const registry = JSON.parse(raw) as FleetRegistry;

  // Backfill icons for legacy registries where agents lack icons.
  // This only triggers a write when at least one agent is missing an icon,
  // which naturally means it runs once (on first load after migration) and
  // becomes a no-op on subsequent loads since all agents will have icons.
  let needsSave = false;
  const usedIcons = registry.agents.map(a => a.icon).filter(Boolean) as string[];
  for (const agent of registry.agents) {
    if (!agent.icon) {
      agent.icon = assignIcon(usedIcons);
      usedIcons.push(agent.icon);
      needsSave = true;
    }
  }
  if (needsSave) saveRegistry(registry);

  return registry;
}

function saveRegistry(registry: FleetRegistry): void {
  ensureFleetDir();
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), { mode: 0o600 });
  enforceOwnerOnly(REGISTRY_PATH);
}

export function getAllAgents(): Agent[] {
  return loadRegistry().agents;
}

export function getAgent(id: string): Agent | undefined {
  return loadRegistry().agents.find(a => a.id === id);
}

export function findAgentByName(name: string): Agent | undefined {
  return loadRegistry().agents.find(
    a => a.friendlyName.toLowerCase() === name.toLowerCase()
  );
}

export function addAgent(agent: Agent): void {
  const registry = loadRegistry();
  registry.agents.push(agent);
  saveRegistry(registry);
}

export function updateAgent(id: string, updates: Partial<Agent>): Agent | undefined {
  const registry = loadRegistry();
  const idx = registry.agents.findIndex(a => a.id === id);
  if (idx === -1) return undefined;
  registry.agents[idx] = { ...registry.agents[idx], ...updates };
  saveRegistry(registry);
  return registry.agents[idx];
}

export function removeAgent(id: string): boolean {
  const registry = loadRegistry();
  const before = registry.agents.length;
  registry.agents = registry.agents.filter(a => a.id !== id);
  if (registry.agents.length === before) return false;
  saveRegistry(registry);
  return true;
}

export function getKeysDir(): string {
  ensureFleetDir();
  return KEYS_DIR;
}

/**
 * Normalize a folder path for comparison: resolve, strip trailing slashes,
 * and lowercase on Windows (case-insensitive filesystem).
 */
function normalizeFolderPath(folder: string): string {
  let normalized = path.resolve(folder);
  // Strip trailing slashes (but keep root "/" or "C:\")
  normalized = normalized.replace(/[\\/]+$/, '') || normalized;
  // Case-insensitive comparison on Windows
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

/**
 * Check if another agent already uses the same folder on the same device.
 * - Local agents: match any existing local agent with the same normalized folder.
 * - Remote agents: match any existing remote agent with the same host + port + normalized folder.
 * Returns true if a duplicate exists.
 */
export function hasDuplicateFolder(
  agentType: 'local' | 'remote',
  folder: string,
  host?: string,
  port?: number,
  excludeId?: string,
): boolean {
  const agents = getAllAgents();
  const normalizedFolder = normalizeFolderPath(folder);

  for (const agent of agents) {
    if (excludeId && agent.id === excludeId) continue;

    const agentFolder = normalizeFolderPath(agent.workFolder);
    if (agentFolder !== normalizedFolder) continue;

    if (agentType === 'local' && agent.agentType === 'local') {
      return true;
    }
    if (agentType === 'remote' && agent.agentType === 'remote' && agent.host === host && agent.port === port) {
      return true;
    }
  }

  return false;
}
