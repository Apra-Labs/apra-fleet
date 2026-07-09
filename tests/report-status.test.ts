import { describe, it, expect, vi, afterEach } from 'vitest';
import { reportStatus, reportStatusSchema } from '../src/tools/report-status.js';
import { sessionRegistry, type SessionState } from '../src/services/session-registry.js';
import { fleetEvents } from '../src/services/event-bus.js';

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    member_id: 'member-1',
    workspace_id: 'ws-1',
    role: 'doer',
    work_folder: '/tmp/w',
    server: null,
    status: 'busy',
    sessionId: 'sid-1',
    ...overrides,
  };
}

const registered: Array<[string, string]> = [];
function register(state: SessionState): void {
  sessionRegistry.register(state);
  registered.push([state.workspace_id, state.member_id]);
}

afterEach(() => {
  for (const [ws, id] of registered.splice(0)) {
    sessionRegistry.unregister(ws, id);
  }
  fleetEvents.removeAllListeners();
});

describe('reportStatus (apra-fleet-2xs.7)', () => {
  it('errors when called with no sessionId on extra (not a live interactive session)', async () => {
    const result = await reportStatus({ status: 'online' }, {});
    expect(result).toContain('error');
    expect(result).toContain('connected interactive session');
  });

  it('errors when the sessionId does not correspond to any registered member session', async () => {
    const result = await reportStatus({ status: 'online' }, { sessionId: 'no-such-session' });
    expect(result).toContain('error');
    expect(result).toContain('no registered member session');
  });

  it('flips the correctly-identified member\'s status from busy to online, closing the loop send_message opens', async () => {
    register(makeSession({ member_id: 'm-flip', workspace_id: 'ws-flip', sessionId: 'sid-flip', status: 'busy' }));

    const result = await reportStatus({ status: 'online' }, { sessionId: 'sid-flip' });
    const parsed = JSON.parse(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.member_id).toBe('m-flip');
    expect(parsed.status).toBe('online');
    expect(sessionRegistry.get('ws-flip', 'm-flip')?.status).toBe('online');
  });

  it('supports reporting "idle" (still connected, not actively engaged)', async () => {
    register(makeSession({ member_id: 'm-idle', workspace_id: 'ws-idle', sessionId: 'sid-idle', status: 'busy' }));

    await reportStatus({ status: 'idle' }, { sessionId: 'sid-idle' });
    expect(sessionRegistry.get('ws-idle', 'm-idle')?.status).toBe('idle');
  });

  it('defaults to "online" when status is omitted (schema-level default, as the MCP SDK applies before calling the handler)', async () => {
    register(makeSession({ member_id: 'm-default', workspace_id: 'ws-default', sessionId: 'sid-default', status: 'busy' }));

    const defaulted = reportStatusSchema.parse({});
    expect(defaulted.status).toBe('online');

    await reportStatus(defaulted, { sessionId: 'sid-default' });
    expect(sessionRegistry.get('ws-default', 'm-default')?.status).toBe('online');
  });

  it('emits a member:status-changed fleet event so dashboards/other listeners see the flip', async () => {
    register(makeSession({ member_id: 'm-event', workspace_id: 'ws-event', sessionId: 'sid-event', status: 'busy' }));

    const listener = vi.fn();
    fleetEvents.on('member:status-changed', listener);

    await reportStatus({ status: 'online' }, { sessionId: 'sid-event' });

    expect(listener).toHaveBeenCalledWith({ memberId: 'm-event', status: 'online' });
  });

  it('only affects the identified session\'s own member -- never another member\'s status', async () => {
    register(makeSession({ member_id: 'm-a', workspace_id: 'ws-shared', sessionId: 'sid-a', status: 'busy' }));
    register(makeSession({ member_id: 'm-b', workspace_id: 'ws-shared', sessionId: 'sid-b', status: 'busy' }));

    await reportStatus({ status: 'online' }, { sessionId: 'sid-a' });

    expect(sessionRegistry.get('ws-shared', 'm-a')?.status).toBe('online');
    expect(sessionRegistry.get('ws-shared', 'm-b')?.status).toBe('busy');
  });
});
