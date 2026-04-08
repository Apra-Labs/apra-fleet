import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import {
  getAllAgents,
  getAgent,
  findAgentByName,
  addAgent,
  updateAgent,
  removeAgent,
  hasDuplicateFolder,
} from '../src/services/registry.js';
import { makeTestAgent, REGISTRY_PATH, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';

const makeAgent = makeTestAgent;

beforeEach(() => backupAndResetRegistry());
afterEach(() => restoreRegistry());

describe('registry CRUD', () => {
  it('adds, retrieves by ID, and retrieves by name', () => {
    const agent = makeAgent({ friendlyName: 'web-server' });
    addAgent(agent);

    expect(getAllAgents()).toHaveLength(1);

    const byId = getAgent(agent.id);
    expect(byId).toBeDefined();
    expect(byId!.friendlyName).toBe('web-server');
  });

  it('returns undefined for unknown agent ID', () => {
    expect(getAgent('nonexistent-id')).toBeUndefined();
  });

  it('finds agent by name (case-insensitive)', () => {
    addAgent(makeAgent({ friendlyName: 'ML-Trainer' }));

    expect(findAgentByName('ml-trainer')).toBeDefined();
    expect(findAgentByName('ML-TRAINER')).toBeDefined();
    expect(findAgentByName('nonexistent')).toBeUndefined();
  });

  it('updates an agent and persists changes', () => {
    const agent = makeAgent({ friendlyName: 'old-name' });
    addAgent(agent);

    const updated = updateAgent(agent.id, { friendlyName: 'new-name', port: 2222 });
    expect(updated!.friendlyName).toBe('new-name');
    expect(updated!.port).toBe(2222);

    expect(getAgent(agent.id)!.friendlyName).toBe('new-name');
  });

  it('returns undefined when updating nonexistent agent', () => {
    expect(updateAgent('fake-id', { friendlyName: 'x' })).toBeUndefined();
  });

  it('removes an agent', () => {
    const agent = makeAgent();
    addAgent(agent);
    expect(removeAgent(agent.id)).toBe(true);
    expect(getAllAgents()).toHaveLength(0);
  });

  it('returns false when removing nonexistent agent', () => {
    expect(removeAgent('fake-id')).toBe(false);
  });
});


describe('registry - security', () => {
  it('does not store plaintext password in agent fields', () => {
    addAgent(makeAgent({ encryptedPassword: 'abc123:def456:789xyz' }));

    const raw = fs.readFileSync(REGISTRY_PATH, 'utf-8');
    expect(raw).toContain('encryptedPassword');
    expect(raw).not.toMatch(/"password"\s*:/);
  });
});

describe('registry - cloud agent storage', () => {
  it('stores and retrieves cloud config in agent', () => {
    const agent = makeAgent({
      cloud: {
        provider: 'aws',
        instanceId: 'i-0abc1234def567890',
        region: 'us-east-1',
        idleTimeoutMin: 30,
      },
    });
    addAgent(agent);

    const retrieved = getAgent(agent.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.cloud).toBeDefined();
    expect(retrieved!.cloud!.instanceId).toBe('i-0abc1234def567890');
    expect(retrieved!.cloud!.region).toBe('us-east-1');
  });

  it('stores cloud config with optional profile', () => {
    const agent = makeAgent({
      cloud: {
        provider: 'aws',
        instanceId: 'i-0abc1234def567890',
        region: 'eu-west-1',
        profile: 'my-profile',
        idleTimeoutMin: 60,
      },
    });
    addAgent(agent);

    const retrieved = getAgent(agent.id);
    expect(retrieved!.cloud!.profile).toBe('my-profile');
    expect(retrieved!.cloud!.idleTimeoutMin).toBe(60);
  });

  it('updates cloud config fields via updateAgent', () => {
    const agent = makeAgent({
      cloud: {
        provider: 'aws',
        instanceId: 'i-0abc1234def567890',
        region: 'us-east-1',
        idleTimeoutMin: 30,
      },
    });
    addAgent(agent);

    const updatedCloud = {
      ...agent.cloud!,
      region: 'us-west-2',
      idleTimeoutMin: 60,
    };
    const updated = updateAgent(agent.id, { cloud: updatedCloud });
    expect(updated!.cloud!.region).toBe('us-west-2');
    expect(updated!.cloud!.idleTimeoutMin).toBe(60);
    expect(updated!.cloud!.instanceId).toBe('i-0abc1234def567890'); // unchanged
  });

  it('persists cloud config to disk and reloads correctly', () => {
    const agent = makeAgent({
      cloud: {
        provider: 'aws',
        instanceId: 'i-0abc1234def567890',
        region: 'us-east-1',
        idleTimeoutMin: 30,
      },
    });
    addAgent(agent);

    // Simulate reload by reading raw registry file
    const raw = fs.readFileSync(REGISTRY_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    const stored = parsed.agents[0];
    expect(stored.cloud).toBeDefined();
    expect(stored.cloud.instanceId).toBe('i-0abc1234def567890');
  });

  it('non-cloud agents have no cloud field', () => {
    const agent = makeAgent(); // no cloud field
    addAgent(agent);
    const retrieved = getAgent(agent.id);
    expect(retrieved!.cloud).toBeUndefined();
  });
});

describe('registry - duplicate folder validation', () => {
  it('detects duplicate local folder', () => {
    addAgent(makeAgent({ id: 'local-1', agentType: 'local', workFolder: '/home/user/project', host: undefined }));
    expect(hasDuplicateFolder('local', '/home/user/project')).toBe(true);
  });

  it('detects duplicate remote host+folder', () => {
    addAgent(makeAgent({ id: 'remote-1', host: '10.0.0.1', workFolder: '/srv/app' }));
    expect(hasDuplicateFolder('remote', '/srv/app', '10.0.0.1', 22)).toBe(true);
  });

  it('allows same folder on different remote hosts', () => {
    addAgent(makeAgent({ id: 'remote-1', host: '10.0.0.1', workFolder: '/srv/app' }));
    expect(hasDuplicateFolder('remote', '/srv/app', '10.0.0.2')).toBe(false);
  });

  it('allows same host+folder on different ports (RPort scenario)', () => {
    addAgent(makeAgent({ id: 'remote-1', host: '10.0.0.1', port: 24091, workFolder: '/home/blub0x' }));
    expect(hasDuplicateFolder('remote', '/home/blub0x', '10.0.0.1', 21870)).toBe(false);
  });

  it('detects duplicate remote host+port+folder', () => {
    addAgent(makeAgent({ id: 'remote-1', host: '10.0.0.1', port: 22, workFolder: '/srv/app' }));
    expect(hasDuplicateFolder('remote', '/srv/app', '10.0.0.1', 22)).toBe(true);
  });

  it('allows same path for local + remote agents', () => {
    addAgent(makeAgent({ id: 'remote-1', host: '10.0.0.1', workFolder: '/home/user/project' }));
    expect(hasDuplicateFolder('local', '/home/user/project')).toBe(false);
  });

  it('normalizes trailing slashes', () => {
    addAgent(makeAgent({ id: 'local-1', agentType: 'local', workFolder: '/home/user/project', host: undefined }));
    expect(hasDuplicateFolder('local', '/home/user/project/')).toBe(true);
  });

  it('excludes agent by ID (for updates)', () => {
    addAgent(makeAgent({ id: 'local-1', agentType: 'local', workFolder: '/home/user/project', host: undefined }));
    expect(hasDuplicateFolder('local', '/home/user/project', undefined, undefined, 'local-1')).toBe(false);
  });

  it('rejects update_agent folder change when duplicate exists', () => {
    addAgent(makeAgent({ id: 'local-1', agentType: 'local', workFolder: '/home/user/project-a', host: undefined }));
    addAgent(makeAgent({ id: 'local-2', agentType: 'local', workFolder: '/home/user/project-b', host: undefined }));

    expect(hasDuplicateFolder('local', '/home/user/project-a', undefined, undefined, 'local-2')).toBe(true);
  });
});
