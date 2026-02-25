import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getAgentOrFail, getAgentOS, touchAgent } from '../src/utils/agent-helpers.js';
import { addAgent, getAgent } from '../src/services/registry.js';
import type { Agent } from '../src/types.js';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';

const makeAgent = makeTestAgent;

beforeEach(() => backupAndResetRegistry());
afterEach(() => restoreRegistry());

describe('getAgentOrFail', () => {
  it('returns agent when found, error string when not', () => {
    const agent = makeAgent({ id: 'found-agent', friendlyName: 'my-agent' });
    addAgent(agent);

    const found = getAgentOrFail('found-agent');
    expect(typeof found).not.toBe('string');
    expect((found as Agent).friendlyName).toBe('my-agent');

    const notFound = getAgentOrFail('nonexistent');
    expect(typeof notFound).toBe('string');
    expect(notFound).toContain('not found');
  });
});

describe('getAgentOS', () => {
  it('defaults to linux when OS is not set', () => {
    expect(getAgentOS(makeAgent({ os: undefined }))).toBe('linux');
  });
});

describe('touchAgent', () => {
  it('updates lastUsed timestamp', () => {
    const agent = makeAgent({ id: 'touch-test' });
    addAgent(agent);

    touchAgent('touch-test');
    expect(getAgent('touch-test')!.lastUsed).toBeDefined();
  });

  it('updates sessionId when provided, preserves when not', () => {
    addAgent(makeAgent({ id: 'sess-test', sessionId: 'existing' }));

    touchAgent('sess-test', 'new-session');
    expect(getAgent('sess-test')!.sessionId).toBe('new-session');

    addAgent(makeAgent({ id: 'no-sess-test', sessionId: 'keep-me' }));
    touchAgent('no-sess-test');
    expect(getAgent('no-sess-test')!.sessionId).toBe('keep-me');
  });
});
