import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getAgentOrFail, getAgentOS, touchAgent, checkVcsTokenExpiry } from '../src/utils/agent-helpers.js';
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

describe('checkVcsTokenExpiry', () => {
  it('returns null when no expiry is tracked', () => {
    const agent = makeAgent({});
    expect(checkVcsTokenExpiry(agent)).toBeNull();
  });

  it('returns null when token is not near expiry', () => {
    const now = new Date('2026-03-24T10:00:00Z');
    const agent = makeAgent({ vcsTokenExpiresAt: '2026-03-24T11:00:00Z' });
    expect(checkVcsTokenExpiry(agent, now)).toBeNull();
  });

  it('returns warning when token expires within 10 minutes', () => {
    const now = new Date('2026-03-24T10:55:00Z');
    const agent = makeAgent({ vcsTokenExpiresAt: '2026-03-24T11:00:00Z' });
    const result = checkVcsTokenExpiry(agent, now);
    expect(result).toContain('⚠️');
    expect(result).toContain('5 minute');
    expect(result).toContain('consider refreshing');
  });

  it('returns warning when token is expired', () => {
    const now = new Date('2026-03-24T12:00:00Z');
    const agent = makeAgent({ vcsTokenExpiresAt: '2026-03-24T11:00:00Z' });
    const result = checkVcsTokenExpiry(agent, now);
    expect(result).toContain('⚠️');
    expect(result).toContain('expired');
    expect(result).toContain('re-run provision_vcs_auth');
  });

  it('uses singular "minute" for 1 minute remaining', () => {
    const now = new Date('2026-03-24T10:59:30Z');
    const agent = makeAgent({ vcsTokenExpiresAt: '2026-03-24T11:00:00Z' });
    const result = checkVcsTokenExpiry(agent, now);
    expect(result).toContain('1 minute');
    expect(result).not.toContain('1 minutes');
  });
});
