import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, makeTestLocalAgent, decodePowerShellEncodedCommand } from './test-helpers.js';
import { queryMemberToolErrors, type MemberErrorQueryDeps } from '../src/services/member-error-query.js';
import { recordToolError, __resetErrorRegistry } from '../src/services/error-registry.js';
import type { SSHExecResult } from '../src/types.js';

// Reading a member's tool-call errors: in-process for a local member, over
// SSH (`apra-fleet call ... query_errors`) for a remote one. Every failure is
// { available: false }, never an empty list.

const AVAILABLE = { state: 'available' as const, checkedAt: '2026-11-01T00:00:00Z' };

function deps(answer: (cmd: string) => Promise<SSHExecResult>): MemberErrorQueryDeps & { cmds: string[] } {
  const cmds: string[] = [];
  return {
    cmds,
    exec: vi.fn(async (_agent, command: string) => { cmds.push(command); return answer(command); }),
    resolveHome: vi.fn(async () => '/home/u'),
  };
}

const callResult = (body: unknown): SSHExecResult => ({
  stdout: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(body) }] }), stderr: '', code: 0,
});

describe('queryMemberToolErrors', () => {
  beforeEach(() => __resetErrorRegistry());
  afterEach(() => __resetErrorRegistry());

  it('local member: reads this server\'s registry in-process, no command run', async () => {
    const member = makeTestLocalAgent({ friendlyName: 'meq-local' });
    recordToolError(member.id, 'kb_query', Object.assign(new Error('x'), { code: 'E-KB-HTTP-AUTH', reason: 'expired' }));
    recordToolError('someone-else', 'kb_query', new Error('x'));
    const d = deps(async () => { throw new Error('must not run'); });
    const r = await queryMemberToolErrors(member, 30, { timeoutMs: 1000 }, d);
    expect(r).toMatchObject({ available: true, sinceSeconds: 30, total: 1 });
    expect(r.available && r.entries.map(e => [e.member, e.code, e.reason])).toEqual([[member.id, 'E-KB-HTTP-AUTH', 'expired']]);
    expect(d.cmds).toEqual([]);
  });

  it('remote member: runs query_errors as the member with the elapsed window and parses the entries', async () => {
    const member = makeTestAgent({ friendlyName: 'meq-remote', os: 'linux', fleetMcp: AVAILABLE });
    const entry = { at: '2026-11-01T00:00:01.000Z', member: member.id, source: 'tool-call', tool: 'kb_query', code: 'E-KB-HTTP-AUTH', reason: 'rejected' };
    const d = deps(async () => callResult({ member: member.id, since_seconds: 42, total: 1, entries: [entry] }));
    const r = await queryMemberToolErrors(member, 42, { timeoutMs: 5000 }, d);
    expect(r).toEqual({ available: true, sinceSeconds: 42, total: 1, entries: [entry] });
    expect(d.cmds).toHaveLength(1);
    const cmd = d.cmds[0];
    expect(cmd).toContain(`'{"member":"${member.id}","since_seconds":42}'`);
    expect(cmd).toContain(`'/home/u/.apra-fleet/bin/apra-fleet' 'call' '--member' '${member.id}' 'query_errors' '--args-file'`);
    expect(vi.mocked(d.exec).mock.calls[0].slice(2, 4)).toEqual([5000, 5000]);
  });

  it('remote Windows member: PowerShell form, no POSIX syntax', async () => {
    const member = makeTestAgent({ friendlyName: 'meq-win', os: 'windows', shell: 'pwsh7', fleetMcp: AVAILABLE });
    const d = deps(async () => callResult({ total: 0, entries: [] }));
    d.resolveHome = vi.fn(async () => 'C:\\Users\\u');
    const r = await queryMemberToolErrors(member, 7, { timeoutMs: 5000 }, d);
    expect(r).toEqual({ available: true, sinceSeconds: 7, total: 0, entries: [] });
    const ps = decodePowerShellEncodedCommand(d.cmds[0]);
    expect(ps).toContain(`Set-Content -LiteralPath 'C:\\Users\\u\\.apra-fleet\\query-errors-args-${member.id}-`);
    expect(ps).toContain(`& 'C:\\Users\\u\\.apra-fleet\\bin\\apra-fleet.exe' 'call'`);
    expect(ps).not.toContain('printf');
  });

  it('an older member install without query_errors: unavailable with the cause, not zero errors', async () => {
    const member = makeTestAgent({ friendlyName: 'meq-old', os: 'linux', fleetMcp: AVAILABLE });
    const d = deps(async () => ({
      stdout: '',
      stderr: JSON.stringify({ error: { code: 'E-TOOL', message: 'MCP error -32602: Tool query_errors not found', tool: 'query_errors' } }),
      code: 1,
    }));
    const r = await queryMemberToolErrors(member, 10, { timeoutMs: 5000 }, d);
    expect(r.available).toBe(false);
    expect(r).not.toHaveProperty('entries');
    expect(!r.available && r.detail).toContain('E-TOOL');
  });

  it('a member install whose binary has no call verb: unavailable', async () => {
    const member = makeTestAgent({ friendlyName: 'meq-older', os: 'linux', fleetMcp: AVAILABLE });
    const d = deps(async () => ({ stdout: 'Usage: apra-fleet <command>', stderr: "unknown command 'call'", code: 1 }));
    const r = await queryMemberToolErrors(member, 10, { timeoutMs: 5000 }, d);
    expect(r).toMatchObject({ available: false, sinceSeconds: 10 });
  });

  it('remote member without a verified install: unavailable, no SSH round trip', async () => {
    const member = makeTestAgent({ friendlyName: 'meq-noinstall', os: 'linux' });
    const d = deps(async () => callResult({ total: 0, entries: [] }));
    const r = await queryMemberToolErrors(member, 10, { timeoutMs: 5000 }, d);
    expect(r).toMatchObject({ available: false, sinceSeconds: 10 });
    expect(d.cmds).toEqual([]);
  });

  it('an SSH failure is reported, never thrown', async () => {
    const member = makeTestAgent({ friendlyName: 'meq-ssh', os: 'linux', fleetMcp: AVAILABLE });
    const d = deps(async () => { throw new Error('Command timed out after 5000ms'); });
    const r = await queryMemberToolErrors(member, 10, { timeoutMs: 5000 }, d);
    expect(r).toMatchObject({ available: false, sinceSeconds: 10 });
    expect(!r.available && r.detail).toContain('timed out');
  });

  it('each query writes its own args file, so concurrent queries on one member never share one', async () => {
    const member = makeTestAgent({ friendlyName: 'meq-args', os: 'linux', fleetMcp: AVAILABLE });
    const d = deps(async () => callResult({ total: 0, entries: [] }));
    await Promise.all([queryMemberToolErrors(member, 10, { timeoutMs: 5000 }, d), queryMemberToolErrors(member, 20, { timeoutMs: 5000 }, d)]);
    const paths = d.cmds.map(c => /> '([^']+)'/.exec(c)?.[1]);
    expect(paths[0]).toMatch(new RegExp(`query-errors-args-${member.id}-[0-9a-f]+\\.json$`));
    expect(paths[0]).not.toBe(paths[1]);
  });

  describe('one wall-clock deadline for the whole read', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('a home probe that never answers still ends at the deadline, unavailable', async () => {
      const member = makeTestAgent({ friendlyName: 'meq-hang', os: 'linux', fleetMcp: AVAILABLE });
      const d = deps(async () => callResult({ total: 0, entries: [] }));
      d.resolveHome = vi.fn(() => new Promise<string | null>(() => {}));
      const pending = queryMemberToolErrors(member, 10, { timeoutMs: 5000 }, d);
      await vi.advanceTimersByTimeAsync(5000);
      const r = await pending;
      expect(r).toMatchObject({ available: false, sinceSeconds: 10 });
      expect(!r.available && r.detail).toContain('did not answer within 5000 ms');
    });

    it('the caller aborting ends the read at once, and the signal reaches the exec', async () => {
      const member = makeTestAgent({ friendlyName: 'meq-abort', os: 'linux', fleetMcp: AVAILABLE });
      const ac = new AbortController();
      const d = deps(() => new Promise<SSHExecResult>(() => {}));
      const pending = queryMemberToolErrors(member, 10, { timeoutMs: 5000, signal: ac.signal }, d);
      await vi.advanceTimersByTimeAsync(10);
      ac.abort();
      const r = await pending;
      expect(r).toMatchObject({ available: false });
      expect(!r.available && r.detail).toContain('cancelled');
      expect(vi.mocked(d.exec).mock.calls[0][4]).toBe(ac.signal);
    });
  });
});
