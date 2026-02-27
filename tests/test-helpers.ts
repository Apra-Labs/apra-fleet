/**
 * Shared test helpers for registry-backed tests.
 * Eliminates duplicated makeAgent/beforeEach/afterEach patterns.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Agent } from '../src/types.js';

export const FLEET_DIR = path.join(os.homedir(), '.claude-fleet');
export const REGISTRY_PATH = path.join(FLEET_DIR, 'registry.json');

let backupContent: string | null = null;

/**
 * Create a test agent with sensible defaults and optional overrides.
 * Works for both remote and local agent tests.
 */
export function makeTestAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    friendlyName: 'test-agent',
    agentType: 'remote',
    host: '192.168.1.100',
    port: 22,
    username: 'testuser',
    authType: 'password',
    encryptedPassword: 'fake-encrypted',
    workFolder: '/home/testuser/project',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Create a local test agent with sensible defaults.
 */
export function makeTestLocalAgent(overrides: Partial<Agent> = {}): Agent {
  return makeTestAgent({
    agentType: 'local',
    host: undefined,
    port: undefined,
    username: undefined,
    authType: undefined,
    encryptedPassword: undefined,
    workFolder: path.join(os.tmpdir(), `fleet-test-${Date.now()}`),
    os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
    ...overrides,
  });
}

/**
 * Back up the existing registry and reset to empty.
 * Call in beforeEach.
 */
export function backupAndResetRegistry(): void {
  if (fs.existsSync(REGISTRY_PATH)) {
    backupContent = fs.readFileSync(REGISTRY_PATH, 'utf-8');
  }
  if (!fs.existsSync(FLEET_DIR)) {
    fs.mkdirSync(FLEET_DIR, { recursive: true });
  }
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify({ version: '1.0', agents: [] }, null, 2));
}

/**
 * Restore the registry from backup.
 * Call in afterEach.
 */
export function restoreRegistry(): void {
  if (backupContent !== null) {
    fs.writeFileSync(REGISTRY_PATH, backupContent);
    backupContent = null;
  } else if (fs.existsSync(REGISTRY_PATH)) {
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify({ version: '1.0', agents: [] }, null, 2));
  }
}
