/**
 * Member access secret (apra-fleet-b4g.122.4): a session from another user
 * cannot use an apra-fleet install's server over loopback.
 *
 * Every install holds an owner-only secret in its data dir; its server accepts
 * a ?member= session only with that secret (HTTP-level 401/OK checks live in
 * tests/http-transport.test.ts section (k) and the two-install integration
 * test). Covered here:
 *  - the secret file itself (owner-only, stable, a corrupt one replaced);
 *  - every writer of a member MCP config carries it -- the claude per-folder
 *    entry, the opencode per-folder entry, the remote per-session config, the
 *    local per-session config -- and no exec string sent to the member ever
 *    contains it (the shared sentinel scanner: raw, base64, -EncodedCommand);
 *  - the upgrade path: an older member install without a secret gets one from
 *    update_member fleet_install "auto", written through the secret-file
 *    channel and recorded (encrypted) for the orchestrator's later writes;
 *  - a local member (agentType local) still gets kb_* / code_* through the
 *    per-session config path: its config's URL + headers open a member session
 *    on a real server that lists them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  backupAndResetRegistry, restoreRegistry, makeTestAgent, makeTestLocalAgent, decodePowerShellEncodedCommand,
} from './test-helpers.js';
import { findSentinel } from './helpers/sentinel-scan.js';
import {
  MEMBER_SECRET_HEADER, getOrCreateMemberAccessSecret, memberAccessSecretMatches, memberAccessSecretPath,
  readMemberAccessSecret,
} from '../src/services/member-access-secret.js';
import { sessionMcpConfigContent, writeSessionMcpConfig } from '../src/services/session-mcp-config.js';
import { ClaudeProvider } from '../src/providers/claude.js';
import { OpenCodeProvider } from '../src/providers/opencode.js';
import { AgyProvider } from '../src/providers/agy.js';
import { addAgent, getAgent, recordFleetMcpStatus, updateAgent } from '../src/services/registry.js';
import { __setMemberFleetMcpDeps, type MemberFleetMcpDeps } from '../src/services/member-fleet-install.js';
import { updateMember } from '../src/tools/update-member.js';
import { createHttpTransport, type HttpTransportHandle } from '../src/services/http-transport.js';
import { registerAllTools } from '../src/services/tool-registry.js';
import { encryptPassword, decryptPassword } from '../src/utils/crypto.js';
import type { MemberShell } from '../src/os/os-commands.js';
import type { Agent, SSHExecResult } from '../src/types.js';

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
    testConnection: vi.fn(async () => ({ ok: true, latencyMs: 5 })),
    transferFiles: async (paths: string[]) => ({ success: paths, failed: [] }),
    writeSecretFile: async () => { throw new Error('the test injects its own secret-file channel'); },
    removeSecretFile: async () => undefined,
    close: vi.fn(),
  }),
}));
vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
  readMemberStatus: vi.fn(() => 'idle'),
}));
vi.mock('../src/cli/install.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/cli/install.js')>();
  return { ...actual, loadAgentAssets: () => [] };
});

const SECRET = 'e3'.repeat(32); // a well-formed 64-hex secret, easy to grep for
const ok = (stdout = ''): SSHExecResult => ({ stdout, stderr: '', code: 0 });
const plain = (c: string): string => (c.includes('-EncodedCommand') ? decodePowerShellEncodedCommand(c) : c);

/** Every command must be free of the secret, in every encoding the scanner knows. */
function expectNoSecretIn(commands: string[], secret = SECRET): void {
  expect(commands.length).toBeGreaterThan(0);
  for (const c of commands) expect(findSentinel(c, secret), c).toBeNull();
}

let tmp: string;
beforeEach(() => {
  backupAndResetRegistry();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'member-access-secret-'));
});
afterEach(() => {
  __setMemberFleetMcpDeps(null);
  restoreRegistry();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the secret file', () => {
  it('is created owner-only with 64 hex chars, then read back unchanged', () => {
    const p = path.join(tmp, 'data', 'member-access.key');
    const a = getOrCreateMemberAccessSecret(p);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(getOrCreateMemberAccessSecret(p)).toBe(a);
    expect(readMemberAccessSecret(p)).toBe(a);
    if (process.platform !== 'win32') expect(fs.statSync(p).mode & 0o777).toBe(0o600);
  });

  it('a corrupt file is replaced, and two installs (data dirs) get different secrets', () => {
    const p = path.join(tmp, 'a', 'member-access.key');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'not-a-secret');
    const a = getOrCreateMemberAccessSecret(p);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(getOrCreateMemberAccessSecret(path.join(tmp, 'b', 'member-access.key'))).not.toBe(a);
  });

  it('matching is exact: missing, wrong, truncated and absent-expected all fail', () => {
    expect(memberAccessSecretMatches(SECRET, SECRET)).toBe(true);
    expect(memberAccessSecretMatches(undefined, SECRET)).toBe(false);
    expect(memberAccessSecretMatches('f'.repeat(64), SECRET)).toBe(false);
    expect(memberAccessSecretMatches(SECRET.slice(1), SECRET)).toBe(false);
    expect(memberAccessSecretMatches(SECRET, null)).toBe(false);
    expect(memberAccessSecretMatches([SECRET], SECRET)).toBe(false);
  });
});

interface Flavour { name: string; os: 'linux' | 'windows'; shell?: MemberShell; home: string; work: string }
const FLAVOURS: Flavour[] = [
  { name: 'posix', os: 'linux', home: '/home/bella', work: '/home/bella/repo' },
  { name: 'windows/powershell', os: 'windows', shell: 'powershell5', home: 'C:\\Users\\bella', work: 'C:\\Users\\bella\\repo' },
  { name: 'windows/gitbash', os: 'windows', shell: 'gitbash', home: '/c/Users/bella', work: '/c/Users/bella/repo' },
];

/** A fresh member shell that records every command (decoded) and answers the
 *  config reads/writes the writers issue; the secret-file channel stages into
 *  `staged`. */
function fakeMember() {
  const commands: string[] = [];
  const staged: string[] = [];
  const exec = async (raw: string): Promise<SSHExecResult> => {
    commands.push(raw);
    const c = plain(raw);
    if (c.includes('rev-parse') || c.includes('ls-files')) return { stdout: '', stderr: 'not a git repository', code: 128 };
    if (/^test -f |Test-Path .*-PathType Leaf/.test(c)) return { stdout: '', stderr: '', code: 1 };
    return ok('');
  };
  const secretChannel = {
    write: async (content: string) => { staged.push(content); return `/staged/.apra-fleet-secret-${staged.length}`; },
    remove: async () => undefined,
  };
  return { commands, staged, exec, secretChannel };
}

describe('every member MCP config writer carries the secret; no member command contains it', () => {
  for (const f of FLAVOURS) {
    it(`claude per-folder entry (${f.name})`, async () => {
      const m = fakeMember();
      const agent = makeTestAgent({ os: f.os, shell: f.shell, workFolder: f.work, llmProvider: 'claude' });
      const url = `http://localhost:7611/mcp?member=${agent.id}`;
      await new ClaudeProvider().syncMemberMcpEntry({
        agent, execCommand: m.exec, memberHomeDir: f.home, agentOs: f.os, shell: f.shell,
        secretChannel: m.secretChannel, url, headers: { [MEMBER_SECRET_HEADER]: SECRET },
      });
      expect(m.staged).toHaveLength(1);
      const written = JSON.parse(m.staged[0]);
      const projects = written.projects as Record<string, { mcpServers: Record<string, unknown> }>;
      const entry = Object.values(projects)[0].mcpServers['apra-fleet'];
      expect(entry).toEqual({ type: 'http', url, headers: { [MEMBER_SECRET_HEADER]: SECRET } });
      expectNoSecretIn(m.commands);
    });

    it(`opencode per-folder entry (${f.name})`, async () => {
      const m = fakeMember();
      const agent = makeTestAgent({ os: f.os, shell: f.shell, workFolder: f.work, llmProvider: 'opencode' });
      const url = `http://localhost:7611/mcp?member=${agent.id}`;
      await new OpenCodeProvider().syncMemberMcpEntry({
        agent, execCommand: m.exec, memberHomeDir: null, agentOs: f.os, shell: f.shell,
        secretChannel: m.secretChannel, url, headers: { [MEMBER_SECRET_HEADER]: SECRET },
      });
      expect(m.staged).toHaveLength(1);
      expect(JSON.parse(m.staged[0]).mcp['apra-fleet']).toEqual({ type: 'remote', url, enabled: true, headers: { [MEMBER_SECRET_HEADER]: SECRET } });
      expectNoSecretIn(m.commands);
      // the move that lands it names only paths
      expect(m.commands.some(c => /mv -f|Move-Item/.test(plain(c)) && plain(c).includes('opencode.json'))).toBe(true);
    });

    it(`agy per-folder entry (${f.name})`, async () => {
      const m = fakeMember();
      const agent = makeTestAgent({ os: f.os, shell: f.shell, workFolder: f.work, llmProvider: 'agy' });
      const url = `http://localhost:7611/mcp?member=${agent.id}`;
      await new AgyProvider().syncMemberMcpEntry({
        agent, execCommand: m.exec, memberHomeDir: f.home, agentOs: f.os, shell: f.shell,
        secretChannel: m.secretChannel, url, headers: { [MEMBER_SECRET_HEADER]: SECRET },
      });
      expect(m.staged).toHaveLength(1);
      expect(JSON.parse(m.staged[0]).mcpServers['apra-fleet']).toEqual({ url, headers: { [MEMBER_SECRET_HEADER]: SECRET } });
      expectNoSecretIn(m.commands);
      // the move that lands it names only paths
      expect(m.commands.some(c => /mv -f|Move-Item/.test(plain(c)) && plain(c).includes('mcp_config.json'))).toBe(true);
    });

    it(`remote per-session config (${f.name})`, async () => {
      const m = fakeMember();
      const agent = makeTestAgent({ os: f.os, shell: f.shell, workFolder: f.work, memberMcpPort: 7611, encryptedMemberMcpSecret: encryptPassword(SECRET) });
      const target = f.os === 'windows' && f.shell !== 'gitbash' ? `${f.work}\\.fleet-session-mcp.json` : `${f.work}/.fleet-session-mcp.json`;
      const r = await writeSessionMcpConfig(agent, target, m.exec, { alwaysLoad: true, stage: async (_a, content) => m.secretChannel.write(content) });
      expect(r).toEqual({ ok: true });
      expect(m.staged).toHaveLength(1);
      expect(JSON.parse(m.staged[0]).mcpServers['apra-fleet']).toEqual({
        type: 'http', url: `http://localhost:7611/mcp?member=${agent.id}`, headers: { [MEMBER_SECRET_HEADER]: SECRET }, alwaysLoad: true,
      });
      expectNoSecretIn(m.commands);
    });
  }

  it('an opencode entry with the secret and no secret-file channel fails loudly instead of writing inline', async () => {
    const m = fakeMember();
    const agent = makeTestAgent({ os: 'linux', workFolder: '/home/bella/repo', llmProvider: 'opencode' });
    await expect(new OpenCodeProvider().syncMemberMcpEntry({
      agent, execCommand: m.exec, memberHomeDir: null, agentOs: 'linux',
      url: `http://localhost:7611/mcp?member=${agent.id}`, headers: { [MEMBER_SECRET_HEADER]: SECRET },
    })).rejects.toThrow(/E-MEMBER-CONFIG-NO-FILE-CHANNEL/);
    for (const c of m.commands) expect(findSentinel(c, SECRET)).toBeNull();
  });

  it('an agy entry with the secret and no secret-file channel fails loudly instead of writing inline', async () => {
    const m = fakeMember();
    const agent = makeTestAgent({ os: 'linux', workFolder: '/home/bella/repo', llmProvider: 'agy' });
    await expect(new AgyProvider().syncMemberMcpEntry({
      agent, execCommand: m.exec, memberHomeDir: '/home/bella', agentOs: 'linux',
      url: `http://localhost:7611/mcp?member=${agent.id}`, headers: { [MEMBER_SECRET_HEADER]: SECRET },
    })).rejects.toThrow(/E-MEMBER-CONFIG-NO-FILE-CHANNEL/);
    for (const c of m.commands) expect(findSentinel(c, SECRET)).toBeNull();
  });

  it('a remote member whose install has no secret (older) gets a header-free session config through the plain writer', () => {
    const agent = makeTestAgent({ os: 'linux' });
    expect(JSON.parse(sessionMcpConfigContent(agent)).mcpServers['apra-fleet'].headers).toBeUndefined();
  });

  it("local per-session config: this install's own secret, owner-only file", async () => {
    const agent = makeTestLocalAgent();
    const file = path.join(tmp, 'session-mcp', `${agent.id}.json`);
    const r = await writeSessionMcpConfig(agent, file, async () => { throw new Error('a local config needs no member command'); });
    expect(r).toEqual({ ok: true });
    const entry = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers['apra-fleet'];
    expect(entry.headers).toEqual({ [MEMBER_SECRET_HEADER]: readMemberAccessSecret(memberAccessSecretPath()) });
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

// ---------------------------------------------------------------------------
// Upgrade path: update_member fleet_install "auto" on an older member install
// ---------------------------------------------------------------------------

const VERSION = 'v0.4.4';
const HOME = '/home/bella';
const WORK = '/home/bella/repo';

interface World {
  installed: string;
  /** Content of <home>/.apra-fleet/data/member-access.key on the member (null: absent). */
  secretFile: string | null;
  /** Files staged through the secret-file channel, by path. */
  staged: Map<string, string>;
  log: string[];
  /** Agents handed to the per-folder entry writer. */
  written: Agent[];
  recorded: string[];
  readFails?: boolean;
}

function upgradeDeps(w: World): MemberFleetMcpDeps {
  return {
    exec: async (_agent, raw) => {
      const c = plain(raw);
      w.log.push(raw);
      if (c.includes('member-access.key') && c.includes('mv -f')) {
        const from = /mv -f "([^"]+)"/.exec(c)![1];
        w.secretFile = w.staged.get(from) ?? null;
        w.staged.delete(from);
        return ok();
      }
      if (c.includes('member-access.key')) {
        if (w.readFails) return { stdout: '', stderr: 'Permission denied', code: 1 };
        return ok(w.secretFile ?? '');
      }
      if (c.includes('member-install.json') && c.includes('cat ')) return ok(JSON.stringify({ version: w.installed, port: 7611 }));
      if (c.includes('member-install.json')) return ok('');
      if (c.includes('server.json')) return ok('');
      if (c.includes("'register-member'")) return ok('registered');
      if (c.includes('command -v bd')) return ok('bd version 1.3.0\n');
      if (c.includes("'call'") && c.includes("'--list-tools'")) return ok(JSON.stringify({ tools: ['version', 'kb_query', 'code_query'].map(name => ({ name })) }));
      if (c.includes("'call'") && c.includes("'version'")) return ok(JSON.stringify({ content: [{ type: 'text', text: `apra-fleet ${w.installed}` }] }));
      if (c.includes('--version')) return ok(`apra-fleet ${w.installed}\n`);
      if (c.includes('uname -m')) return ok('x86_64');
      if (c.includes("'install'")) { w.installed = VERSION; return ok('installed'); }
      return { stdout: '', stderr: `unexpected: ${c}`, code: 127 };
    },
    transfer: async (_a, localPaths) => ({ success: localPaths, failed: [] }),
    resolveHome: async () => HOME,
    orchestratorPlatform: () => ({ os: 'linux', arch: 'x64' }),
    orchestratorExecutable: () => '/opt/fleet/apra-fleet',
    orchestratorVersion: () => VERSION,
    downloadReleaseAsset: async () => { throw new Error('not expected'); },
    removeLocal: () => {},
    connectLocalMember: async () => { throw new Error('not expected'); },
    now: () => new Date(Date.UTC(2026, 9, 6, 12, 0, 0)),
    record: (id, status) => { recordFleetMcpStatus(id, status); },
    writeMcpEntry: async (agent: Agent) => { w.written.push(agent); return { ok: true }; },
    stageSecretFile: async (_agent, content) => {
      const p = `${HOME}/.apra-fleet-member-access-${w.staged.size + 1}`;
      w.staged.set(p, content);
      return p;
    },
    recordMemberSecret: (id, secret) => { w.recorded.push(secret); updateAgent(id, { encryptedMemberMcpSecret: encryptPassword(secret) }); },
  };
}

function world(over: Partial<World> = {}): World {
  return { installed: 'v0.4.3', secretFile: null, staged: new Map(), log: [], written: [], recorded: [], ...over };
}

function remoteMember(): Agent {
  const a = makeTestAgent({ os: 'linux', llmProvider: 'claude', workFolder: WORK, friendlyName: 'bella' });
  addAgent(a);
  return a;
}

describe('upgrade path: an older member install gets a secret from fleet_install "auto"', () => {
  it('creates it on the member through the secret-file channel, records it, and the per-folder writer uses it', async () => {
    const w = world();
    __setMemberFleetMcpDeps(upgradeDeps(w));
    const a = remoteMember();
    const result = await updateMember({ member_id: a.id, fleet_install: 'auto' } as any);
    expect(result).toContain('fleetMcp: available');
    expect(w.log.some(c => plain(c).includes("'install'"))).toBe(true);

    const secret = w.secretFile?.trim() ?? '';
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(w.staged.size).toBe(0); // moved into place, nothing left staged
    expect(w.recorded).toEqual([secret]);
    expect(decryptPassword(getAgent(a.id)!.encryptedMemberMcpSecret!)).toBe(secret);
    // the per-folder entry writer got an agent that carries it
    expect(w.written).toHaveLength(1);
    expect(decryptPassword(w.written[0].encryptedMemberMcpSecret!)).toBe(secret);
    // ... and later session configs carry it
    expect(JSON.parse(sessionMcpConfigContent(getAgent(a.id)!)).mcpServers['apra-fleet'].headers).toEqual({ [MEMBER_SECRET_HEADER]: secret });
    // it never rode a command string
    expectNoSecretIn(w.log, secret);
    // the status shown to the operator does not carry it
    expect(JSON.stringify(getAgent(a.id)!.fleetMcp)).not.toContain(secret);
  });

  it('an install that already has a secret keeps it (read, never rewritten)', async () => {
    const w = world({ installed: VERSION, secretFile: `${SECRET}\n` });
    __setMemberFleetMcpDeps(upgradeDeps(w));
    const a = remoteMember();
    await updateMember({ member_id: a.id, fleet_install: 'auto' } as any);
    expect(w.secretFile).toBe(`${SECRET}\n`);
    expect(w.log.some(c => plain(c).includes('mv -f'))).toBe(false);
    expect(decryptPassword(getAgent(a.id)!.encryptedMemberMcpSecret!)).toBe(SECRET);
    expectNoSecretIn(w.log);
  });

  it('an unreadable secret file makes fleetMcp unavailable with its own reason, never a silent header-free success', async () => {
    const w = world({ installed: VERSION, readFails: true });
    __setMemberFleetMcpDeps(upgradeDeps(w));
    const a = remoteMember();
    await updateMember({ member_id: a.id, fleet_install: 'auto' } as any);
    expect(getAgent(a.id)!.fleetMcp).toMatchObject({ state: 'unavailable', reason: 'member-secret-unavailable' });
    expect(getAgent(a.id)!.fleetMcp!.detail).toContain('member-access.key');
  });
});

// ---------------------------------------------------------------------------
// A local member keeps kb/code access through the per-session config path
// ---------------------------------------------------------------------------

describe('a local member still gets kb/code access through its per-session config', () => {
  let handle: HttpTransportHandle | undefined;
  let client: Client | undefined;
  afterEach(async () => {
    try { await client?.close(); } catch { /* ignore */ }
    if (handle) await handle.close();
    handle = undefined;
    client = undefined;
  });

  it("the config's URL and headers open a member session that lists kb_* and code_*", async () => {
    const agent = makeTestLocalAgent({ workFolder: tmp });
    addAgent(agent);
    handle = await createHttpTransport({ registerTools: (s, scope) => registerAllTools(s, scope), preferredPort: 0 });
    const entry = JSON.parse(sessionMcpConfigContent(agent)).mcpServers['apra-fleet'] as { url: string; headers: Record<string, string> };
    // The config names this server's port; the test server listens on an ephemeral one.
    const url = new URL(entry.url);
    url.host = `127.0.0.1:${handle.port}`;
    client = new Client({ name: 'local-member-session', version: '1.0.0' }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(url, {
      reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 100, initialReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 },
      requestInit: { headers: entry.headers },
    }));
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names.some(n => n.startsWith('kb_'))).toBe(true);
    expect(names.some(n => n.startsWith('code_'))).toBe(true);
  });

  it('the same session without the config headers is refused', async () => {
    const agent = makeTestLocalAgent({ workFolder: tmp });
    addAgent(agent);
    handle = await createHttpTransport({ registerTools: (s, scope) => registerAllTools(s, scope), preferredPort: 0 });
    client = new Client({ name: 'no-secret', version: '1.0.0' }, { capabilities: {} });
    await expect(client.connect(new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${handle.port}/mcp?member=${agent.id}`),
      { reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 100, initialReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 } },
    ))).rejects.toThrow(/member secret required/);
  });
});
