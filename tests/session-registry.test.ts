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

  // apra-fleet-eft.50.1: the durable launch-pid anchor that outlives the
  // SessionState churn (register -> unregister -> reconnect/re-register) a
  // persistent interactive member goes through across dispatch retries. It is
  // the liveness fallback of last resort for execute_prompt's dead-session
  // guard, so a dead launch-time process on retry attempt 2+ is still
  // detectable even after a reconnect re-registered the live session with
  // pid=undefined. Every case here uses a workspace/member unique to the test
  // because lastPids is deliberately NEVER cleared on unregister -- that churn
  // is exactly what it is designed to outlive.
  describe('lastKnownPid (apra-fleet-eft.50.1)', () => {
    it('register() with a pid records it as the lastKnownPid', () => {
      register(makeState({ member_id: 'm-lkp-rec', workspace_id: 'ws-lkp-1', pid: 5150 }));
      expect(sessionRegistry.lastKnownPid('ws-lkp-1', 'm-lkp-rec')).toBe(5150);
    });

    it('returns undefined for a member that never had a pid captured (pre-existing behavior unchanged)', () => {
      register(makeState({ member_id: 'm-lkp-none', workspace_id: 'ws-lkp-2' }));
      expect(sessionRegistry.lastKnownPid('ws-lkp-2', 'm-lkp-none')).toBeUndefined();
    });

    it('PERSISTS after unregister() -- the live SessionState is gone but the launch-pid anchor survives', () => {
      register(makeState({ member_id: 'm-lkp-persist', workspace_id: 'ws-lkp-3', pid: 8080 }));
      sessionRegistry.unregister('ws-lkp-3', 'm-lkp-persist');

      // The live session is gone ...
      expect(sessionRegistry.get('ws-lkp-3', 'm-lkp-persist')).toBeUndefined();
      // ... but the durable anchor still remembers the dead process's pid, so a
      // later reconnect + retry can still detect that it is dead.
      expect(sessionRegistry.lastKnownPid('ws-lkp-3', 'm-lkp-persist')).toBe(8080);
    });

    it('is NOT overwritten when the member re-registers (reconnects) with pid=undefined -- the exact eft.50 reconnect-loses-pid path', () => {
      // Attempt 1: registered with a real launch-time pid.
      register(makeState({ member_id: 'm-lkp-reconnect', workspace_id: 'ws-lkp-4', pid: 16031 }));
      // Disconnect between attempts drops the live SessionState.
      sessionRegistry.unregister('ws-lkp-4', 'm-lkp-reconnect');
      // Reconnect on the retry re-registers WITHOUT a pid (the priorPid lookup
      // found no entry, so pid=undefined) -- this used to blind the liveness
      // check on attempt 2+.
      register(makeState({ member_id: 'm-lkp-reconnect', workspace_id: 'ws-lkp-4' }));

      // Live SessionState now has no pid ...
      expect(sessionRegistry.get('ws-lkp-4', 'm-lkp-reconnect')?.pid).toBeUndefined();
      // ... but the durable anchor still points at the original (now dead) pid.
      expect(sessionRegistry.lastKnownPid('ws-lkp-4', 'm-lkp-reconnect')).toBe(16031);
    });

    it('is overwritten only by a NEWER pid registered for the same member', () => {
      register(makeState({ member_id: 'm-lkp-new', workspace_id: 'ws-lkp-5', pid: 100 }));
      expect(sessionRegistry.lastKnownPid('ws-lkp-5', 'm-lkp-new')).toBe(100);

      // A fresh re-dispatch spawns a new process with a new pid -- the anchor
      // moves forward to it.
      register(makeState({ member_id: 'm-lkp-new', workspace_id: 'ws-lkp-5', pid: 200 }));
      expect(sessionRegistry.lastKnownPid('ws-lkp-5', 'm-lkp-new')).toBe(200);
    });

    it('setPid() keeps the durable anchor in step with the live session pid', () => {
      register(makeState({ member_id: 'm-lkp-setpid', workspace_id: 'ws-lkp-6' }));
      expect(sessionRegistry.lastKnownPid('ws-lkp-6', 'm-lkp-setpid')).toBeUndefined();

      sessionRegistry.setPid('ws-lkp-6', 'm-lkp-setpid', 4321);
      expect(sessionRegistry.get('ws-lkp-6', 'm-lkp-setpid')?.pid).toBe(4321);
      expect(sessionRegistry.lastKnownPid('ws-lkp-6', 'm-lkp-setpid')).toBe(4321);
    });

    it('is scoped by workspace -- the same member_id in a different workspace has its own anchor', () => {
      register(makeState({ member_id: 'shared-lkp', workspace_id: 'ws-lkp-7a', pid: 111 }));
      register(makeState({ member_id: 'shared-lkp', workspace_id: 'ws-lkp-7b', pid: 222 }));

      expect(sessionRegistry.lastKnownPid('ws-lkp-7a', 'shared-lkp')).toBe(111);
      expect(sessionRegistry.lastKnownPid('ws-lkp-7b', 'shared-lkp')).toBe(222);
    });
  });

  describe('findBySessionId (apra-fleet-2xs.7)', () => {
    it('finds the session owning a given MCP transport sessionId', () => {
      register(makeState({ member_id: 'm-find', workspace_id: 'ws-find', sessionId: 'sid-find-1' }));
      const found = sessionRegistry.findBySessionId('sid-find-1');
      expect(found?.member_id).toBe('m-find');
      expect(found?.workspace_id).toBe('ws-find');
    });

    it('returns undefined for a sessionId that matches no registered session', () => {
      expect(sessionRegistry.findBySessionId('no-such-sid')).toBeUndefined();
    });

    it('distinguishes between two different members\' sessionIds', () => {
      register(makeState({ member_id: 'm-x', workspace_id: 'ws-find', sessionId: 'sid-x' }));
      register(makeState({ member_id: 'm-y', workspace_id: 'ws-find', sessionId: 'sid-y' }));

      expect(sessionRegistry.findBySessionId('sid-x')?.member_id).toBe('m-x');
      expect(sessionRegistry.findBySessionId('sid-y')?.member_id).toBe('m-y');
    });
  });
});
