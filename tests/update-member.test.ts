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
