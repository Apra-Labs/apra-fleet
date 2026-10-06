/**
 * The install writes the per-install access secret into each provider's MCP
 * registration. The secret must (1) reach every provider's config as the
 * X-Apra-Fleet-Member-Secret header, (2) never land in a world-readable file
 * (existing 0644 configs are tightened), and (3) never ride in argv.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { registerHttpMcp, registerClaudeHttpMcp } from '../src/cli/install.js';
import { getProviderInstallConfig } from '../src/cli/config.js';
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
