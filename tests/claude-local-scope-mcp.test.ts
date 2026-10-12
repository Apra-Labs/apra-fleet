/**
 * Upgrade path: a header-less Claude LOCAL-scope apra-fleet entry
 * (~/.claude.json projects[*]) shadows the user-scope registration; install
 * rewrites it with the access secret. HOME and USERPROFILE are sandboxed: the
 * real home is never touched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isThisInstallMcpUrl, refreshClaudeLocalScopeEntries, claudeUserConfigPath } from '../src/services/claude-local-scope-mcp.js';

const HEADER = 'X-Apra-Fleet-Member-Secret';
const SECRET = 'ab'.repeat(32);
const URL_ = 'http://localhost:7523/mcp';

let tmp: string;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-local-scope-'));
  for (const k of ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR']) saved[k] = process.env[k];
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  delete process.env.CLAUDE_CONFIG_DIR;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A ~/.claude.json as a 0.4.3 user may have it: user-scope entry plus an unscoped `claude mcp add apra-fleet` (local scope, no header). */
function v043ClaudeJson(): any {
  return {
    numStartups: 3,
    mcpServers: { 'apra-fleet': { type: 'http', url: URL_ } },
    projects: {
      '/home/u/repo-a': { allowedTools: [], mcpServers: { 'apra-fleet': { type: 'http', url: URL_ } } },
      '/home/u/repo-b': { mcpServers: {
        'apra-fleet': { type: 'stdio', command: '/home/u/.apra-fleet/bin/apra-fleet', args: ['run', '--transport', 'stdio'] },
      } },
      '/home/u/repo-c': { mcpServers: { 'apra-fleet': { type: 'http', url: 'http://localhost:9999/mcp' } } },
      '/home/u/member': { mcpServers: { 'apra-fleet': { type: 'http', url: `${URL_}?member=11111111-2222-3333-4444-555555555555` } } },
      '/home/u/repo-d': { mcpServers: { other: { type: 'http', url: 'https://example.com/mcp' } } },
    },
  };
}

describe('isThisInstallMcpUrl', () => {
  it('matches the exact endpoint and loopback spellings only', () => {
    expect(isThisInstallMcpUrl(URL_, URL_)).toBe(true);
    expect(isThisInstallMcpUrl('http://127.0.0.1:7523/mcp/', URL_)).toBe(true);
    expect(isThisInstallMcpUrl('http://localhost:7524/mcp', URL_)).toBe(false);
    expect(isThisInstallMcpUrl(`${URL_}?member=x`, URL_)).toBe(false);
    expect(isThisInstallMcpUrl('http://example.com:7523/mcp', URL_)).toBe(false);
    expect(isThisInstallMcpUrl(undefined, URL_)).toBe(false);
  });
});

describe('refreshClaudeLocalScopeEntries', () => {
  it('rewrites only header-less local-scope http entries for this URL, keeping everything else', () => {
    const file = claudeUserConfigPath();
    expect(file.startsWith(tmp)).toBe(true);
    const before = v043ClaudeJson();
    fs.writeFileSync(file, JSON.stringify(before));
    expect(refreshClaudeLocalScopeEntries(file, URL_, { [HEADER]: SECRET })).toEqual(['/home/u/repo-a']);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(after.projects['/home/u/repo-a'].mcpServers['apra-fleet']).toEqual({ type: 'http', url: URL_, headers: { [HEADER]: SECRET } });
    expect(after.projects['/home/u/repo-a'].allowedTools).toEqual([]);
    for (const k of ['/home/u/repo-b', '/home/u/repo-c', '/home/u/member', '/home/u/repo-d']) {
      expect(after.projects[k]).toEqual(before.projects[k]);
    }
    expect(after.numStartups).toBe(3);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o077).toBe(0);
    // idempotent: a second run changes nothing and does not rewrite the file
    const bytes = fs.readFileSync(file, 'utf8');
    expect(refreshClaudeLocalScopeEntries(file, URL_, { [HEADER]: SECRET })).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
  });

  it('replaces a stale secret (case-insensitive header key) and keeps other headers', () => {
    const file = claudeUserConfigPath();
    fs.writeFileSync(file, JSON.stringify({ projects: { '/r': { mcpServers: { 'apra-fleet': { type: 'http', url: URL_, headers: { 'x-apra-fleet-member-secret': 'cd'.repeat(32), 'X-Other': '1' } } } } } }));
    expect(refreshClaudeLocalScopeEntries(file, URL_, { [HEADER]: SECRET })).toEqual(['/r']);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).projects['/r'].mcpServers['apra-fleet'].headers).toEqual({ 'X-Other': '1', [HEADER]: SECRET });
  });

  it('keeps the entry\'s other fields when merging the header; writes atomically (no temp file left)', () => {
    const file = claudeUserConfigPath();
    fs.writeFileSync(file, JSON.stringify({ projects: { '/r': { mcpServers: { 'apra-fleet': { type: 'sse', url: URL_, timeout: 5 } } } } }));
    refreshClaudeLocalScopeEntries(file, URL_, { [HEADER]: SECRET });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).projects['/r'].mcpServers['apra-fleet']).toEqual({ type: 'sse', url: URL_, timeout: 5, headers: { [HEADER]: SECRET } });
    expect(fs.readdirSync(tmp).filter(f => f.endsWith('.tmp'))).toEqual([]);
  });

  it('is a no-op without a config file, and refuses an unparseable one without writing', () => {
    const file = claudeUserConfigPath();
    expect(refreshClaudeLocalScopeEntries(file, URL_, { [HEADER]: SECRET })).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
    fs.writeFileSync(file, '{ nope');
    expect(() => refreshClaudeLocalScopeEntries(file, URL_, { [HEADER]: SECRET })).toThrow(/not valid JSON/);
    expect(fs.readFileSync(file, 'utf8')).toBe('{ nope');
  });
});
