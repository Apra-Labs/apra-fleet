import { describe, it, expect, vi, beforeEach } from 'vitest';

// Per-session tool scope at the registration layer: registerAllTools(server,
// scope) registers only the in-scope tools, and every handler runs with the
// calling session's member id available (extra.sessionMemberId and
// getSessionMemberId()). The over-the-wire behaviour (tools/list, 403, JWT and
// channel sessions) is covered by tests/member-session-scope.test.ts.
//
// Isolation: kbQuery, handleCodeGraph, resolveCodeSelf and recordUsage are mocked, so no KB is
// opened, no code-intel provider resolved and no telemetry written.

const seen = vi.hoisted(() => ({ kb: [] as unknown[], code: [] as unknown[], extras: [] as unknown[] }));

vi.mock('../src/tools/kb-query.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/tools/kb-query.js')>();
  const { getSessionMemberId } = await import('../src/services/tool-scope.js');
  return {
    ...actual,
    kbQuery: vi.fn(async () => {
      seen.kb.push(getSessionMemberId());
      return '{"results":[]}';
    }),
  };
});
vi.mock('../src/tools/code-intelligence.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/tools/code-intelligence.js')>();
  const { getSessionMemberId } = await import('../src/services/tool-scope.js');
  return {
    ...actual,
    handleCodeGraph: vi.fn(async () => {
      seen.code.push(getSessionMemberId());
      return { ok: true };
    }),
    // The member ids here are not registered, so the real (self) resolver
    // would refuse with E-SELF-NO-WORKFOLDER before the handler runs; that
    // path is covered by tests/code-intelligence-self.test.ts.
    resolveCodeSelf: vi.fn(() => ({ repo: '/scope-test/repo', memberId: getSessionMemberId() })),
  };
});
vi.mock('../src/tools/report-status.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/tools/report-status.js')>();
  return { ...actual, reportStatus: vi.fn(async (_input: unknown, extra: unknown) => { seen.extras.push(extra); return '{"ok":true}'; }) };
});
vi.mock('../src/tools/code-intelligence-telemetry.js', () => ({ recordUsage: vi.fn() }));

import { registerAllTools } from '../src/services/tool-registry.js';
import { FULL_TOOL_SCOPE, memberToolScope, isToolInScope, getSessionMemberId } from '../src/services/tool-scope.js';
import { MEMBER_ALLOWED_TOOLS, MEMBER_CHANNEL_TOOLS, REGISTERED_TOOL_NAMES } from '../src/services/member-tool-allowlist.js';

type ToolHandler = (input: unknown, extra?: unknown) => Promise<unknown>;

async function register(scope?: Parameters<typeof registerAllTools>[1]): Promise<Map<string, ToolHandler>> {
  const registered = new Map<string, ToolHandler>();
  const fakeServer = {
    tool: (name: string, _d: string, _s: unknown, handler: ToolHandler) => { registered.set(name, handler); },
    server: { sendLoggingMessage: async () => {} },
  };
  await registerAllTools(fakeServer as never, scope);
  return registered;
}

const sorted = (xs: Iterable<string>) => [...xs].sort();

describe('registerAllTools scope gate', () => {
  it('FULL scope (and the default) registers every tool', async () => {
    expect(sorted((await register()).keys())).toEqual(sorted(REGISTERED_TOOL_NAMES));
    expect(sorted((await register(FULL_TOOL_SCOPE)).keys())).toEqual(sorted(REGISTERED_TOOL_NAMES));
  });

  it('a MEMBER scope without the channel capability registers exactly the base allowlist', async () => {
    const names = sorted((await register(memberToolScope('m-1', false))).keys());
    expect(names).toEqual(sorted(MEMBER_ALLOWED_TOOLS));
    for (const t of ['execute_prompt', 'execute_command', 'stop_prompt', 'send_files', 'receive_files', 'respond_to_message', 'send_message']) {
      expect(names).not.toContain(t);
    }
  });

  it('a channel-capable MEMBER scope registers the base allowlist plus MEMBER_CHANNEL_TOOLS, nothing else', async () => {
    const names = sorted((await register(memberToolScope('m-1', true))).keys());
    expect(names).toEqual(sorted([...MEMBER_ALLOWED_TOOLS, ...MEMBER_CHANNEL_TOOLS]));
    expect(names).not.toContain('send_message');
  });

  it('isToolInScope denies an unknown future tool to members unless the allowlist rule admits it', () => {
    const member = memberToolScope('m-1', false);
    expect(isToolInScope('some_future_admin_tool', member)).toBe(false);
    expect(isToolInScope('some_future_admin_tool', FULL_TOOL_SCOPE)).toBe(true);
    expect(isToolInScope('kb_some_future_tool', member)).toBe(true);
    expect(isToolInScope('respond_to_message', member)).toBe(false);
    expect(isToolInScope('respond_to_message', memberToolScope('m-1', true))).toBe(true);
  });
});

describe('handlers receive the calling session member id', () => {
  beforeEach(() => { seen.kb.length = 0; seen.code.length = 0; seen.extras.length = 0; });

  it('kb_* and code_* handlers on a MEMBER session see the member id', async () => {
    const tools = await register(memberToolScope('member-uuid-42', false));
    await tools.get('kb_query')!({ query: 'x' }, {});
    await tools.get('code_graph')!({ symbol: 'foo' }, {});
    expect(seen.kb).toEqual(['member-uuid-42']);
    expect(seen.code).toEqual(['member-uuid-42']);
  });

  it('the handler extra carries sessionMemberId alongside the original extra fields, and the context does not leak', async () => {
    const tools = await register(memberToolScope('member-uuid-42', false));
    await tools.get('report_status')!({ status: 'online' }, { sessionId: 'sid-1' });
    expect(seen.extras).toEqual([{ sessionId: 'sid-1', sessionMemberId: 'member-uuid-42' }]);
    expect(getSessionMemberId()).toBeUndefined();
  });

  it('a FULL session handler sees no member id', async () => {
    const tools = await register(FULL_TOOL_SCOPE);
    await tools.get('kb_query')!({ query: 'x' }, {});
    await tools.get('code_graph')!({ symbol: 'foo' }, {});
    expect(seen.kb).toEqual([undefined]);
    expect(seen.code).toEqual([undefined]);
  });
});
