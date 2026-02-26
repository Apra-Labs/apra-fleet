import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Agent, FleetRegistry } from '../types.js';
import { encryptPassword } from '../utils/crypto.js';

const FLEET_DIR = path.join(os.homedir(), '.claude-fleet');
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

function enforceFilePermissions(filePath: string): void {
  if (process.platform !== 'win32') {
    fs.chmodSync(filePath, 0o600);
  }
}

function loadRegistry(): FleetRegistry {
  ensureFleetDir();
  if (!fs.existsSync(REGISTRY_PATH)) {
    const empty: FleetRegistry = { version: '1.0', agents: [] };
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(empty, null, 2), { mode: 0o600 });
    enforceFilePermissions(REGISTRY_PATH);
    return empty;
  }
  const raw = fs.readFileSync(REGISTRY_PATH, 'utf-8');
  return JSON.parse(raw) as FleetRegistry;
}

function saveRegistry(registry: FleetRegistry): void {
  ensureFleetDir();
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), { mode: 0o600 });
  enforceFilePermissions(REGISTRY_PATH);
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
 * - Remote agents: match any existing remote agent with the same host + normalized folder.
 * Returns true if a duplicate exists.
 */
export function hasDuplicateFolder(
  agentType: 'local' | 'remote',
  folder: string,
  host?: string,
  excludeId?: string,
): boolean {
  const agents = getAllAgents();
  const normalizedFolder = normalizeFolderPath(folder);

  for (const agent of agents) {
    if (excludeId && agent.id === excludeId) continue;

    const agentFolder = normalizeFolderPath(agent.remoteFolder);
    if (agentFolder !== normalizedFolder) continue;

    if (agentType === 'local' && agent.agentType === 'local') {
      return true;
    }
    if (agentType === 'remote' && agent.agentType === 'remote' && agent.host === host) {
      return true;
    }
  }

  return false;
}

export function resetSession(agentId?: string): number {
  const registry = loadRegistry();
  let count = 0;
  for (const agent of registry.agents) {
    if (!agentId || agent.id === agentId) {
      if (agent.sessionId) {
        agent.sessionId = undefined;
        count++;
      }
    }
  }
  saveRegistry(registry);
  return count;
}
