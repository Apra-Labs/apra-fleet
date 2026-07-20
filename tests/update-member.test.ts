import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent, getAllAgents } from '../src/services/registry.js';
import { updateMember } from '../src/tools/update-member.js';
import { credentialSet, credentialDelete } from '../src/services/credential-store.js';
import type { SSHExecResult } from '../src/types.js';

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();
const mockTestConnection = vi.fn();

// Default: connection "fails" so provisionAgents is skipped for tests that don't
// care about it -- keeps the many pre-existing update-member tests from making
// real network calls now that update_member re-provisions agent files for remote
// members. Dedicated provisioning tests below override this per-case.
vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: mockTestConnection,
  }),
}));

const mockUploadContentToHome = vi.fn();
vi.mock('../src/services/sftp.js', () => ({
  uploadContentToHome: (...args: any[]) => mockUploadContentToHome(...args),
}));

describe('updateMember', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    mockExecCommand.mockReset();
    mockTestConnection.mockReset();
    mockUploadContentToHome.mockReset();
    mockTestConnection.mockResolvedValue({ ok: false, error: 'not reachable in this test' });
    mockUploadContentToHome.mockResolvedValue({ success: [], failed: [] });
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('warns when cloud fields are passed for a non-cloud member (local)', async () => {
    const member = makeTestLocalAgent();
    addAgent(member);

    const result = await updateMember({
      member_id: member.id,
      cloud_region: 'us-east-1',
    });

    expect(result).toContain('Warning: cloud fields (cloud_region) are ignored for non-cloud members.');
  });

  it('warns with multiple cloud fields (remote)', async () => {
    const member = makeTestAgent(); // This is a remote, non-cloud member
    addAgent(member);

    const result = await updateMember({
      member_name: member.friendlyName,
      cloud_region: 'us-west-2',
      cloud_profile: 'test-profile',
    });

    expect(result).toContain('Warning: cloud fields (cloud_region, cloud_profile) are ignored for non-cloud members.');
  });

  it('rejects host change that creates a duplicate host+port+folder', async () => {
    const agent1 = makeTestAgent({ id: 'member-1', host: '10.0.0.1', port: 22, workFolder: '/srv/app' });
    const agent2 = makeTestAgent({ id: 'member-2', host: '10.0.0.2', port: 22, workFolder: '/srv/app' });
    addAgent(agent1);
    addAgent(agent2);

    // Changing agent2's host to 10.0.0.1 would collide with agent1
    const result = await updateMember({ member_id: agent2.id, host: '10.0.0.1' });
    expect(result).toContain('Another member already uses folder "/srv/app" on host 10.0.0.1:22');
  });

  it('rejects port change that creates a duplicate host+port+folder', async () => {
    const agent1 = makeTestAgent({ id: 'member-1', host: '10.0.0.1', port: 2222, workFolder: '/srv/app' });
    const agent2 = makeTestAgent({ id: 'member-2', host: '10.0.0.1', port: 22, workFolder: '/srv/app' });
    addAgent(agent1);
    addAgent(agent2);

    // Changing agent2's port to 2222 would collide with agent1
    const result = await updateMember({ member_id: agent2.id, port: 2222 });
    expect(result).toContain('Another member already uses folder "/srv/app" on host 10.0.0.1:2222');
  });

  it('allows host change when no collision exists', async () => {
    const agent1 = makeTestAgent({ id: 'member-1', host: '10.0.0.1', port: 22, workFolder: '/srv/app' });
    const agent2 = makeTestAgent({ id: 'member-2', host: '10.0.0.2', port: 22, workFolder: '/srv/other' });
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

  it('resolves {{secure.NAME}} token in password field', async () => {
    const member = makeTestAgent({ authType: 'password' });
    addAgent(member);

    const credName = `test-cred-${Date.now()}`;
    credentialSet(credName, 'mysecretpass');
    try {
      const result = await updateMember({
        member_id: member.id,
        password: `{{secure.${credName}}}`,
      });
      expect(result).toContain('Member "test-agent" updated.');
    } finally {
      credentialDelete(credName);
    }
  });

  it('returns error when {{secure.NAME}} token references missing credential', async () => {
    const member = makeTestAgent({ authType: 'password' });
    addAgent(member);

    const result = await updateMember({
      member_id: member.id,
      password: '{{secure.nonexistent_cred}}',
    });
    expect(result).toContain('❌ Credential "nonexistent_cred" not found.');
    expect(result).toContain('Member was NOT updated.');
  });

  it('stores a valid category', async () => {
    const member = makeTestLocalAgent();
    addAgent(member);
    const result = await updateMember({ member_id: member.id, category: 'doers' });
    expect(result).toContain('updated');
    const updated = getAllAgents().find(a => a.id === member.id);
    expect(updated?.category).toBe('doers');
  });

  it('clears category when empty string is passed', async () => {
    const member = makeTestLocalAgent({ category: 'doers' });
    addAgent(member);
    const result = await updateMember({ member_id: member.id, category: '' });
    expect(result).toContain('updated');
    const updated = getAllAgents().find(a => a.id === member.id);
    expect(updated?.category).toBeUndefined();
  });

  it('clears category when whitespace-only string is passed', async () => {
    const member = makeTestLocalAgent({ category: 'doers' });
    addAgent(member);
    const result = await updateMember({ member_id: member.id, category: '   ' });
    expect(result).toContain('updated');
    const updated = getAllAgents().find(a => a.id === member.id);
    expect(updated?.category).toBeUndefined();
  });

  it('adds tags to a member', async () => {
    const member = makeTestLocalAgent();
    addAgent(member);
    const result = await updateMember({ member_id: member.id, tags: ['gpu', 'prod'] });
    expect(result).toContain('updated');
    const updated = getAllAgents().find(a => a.id === member.id);
    expect(updated?.tags).toEqual(['gpu', 'prod']);
  });

  it('clears tags when empty array is passed', async () => {
    const member = makeTestLocalAgent({ tags: ['gpu', 'prod'] });
    addAgent(member);
    const result = await updateMember({ member_id: member.id, tags: [] });
    expect(result).toContain('updated');
    const updated = getAllAgents().find(a => a.id === member.id);
    expect(updated?.tags).toBeUndefined();
  });

  it('replaces existing tags with new tags', async () => {
    const member = makeTestLocalAgent({ tags: ['old-tag', 'another-old'] });
    addAgent(member);
    const result = await updateMember({ member_id: member.id, tags: ['new-tag'] });
    expect(result).toContain('updated');
    const updated = getAllAgents().find(a => a.id === member.id);
    expect(updated?.tags).toEqual(['new-tag']);
  });

  it('does not warn when updating a cloud member', async () => {
    const member = makeTestAgent({ // A remote member with a cloud property
      cloud: {
        provider: 'aws',
        instanceId: 'i-1234567890abcdef0',
        region: 'us-east-1',
        idleTimeoutMin: 30,
      }
    });
    addAgent(member);

    const result = await updateMember({
      member_id: member.id,
      cloud_region: 'eu-central-1',
    });

    expect(result).not.toContain('Warning:');
    expect(result).toContain('Member "test-agent" updated.');
  });
});

describe('updateMember -- agent re-provisioning (remote members)', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    mockExecCommand.mockReset();
    mockTestConnection.mockReset();
    mockUploadContentToHome.mockReset();
    mockTestConnection.mockResolvedValue({ ok: false, error: 'not reachable in this test' });
    mockUploadContentToHome.mockResolvedValue({ success: [], failed: [] });
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('re-provisions agent files once connectivity is confirmed', async () => {
    const member = makeTestAgent({ llmProvider: 'claude' });
    addAgent(member);

    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 }); // empty remote dir -> push everything
    mockUploadContentToHome.mockResolvedValue({ success: ['planner.md', 'doer.md'], failed: [] });

    const result = await updateMember({ member_id: member.id, category: 'doers' });

    expect(result).toContain('Member "test-agent" updated.');
    expect(mockUploadContentToHome).toHaveBeenCalled();
    expect(result).toMatch(/Agents:\s+\d+ file\(s\) provisioned/);
  });

  it('appends a warning but still updates when the provisioning probe fails', async () => {
    const member = makeTestAgent({ llmProvider: 'claude' });
    addAgent(member);

    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: 'boom', code: 1 }); // probe fails

    const result = await updateMember({ member_id: member.id, category: 'doers' });

    expect(result).toContain('Member "test-agent" updated.');
    expect(result).toContain('Could not verify remote agent files');
    expect(mockUploadContentToHome).not.toHaveBeenCalled();
  });

  it('re-provisions at the new provider path when llm_provider is switched', async () => {
    const member = makeTestAgent({ llmProvider: 'claude' });
    addAgent(member);

    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    // New provider's remote dir has never been provisioned -- empty probe -> push everything.
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });
    mockUploadContentToHome.mockResolvedValue({ success: ['planner.md'], failed: [] });

    const result = await updateMember({ member_id: member.id, llm_provider: 'gemini' });

    expect(result).toContain('Provider: gemini');
    expect(mockUploadContentToHome).toHaveBeenCalledTimes(1);
    const [, , calledDir] = mockUploadContentToHome.mock.calls[0];
    expect(calledDir).toBe('.gemini/agents');
  });

  it('skips provisioning with a warning when unreachable, but still applies the update', async () => {
    const member = makeTestAgent();
    addAgent(member);

    mockTestConnection.mockResolvedValue({ ok: false, error: 'connection timed out' });

    const result = await updateMember({ member_id: member.id, category: 'doers' });

    expect(result).toContain('Member "test-agent" updated.');
    expect(result).toContain('Could not reach member -- agent files not re-provisioned: connection timed out');
    expect(mockExecCommand).not.toHaveBeenCalled();
    expect(mockUploadContentToHome).not.toHaveBeenCalled();
  });

  it('does not attempt provisioning for local members', async () => {
    const member = makeTestLocalAgent();
    addAgent(member);

    const result = await updateMember({ member_id: member.id, category: 'doers' });

    expect(result).toContain('updated');
    expect(mockTestConnection).not.toHaveBeenCalled();
    expect(mockUploadContentToHome).not.toHaveBeenCalled();
  });

  it('does not attempt a connection or emit a provisioning warning for a codex remote member (no agents dir)', async () => {
    const member = makeTestAgent({ llmProvider: 'codex' });
    addAgent(member);

    const result = await updateMember({ member_id: member.id, category: 'doers' });

    expect(result).toContain('Member "test-agent" updated.');
    expect(mockTestConnection).not.toHaveBeenCalled();
    expect(mockExecCommand).not.toHaveBeenCalled();
    expect(mockUploadContentToHome).not.toHaveBeenCalled();
    expect(result).not.toContain('Could not reach member');
    expect(result).not.toContain('Agents:');
  });

  it('does not attempt a connection or emit a provisioning warning for a copilot remote member (no agents dir)', async () => {
    const member = makeTestAgent({ llmProvider: 'copilot' });
    addAgent(member);

    const result = await updateMember({ member_id: member.id, category: 'doers' });

    expect(result).toContain('Member "test-agent" updated.');
    expect(mockTestConnection).not.toHaveBeenCalled();
    expect(mockExecCommand).not.toHaveBeenCalled();
    expect(mockUploadContentToHome).not.toHaveBeenCalled();
    expect(result).not.toContain('Could not reach member');
  });
});
