import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import { makeTestAgent, makeTestLocalAgent, backupAndResetRegistry, restoreRegistry, decodePowerShellEncodedCommand } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { executePrompt, provisionedRemoteAgents, inFlightAgents, withToolErrors, type ExecutePromptResult } from '../src/tools/execute-prompt.js';
import { recordToolError, __resetErrorRegistry } from '../src/services/error-registry.js';
import type { SSHExecResult } from '../src/types.js';

// execute_prompt's toolErrors: once a dispatch ends, the member's tool-call
// errors for the call's elapsed time are attached as an FYI -- read in-process
// for a local member, over SSH for a remote one. A query that cannot run never
// fails the dispatch.

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
  readMemberStatus: vi.fn(() => 'idle'),
}));

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: vi.fn(),
    transferFiles: vi.fn(),
    writeSecretFile: vi.fn(async (name: string) => `/home/testuser/${name}`),
    removeSecretFile: vi.fn(async () => {}),
    close: vi.fn(),
  }),
}));

vi.mock('../src/services/agent-provisioner.js', () => ({
  provisionAgents: vi.fn().mockResolvedValue({ pushed: [] }),
  remoteAgentsDir: vi.fn().mockReturnValue('.claude/agents/pm'),
}));

vi.mock('../src/utils/workspace-trust.js', () => ({
  seedWorkspaceTrust: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/services/member-home.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/member-home.js')>()),
  getMemberHomeDir: vi.fn(async () => '/home/testuser'),
}));

const OK = JSON.stringify({ result: 'ok', session_id: 'sess-te' });
const AVAILABLE = { state: 'available' as const, checkedAt: '2026-11-01T00:00:00Z' };
const DISPATCH_MS = 42_500;
/** The window the member is asked for: 43 s elapsed (rounded up) plus 5 s of start slack. */
const WINDOW_S = 48;

const decoded = (c: string) => (c.startsWith('powershell -EncodedCommand ') ? decodePowerShellEncodedCommand(c) : c);
const isQuery = (c: string) => decoded(c).includes("'query_errors'");
const isMain = (c: string) => decoded(c).includes('--output-format json');
const queryCmds = () => mockExecCommand.mock.calls.map(c => c[0]).filter(isQuery);

/**
 * Stub member: the main dispatch takes DISPATCH_MS and records `during`
 * (when given) as a tool error made by the doer; the query_errors call
 * answers with `query`; everything else succeeds.
 */
function stub(query: (cmd: string) => Promise<SSHExecResult>, during?: () => void) {
  mockExecCommand.mockImplementation(async (cmd: string) => {
    if (isQuery(cmd)) return query(cmd);
    if (isMain(cmd)) {
      vi.setSystemTime(Date.now() + DISPATCH_MS);
      during?.();
      return { stdout: OK, stderr: '', code: 0 };
    }
    return { stdout: OK, stderr: '', code: 0 };
  });
}

const structured = (r: unknown) => (r as ExecutePromptResult).structuredContent!;

describe('execute_prompt toolErrors', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    vi.useFakeTimers();
    provisionedRemoteAgents.clear();
    __resetErrorRegistry();
  });
  afterEach(() => {
    restoreRegistry();
    vi.useRealTimers();
    __resetErrorRegistry();
  });

  it('local member: reads this server\'s registry in-process for the elapsed window, no SSH query', async () => {
    const workFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-te-local-'));
    const member = makeTestLocalAgent({ friendlyName: 'te-local', workFolder });
    addAgent(member);
    onTestFinished(() => fs.rmSync(workFolder, { recursive: true, force: true }));
    // Before the call: outside the window.
    vi.setSystemTime(Date.now() - 30_000);
    recordToolError(member.id, 'kb_capture', new Error('earlier'));
    vi.setSystemTime(Date.now() + 30_000);
    stub(async () => { throw new Error('no SSH query for a local member'); },
      () => recordToolError(member.id, 'kb_query', Object.assign(new Error('x'), { code: 'E-KB-HTTP-AUTH', reason: 'expired' })));

    const r = await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 120 });
    const sc = structured(r);
    expect(sc.isError).toBeFalsy();
    expect(sc.toolErrors).toMatchObject({ available: true, sinceSeconds: WINDOW_S, total: 1 });
    expect((sc.toolErrors as { entries: Array<{ tool: string; code: string; reason: string }> }).entries.map(e => [e.tool, e.code, e.reason]))
      .toEqual([['kb_query', 'E-KB-HTTP-AUTH', 'expired']]);
    expect(queryCmds()).toEqual([]);
  });

  it('remote member: queries the member over SSH for the elapsed window and attaches the entries', async () => {
    const member = makeTestAgent({ friendlyName: 'te-remote', os: 'linux', fleetMcp: AVAILABLE });
    addAgent(member);
    const entry = { at: '2026-11-01T00:00:01.000Z', member: member.id, source: 'tool-call', tool: 'kb_query', code: 'E-KB-HTTP-AUTH', reason: 'rejected' };
    stub(async () => ({ stdout: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ total: 1, entries: [entry] }) }] }), stderr: '', code: 0 }));

    const r = await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 120 });
    const sc = structured(r);
    expect(sc.response).toBe('ok');
    expect(sc.toolErrors).toEqual({ available: true, sinceSeconds: WINDOW_S, total: 1, entries: [entry] });
    expect(queryCmds()).toHaveLength(1);
    expect(queryCmds()[0]).toContain(`"since_seconds":${WINDOW_S}`);
  });

  it('an older member install without query_errors: the dispatch succeeds and toolErrors says unavailable', async () => {
    const member = makeTestAgent({ friendlyName: 'te-old', os: 'linux', fleetMcp: AVAILABLE });
    addAgent(member);
    stub(async () => ({ stdout: '', stderr: JSON.stringify({ error: { code: 'E-TOOL', message: 'MCP error -32602: Tool query_errors not found' } }), code: 1 }));

    const r = await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 120 });
    const sc = structured(r);
    expect(sc.isError).toBeFalsy();
    expect(sc.response).toBe('ok');
    expect(sc.toolErrors).toMatchObject({ available: false, sinceSeconds: WINDOW_S });
    expect(sc.toolErrors).not.toHaveProperty('entries');
  });

  it('a query that throws does not fail the dispatch', async () => {
    const member = makeTestAgent({ friendlyName: 'te-throw', os: 'linux', fleetMcp: AVAILABLE });
    addAgent(member);
    stub(async () => { throw new Error('Connection lost'); });

    const r = await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 120 });
    const sc = structured(r);
    expect(sc.isError).toBeFalsy();
    expect(sc.response).toBe('ok');
    expect(sc.toolErrors).toMatchObject({ available: false });
  });

  // Skipped while a caller deadline may be about to expire: max_total_s nearly
  // spent, or (timeout_s only) elapsed within [timeout_s - 2 s, timeout_s + 30 s],
  // where apra-fleet-client's timeout_s-derived deadline may still be pending.
  it.each([
    ['max_total_s nearly spent', { timeout_s: 120, max_total_s: 43 }],
    ['timeout_s only, elapsed just under it', { timeout_s: 43 }],
    ['timeout_s only, elapsed inside its client grace', { timeout_s: 20 }],
  ])('%s: the remote query is skipped, reported unavailable', async (_label, limits) => {
    const member = makeTestAgent({ friendlyName: 'te-budget', os: 'linux', fleetMcp: AVAILABLE });
    addAgent(member);
    stub(async () => { throw new Error('the query must not run'); });

    const r = await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, ...limits });
    const sc = structured(r);
    expect(sc.response).toBe('ok');
    expect(sc.toolErrors).toMatchObject({ available: false });
    expect(queryCmds()).toEqual([]);
  });

  it('timeout_s only, dispatch ran well past it (inactivity timeout, not a total): the remote member is still queried', async () => {
    const member = makeTestAgent({ friendlyName: 'te-long', os: 'linux', fleetMcp: AVAILABLE });
    addAgent(member);
    stub(async () => ({ stdout: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ total: 0, entries: [] }) }] }), stderr: '', code: 0 }));

    // timeout_s 5: the client deadline window [3 s, 35 s] has passed at 42.5 s.
    const r = await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });
    expect(structured(r).toolErrors).toEqual({ available: true, sinceSeconds: WINDOW_S, total: 0, entries: [] });
    expect(queryCmds()).toHaveLength(1);
  });

  it('no dispatch ran (member busy): no toolErrors and no query', async () => {
    const member = makeTestAgent({ friendlyName: 'te-busy', os: 'linux', fleetMcp: AVAILABLE });
    addAgent(member);
    stub(async () => { throw new Error('the query must not run'); });
    inFlightAgents.add(member.id);
    onTestFinished(() => { inFlightAgents.delete(member.id); });

    const r = await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 120 });
    const sc = structured(r);
    expect(sc.reason).toBe('busy');
    expect(sc).not.toHaveProperty('toolErrors');
    expect(queryCmds()).toEqual([]);
  });
});

describe('withToolErrors', () => {
  const agent = makeTestAgent({ friendlyName: 'wte' });
  const report = { available: true as const, sinceSeconds: 1, total: 0, entries: [] };

  it('adds no structuredContent where the result had none, and does not read', async () => {
    const read = vi.fn(async () => report);
    const plain: ExecutePromptResult = { text: 'done' };
    expect(await withToolErrors(plain, agent, read)).toEqual({ text: 'done' });
    expect(await withToolErrors('[FAIL] text', agent, read)).toBe('[FAIL] text');
    expect(read).not.toHaveBeenCalled();
  });

  it('attaches toolErrors only when a dispatch ran', async () => {
    const read = vi.fn(async () => report);
    const r: ExecutePromptResult = { text: 'ok', structuredContent: { response: 'ok' } };
    expect(await withToolErrors(r, undefined, read)).toBe(r);
    expect(read).not.toHaveBeenCalled();
    expect(await withToolErrors(r, agent, read)).toEqual({ text: 'ok', structuredContent: { response: 'ok', toolErrors: report } });
  });
});
