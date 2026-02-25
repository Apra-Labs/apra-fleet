import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  getAllAgents,
  getAgent,
  findAgentByName,
  addAgent,
  updateAgent,
  removeAgent,
  resetSession,
  setFleetToken,
  getFleetToken,
} from '../src/services/registry.js';
import type { Agent } from '../src/types.js';

const FLEET_DIR = path.join(os.homedir(), '.claude-fleet');
const REGISTRY_PATH = path.join(FLEET_DIR, 'registry.json');

let backupContent: string | null = null;

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    friendlyName: 'test-agent',
    host: '192.168.1.100',
    port: 22,
    username: 'testuser',
    authType: 'password',
    encryptedPassword: 'fake-encrypted',
    remoteFolder: '/home/testuser/project',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  // Backup existing registry if it exists
  if (fs.existsSync(REGISTRY_PATH)) {
    backupContent = fs.readFileSync(REGISTRY_PATH, 'utf-8');
  }
  // Reset to empty registry
  if (!fs.existsSync(FLEET_DIR)) {
    fs.mkdirSync(FLEET_DIR, { recursive: true });
  }
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify({ version: '1.0', agents: [] }, null, 2));
});

afterEach(() => {
  // Restore original registry
  if (backupContent !== null) {
    fs.writeFileSync(REGISTRY_PATH, backupContent);
    backupContent = null;
  } else if (fs.existsSync(REGISTRY_PATH)) {
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify({ version: '1.0', agents: [] }, null, 2));
  }
});

describe('registry CRUD', () => {
  it('starts with an empty agent list', () => {
    expect(getAllAgents()).toEqual([]);
  });

  it('adds and retrieves an agent', () => {
    const agent = makeAgent({ friendlyName: 'web-server' });
    addAgent(agent);

    const all = getAllAgents();
    expect(all).toHaveLength(1);
    expect(all[0].friendlyName).toBe('web-server');
    expect(all[0].id).toBe(agent.id);
  });

  it('retrieves an agent by ID', () => {
    const agent = makeAgent({ friendlyName: 'by-id-test' });
    addAgent(agent);

    const found = getAgent(agent.id);
    expect(found).toBeDefined();
    expect(found!.friendlyName).toBe('by-id-test');
  });

  it('returns undefined for unknown agent ID', () => {
    expect(getAgent('nonexistent-id')).toBeUndefined();
  });

  it('finds agent by name (case-insensitive)', () => {
    const agent = makeAgent({ friendlyName: 'ML-Trainer' });
    addAgent(agent);

    expect(findAgentByName('ml-trainer')).toBeDefined();
    expect(findAgentByName('ML-TRAINER')).toBeDefined();
    expect(findAgentByName('ML-Trainer')).toBeDefined();
    expect(findAgentByName('nonexistent')).toBeUndefined();
  });

  it('updates an agent', () => {
    const agent = makeAgent({ friendlyName: 'old-name' });
    addAgent(agent);

    const updated = updateAgent(agent.id, { friendlyName: 'new-name', port: 2222 });
    expect(updated).toBeDefined();
    expect(updated!.friendlyName).toBe('new-name');
    expect(updated!.port).toBe(2222);

    // Verify persisted
    const fetched = getAgent(agent.id);
    expect(fetched!.friendlyName).toBe('new-name');
    expect(fetched!.port).toBe(2222);
  });

  it('returns undefined when updating nonexistent agent', () => {
    expect(updateAgent('fake-id', { friendlyName: 'x' })).toBeUndefined();
  });

  it('removes an agent', () => {
    const agent = makeAgent();
    addAgent(agent);
    expect(getAllAgents()).toHaveLength(1);

    const removed = removeAgent(agent.id);
    expect(removed).toBe(true);
    expect(getAllAgents()).toHaveLength(0);
  });

  it('returns false when removing nonexistent agent', () => {
    expect(removeAgent('fake-id')).toBe(false);
  });

  it('handles multiple agents', () => {
    addAgent(makeAgent({ friendlyName: 'agent-1' }));
    addAgent(makeAgent({ friendlyName: 'agent-2' }));
    addAgent(makeAgent({ friendlyName: 'agent-3' }));

    expect(getAllAgents()).toHaveLength(3);
  });
});

describe('registry - sessions', () => {
  it('resets session for a single agent', () => {
    const agent = makeAgent({ sessionId: 'session-abc-123' });
    addAgent(agent);

    const count = resetSession(agent.id);
    expect(count).toBe(1);
    expect(getAgent(agent.id)!.sessionId).toBeUndefined();
  });

  it('resets sessions for all agents', () => {
    addAgent(makeAgent({ id: 'a1', sessionId: 'sess-1' }));
    addAgent(makeAgent({ id: 'a2', sessionId: 'sess-2' }));
    addAgent(makeAgent({ id: 'a3' })); // no session

    const count = resetSession();
    expect(count).toBe(2);
    expect(getAgent('a1')!.sessionId).toBeUndefined();
    expect(getAgent('a2')!.sessionId).toBeUndefined();
  });

  it('returns 0 when no sessions to reset', () => {
    addAgent(makeAgent({ id: 'a1' }));
    expect(resetSession()).toBe(0);
  });
});

describe('registry - fleet token', () => {
  it('stores and retrieves fleet token', () => {
    setFleetToken('my-fleet-token-123');
    expect(getFleetToken()).toBe('my-fleet-token-123');
  });

  it('overwrites previous fleet token', () => {
    setFleetToken('token-1');
    setFleetToken('token-2');
    expect(getFleetToken()).toBe('token-2');
  });
});

describe('registry - JSON file integrity', () => {
  it('persists to a valid JSON file', () => {
    const agent = makeAgent({ friendlyName: 'json-check' });
    addAgent(agent);

    const raw = fs.readFileSync(REGISTRY_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe('1.0');
    expect(parsed.agents).toHaveLength(1);
    expect(parsed.agents[0].friendlyName).toBe('json-check');
  });

  it('does not store plaintext password in agent fields', () => {
    const agent = makeAgent({
      encryptedPassword: 'abc123:def456:789xyz',
      friendlyName: 'password-check',
    });
    addAgent(agent);

    const raw = fs.readFileSync(REGISTRY_PATH, 'utf-8');
    // The field is "encryptedPassword", not "password"
    expect(raw).toContain('encryptedPassword');
    expect(raw).not.toMatch(/"password"\s*:/);
  });
});
