/**
 * [test] apra-fleet-4qtu.2.2: end-to-end verification of the member_owner
 * tool (apra-fleet-4qtu.2.1, src/tools/member-owner.ts), driven through the
 * REGISTERED tool (src/services/tool-registry.ts's `server.tool('member_owner', ...)`
 * closure) rather than the internal memberOwner() function directly, so
 * registration is exercised too -- and through the client memberOwner
 * wrapper's mock transport, so the client-side option names are exercised
 * against the same schema the server declares.
 *
 * Shared-registry constraint: tests/global-setup.ts computes ONE data dir
 * per vitest run and every worker shares registry.json -- it is never reset
 * per file, and fileParallelism:false only serializes files, it does not
 * isolate them. Every assertion below is therefore scoped to the member ids
 * THIS suite creates (looked up by id, never "the whole list" or a total
 * count); each test registers a uniquely-id'd member and removes it in
 * cleanup, matching the sibling apra-fleet-4qtu.1.2 suite
 * (tests/integration/member-owner-env-fields.test.ts).
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { addAgent, getAgent, removeAgent, updateAgent } from '../../src/services/registry.js';
import { makeTestAgent } from '../test-helpers.js';

type ToolContentItem = { type: string; text: string };
type ToolResult = { content: ToolContentItem[]; structuredContent?: Record<string, unknown> };
type ToolHandler = (input: unknown, extra?: unknown) => Promise<ToolResult>;

interface Registered {
  schema: Record<string, unknown>;
  handler: ToolHandler;
}

/**
 * Minimal stand-in for McpServer: records what each server.tool() call
 * registered, so the REAL registered closure (schema + wrapTool-wrapped
 * handler) can be invoked directly -- same shape used by
 * tests/code-intelligence-registry-wiring.test.ts (apra-fleet-b4g.13).
 */
async function recordRegisteredTools(): Promise<Map<string, Registered>> {
  const { registerAllTools } = await import('../../src/services/tool-registry.js');
  const registered = new Map<string, Registered>();
  const fakeServer = {
    tool: (name: string, _description: string, schema: Record<string, unknown>, handler: ToolHandler) => {
      registered.set(name, { schema, handler });
    },
    server: { sendLoggingMessage: async () => {} },
  };
  await registerAllTools(fakeServer as never);
  return registered;
}

/** The core message text -- the one content item NOT wrapped in the onboarding <apra-fleet-display> tag. */
function coreText(result: ToolResult): string {
  const item = result.content.find((c) => !c.text.startsWith('<apra-fleet-display>'));
  expect(item, `no core (non-onboarding) text item in content: ${JSON.stringify(result.content)}`).toBeTruthy();
  return item!.text;
}

describe('member_owner integration (apra-fleet-4qtu.2.2)', () => {
  let handler: ToolHandler;
  let schema: Record<string, unknown>;
  const createdIds: string[] = [];

  beforeAll(async () => {
    const registered = await recordRegisteredTools();
    const entry = registered.get('member_owner');
    expect(entry, 'member_owner was not registered by registerAllTools').toBeTruthy();
    handler = entry!.handler;
    schema = entry!.schema;
  });

  afterEach(() => {
    for (const id of createdIds.splice(0)) {
      removeAgent(id);
    }
  });

  function trackedMember(overrides: Record<string, unknown> = {}) {
    const agent = makeTestAgent(overrides);
    addAgent(agent);
    createdIds.push(agent.id);
    return agent;
  }

  // (6) member_owner appears in the tool listing from src/services/tool-registry.ts.
  it('(6) is registered under the name "member_owner" with member/action/package/ref in its schema', () => {
    expect(schema).toBeTruthy();
    expect(Object.keys(schema)).toEqual(expect.arrayContaining(['member_id', 'member_name', 'action', 'package', 'ref']));
  });

  // (1) action set writes owner {package, ref} and it is visible afterwards through member_detail json.
  it('(1) action "set" writes owner {package, ref}, visible through member_detail json', async () => {
    const agent = trackedMember();

    const result = await handler({ member_id: agent.id, action: 'set', package: 'fleet-sprint', ref: 'sprint-1' });

    expect(coreText(result)).toContain('owner set to fleet-sprint@sprint-1');
    expect(result.structuredContent?.outcome).toBe('set');
    expect(result.structuredContent?.ok).toBe(true);

    const { memberDetail } = await import('../../src/tools/member-detail.js');
    const detail = JSON.parse(await memberDetail({ member_id: agent.id, format: 'json' })) as Record<string, unknown>;
    expect(detail.owner).toEqual({ package: 'fleet-sprint', ref: 'sprint-1' });
  });

  // (2) action clear removes owner and member_detail then reports it absent, not an empty object.
  it('(2) action "clear" removes owner; member_detail then reports it absent, not an empty object', async () => {
    const agent = trackedMember({ owner: { package: 'fleet-sprint', ref: 'sprint-1' } });

    const result = await handler({ member_id: agent.id, action: 'clear' });

    expect(coreText(result)).toContain('owner cleared');
    expect(result.structuredContent?.outcome).toBe('cleared');
    expect(result.structuredContent?.owner).toBeNull();

    const stored = getAgent(agent.id) as unknown as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(stored, 'owner'), 'owner key must be entirely absent, not present-but-empty').toBe(false);

    const { memberDetail } = await import('../../src/tools/member-detail.js');
    const detail = JSON.parse(await memberDetail({ member_id: agent.id, format: 'json' })) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(detail, 'owner')).toBe(false);
  });

  // (3) a malformed package or ref is refused with a validation error and leaves any existing owner untouched.
  it('(3) a malformed package is refused with a validation error; existing owner is untouched', async () => {
    const agent = trackedMember({ owner: { package: 'fleet-sprint', ref: 'sprint-1' } });

    const result = await handler({ member_id: agent.id, action: 'set', package: 'bad package!', ref: 'sprint-2' });

    expect(coreText(result)).toContain('Invalid owner package');
    expect(result.structuredContent?.outcome).toBe('invalid_input');
    expect(getAgent(agent.id)?.owner).toEqual({ package: 'fleet-sprint', ref: 'sprint-1' });
  });

  it('(3) a malformed ref is refused with a validation error; existing owner is untouched', async () => {
    const agent = trackedMember({ owner: { package: 'fleet-sprint', ref: 'sprint-1' } });

    const result = await handler({ member_id: agent.id, action: 'set', package: 'fleet-sprint', ref: 'bad ref!' });

    expect(coreText(result)).toContain('Invalid owner ref');
    expect(result.structuredContent?.outcome).toBe('invalid_input');
    expect(getAgent(agent.id)?.owner).toEqual({ package: 'fleet-sprint', ref: 'sprint-1' });
  });

  // (4) while reservedBy is set, BOTH set and clear are refused with error code member-held,
  // and the stored owner is unchanged after the refusal.
  //
  // (5) Falsification note: this property is NOT vacuous -- deleting the
  // memberHeldRefusal() call from either branch of memberOwner() (src/tools/
  // member-owner.ts) makes both assertions below fail, because the tool
  // would then happily set/clear a held member's owner instead of returning
  // outcome "member_held". Verified by temporarily commenting out both
  // `memberHeldRefusal(existing)` call sites during authoring of this suite
  // and re-running it: both tests below failed with the owner mutated.
  it('(4)/(5) "set" is refused with error code member-held while the member is reserved; owner unchanged', async () => {
    const agent = trackedMember({ owner: { package: 'fleet-sprint', ref: 'sprint-1' } });
    updateAgent(agent.id, { reservedBy: 'sprint-99' });

    const result = await handler({ member_id: agent.id, action: 'set', package: 'other-pkg', ref: 'sprint-2' });

    expect(coreText(result)).toContain('member-held');
    expect(result.structuredContent?.outcome).toBe('member_held');
    expect(result.structuredContent?.ok).toBe(false);
    expect(getAgent(agent.id)?.owner).toEqual({ package: 'fleet-sprint', ref: 'sprint-1' });
  });

  it('(4)/(5) "clear" is refused with error code member-held while the member is reserved; owner unchanged', async () => {
    const agent = trackedMember({ owner: { package: 'fleet-sprint', ref: 'sprint-1' } });
    updateAgent(agent.id, { reservedBy: 'sprint-99' });

    const result = await handler({ member_id: agent.id, action: 'clear' });

    expect(coreText(result)).toContain('member-held');
    expect(result.structuredContent?.outcome).toBe('member_held');
    expect(result.structuredContent?.ok).toBe(false);
    expect(getAgent(agent.id)?.owner).toEqual({ package: 'fleet-sprint', ref: 'sprint-1' });
  });

  // (7) the client memberOwner wrapper reaches the tool through the mock
  // transport with the SAME option names the server schema declares.
  it('(7) the client memberOwner wrapper sends the same option names as the registered schema', async () => {
    const { ApraFleet } = await import('../../packages/apra-fleet-client/src/client/api.mjs');

    let calledName: string | undefined;
    let calledArgs: Record<string, unknown> | undefined;
    const mockClient = {
      async callTool(name: string, args: Record<string, unknown>) {
        calledName = name;
        calledArgs = args;
        return { status: 'ok' };
      },
    };

    const fleet = new (ApraFleet as new (client: unknown) => { memberOwner: (o: Record<string, unknown>) => Promise<unknown> })(mockClient);
    const options = { member_id: 'abc-123', action: 'set', package: 'fleet-sprint', ref: 'sprint-1' };
    await fleet.memberOwner(options);

    expect(calledName).toBe('member_owner');
    expect(calledArgs).toEqual(options);
    // Every option name the client sent must be one the server schema declares.
    for (const key of Object.keys(calledArgs!)) {
      expect(Object.keys(schema)).toContain(key);
    }
  });

  it('returns member_not_found for an unknown member without registering a partial owner', async () => {
    const result = await handler({ member_name: 'does-not-exist-4qtu22', action: 'set', package: 'fleet-sprint', ref: 'sprint-1' });
    expect(result.structuredContent?.outcome).toBe('member_not_found');
  });
});
