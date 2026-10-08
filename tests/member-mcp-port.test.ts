/**
 * The member MCP URL uses the port the member's OWN install records.
 *
 * Two member installs on one host (one per Unix user) cannot share a port, so
 * a remote member's per-folder entry and per-session --mcp-config must point
 * at the port its own install recorded in data/member-install.json -- never a
 * hard-coded default another user's server may hold. Verified here with a FAKE
 * member transport: the fleetMcp probe reads the marker on the member,
 * resolves the port, hands the per-folder writer an agent carrying it, and the
 * registry persists it so later sessions use it too.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  backupAndResetRegistry, restoreRegistry, makeTestAgent, decodePowerShellEncodedCommand,
} from './test-helpers.js';
import { addAgent, getAgent, recordFleetMcpStatus } from '../src/services/registry.js';
import {
  refreshMemberFleetMcp, resolveMemberMcpPort, type MemberFleetMcpDeps,
} from '../src/services/member-fleet-install.js';
import { memberMcpUrl } from '../src/services/member-config-io.js';
import { sessionMcpConfigContent } from '../src/services/session-mcp-config.js';
import type { Agent, SSHExecResult } from '../src/types.js';

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
  readMemberStatus: vi.fn(() => 'idle'),
}));

const ORCH = 'v0.4.4';
const HOME = '/home/bella';
const WORK = '/home/bella/repo';

interface World {
  /** member-install.json content on the member ('' = empty file). */
  marker: string;
  /** server.json content on the member, or null when absent. */
  serverJson: string | null;
  log: string[];
  /** Agents handed to the per-folder MCP entry writer. */
  written: Agent[];
}

const ok = (stdout: string): SSHExecResult => ({ stdout, stderr: '', code: 0 });

function deps(w: World): MemberFleetMcpDeps {
  return {
    exec: async (_agent: Agent, raw: string) => {
      const c = decodePowerShellEncodedCommand(raw);
      w.log.push(c);
      // Marker existence probe (test -f / Test-Path -PathType Leaf).
      // The member access secret read: an install without one (older than the secret).
      if (c.includes('member-access.key')) return ok('');
      if (c.includes('member-install.json') && !c.includes('cat ') && !c.includes('Get-Content')) return ok('');
      if (c.includes('member-install.json')) return ok(w.marker);
      if (c.includes('server.json')) return ok(w.serverJson ?? '');
      if (c.includes("'register-member'")) return ok('Member registered successfully');
      if (c.includes("'call'") && c.includes("'--list-tools'")) {
        return ok(JSON.stringify({ tools: ['version', 'kb_query', 'code_query'].map(name => ({ name })) }));
      }
      if (c.includes("'call'") && c.includes("'version'")) return ok(JSON.stringify({ content: [{ type: 'text', text: `apra-fleet ${ORCH}` }] }));
      if (c.includes('--version')) return ok(`apra-fleet ${ORCH}\n`);
      if (c.includes('uname -m')) return ok('x86_64');
      return { stdout: '', stderr: `unexpected: ${c}`, code: 127 };
    },
    transfer: async (_a, localPaths) => ({ success: localPaths, failed: [] }),
    resolveHome: async () => HOME,
    orchestratorPlatform: () => ({ os: 'linux', arch: 'x64' }),
    orchestratorExecutable: () => '/opt/fleet/apra-fleet',
    orchestratorVersion: () => ORCH,
    downloadReleaseAsset: async () => { throw new Error('not expected'); },
    removeLocal: () => {},
    connectLocalMember: async () => { throw new Error('not expected'); },
    now: () => new Date(Date.UTC(2026, 9, 6, 12, 0, 0)),
    record: (id, status) => { recordFleetMcpStatus(id, status); },
    writeMcpEntry: async (agent: Agent) => { w.written.push(agent); return { ok: true }; },
  };
}

function world(marker: object | string, serverJson: object | null = null): World {
  return {
    marker: typeof marker === 'string' ? marker : JSON.stringify(marker),
    serverJson: serverJson === null ? null : JSON.stringify(serverJson),
    log: [],
    written: [],
  };
}

function remoteMember(overrides: Partial<Agent> = {}): Agent {
  const a = makeTestAgent({ os: 'linux', llmProvider: 'claude', workFolder: WORK, friendlyName: 'bella', ...overrides });
  addAgent(a);
  return a;
}

const PROBE = { install: false, writeMcpEntry: true } as const;

beforeEach(() => { backupAndResetRegistry(); });
afterEach(() => { restoreRegistry(); });

describe('marker records port N', () => {
  it('per-folder entry and per-session config both use http://localhost:N/mcp?member=<uuid>', async () => {
    const agent = remoteMember();
    const w = world({ version: ORCH, installedAt: '2026-10-06T00:00:00Z', port: 7611 }, { pid: 4242, port: 7611 });
    const status = await refreshMemberFleetMcp(agent, deps(w), PROBE);
    expect(status).toMatchObject({ state: 'available', port: 7611, portSource: 'marker' });
    expect(status.detail).toBeUndefined();

    const expected = `http://localhost:7611/mcp?member=${encodeURIComponent(agent.id)}`;
    // Per-folder entry: the writer received an agent carrying the resolved port.
    expect(w.written).toHaveLength(1);
    expect(memberMcpUrl(w.written[0])).toBe(expected);
    // Persisted: every later dispatch's per-session config reads the registry entry.
    const stored = getAgent(agent.id)!;
    expect(stored.memberMcpPort).toBe(7611);
    expect(memberMcpUrl(stored)).toBe(expected);
    expect(JSON.parse(sessionMcpConfigContent(stored)).mcpServers['apra-fleet'].url).toBe(expected);
  });

  it('a later probe that fails before reading the marker keeps the recorded port', async () => {
    const agent = remoteMember();
    await refreshMemberFleetMcp(agent, deps(world({ version: ORCH, port: 7611 })), PROBE);
    const d = { ...deps(world({ version: ORCH, port: 7611 })), resolveHome: async () => null };
    const s = await refreshMemberFleetMcp(getAgent(agent.id)!, d, PROBE);
    expect(s).toMatchObject({ state: 'unavailable', reason: 'home-unresolved' });
    expect(getAgent(agent.id)!.memberMcpPort).toBe(7611);
  });
});

describe('no recorded port', () => {
  it('uses the built-in default and fleetMcp detail says the port was not recorded', async () => {
    const agent = remoteMember({ memberMcpPort: 7611 });
    const w = world({ version: 'v0.4.3', installedAt: '2026-10-01T00:00:00Z' });
    const status = await refreshMemberFleetMcp(agent, deps(w), PROBE);
    expect(status).toMatchObject({ state: 'available', port: 7523, portSource: 'default' });
    expect(status.detail).toMatch(/did not record its port/);
    expect(status.detail).toContain('7523');
    const stored = getAgent(agent.id)!;
    expect(stored.memberMcpPort).toBeUndefined();
    expect(stored.fleetMcp?.detail).toMatch(/did not record its port/);
    expect(memberMcpUrl(stored)).toBe(`http://localhost:7523/mcp?member=${encodeURIComponent(agent.id)}`);
    expect(memberMcpUrl(w.written[0])).toBe(`http://localhost:7523/mcp?member=${encodeURIComponent(agent.id)}`);
  });

  it('the note survives a later failure in the same probe', async () => {
    const agent = remoteMember();
    const w = world({ version: ORCH });
    const d = deps(w);
    const exec = d.exec;
    d.exec = async (a, raw, t) => {
      const c = decodePowerShellEncodedCommand(raw);
      if (c.includes("'register-member'")) { w.log.push(c); return { stdout: '', stderr: 'boom', code: 1 }; }
      return exec(a, raw, t);
    };
    const s = await refreshMemberFleetMcp(agent, d, PROBE);
    expect(s).toMatchObject({ state: 'unavailable', reason: 'register-failed', portSource: 'default' });
    expect(s.detail).toMatch(/did not record its port/);
  });
});

describe('marker and server.json disagree', () => {
  it('marker wins and the disagreement is reported', async () => {
    const agent = remoteMember();
    const w = world({ version: ORCH, port: 7611 }, { pid: 99, port: 7523 });
    const status = await refreshMemberFleetMcp(agent, deps(w), PROBE);
    expect(status).toMatchObject({ state: 'available', port: 7611, portSource: 'marker' });
    expect(status.detail).toMatch(/marker records port 7611 but server\.json records port 7523/);
    expect(getAgent(agent.id)!.memberMcpPort).toBe(7611);
    expect(memberMcpUrl(w.written[0])).toContain('localhost:7611/');
  });
});

describe('resolver commands carry no shell variable expansion', () => {
  const EXPANSION = [/\$HOME/, /~\//, /\$env:/i, /\$\(/, /\$\{/, /%USERPROFILE%/i];

  it.each([
    ['linux', undefined, '/home/bella'],
    ['macos', undefined, '/Users/bella'],
    ['windows', 'powershell5', 'C:\\Users\\bella'],
    ['windows', 'gitbash', 'C:/Users/bella'],
  ] as const)('%s (%s)', async (os, shell, home) => {
    const agent = makeTestAgent({ os, ...(shell ? { shell } : {}), workFolder: WORK });
    const log: string[] = [];
    const r = await resolveMemberMcpPort(agent, home, {
      exec: async (_a, raw) => {
        const c = decodePowerShellEncodedCommand(raw);
        log.push(c);
        return ok(c.includes('member-install.json') ? JSON.stringify({ port: 7611 }) : '');
      },
    });
    expect(r).toEqual({ kind: 'resolved', port: 7611, source: 'marker' });
    expect(log).toHaveLength(2);
    for (const c of log) {
      for (const re of EXPANSION) expect(c).not.toMatch(re);
      expect(c).toContain(home.replace(/\\/g, os === 'windows' && shell === 'powershell5' ? '\\' : '/'));
    }
    expect(log[0]).toContain('member-install.json');
    expect(log[1]).toContain('server.json');
  });

  it('an unreadable marker is a failure, never the default', async () => {
    const agent = makeTestAgent({ os: 'linux', workFolder: WORK });
    const r = await resolveMemberMcpPort(agent, HOME, {
      exec: async () => ({ stdout: '', stderr: 'Permission denied', code: 1 }),
    });
    expect(r.kind).toBe('failed');
  });
});

describe('local members are unaffected', () => {
  it('follow this process port, not memberMcpPort', () => {
    const local = { id: 'abc', agentType: 'local' as const, memberMcpPort: 7611 };
    expect(memberMcpUrl(local)).not.toContain(':7611/');
  });
});

