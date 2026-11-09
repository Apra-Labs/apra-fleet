import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendMessage } from '../src/tools/send-message.js';
import { sessionRegistry, type SessionState } from '../src/services/session-registry.js';
import { setTokenIssuer, resetTokenIssuer, type TokenIssuer } from '../src/services/token-issuer.js';

const FAKE_WORKSPACE = 'ws-fake-sender';

const fakeIssuer: TokenIssuer = {
  workspaceId: () => FAKE_WORKSPACE,
  issue: () => 'unused-in-these-tests',
  verify: () => null,
};

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    member_id: 'member-1',
    workspace_id: FAKE_WORKSPACE,
    role: 'doer',
    work_folder: '/tmp/w',
    server: { server: { notification: vi.fn().mockResolvedValue(undefined) } } as any,
    status: 'online',
    ...overrides,
  };
}

const registered: Array<[string, string]> = [];
function register(state: SessionState): void {
  sessionRegistry.register(state);
  registered.push([state.workspace_id, state.member_id]);
}

beforeEach(() => {
  setTokenIssuer(fakeIssuer);
});

afterEach(() => {
  for (const [ws, id] of registered.splice(0)) {
    sessionRegistry.unregister(ws, id);
  }
  resetTokenIssuer();
});

describe('sendMessage', () => {
  it('returns an error for a member not registered at all', async () => {
    const result = await sendMessage({ member_id: 'no-such-member', content: 'hi' });
    expect(JSON.parse(result)).toEqual({ error: 'member not connected or no MCP session' });
  });

  it('returns an error for a member registered but with no MCP server (server=null, not yet connected)', async () => {
    register(makeSession({ member_id: 'm-no-server', server: null }));
    const result = await sendMessage({ member_id: 'm-no-server', content: 'hi' });
    expect(JSON.parse(result)).toEqual({ error: 'member not connected or no MCP session' });
  });

  it('returns an error for a member connected in a DIFFERENT workspace (cannot cross the boundary)', async () => {
    register(makeSession({ member_id: 'm-foreign', workspace_id: 'ws-someone-else' }));
    const result = await sendMessage({ member_id: 'm-foreign', content: 'hi' });
    expect(JSON.parse(result)).toEqual({ error: 'member not connected or no MCP session' });
  });

  it('sends a notification to the member\'s MCP server and returns ok with a msgid', async () => {
    const notification = vi.fn().mockResolvedValue(undefined);
    register(makeSession({ member_id: 'm-ok', server: { server: { notification } } as any }));

    const result = await sendMessage({ member_id: 'm-ok', content: 'hello there' });
    const parsed = JSON.parse(result);

    expect(parsed.ok).toBe(true);
    expect(typeof parsed.msgid).toBe('string');
    expect(notification).toHaveBeenCalledTimes(1);
    expect(notification).toHaveBeenCalledWith({
      method: 'notifications/claude/channel',
      params: {
        content: 'hello there',
        meta: { from: 'pm', msgid: parsed.msgid },
      },
    });
  });

  it('includes reply_to in the notification meta when provided', async () => {
    const notification = vi.fn().mockResolvedValue(undefined);
    register(makeSession({ member_id: 'm-reply', server: { server: { notification } } as any }));

    await sendMessage({ member_id: 'm-reply', content: 'reply content', reply_to: 'original-msg-id' });

    expect(notification).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          meta: expect.objectContaining({ reply_to: 'original-msg-id' }),
        }),
      }),
    );
  });

  it('sets the member session status to busy after a successful send', async () => {
    register(makeSession({ member_id: 'm-busy', status: 'online' }));
    await sendMessage({ member_id: 'm-busy', content: 'go' });
    expect(sessionRegistry.get(FAKE_WORKSPACE, 'm-busy')?.status).toBe('busy');
  });

  it('uses the explicit senderWorkspaceId parameter over the token issuer\'s workspace when provided', async () => {
    register(makeSession({ member_id: 'm-explicit-ws', workspace_id: 'ws-explicit' }));

    // Without the explicit workspace, this member is invisible (registered
    // under 'ws-explicit', not the fake issuer's FAKE_WORKSPACE).
    const withoutExplicit = await sendMessage({ member_id: 'm-explicit-ws', content: 'hi' });
    expect(JSON.parse(withoutExplicit).error).toBeDefined();

    const withExplicit = await sendMessage({ member_id: 'm-explicit-ws', content: 'hi' }, 'ws-explicit');
    expect(JSON.parse(withExplicit).ok).toBe(true);
  });

  describe('probe', () => {
    it('no session: reports not connected and sends nothing', async () => {
      const result = JSON.parse(await sendMessage({ member_id: 'orchestrator', content: '', probe: true }));
      expect(result).toEqual({ probe: true, member_id: 'orchestrator', connected: false, channel_capable: false });
    });

    it('a session without the channel capability: connected but not channel-capable; no notification, status unchanged', async () => {
      const notification = vi.fn().mockResolvedValue(undefined);
      register(makeSession({ member_id: 'm-plain', server: { server: { notification } } as any, channelCapable: false }));
      const result = JSON.parse(await sendMessage({ member_id: 'm-plain', content: 'ignored', probe: true }));
      expect(result).toEqual({ probe: true, member_id: 'm-plain', connected: true, channel_capable: false });
      expect(notification).not.toHaveBeenCalled();
      expect(sessionRegistry.get(FAKE_WORKSPACE, 'm-plain')?.status).toBe('online');
    });

    it('a channel-capable session: connected and channel-capable; no notification, status unchanged', async () => {
      const notification = vi.fn().mockResolvedValue(undefined);
      register(makeSession({ member_id: 'orchestrator', server: { server: { notification } } as any, channelCapable: true }));
      const result = JSON.parse(await sendMessage({ member_id: 'orchestrator', content: '', probe: true }));
      expect(result).toEqual({ probe: true, member_id: 'orchestrator', connected: true, channel_capable: true });
      expect(notification).not.toHaveBeenCalled();
      expect(sessionRegistry.get(FAKE_WORKSPACE, 'orchestrator')?.status).toBe('online');
    });

    it('a channel-capable registration with no live server yet is not connected', async () => {
      register(makeSession({ member_id: 'm-pending', server: null, channelCapable: true }));
      const result = JSON.parse(await sendMessage({ member_id: 'm-pending', content: '', probe: true }));
      expect(result).toEqual({ probe: true, member_id: 'm-pending', connected: false, channel_capable: false });
    });

    it('a channel-capable session in another workspace is invisible', async () => {
      register(makeSession({ member_id: 'm-other-ws', workspace_id: 'ws-someone-else', channelCapable: true }));
      const result = JSON.parse(await sendMessage({ member_id: 'm-other-ws', content: '', probe: true }));
      expect(result).toEqual({ probe: true, member_id: 'm-other-ws', connected: false, channel_capable: false });
    });
  });
});
