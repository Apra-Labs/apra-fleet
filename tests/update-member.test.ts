import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { updateMember } from '../src/tools/update-member.js';

describe('updateMember', () => {
  beforeEach(() => {
    backupAndResetRegistry();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('warns when cloud fields are passed for a non-cloud member (local)', async () => {
    const agent = makeTestLocalAgent();
    addAgent(agent);

    const result = await updateMember({
      member_id: agent.id,
      cloud_region: 'us-east-1',
    });

    expect(result).toContain('Warning: cloud fields (cloud_region) are ignored for non-cloud members.');
  });

  it('warns with multiple cloud fields (remote)', async () => {
    const agent = makeTestAgent(); // This is a remote, non-cloud agent
    addAgent(agent);

    const result = await updateMember({
      member_name: agent.friendlyName,
      cloud_region: 'us-west-2',
      cloud_profile: 'test-profile',
    });

    expect(result).toContain('Warning: cloud fields (cloud_region, cloud_profile) are ignored for non-cloud members.');
  });

  it('rejects host change that creates a duplicate host+port+folder', async () => {
    const agent1 = makeTestAgent({ id: 'agent-1', host: '10.0.0.1', port: 22, workFolder: '/srv/app' });
    const agent2 = makeTestAgent({ id: 'agent-2', host: '10.0.0.2', port: 22, workFolder: '/srv/app' });
    addAgent(agent1);
    addAgent(agent2);

    // Changing agent2's host to 10.0.0.1 would collide with agent1
    const result = await updateMember({ member_id: agent2.id, host: '10.0.0.1' });
    expect(result).toContain('Another member already uses folder "/srv/app" on host 10.0.0.1:22');
  });

  it('rejects port change that creates a duplicate host+port+folder', async () => {
    const agent1 = makeTestAgent({ id: 'agent-1', host: '10.0.0.1', port: 2222, workFolder: '/srv/app' });
    const agent2 = makeTestAgent({ id: 'agent-2', host: '10.0.0.1', port: 22, workFolder: '/srv/app' });
    addAgent(agent1);
    addAgent(agent2);

    // Changing agent2's port to 2222 would collide with agent1
    const result = await updateMember({ member_id: agent2.id, port: 2222 });
    expect(result).toContain('Another member already uses folder "/srv/app" on host 10.0.0.1:2222');
  });

  it('allows host change when no collision exists', async () => {
    const agent1 = makeTestAgent({ id: 'agent-1', host: '10.0.0.1', port: 22, workFolder: '/srv/app' });
    const agent2 = makeTestAgent({ id: 'agent-2', host: '10.0.0.2', port: 22, workFolder: '/srv/other' });
    addAgent(agent1);
    addAgent(agent2);

    // Changing agent2's host to 10.0.0.1 is fine — different folder
    const result = await updateMember({ member_id: agent2.id, host: '10.0.0.1' });
    expect(result).toContain('Member "test-agent" updated.');
  });

  it('does not trigger uniqueness check on local member when only host-like fields change', async () => {
    const local = makeTestLocalAgent({ workFolder: '/home/user/project' });
    addAgent(local);

    // Updating friendly_name on a local member — no collision check needed
    const result = await updateMember({ member_id: local.id, friendly_name: 'new-name' });
    expect(result).toContain('Member "new-name" updated.');
  });

  it('does not warn when updating a cloud member', async () => {
    const agent = makeTestAgent({ // A remote agent with a cloud property
      cloud: {
        provider: 'aws',
        instanceId: 'i-1234567890abcdef0',
        region: 'us-east-1',
        idleTimeoutMin: 30,
      }
    });
    addAgent(agent);

    const result = await updateMember({
      member_id: agent.id,
      cloud_region: 'eu-central-1',
    });

    expect(result).not.toContain('Warning:');
    expect(result).toContain('Member "test-agent" updated.');
  });
});
