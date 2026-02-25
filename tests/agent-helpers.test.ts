import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getAgentOrFail, getAgentOS, formatAgentHost, touchAgent } from '../src/utils/agent-helpers.js';
import { addAgent, getAgent } from '../src/services/registry.js';
import type { Agent } from '../src/types.js';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';

const makeAgent = makeTestAgent;

beforeEach(() => backupAndResetRegistry());
afterEach(() => restoreRegistry());

describe('getAgentOrFail', () => {
  it('returns agent when found', () => {
    const agent = makeAgent({ id: 'found-agent', friendlyName: 'my-agent' });
    addAgent(agent);
    const result = getAgentOrFail('found-agent');
    expect(typeof result).not.toBe('string');
    expect((result as Agent).friendlyName).toBe('my-agent');
  });

  it('returns error string when not found', () => {
    const result = getAgentOrFail('nonexistent');
    expect(typeof result).toBe('string');
    expect(result).toContain('not found');
  });
});

describe('getAgentOS', () => {
  it('returns agent OS when set', () => {
    expect(getAgentOS(makeAgent({ os: 'windows' }))).toBe('windows');
    expect(getAgentOS(makeAgent({ os: 'macos' }))).toBe('macos');
    expect(getAgentOS(makeAgent({ os: 'linux' }))).toBe('linux');
  });

  it('defaults to linux when OS is not set', () => {
    expect(getAgentOS(makeAgent({ os: undefined }))).toBe('linux');
  });
});

describe('formatAgentHost', () => {
  it('returns (local) for local agents', () => {
    expect(formatAgentHost(makeAgent({ agentType: 'local' }))).toBe('(local)');
  });

  it('returns host:port for remote agents', () => {
    expect(formatAgentHost(makeAgent({ host: '10.0.0.1', port: 2222 }))).toBe('10.0.0.1:2222');
  });
});

describe('touchAgent', () => {
  it('updates lastUsed timestamp', () => {
    const agent = makeAgent({ id: 'touch-test' });
    addAgent(agent);

    touchAgent('touch-test');
    const updated = getAgent('touch-test');
    expect(updated!.lastUsed).toBeDefined();
  });

  it('updates sessionId when provided', () => {
    const agent = makeAgent({ id: 'session-test' });
    addAgent(agent);

    touchAgent('session-test', 'new-session-id');
    const updated = getAgent('session-test');
    expect(updated!.sessionId).toBe('new-session-id');
    expect(updated!.lastUsed).toBeDefined();
  });

  it('does not set sessionId when not provided', () => {
    const agent = makeAgent({ id: 'no-session-test', sessionId: 'existing' });
    addAgent(agent);

    touchAgent('no-session-test');
    const updated = getAgent('no-session-test');
    expect(updated!.sessionId).toBe('existing');
  });
});
