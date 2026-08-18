import { describe, it, expect } from 'vitest';

// rmkb-3n5.4.3: pin the server-side tool boundary at the REGISTRATION layer.
//
// The enforcement model is deny-by-omission: a tool outside a session's scope
// is never registered on that session's McpServer, so it never appears in
// tools/list and cannot be called at all. These assertions therefore look at
// what registerAllTools() actually registered -- not at a call-time refusal,
// which is a weaker guarantee (and one this code deliberately does NOT rely
// on).
//
// Harness: the same 4-line fake McpServer shape used by
// tests/code-intelligence-registry-wiring.test.ts. `server.tool()` and
// `server.server.sendLoggingMessage()` are the only members registerAllTools
// touches. Nothing here invokes a handler, so no provider, KB or telemetry
// path is exercised.

import { registerAllTools, MEMBER_TOOL_ALLOWLIST, isToolInScope, type ToolScope } from '../src/services/tool-registry.js';

async function registeredToolNames(scope?: ToolScope): Promise<string[]> {
  const names: string[] = [];
  const fakeServer = {
    tool: (name: string) => { names.push(name); },
    server: { sendLoggingMessage: async () => {} },
  };
  if (scope === undefined) {
    await registerAllTools(fakeServer as never);
  } else {
    await registerAllTools(fakeServer as never, scope);
  }
  return names;
}

// Every tool a member session must NOT see, with the reason it matters. Kept
// spelled out here (rather than derived from the allow-list) so this file
// fails loudly if any one of them is ever quietly opted in.
const MUST_BE_ABSENT = [
  'compose_permissions',   // self-escalation: rewrites its own allow list
  'execute_prompt',        // arbitrary execution on any member
  'execute_command',       // arbitrary execution on any member
  'stop_prompt',           // kills work on any member
  'send_files',            // exfiltration
  'receive_files',         // exfiltration
  'send_email',            // exfiltration
  'kb_promote',            // mints CONFIRMED
  'kb_import',             // mints CONFIRMED
  'kb_export',             // auto-commits the bible to git
  'kb_setup',              // installs a git hook, writes credentials
  'list_members',          // leaks fleet topology
  'member_detail',         // leaks fleet topology
  'fleet_status',          // leaks fleet topology
  'dolt_push_mutex',       // global mutex: can wedge unrelated sprints
  'child_id_allocator',    // global mutex: can wedge unrelated sprints
];

describe('rmkb-3n5.4.3 member tool scope: registration-level allow-list', () => {
  it('registers EXACTLY the 15 allow-listed tools for a member scope -- no extras', async () => {
    const names = await registeredToolNames('member');

    // Exact-set comparison, not a superset check: a future tool that leaks
    // into the member scope turns this red even if nothing dangerous is
    // named in MUST_BE_ABSENT yet.
    expect([...names].sort()).toEqual([...MEMBER_TOOL_ALLOWLIST].sort());
    expect(names).toHaveLength(15);
  });

  it('omits every dangerous tool from a member scope (absent from the registration map, not refused at call time)', async () => {
    const names = await registeredToolNames('member');

    for (const dangerous of MUST_BE_ABSENT) {
      expect(names).not.toContain(dangerous);
    }
    // Sanity: the member set is not empty/broken -- the KB read path is there.
    expect(names).toContain('kb_query');
    expect(names).toContain('code_graph');
  });

  it('registers the FULL surface by default (no scope argument), including the excluded tools', async () => {
    const full = await registeredToolNames();

    for (const dangerous of MUST_BE_ABSENT) {
      expect(full).toContain(dangerous);
    }
    // Full is a strict superset of member: every allow-listed name really is
    // a registered tool (guards against a typo in MEMBER_TOOL_ALLOWLIST that
    // would silently shrink the member set).
    for (const allowed of MEMBER_TOOL_ALLOWLIST) {
      expect(full).toContain(allowed);
    }
    expect(full.length).toBeGreaterThan(MEMBER_TOOL_ALLOWLIST.length);
  });

  it("scope 'full' is identical to the default", async () => {
    expect(await registeredToolNames('full')).toEqual(await registeredToolNames());
  });

  it('denies an unknown//newly-added tool by default under the member scope', () => {
    // The allow-list is the whole contract: a tool added to tool-registry.ts
    // later is not in MEMBER_TOOL_ALLOWLIST, so isToolInScope says no.
    expect(isToolInScope('some_tool_added_next_sprint', 'member')).toBe(false);
    expect(isToolInScope('some_tool_added_next_sprint', 'full')).toBe(true);
    expect(isToolInScope('kb_query', 'member')).toBe(true);
    expect(isToolInScope('compose_permissions', 'member')).toBe(false);
  });
});
