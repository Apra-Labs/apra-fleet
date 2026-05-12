import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent, getAgent } from '../src/services/registry.js';
import { updateMember } from '../src/tools/update-member.js';

beforeEach(() => backupAndResetRegistry());
afterEach(() => restoreRegistry());

describe('gbrain config — register_member', () => {
  it('agent with gbrain: true persists the field', () => {
    const agent = makeTestAgent({ gbrain: true });
    addAgent(agent);
    const stored = getAgent(agent.id);
    expect(stored?.gbrain).toBe(true);
  });

  it('agent without gbrain field defaults to undefined (falsy)', () => {
    const agent = makeTestAgent();
    addAgent(agent);
    const stored = getAgent(agent.id);
    expect(stored?.gbrain).toBeFalsy();
  });

  it('local agent supports gbrain field', () => {
    const agent = makeTestLocalAgent({ gbrain: true });
    addAgent(agent);
    const stored = getAgent(agent.id);
    expect(stored?.gbrain).toBe(true);
  });
});

describe('gbrain config — update_member', () => {
  it('enables gbrain on an existing member', async () => {
    const agent = makeTestAgent({ gbrain: false });
    addAgent(agent);

    const result = await updateMember({ member_id: agent.id, gbrain: true });
    expect(result).toContain('updated');

    const stored = getAgent(agent.id);
    expect(stored?.gbrain).toBe(true);
  });

  it('disables gbrain on an existing member', async () => {
    const agent = makeTestAgent({ gbrain: true });
    addAgent(agent);

    const result = await updateMember({ member_id: agent.id, gbrain: false });
    expect(result).toContain('updated');

    const stored = getAgent(agent.id);
    expect(stored?.gbrain).toBe(false);
  });
});
