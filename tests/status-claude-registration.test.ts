/**
 * apra-fleet status reports a missing / mismatched claude user-scope apra-fleet
 * MCP registration (the pure check plus runStatus in every server state).
 * All I/O is in a per-test temp dir (CLAUDE_CONFIG_DIR); install-config and the
 * secret are injected, never read from the real home.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { mockCheckRunning, mockInstallConfig, mockSecret } = vi.hoisted(() => ({
  mockCheckRunning: vi.fn(),
  mockInstallConfig: vi.fn(),
  mockSecret: vi.fn(),
}));
vi.mock('../src/services/singleton.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/singleton.js')>()),
  checkRunningInstance: mockCheckRunning,
}));
vi.mock('../src/services/service-manager/index.js', () => ({
  getServiceManager: vi.fn().mockResolvedValue({
    query: vi.fn().mockResolvedValue({ installed: false, running: false }),
  }),
}));
vi.mock('../src/cli/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/cli/config.js')>()),
  readInstallConfig: mockInstallConfig,
}));
vi.mock('../src/services/member-access-secret.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/member-access-secret.js')>()),
  readMemberAccessSecret: mockSecret,
}));

import { checkClaudeUserScopeRegistration } from '../src/services/claude-local-scope-mcp.js';
import { runStatus } from '../src/cli/status.js';
import { DEFAULT_PORT } from '../src/paths.js';

const URL_ = `http://localhost:${DEFAULT_PORT}/mcp`;
const SECRET = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const HDR = 'X-Apra-Fleet-Member-Secret';

let dir: string;
let file: string;
const writeCfg = (servers: unknown) => fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }));
const check = (extra: Partial<Parameters<typeof checkClaudeUserScopeRegistration>[0]> = {}) =>
  checkClaudeUserScopeRegistration({ configFile: file, expectedUrl: URL_, expectedSecret: SECRET, ...extra });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-reg-'));
  file = path.join(dir, '.claude.json');
  process.env.CLAUDE_CONFIG_DIR = dir;
  mockInstallConfig.mockReturnValue({ providers: { claude: { skill: 'pm', installedAt: 'x' } } });
  mockSecret.mockReturnValue(SECRET);
});
afterEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('checkClaudeUserScopeRegistration', () => {
  it('missing: no file, no apra-fleet entry', () => {
    expect(check()).toBe('missing');
    writeCfg({ other: { type: 'http', url: 'http://x/' } });
    expect(check()).toBe('missing');
  });
  it('wrong-url', () => {
    writeCfg({ 'apra-fleet': { type: 'http', url: 'http://localhost:1/mcp', headers: { [HDR]: SECRET } } });
    expect(check()).toBe('wrong-url');
  });
  it('wrong-secret (header differs or absent)', () => {
    writeCfg({ 'apra-fleet': { type: 'http', url: URL_, headers: { [HDR]: OTHER } } });
    expect(check()).toBe('wrong-secret');
    writeCfg({ 'apra-fleet': { type: 'http', url: URL_ } });
    expect(check()).toBe('wrong-secret');
  });
  it('healthy http, localhost and 127.0.0.1 equivalent, header key case-insensitive', () => {
    writeCfg({ 'apra-fleet': { type: 'http', url: URL_, headers: { [HDR]: SECRET } } });
    expect(check()).toBe('ok');
    writeCfg({ 'apra-fleet': { type: 'http', url: `http://127.0.0.1:${DEFAULT_PORT}/mcp/`, headers: { [HDR.toLowerCase()]: SECRET } } });
    expect(check()).toBe('ok');
  });
  it('healthy stdio', () => {
    writeCfg({ 'apra-fleet': { type: 'stdio', command: 'apra-fleet', args: [] } });
    expect(check()).toBe('ok-stdio');
  });
  it('unreadable: invalid JSON, file left byte-identical', () => {
    fs.writeFileSync(file, '{ not json');
    const before = fs.readFileSync(file);
    expect(check()).toBe('unreadable');
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });
  it('secret file absent (null secret): no secret alarm, nothing created', () => {
    writeCfg({ 'apra-fleet': { type: 'http', url: URL_ } });
    expect(check({ expectedSecret: null })).toBe('ok');
    expect(fs.readdirSync(dir)).toEqual(['.claude.json']);
  });
  it('not-applicable when claude is not a recorded provider', () => {
    expect(check({ claudeRecorded: false })).toBe('not-applicable');
  });
});

describe('runStatus claude registration warning', () => {
  let out: string[];
  beforeEach(() => {
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  });
  const states: Array<[string, unknown]> = [
    ['running', { running: true, state: 'running', url: 'http://127.0.0.1:1/mcp', pid: 1 }],
    ['stopped', { running: false, state: 'gone' }],
    ['unresponsive', { running: false, state: 'unresponsive', url: 'http://127.0.0.1:1/mcp', pid: 1 }],
  ];
  for (const [name, inst] of states) {
    it(`${name}: missing registration prints Warning, config file and install --force`, async () => {
      mockCheckRunning.mockResolvedValue(inst);
      await runStatus([]);
      const text = out.join('\n');
      expect(text).toMatch(/Warning:\s+claude user config .*\.claude\.json has no apra-fleet MCP registration/);
      expect(text).toContain(file);
      expect(text).toContain('apra-fleet install --force');
    });
    it(`${name}: healthy registration prints no registration warning, and no secret leaks`, async () => {
      writeCfg({ 'apra-fleet': { type: 'http', url: URL_, headers: { [HDR]: SECRET } } });
      mockCheckRunning.mockResolvedValue(inst);
      await runStatus([]);
      expect(out.join('\n')).not.toMatch(/claude user config/);
      expect(out.join('\n')).not.toContain(SECRET);
    });
  }
  it('wrong secret warns without printing either secret', async () => {
    writeCfg({ 'apra-fleet': { type: 'http', url: URL_, headers: { [HDR]: OTHER } } });
    mockCheckRunning.mockResolvedValue(states[1][1]);
    await runStatus([]);
    const text = out.join('\n');
    expect(text).toMatch(/does not match this install/);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(OTHER);
  });
  it('claude not recorded (codex only): no registration warning in any state', async () => {
    mockInstallConfig.mockReturnValue({ providers: { codex: { skill: 'pm', installedAt: 'x' } } });
    for (const [, inst] of states) {
      mockCheckRunning.mockResolvedValue(inst);
      await runStatus([]);
    }
    expect(out.join('\n')).not.toMatch(/claude user config/);
  });
});
