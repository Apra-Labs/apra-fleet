/**
 * The install writes the per-install access secret into each provider's MCP
 * registration. The secret must (1) reach every provider's config as the
 * X-Apra-Fleet-Member-Secret header, (2) never land in a world-readable file
 * (existing 0644 configs are tightened), and (3) never ride in argv.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { registerHttpMcp, registerClaudeHttpMcp, registeredMcpTransport } from '../src/cli/install.js';
import { getProviderInstallConfig, writeOwnerOnlyFile } from '../src/cli/config.js';
import type { LlmProvider } from '../src/types.js';

const HEADER = 'X-Apra-Fleet-Member-Secret';
const SECRET = 'cd'.repeat(32);
const URL_ = 'http://localhost:7523/mcp';
const posix = process.platform !== 'win32';

let tmpHome: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-reg-'));
  for (const k of ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR']) saved[k] = process.env[k];
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  delete process.env.CLAUDE_CONFIG_DIR;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const mode = (f: string) => fs.statSync(f).mode & 0o777;
const read = (f: string) => fs.readFileSync(f, 'utf8');

describe('registerHttpMcp writes the secret header per provider, owner-only', () => {
  const cases: Array<{ provider: LlmProvider; file: (h: string) => string; header: (c: string) => unknown }> = [
    { provider: 'claude', file: h => path.join(h, '.claude.json'), header: c => JSON.parse(c).mcpServers['apra-fleet'].headers[HEADER] },
    { provider: 'codex', file: h => getProviderInstallConfig('codex', h).settingsFile, header: c => (parseToml(c) as any).mcp_servers['apra-fleet'].http_headers[HEADER] },
    { provider: 'copilot', file: h => getProviderInstallConfig('copilot', h).settingsFile, header: c => JSON.parse(c).mcpServers['apra-fleet'].headers[HEADER] },
    { provider: 'agy', file: h => path.join(h, '.gemini', 'config', 'mcp_config.json'), header: c => JSON.parse(c).mcpServers['apra-fleet'].headers[HEADER] },
    { provider: 'opencode', file: h => getProviderInstallConfig('opencode', h).settingsFile, header: c => JSON.parse(c).mcp['apra-fleet'].headers[HEADER] },
  ];
  for (const c of cases) {
    it(`${c.provider}: header present${posix ? ', file 0600 even when it pre-existed as 0644' : ''}`, () => {
      const paths = getProviderInstallConfig(c.provider, tmpHome);
      const file = c.file(tmpHome);
      // a pre-existing, group/world-readable config
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, c.provider === 'codex' ? '' : '{}', { mode: 0o644 });
      if (posix) fs.chmodSync(file, 0o644);
      registerHttpMcp(c.provider, paths, URL_, { [HEADER]: SECRET });
      expect(c.header(read(file))).toBe(SECRET);
      if (posix) expect(mode(file)).toBe(0o600);
    });
  }
});

describe('registerClaudeHttpMcp', () => {
  it('preserves other claude config and honours CLAUDE_CONFIG_DIR', () => {
    const dir = path.join(tmpHome, 'cc');
    fs.mkdirSync(dir);
    process.env.CLAUDE_CONFIG_DIR = dir;
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ numStartups: 7, mcpServers: { other: { type: 'http', url: 'x' } } }));
    registerClaudeHttpMcp(URL_, { [HEADER]: SECRET });
    const j = JSON.parse(read(path.join(dir, '.claude.json')));
    expect(j.numStartups).toBe(7);
    expect(j.mcpServers.other).toEqual({ type: 'http', url: 'x' });
    expect(j.mcpServers['apra-fleet']).toEqual({ type: 'http', url: URL_, headers: { [HEADER]: SECRET } });
    expect(fs.existsSync(path.join(tmpHome, '.claude.json'))).toBe(false);
  });

  it('refuses to overwrite an unparseable claude config', () => {
    const f = path.join(tmpHome, '.claude.json');
    fs.writeFileSync(f, '{ not json');
    expect(() => registerClaudeHttpMcp(URL_, { [HEADER]: SECRET })).toThrow(/not valid JSON/);
    expect(read(f)).toBe('{ not json');
  });
});

describe('owner-only mode of credential-carrying config writes', () => {
  // Runs on every platform: proves the write path REQUESTS 0600 (create mode
  // plus an explicit chmod for a pre-existing file), which win32 cannot show
  // through stat.
  it('writeOwnerOnlyFile requests mode 0o600 on write and chmods the file to 0o600', () => {
    const file = path.join(tmpHome, 'owner-only.json');
    const writeSpy = vi.spyOn(fs, 'writeFileSync');
    const chmodSpy = vi.spyOn(fs, 'chmodSync');
    try {
      writeOwnerOnlyFile(file, '{}');
      const w = writeSpy.mock.calls.find(c => c[0] === file);
      expect(w).toBeDefined();
      expect((w![2] as any)?.mode).toBe(0o600);
      expect(chmodSpy.mock.calls.some(c => c[0] === file && c[1] === 0o600)).toBe(true);
    } finally {
      writeSpy.mockRestore();
      chmodSpy.mockRestore();
    }
  });

  it('every provider registration routes the header-carrying write through an owner-only write', () => {
    const chmodSpy = vi.spyOn(fs, 'chmodSync');
    try {
      for (const p of ['claude', 'codex', 'copilot', 'agy', 'opencode'] as LlmProvider[]) {
        chmodSpy.mockClear();
        registerHttpMcp(p, getProviderInstallConfig(p, tmpHome), URL_, { [HEADER]: SECRET });
        expect(chmodSpy.mock.calls.filter(c => c[1] === 0o600).length, p).toBeGreaterThan(0);
      }
    } finally {
      chmodSpy.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')('POSIX: a written registration has no group/other permission bits', () => {
    const file = path.join(tmpHome, '.claude.json');
    fs.writeFileSync(file, '{}', { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    registerClaudeHttpMcp(URL_, { [HEADER]: SECRET });
    expect(fs.statSync(file).mode & 0o077).toBe(0);
  });
});

describe('registeredMcpTransport reads each provider\'s own registration', () => {
  const write = (f: string, c: string) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); };
  const settings = (p: LlmProvider) => getProviderInstallConfig(p, tmpHome).settingsFile;
  it('detects stdio, http and absent entries per provider, never throwing on garbage', () => {
    const t = (p: LlmProvider) => registeredMcpTransport(p, getProviderInstallConfig(p, tmpHome));
    for (const p of ['claude', 'codex', 'copilot', 'agy', 'opencode'] as LlmProvider[]) expect(t(p), p).toBeUndefined();

    write(path.join(tmpHome, '.claude.json'), JSON.stringify({ mcpServers: { 'apra-fleet': { type: 'stdio', command: 'x', args: [] } } }));
    write(settings('codex'), '[mcp_servers.apra-fleet]\nurl = "http://localhost:7523/mcp"\n');
    write(settings('copilot'), JSON.stringify({ mcpServers: { 'apra-fleet': { command: 'x', args: [] } } }));
    write(path.join(tmpHome, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: { 'apra-fleet': { url: URL_ } } }));
    write(settings('opencode'), JSON.stringify({ mcp: { 'apra-fleet': { type: 'local', command: ['x'], enabled: true } } }));
    expect(t('claude')).toBe('stdio');
    expect(t('codex')).toBe('http');
    expect(t('copilot')).toBe('stdio');
    expect(t('agy')).toBe('http');
    expect(t('opencode')).toBe('stdio');

    write(path.join(tmpHome, '.claude.json'), '{ not json');
    write(settings('codex'), 'not = [toml');
    expect(t('claude')).toBeUndefined();
    expect(t('codex')).toBeUndefined();
  });
});
