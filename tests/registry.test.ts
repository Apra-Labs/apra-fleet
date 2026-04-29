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
    const member = makeAgent({ friendlyName: 'web-server' });
    addAgent(member);

    expect(getAllAgents()).toHaveLength(1);

    const byId = getAgent(member.id);
    expect(byId).toBeDefined();
    expect(byId!.friendlyName).toBe('web-server');
  });

  it('returns undefined for unknown member ID', () => {
    expect(getAgent('nonexistent-id')).toBeUndefined();
  });

  it('finds member by name (case-insensitive)', () => {
    addAgent(makeAgent({ friendlyName: 'ML-Trainer' }));

    expect(findAgentByName('ml-trainer')).toBeDefined();
    expect(findAgentByName('ML-TRAINER')).toBeDefined();
    expect(findAgentByName('nonexistent')).toBeUndefined();
  });

  it('updates an member and persists changes', () => {
    const member = makeAgent({ friendlyName: 'old-name' });
    addAgent(member);

    const updated = updateAgent(member.id, { friendlyName: 'new-name', port: 2222 });
    expect(updated!.friendlyName).toBe('new-name');
    expect(updated!.port).toBe(2222);

    expect(getAgent(member.id)!.friendlyName).toBe('new-name');
  });

  it('returns undefined when updating nonexistent member', () => {
    expect(updateAgent('fake-id', { friendlyName: 'x' })).toBeUndefined();
  });

  it('removes an member', () => {
    const member = makeAgent();
    addAgent(member);
    expect(removeAgent(member.id)).toBe(true);
    expect(getAllAgents()).toHaveLength(0);
  });

  it('returns false when removing nonexistent member', () => {
    expect(removeAgent('fake-id')).toBe(false);
  });
});


describe('registry - security', () => {
  it('does not store plaintext password in member fields', () => {
    addAgent(makeAgent({ encryptedPassword: 'abc123:def456:789xyz' }));

    const raw = fs.readFileSync(REGISTRY_PATH, 'utf-8');
    expect(raw).toContain('encryptedPassword');
    expect(raw).not.toMatch(/"password"\s*:/);
  });
});

describe('registry - cloud member storage', () => {
  it('stores and retrieves cloud config in member', () => {
    const member = makeAgent({
      cloud: {
        provider: 'aws',
        instanceId: 'i-0abc1234def567890',
        region: 'us-east-1',
        idleTimeoutMin: 30,
      },
    });
    addAgent(member);

    const retrieved = getAgent(member.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.cloud).toBeDefined();
    expect(retrieved!.cloud!.instanceId).toBe('i-0abc1234def567890');
    expect(retrieved!.cloud!.region).toBe('us-east-1');
  });

  it('stores cloud config with optional profile', () => {
    const member = makeAgent({
      cloud: {
        provider: 'aws',
        instanceId: 'i-0abc1234def567890',
        region: 'eu-west-1',
        profile: 'my-profile',
        idleTimeoutMin: 60,
      },
    });
    addAgent(member);

    const retrieved = getAgent(member.id);
    expect(retrieved!.cloud!.profile).toBe('my-profile');
    expect(retrieved!.cloud!.idleTimeoutMin).toBe(60);
  });

  it('updates cloud config fields via updateAgent', () => {
    const member = makeAgent({
      cloud: {
        provider: 'aws',
        instanceId: 'i-0abc1234def567890',
        region: 'us-east-1',
        idleTimeoutMin: 30,
      },
    });
    addAgent(member);

    const updatedCloud = {
      ...member.cloud!,
      region: 'us-west-2',
      idleTimeoutMin: 60,
    };
    const updated = updateAgent(member.id, { cloud: updatedCloud });
    expect(updated!.cloud!.region).toBe('us-west-2');
    expect(updated!.cloud!.idleTimeoutMin).toBe(60);
    expect(updated!.cloud!.instanceId).toBe('i-0abc1234def567890'); // unchanged
  });

  it('persists cloud config to disk and reloads correctly', () => {
    const member = makeAgent({
      cloud: {
        provider: 'aws',
        instanceId: 'i-0abc1234def567890',
        region: 'us-east-1',
        idleTimeoutMin: 30,
      },
    });
    addAgent(member);

    // Simulate reload by reading raw registry file
    const raw = fs.readFileSync(REGISTRY_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    const stored = parsed.agents[0];
    expect(stored.cloud).toBeDefined();
    expect(stored.cloud.instanceId).toBe('i-0abc1234def567890');
  });

  it('non-cloud agents have no cloud field', () => {
    const member = makeAgent(); // no cloud field
    addAgent(member);
    const retrieved = getAgent(member.id);
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

  it('excludes member by ID (for updates)', () => {
    addAgent(makeAgent({ id: 'local-1', agentType: 'local', workFolder: '/home/user/project', host: undefined }));
    expect(hasDuplicateFolder('local', '/home/user/project', undefined, undefined, 'local-1')).toBe(false);
  });

  it('rejects update_agent folder change when duplicate exists', () => {
    addAgent(makeAgent({ id: 'local-1', agentType: 'local', workFolder: '/home/user/project-a', host: undefined }));
    addAgent(makeAgent({ id: 'local-2', agentType: 'local', workFolder: '/home/user/project-b', host: undefined }));

    expect(hasDuplicateFolder('local', '/home/user/project-a', undefined, undefined, 'local-2')).toBe(true);
  });
});
