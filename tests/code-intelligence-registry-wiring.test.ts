import { describe, it, expect, vi, beforeEach, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// The code_context handler body in src/services/tool-registry.ts joins three
// layers: (self) resolution (resolveCodeSelf), the provider call
// (handleCodeContext) and KB enrichment (enrichContextWithKb). This test
// drives the REAL registered closure through a minimal fake McpServer that
// records every (name, schemaShape, handler) triple registerAllTools()
// registers, so the wiring itself is pinned: deleting the resolved folder
// from the enrichContextWithKb call, or resolving a different folder for the
// provider than for enrichment, turns these assertions red.
//
// code (self): no code_* tool takes a repo/repo_remote_url argument any more.
// The folder is the calling session's own -- a FULL session's server working
// folder (process.cwd(), stubbed here to a temp git repo), a MEMBER session's
// registered work folder.
//
// Isolation: handleCodeContext, enrichContextWithKb and recordUsage are
// mocked, so no code-intel provider is resolved, no KB is opened, and no
// telemetry is appended to the real ~/.apra-fleet data dir. The registry is
// the isolated test registry (backupAndResetRegistry/restoreRegistry); temp
// repos live under one scratch dir removed in afterAll.

const enrichSpy = vi.hoisted(() => vi.fn());
const handleCodeContextSpy = vi.hoisted(() => vi.fn());
const recordUsageSpy = vi.hoisted(() => vi.fn());

vi.mock('../src/tools/code-intelligence-kb-enrich.js', () => ({
  enrichContextWithKb: enrichSpy,
}));
vi.mock('../src/tools/code-intelligence.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/tools/code-intelligence.js')>();
  return { ...actual, handleCodeContext: handleCodeContextSpy };
});
vi.mock('../src/tools/code-intelligence-telemetry.js', () => ({
  recordUsage: recordUsageSpy,
}));

import { registerAllTools } from '../src/services/tool-registry.js';
import { codeContextSchema } from '../src/tools/code-intelligence.js';
import { memberToolScope, type ToolScope } from '../src/services/tool-scope.js';
import { addAgent } from '../src/services/registry.js';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';

type ToolHandler = (input: unknown, extra?: unknown) => Promise<{ content: { type: string; text: string }[] }>;

interface Registered {
  schema: Record<string, unknown>;
  handler: ToolHandler;
}

// Minimal stand-in for McpServer: records what each server.tool() call
// registered. `server.server.sendLoggingMessage` is the only other member
// registerAllTools touches (onboarding notifications).
async function recordRegisteredTools(scope?: ToolScope): Promise<Map<string, Registered>> {
  const registered = new Map<string, Registered>();
  const fakeServer = {
    tool: (name: string, _description: string, schema: Record<string, unknown>, handler: ToolHandler) => {
      registered.set(name, { schema, handler });
    },
    server: { sendLoggingMessage: async () => {} },
  };
  await registerAllTools(fakeServer as never, scope);
  return registered;
}

const PROVIDER_RESULT = { content: [{ type: 'text', text: 'provider result' }] };
const ENRICHED_RESULT = { content: [{ type: 'text', text: 'provider result' }, { type: 'text', text: '[knowledge-bank] ...' }] };

let scratch: string;
let serverRepo: string;
let memberRepo: string;
let memberId: string;

function gitRepo(name: string): string {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

beforeAll(() => {
  backupAndResetRegistry();
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code-registry-wiring-')));
  serverRepo = gitRepo('server');
  memberRepo = gitRepo('member');
  const agent = makeTestLocalAgent({ friendlyName: 'code-wiring-member', workFolder: memberRepo });
  addAgent(agent);
  memberId = agent.id;
});

afterAll(() => {
  restoreRegistry();
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('code_context registry wiring (code self)', () => {
  beforeEach(() => {
    handleCodeContextSpy.mockReset();
    handleCodeContextSpy.mockResolvedValue(PROVIDER_RESULT);
    enrichSpy.mockReset();
    enrichSpy.mockResolvedValue(ENRICHED_RESULT);
    recordUsageSpy.mockReset();
    vi.spyOn(process, 'cwd').mockReturnValue(serverRepo);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers code_context with a schema that has no repo scope argument', async () => {
    const { schema } = (await recordRegisteredTools()).get('code_context')!;
    expect(Object.keys(schema)).toEqual(['name']);
  });

  it('FULL session: provider, telemetry and KB enrichment all get the server working folder', async () => {
    const { handler } = (await recordRegisteredTools()).get('code_context')!;
    const input = codeContextSchema.parse({ name: 'validateUser' });

    await handler(input, { sessionId: 'sess-full' });

    expect(handleCodeContextSpy).toHaveBeenCalledWith(input, { repo: serverRepo, memberId: undefined });
    // Usage attribution (4th argument): a FULL session carries its session id
    // but never a member id.
    expect(recordUsageSpy).toHaveBeenCalledTimes(1);
    expect(recordUsageSpy).toHaveBeenCalledWith('code_context', 'validateUser', serverRepo, { memberId: undefined, sessionId: 'sess-full' });
    expect(recordUsageSpy.mock.calls[0][3]?.memberId).toBeUndefined();
    expect(enrichSpy).toHaveBeenCalledWith('validateUser', PROVIDER_RESULT, serverRepo, undefined);
  });

  it('MEMBER session: provider, telemetry and KB enrichment all get the member work folder', async () => {
    const { handler } = (await recordRegisteredTools(memberToolScope(memberId, false))).get('code_context')!;
    const input = codeContextSchema.parse({ name: 'validateUser' });

    await handler(input, { sessionId: 'sess-member' });

    expect(handleCodeContextSpy).toHaveBeenCalledWith(input, { repo: memberRepo, memberId });
    // Usage attribution (4th argument): a MEMBER session's call is attributed
    // to the member id (from the tool scope) and the session id.
    expect(recordUsageSpy).toHaveBeenCalledTimes(1);
    expect(recordUsageSpy).toHaveBeenCalledWith('code_context', 'validateUser', memberRepo, { memberId, sessionId: 'sess-member' });
    expect(recordUsageSpy.mock.calls[0][3]?.memberId).toBe(memberId);
    expect(enrichSpy).toHaveBeenCalledWith('validateUser', PROVIDER_RESULT, memberRepo, undefined);
  });

  it('returns the ENRICHED result, not the raw provider result', async () => {
    const { handler } = (await recordRegisteredTools()).get('code_context')!;

    const out = await handler(codeContextSchema.parse({ name: 'validateUser' }));

    expect(JSON.parse(out.content[out.content.length - 1].text)).toEqual(ENRICHED_RESULT);
  });
});
