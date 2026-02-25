import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
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
  hasDuplicateFolder,
} from '../src/services/registry.js';
import { makeTestAgent, REGISTRY_PATH, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';

const makeAgent = makeTestAgent;

beforeEach(() => backupAndResetRegistry());
afterEach(() => restoreRegistry());

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
  it('stores and retrieves fleet token (encrypted)', () => {
    setFleetToken('my-fleet-token-123');
    expect(getFleetToken()).toBe('my-fleet-token-123');

    // Verify it's stored encrypted, not plaintext
    const raw = fs.readFileSync(REGISTRY_PATH, 'utf-8');
    expect(raw).not.toContain('my-fleet-token-123');
    expect(raw).toContain('encryptedFleetToken');
  });

  it('overwrites previous fleet token', () => {
    setFleetToken('token-1');
    setFleetToken('token-2');
    expect(getFleetToken()).toBe('token-2');
  });

  it('migrates legacy plaintext fleetToken on read', () => {
    // Write a registry with legacy plaintext token
    const registry = { version: '1.0', agents: [], fleetToken: 'legacy-plain-token' };
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));

    // Reading should return the token and migrate it
    expect(getFleetToken()).toBe('legacy-plain-token');

    // After migration, plaintext should be gone
    const raw = fs.readFileSync(REGISTRY_PATH, 'utf-8');
    expect(raw).not.toContain('"fleetToken"');
    expect(raw).toContain('encryptedFleetToken');
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

describe('registry - duplicate folder validation', () => {
  it('detects duplicate local folder', () => {
    addAgent(makeAgent({
      id: 'local-1',
      agentType: 'local',
      remoteFolder: '/home/user/project',
      host: undefined,
    }));

    expect(hasDuplicateFolder('local', '/home/user/project')).toBe(true);
  });

  it('detects duplicate remote host+folder', () => {
    addAgent(makeAgent({
      id: 'remote-1',
      agentType: 'remote',
      host: '10.0.0.1',
      remoteFolder: '/srv/app',
    }));

    expect(hasDuplicateFolder('remote', '/srv/app', '10.0.0.1')).toBe(true);
  });

  it('allows same folder on different remote hosts', () => {
    addAgent(makeAgent({
      id: 'remote-1',
      agentType: 'remote',
      host: '10.0.0.1',
      remoteFolder: '/srv/app',
    }));

    expect(hasDuplicateFolder('remote', '/srv/app', '10.0.0.2')).toBe(false);
  });

  it('allows same path for local + remote agents', () => {
    addAgent(makeAgent({
      id: 'remote-1',
      agentType: 'remote',
      host: '10.0.0.1',
      remoteFolder: '/home/user/project',
    }));

    // A local agent with the same path should be allowed (different device scope)
    expect(hasDuplicateFolder('local', '/home/user/project')).toBe(false);
  });

  it('normalizes trailing slashes', () => {
    addAgent(makeAgent({
      id: 'local-1',
      agentType: 'local',
      remoteFolder: '/home/user/project',
      host: undefined,
    }));

    // With trailing slash should still match
    expect(hasDuplicateFolder('local', '/home/user/project/')).toBe(true);
  });

  it('excludes agent by ID (for updates)', () => {
    addAgent(makeAgent({
      id: 'local-1',
      agentType: 'local',
      remoteFolder: '/home/user/project',
      host: undefined,
    }));

    // Excluding the same agent should not be a duplicate
    expect(hasDuplicateFolder('local', '/home/user/project', undefined, 'local-1')).toBe(false);
  });

  it('returns false when no agents exist', () => {
    expect(hasDuplicateFolder('local', '/any/path')).toBe(false);
    expect(hasDuplicateFolder('remote', '/any/path', 'host')).toBe(false);
  });

  it('rejects update_agent folder change when duplicate exists', () => {
    addAgent(makeAgent({
      id: 'local-1',
      agentType: 'local',
      remoteFolder: '/home/user/project-a',
      host: undefined,
    }));
    addAgent(makeAgent({
      id: 'local-2',
      agentType: 'local',
      remoteFolder: '/home/user/project-b',
      host: undefined,
    }));

    // local-2 trying to move to local-1's folder should be detected
    expect(hasDuplicateFolder('local', '/home/user/project-a', undefined, 'local-2')).toBe(true);
  });
});
