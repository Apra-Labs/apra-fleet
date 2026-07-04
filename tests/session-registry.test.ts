import { describe, it, expect, afterEach } from 'vitest';
import { sessionRegistry, type SessionState } from '../src/services/session-registry.js';

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    member_id: 'member-1',
    workspace_id: 'ws-1',
    role: 'doer',
    work_folder: '/tmp/w',
    server: null,
    status: 'online',
    ...overrides,
  };
}

// Registry is a module-level singleton -- clean up every registered
// (workspace_id, member_id) pair after each test so tests can't leak state
// into each other.
const registered: Array<[string, string]> = [];
function register(state: SessionState): void {
  sessionRegistry.register(state);
  registered.push([state.workspace_id, state.member_id]);
}

afterEach(() => {
  for (const [ws, id] of registered.splice(0)) {
    sessionRegistry.unregister(ws, id);
  }
});

describe('sessionRegistry', () => {
  it('register() then get() with the same workspace_id + member_id returns the state', () => {
    register(makeState({ member_id: 'm1', workspace_id: 'ws1' }));
    const found = sessionRegistry.get('ws1', 'm1');
    expect(found).toBeDefined();
    expect(found?.member_id).toBe('m1');
  });

  it('get() returns undefined for a member registered in a DIFFERENT workspace (the security boundary)', () => {
    register(makeState({ member_id: 'shared-name', workspace_id: 'ws1' }));
    const foundInOtherWorkspace = sessionRegistry.get('ws2', 'shared-name');
    expect(foundInOtherWorkspace).toBeUndefined();
  });

  it('the same member_id can be registered independently in two different workspaces without colliding', () => {
    register(makeState({ member_id: 'shared-name', workspace_id: 'ws1', role: 'doer' }));
    register(makeState({ member_id: 'shared-name', workspace_id: 'ws2', role: 'reviewer' }));

    expect(sessionRegistry.get('ws1', 'shared-name')?.role).toBe('doer');
    expect(sessionRegistry.get('ws2', 'shared-name')?.role).toBe('reviewer');
  });

  it('get() returns undefined for a member_id that was never registered', () => {
    expect(sessionRegistry.get('ws-nope', 'no-such-member')).toBeUndefined();
  });

  it('unregister() removes the entry so a subsequent get() returns undefined', () => {
    register(makeState({ member_id: 'm-gone', workspace_id: 'ws1' }));
    expect(sessionRegistry.get('ws1', 'm-gone')).toBeDefined();

    sessionRegistry.unregister('ws1', 'm-gone');
    expect(sessionRegistry.get('ws1', 'm-gone')).toBeUndefined();
  });

  it('unregister() on a never-registered pair is a no-op, not an error', () => {
    expect(() => sessionRegistry.unregister('ws-none', 'm-none')).not.toThrow();
  });

  it('list(workspace_id) returns only that workspace\'s sessions', () => {
    register(makeState({ member_id: 'a', workspace_id: 'ws-list-1' }));
    register(makeState({ member_id: 'b', workspace_id: 'ws-list-1' }));
    register(makeState({ member_id: 'c', workspace_id: 'ws-list-2' }));

    const listed = sessionRegistry.list('ws-list-1');
    expect(listed.map(s => s.member_id).sort()).toEqual(['a', 'b']);
  });

  it('list() with no workspace_id returns sessions across ALL workspaces (diagnostics-only)', () => {
    register(makeState({ member_id: 'x', workspace_id: 'ws-all-1' }));
    register(makeState({ member_id: 'y', workspace_id: 'ws-all-2' }));

    const all = sessionRegistry.list();
    const ids = all.map(s => s.member_id);
    expect(ids).toContain('x');
    expect(ids).toContain('y');
  });

  it('setStatus() updates status only for the correctly-scoped (workspace_id, member_id) pair', () => {
    register(makeState({ member_id: 'm-status', workspace_id: 'ws1', status: 'online' }));

    sessionRegistry.setStatus('ws1', 'm-status', 'busy');
    expect(sessionRegistry.get('ws1', 'm-status')?.status).toBe('busy');
  });

  it('setStatus() on a non-existent session is a no-op, not an error', () => {
    expect(() => sessionRegistry.setStatus('ws-none', 'm-none', 'busy')).not.toThrow();
  });

  it('setPid() records the pid on the correctly-scoped session', () => {
    register(makeState({ member_id: 'm-pid', workspace_id: 'ws1' }));
    sessionRegistry.setPid('ws1', 'm-pid', 4242);
    expect(sessionRegistry.get('ws1', 'm-pid')?.pid).toBe(4242);
  });

  it('setMcpServer() records the server reference on the correctly-scoped session', () => {
    register(makeState({ member_id: 'm-server', workspace_id: 'ws1', server: null }));
    const fakeServer = { marker: 'fake-mcp-server' } as any;
    sessionRegistry.setMcpServer('ws1', 'm-server', fakeServer);
    expect(sessionRegistry.get('ws1', 'm-server')?.server).toBe(fakeServer);
  });

  it('re-registering the same (workspace_id, member_id) overwrites the prior entry entirely', () => {
    register(makeState({ member_id: 'm-re', workspace_id: 'ws1', sessionId: 'sid-old', status: 'online' }));
    register(makeState({ member_id: 'm-re', workspace_id: 'ws1', sessionId: 'sid-new', status: 'busy' }));

    const current = sessionRegistry.get('ws1', 'm-re');
    expect(current?.sessionId).toBe('sid-new');
    expect(current?.status).toBe('busy');
  });
});
