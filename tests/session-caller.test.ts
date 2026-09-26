import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFindBySessionId, mockGetAgentOrFail } = vi.hoisted(() => ({
  mockFindBySessionId: vi.fn(),
  mockGetAgentOrFail: vi.fn(),
}));

vi.mock('../src/services/session-registry.js', () => ({
  sessionRegistry: { findBySessionId: mockFindBySessionId },
}));

vi.mock('../src/utils/agent-helpers.js', () => ({
  getAgentOrFail: mockGetAgentOrFail,
}));

import { resolveSessionCaller } from '../src/utils/session-caller.js';

beforeEach(() => {
  mockFindBySessionId.mockReset();
  mockGetAgentOrFail.mockReset();
});

describe('resolveSessionCaller', () => {
  it('returns operator scope when there is no session id', () => {
    expect(resolveSessionCaller()).toEqual({ identity: '*' });
    expect(resolveSessionCaller(undefined)).toEqual({ identity: '*' });
    expect(mockFindBySessionId).not.toHaveBeenCalled();
  });

  it('returns a synthetic session identity when the session is unknown', () => {
    mockFindBySessionId.mockReturnValue(undefined);
    expect(resolveSessionCaller('sid-missing')).toEqual({
      sessionId: 'sid-missing',
      identity: 'session:sid-missing',
    });
  });

  it('returns the member friendly name when the session and agent resolve', () => {
    const session = { member_id: 'uuid-1', workspace_id: 'ws-1' };
    mockFindBySessionId.mockReturnValue(session);
    mockGetAgentOrFail.mockReturnValue({ friendlyName: 'worker-1' });

    expect(resolveSessionCaller('sid-ok')).toEqual({
      sessionId: 'sid-ok',
      session,
      agent: { friendlyName: 'worker-1' },
      identity: 'worker-1',
    });
  });

  it('does not fall back to a raw member UUID when the agent is gone', () => {
    const session = { member_id: 'uuid-gone', workspace_id: 'ws-1' };
    mockFindBySessionId.mockReturnValue(session);
    mockGetAgentOrFail.mockReturnValue('Member "uuid-gone" not found.');

    expect(resolveSessionCaller('sid-stale')).toEqual({
      sessionId: 'sid-stale',
      session,
      identity: 'session:sid-stale',
    });
  });
});
