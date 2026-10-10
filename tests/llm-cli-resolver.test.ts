/**
 * Unit tests for src/services/llm-cli-resolver.ts (apra-fleet-fqkr.1.1).
 *
 * The resolver runs member-side probes through an injected exec seam, so
 * every location kind is exercised here with a FAKE exec that answers by
 * probe step -- no real shell, no real member. tests/setup.ts globally mocks
 * the module's ensureMemberLlmCli; this file unmocks it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.unmock('../src/services/llm-cli-resolver.js');

import {
  resolveLlmCli,
  ensureMemberLlmCli,
  cliBinaryName,
  formatLlmCliNotFound,
  invalidateLlmCliPath,
  _resetLlmCliResolverState,
  type CliProbeExec,
} from '../src/services/llm-cli-resolver.js';
import { getProvider } from '../src/providers/index.js';
import type { Agent, LlmProvider } from '../src/types.js';

/** Decode a `powershell -EncodedCommand <b64>` string back to its script. */
function decodePs(cmd: string): string {
  const m = cmd.match(/-EncodedCommand (\S+)/);
  return m ? Buffer.from(m[1], 'base64').toString('utf16le') : cmd;
}

type Answers = Partial<Record<string, string | ((cmd: string) => string)>>;

/** Fake exec answering by probe step; records every (kind, cmd) issued. */
function fakeExec(answers: Answers) {
  const calls: { kind: string; cmd: string }[] = [];
  const exec: CliProbeExec = async (cmd, kind) => {
    calls.push({ kind, cmd });
    const a = answers[kind];
    const out = typeof a === 'function' ? a(cmd) : a;
    return out === undefined ? { code: 1, stdout: '' } : { code: 0, stdout: out };
  };
  return { exec, calls };
}

/** Answer an existence check with the candidate it names, if it is in `existing`. */
function existsAnswer(existing: string[], ps = false) {
  return (cmd: string) => {
    const text = ps ? decodePs(cmd) : cmd;
    return existing.find(p => text.includes(ps ? `'${p}'` : `'${p}'`)) ?? '';
  };
}

const HOME = '/home/bella';
const WHOME = 'C:\\Users\\bella';

describe('resolveLlmCli -- POSIX (bash) member', () => {
  const base = { binary: 'claude', provider: 'claude', os: 'linux' as const, homeDir: HOME };

  it('login shell: returns the absolute path from bash -lc command -v', async () => {
    const { exec, calls } = fakeExec({ 'login-shell': 'Welcome banner\n/opt/tools/bin/claude\n' });
    const r = await resolveLlmCli({ ...base, exec });
    expect(r).toMatchObject({ ok: true, path: '/opt/tools/bin/claude', source: 'login-shell' });
    expect(calls[0]).toEqual({ kind: 'default-path', cmd: `command -v 'claude' 2>/dev/null` });
    expect(calls[1].cmd).toBe(`bash -lc 'command -v claude' 2>/dev/null`);
    expect(calls).toHaveLength(2);
  });

  it('default PATH: a member WITHOUT bash (busybox/Alpine) resolves the CLI from its own non-login PATH, probed first', async () => {
    // Every `bash ...` probe exits 127 (bash missing); plain command -v answers.
    const calls: { kind: string; cmd: string }[] = [];
    const exec: CliProbeExec = async (cmd, kind) => {
      calls.push({ kind, cmd });
      if (cmd.startsWith('bash ')) return { code: 127, stdout: '', stderr: 'sh: bash: not found' };
      if (cmd.startsWith('command -v ')) return { code: 0, stdout: '/usr/bin/claude\n' };
      return { code: 1, stdout: '' };
    };
    const r = await resolveLlmCli({ ...base, exec });
    expect(r).toMatchObject({ ok: true, path: '/usr/bin/claude', source: 'default-path' });
    expect(calls.map(c => c.kind)).toEqual(['default-path']);
    expect(calls.some(c => c.cmd.includes('bash'))).toBe(false);
  });

  it('default PATH: a non-path answer (shell function/alias name) is ignored and the other probes run', async () => {
    const target = `${HOME}/.local/bin/claude`;
    const { exec } = fakeExec({ 'default-path': 'claude', 'local-bin': existsAnswer([target]) });
    const r = await resolveLlmCli({ ...base, exec });
    expect(r).toMatchObject({ ok: true, path: target, source: 'local-bin' });
  });

  it('probe exec failure (throw/timeout) is probe_failed, not not-found, and stops probing', async () => {
    const calls: string[] = [];
    const exec: CliProbeExec = async (_cmd, kind) => {
      calls.push(kind);
      if (kind === 'login-shell') throw new Error('Command timed out after 20000ms of inactivity');
      return { code: 1, stdout: '' };
    };
    const r = await resolveLlmCli({ ...base, exec });
    expect(r).toMatchObject({ ok: false, reason: 'probe_failed', probeFailed: { step: 'login-shell', binary: 'claude', error: expect.stringContaining('timed out') } });
    expect(calls).toEqual(['default-path', 'login-shell']);
  });

  it('npm prefix: returns <prefix>/bin/<bin> when the login shell does not see it', async () => {
    const target = '/home/bella/.npm-pfx/bin/claude';
    const { exec } = fakeExec({
      'npm-prefix': (cmd) => (cmd.includes('npm prefix -g') ? '/home/bella/.npm-pfx\n' : existsAnswer([target])(cmd)),
    });
    const r = await resolveLlmCli({ ...base, exec });
    expect(r).toMatchObject({ ok: true, path: target, source: 'npm-prefix' });
  });

  it('nvm: returns the highest-version per-version bin dir', async () => {
    const { exec, calls } = fakeExec({
      nvm: `${HOME}/.nvm/versions/node/v9.11.2/bin/claude\n${HOME}/.nvm/versions/node/v20.11.1/bin/claude\n${HOME}/.nvm/versions/node/v18.19.0/bin/claude\n`,
    });
    const r = await resolveLlmCli({ ...base, exec });
    expect(r).toMatchObject({ ok: true, path: `${HOME}/.nvm/versions/node/v20.11.1/bin/claude`, source: 'nvm' });
    // HOME is resolved in JS and embedded as a quoted literal -- never $HOME.
    const nvmCmd = calls.find(c => c.kind === 'nvm')!.cmd;
    expect(nvmCmd).toContain(`'${HOME}/.nvm/versions/node'/*/bin/'claude'`);
    expect(calls.map(c => c.cmd).join('\n')).not.toContain('$HOME');
  });

  it('~/.local/bin: returns <home>/.local/bin/<bin>', async () => {
    const target = `${HOME}/.local/bin/claude`;
    const { exec } = fakeExec({ 'local-bin': existsAnswer([target]) });
    const r = await resolveLlmCli({ ...base, exec });
    expect(r).toMatchObject({ ok: true, path: target, source: 'local-bin' });
  });

  it('~/.npm-global/bin: returns <home>/.npm-global/bin/<bin>', async () => {
    const target = `${HOME}/.npm-global/bin/claude`;
    const { exec } = fakeExec({ 'npm-global': existsAnswer([target]) });
    const r = await resolveLlmCli({ ...base, exec });
    expect(r).toMatchObject({ ok: true, path: target, source: 'npm-global' });
  });

  it('ignores a non-path login-shell answer (alias text)', async () => {
    const target = `${HOME}/.local/bin/claude`;
    const { exec } = fakeExec({ 'login-shell': "alias claude='claude --foo'", 'local-bin': existsAnswer([target]) });
    const r = await resolveLlmCli({ ...base, exec });
    expect(r).toMatchObject({ ok: true, path: target, source: 'local-bin' });
  });

  it('a gitbash Windows member resolves through the POSIX probes', async () => {
    const { exec, calls } = fakeExec({ 'login-shell': '/c/Users/bella/AppData/Roaming/npm/claude' });
    const r = await resolveLlmCli({ ...base, os: 'windows', shell: 'gitbash', homeDir: '/c/Users/bella', exec });
    expect(r).toMatchObject({ ok: true, path: '/c/Users/bella/AppData/Roaming/npm/claude', source: 'login-shell' });
    expect(calls[0].kind).toBe('default-path');
    expect(calls[1].cmd).toContain('bash -lc');
  });

  it('not found: names every probed location and a one-line fix', async () => {
    const { exec } = fakeExec({});
    const r = await resolveLlmCli({ ...base, exec, installHint: 'curl -fsSL https://claude.ai/install.sh | bash' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    if (r.reason !== 'not_found') throw new Error('expected not_found');
    expect(r.notFound.probed.map(p => p.kind)).toEqual(['default-path', 'login-shell', 'npm-prefix', 'nvm', 'local-bin', 'npm-global']);
    const msg = formatLlmCliNotFound(r.notFound, 'bella-box');
    expect(msg).toContain('claude CLI "claude" not found on member "bella-box"');
    expect(msg).toContain(`${HOME}/.nvm/versions/node/*/bin/claude`);
    expect(msg).toContain(`${HOME}/.local/bin/claude`);
    expect(msg).toContain(`${HOME}/.npm-global/bin/claude`);
    expect(msg).toContain("login shell (bash -lc 'command -v claude')");
    expect(msg).toContain('default PATH (command -v claude)');
    const fix = msg.split('\n').pop()!;
    expect(fix).toMatch(/^Fix: symlink the CLI into ~\/\.local\/bin .* or reinstall it/);
    expect(fix).toContain('curl -fsSL https://claude.ai/install.sh | bash');
  });

  it('unknown home: home-based locations are reported as skipped, not silently dropped', async () => {
    const { exec } = fakeExec({});
    const r = await resolveLlmCli({ ...base, homeDir: null, exec });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    if (r.reason !== 'not_found') throw new Error('expected not_found');
    expect(r.notFound.probed.filter(p => p.location.includes('skipped'))).toHaveLength(3);
  });
});

describe('resolveLlmCli -- Windows PowerShell member', () => {
  const base = { binary: 'claude', provider: 'claude', os: 'windows' as const, shell: 'powershell5' as const, homeDir: WHOME };

  it('Get-Command: returns the resolved application path, via an encoded command', async () => {
    const { exec, calls } = fakeExec({ 'get-command': 'C:\\Program Files\\nodejs\\claude.cmd' });
    const r = await resolveLlmCli({ ...base, exec });
    expect(r).toMatchObject({ ok: true, path: 'C:\\Program Files\\nodejs\\claude.cmd', source: 'get-command' });
    expect(calls[0].cmd).toMatch(/^powershell -EncodedCommand /);
    expect(decodePs(calls[0].cmd)).toContain("Get-Command 'claude' -CommandType Application");
  });

  it('npm prefix: falls back to <home>\\AppData\\Roaming\\npm when npm prefix -g is not answerable', async () => {
    const target = `${WHOME}\\AppData\\Roaming\\npm\\claude.cmd`;
    const { exec, calls } = fakeExec({
      'npm-prefix': (cmd) => (decodePs(cmd).includes('npm prefix -g') ? '' : existsAnswer([target], true)(cmd)),
    });
    const r = await resolveLlmCli({ ...base, exec });
    expect(r).toMatchObject({ ok: true, path: target, source: 'npm-prefix' });
    const check = calls.filter(c => c.kind === 'npm-prefix').map(c => decodePs(c.cmd)).join('\n');
    expect(check).toContain(`'${target}'`);
    expect(check).not.toContain('$env:APPDATA');
  });

  it('npm prefix: uses the reported npm prefix first', async () => {
    const target = 'D:\\npm-global\\claude.cmd';
    const { exec } = fakeExec({
      'npm-prefix': (cmd) => (decodePs(cmd).includes('npm prefix -g') ? 'D:\\npm-global' : existsAnswer([target], true)(cmd)),
    });
    const r = await resolveLlmCli({ ...base, exec });
    expect(r).toMatchObject({ ok: true, path: target, source: 'npm-prefix' });
  });

  it('~/.local/bin: returns <home>\\.local\\bin\\<bin>.exe', async () => {
    const target = `${WHOME}\\.local\\bin\\claude.exe`;
    const { exec } = fakeExec({ 'local-bin': existsAnswer([target], true) });
    const r = await resolveLlmCli({ ...base, exec });
    expect(r).toMatchObject({ ok: true, path: target, source: 'local-bin' });
  });

  it('single quotes in a path are doubled for PowerShell', async () => {
    const home = "C:\\Users\\o'brien";
    const { exec, calls } = fakeExec({});
    await resolveLlmCli({ ...base, homeDir: home, exec });
    const local = decodePs(calls.find(c => c.kind === 'local-bin')!.cmd);
    expect(local).toContain("'C:\\Users\\o''brien\\.local\\bin\\claude.exe'");
  });

  it('not found: names the probed locations and a Windows fix line', async () => {
    const { exec } = fakeExec({});
    const r = await resolveLlmCli({ ...base, exec });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.notFound.probed.map(p => p.kind)).toEqual(['get-command', 'npm-prefix', 'local-bin']);
    const msg = formatLlmCliNotFound(r.notFound);
    expect(msg).toContain(`${WHOME}\\AppData\\Roaming\\npm\\claude.cmd`);
    expect(msg).toContain(`${WHOME}\\.local\\bin\\claude.exe`);
    expect(msg.split('\n').pop()).toMatch(/^Fix: copy or link claude\.exe\/\.cmd into %USERPROFILE%\\\.local\\bin, or reinstall it/);
  });
});

describe('provider coverage', () => {
  it.each([
    ['claude', 'claude'], ['agy', 'agy'], ['opencode', 'opencode'], ['codex', 'codex'], ['copilot', 'copilot'],
  ] as const)('%s resolves via its own binary name', async (prov, bin) => {
    const provider = getProvider(prov);
    expect(cliBinaryName(provider)).toBe(bin);
    const target = `${HOME}/.npm-global/bin/${bin}`;
    const { exec, calls } = fakeExec({ 'npm-global': existsAnswer([target]) });
    const r = await resolveLlmCli({ binary: bin, provider: prov, os: 'linux', homeDir: HOME, exec });
    expect(r).toMatchObject({ ok: true, path: target, source: 'npm-global' });
    expect(calls[0].cmd).toBe(`command -v '${bin}' 2>/dev/null`);
    expect(calls[1].cmd).toContain(`command -v ${bin}`);
  });

  it('the none provider has no CLI', () => {
    expect(cliBinaryName(getProvider('none'))).toBeNull();
  });
});

describe('ensureMemberLlmCli -- persistence and staleness', () => {
  function agent(over: Partial<Agent> = {}): Agent {
    return { id: 'm-1', friendlyName: 'bella-box', agentType: 'remote', workFolder: '/w', os: 'linux', createdAt: '', llmProvider: 'claude', ...over } as Agent;
  }
  const now = () => new Date('2026-10-10T00:00:00.000Z');

  beforeEach(() => { _resetLlmCliResolverState(); });

  it('persists the resolved path on the member and reuses it without re-probing', async () => {
    const a = agent();
    const persisted: unknown[] = [];
    const persist = (_id: string, v: unknown) => { persisted.push(v); };
    const target = `${HOME}/.local/bin/claude`;
    const first = fakeExec({ 'local-bin': existsAnswer([target]) });
    const r1 = await ensureMemberLlmCli(a, getProvider('claude'), { exec: first.exec, homeDir: HOME, persist, now });
    expect(r1).toMatchObject({ ok: true, path: target, reprobed: true });
    expect(a.llmCli).toEqual({ provider: 'claude', path: target, source: 'local-bin', resolvedAt: '2026-10-10T00:00:00.000Z' });
    expect(persisted).toEqual([a.llmCli]);

    const second = fakeExec({});
    const r2 = await ensureMemberLlmCli(a, getProvider('claude'), { exec: second.exec, homeDir: HOME, persist, now });
    expect(r2).toMatchObject({ ok: true, path: target, source: 'stored', reprobed: false });
    expect(second.calls).toHaveLength(0);
    expect(persisted).toHaveLength(1);
  });

  it('a stored path from an earlier process is verified with ONE existence check, not a full probe', async () => {
    const target = `${HOME}/.nvm/versions/node/v20.0.0/bin/claude`;
    const a = agent({ llmCli: { provider: 'claude', path: target, source: 'nvm', resolvedAt: 'x' } });
    const { exec, calls } = fakeExec({ verify: existsAnswer([target]) });
    const r = await ensureMemberLlmCli(a, getProvider('claude'), { exec, homeDir: HOME, persist: () => {}, now });
    expect(r).toMatchObject({ ok: true, path: target, source: 'stored', reprobed: false });
    expect(calls.map(c => c.kind)).toEqual(['verify']);
  });

  it('a stale stored path triggers re-resolution and stores the new path', async () => {
    const stale = `${HOME}/.nvm/versions/node/v18.0.0/bin/claude`;
    const fresh = `${HOME}/.nvm/versions/node/v20.0.0/bin/claude`;
    const a = agent({ llmCli: { provider: 'claude', path: stale, source: 'nvm', resolvedAt: 'x' } });
    const persisted: unknown[] = [];
    const { exec, calls } = fakeExec({ verify: '', nvm: `${fresh}\n` });
    const r = await ensureMemberLlmCli(a, getProvider('claude'), { exec, homeDir: HOME, persist: (_i, v) => persisted.push(v), now });
    expect(r).toMatchObject({ ok: true, path: fresh, source: 'nvm', reprobed: true });
    expect(calls[0].kind).toBe('verify');
    expect(a.llmCli?.path).toBe(fresh);
    expect(persisted).toEqual([a.llmCli]);
  });

  it('a stored path for a different provider is not reused', async () => {
    const a = agent({ llmProvider: 'codex', llmCli: { provider: 'claude', path: `${HOME}/.local/bin/claude`, source: 'local-bin', resolvedAt: 'x' } });
    const target = `${HOME}/.npm-global/bin/codex`;
    const { exec, calls } = fakeExec({ 'npm-global': existsAnswer([target]) });
    const r = await ensureMemberLlmCli(a, getProvider('codex'), { exec, homeDir: HOME, persist: () => {}, now });
    expect(r).toMatchObject({ ok: true, path: target, reprobed: true });
    expect(calls.some(c => c.kind === 'verify')).toBe(false);
  });

  it('not found: structured result plus a message; a stale stored path is cleared', async () => {
    const a = agent({ llmCli: { provider: 'claude', path: '/gone/claude', source: 'login-shell', resolvedAt: 'x' } });
    const persisted: unknown[] = [];
    const { exec } = fakeExec({});
    const r = await ensureMemberLlmCli(a, getProvider('claude'), { exec, homeDir: HOME, persist: (_i, v) => persisted.push(v), now });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('not_found');
    expect(r.notFound?.binary).toBe('claude');
    expect(r.message).toContain('Probed locations:');
    expect(r.message).toContain('Fix:');
    expect(a.llmCli).toBeUndefined();
    expect(persisted).toEqual([undefined]);
  });

  it('a verify exec failure keeps the stored path and reports probe_failed (never cleared on a transport error)', async () => {
    const stored = { provider: 'claude' as const, path: `${HOME}/.local/bin/claude`, source: 'local-bin' as const, resolvedAt: 'x' };
    const a = agent({ llmCli: { ...stored } });
    const persist = vi.fn();
    const calls: string[] = [];
    const exec: CliProbeExec = async (_c, kind) => { calls.push(kind); throw new Error('SSH connection closed'); };
    const r = await ensureMemberLlmCli(a, getProvider('claude'), { exec, homeDir: HOME, persist, now });
    expect(r).toMatchObject({ ok: false, reason: 'probe_failed', probeFailed: { step: 'verify', error: 'SSH connection closed' } });
    if (r.ok) return;
    expect(r.notFound).toBeUndefined();
    expect(r.message).toContain('not a missing CLI');
    expect(calls).toEqual(['verify']);
    expect(a.llmCli).toEqual(stored);
    expect(persist).not.toHaveBeenCalled();
    // Not marked verified: the next call checks again and, once reachable, reuses the path.
    const ok2 = fakeExec({ verify: existsAnswer([stored.path]) });
    const r2 = await ensureMemberLlmCli(a, getProvider('claude'), { exec: ok2.exec, homeDir: HOME, persist, now });
    expect(r2).toMatchObject({ ok: true, path: stored.path, source: 'stored' });
  });

  it('a resolution exec failure after a stale verify keeps the stored path (not cleared, not persisted)', async () => {
    const stored = { provider: 'claude' as const, path: '/gone/claude', source: 'login-shell' as const, resolvedAt: 'x' };
    const a = agent({ llmCli: { ...stored } });
    const persist = vi.fn();
    const exec: CliProbeExec = async (_c, kind) => {
      if (kind === 'verify') return { code: 0, stdout: '' };
      throw new Error('Command timed out after 20000ms of inactivity');
    };
    const r = await ensureMemberLlmCli(a, getProvider('claude'), { exec, homeDir: HOME, persist, now });
    expect(r).toMatchObject({ ok: false, reason: 'probe_failed', probeFailed: { step: 'default-path' } });
    expect(a.llmCli).toEqual(stored);
    expect(persist).not.toHaveBeenCalled();
  });

  it('the none provider resolves to no path without probing', async () => {
    const { exec, calls } = fakeExec({});
    const r = await ensureMemberLlmCli(agent({ llmProvider: 'none' as LlmProvider }), getProvider('none'), { exec, homeDir: HOME });
    expect(r).toEqual({ ok: true, path: undefined, reprobed: false });
    expect(calls).toHaveLength(0);
  });

  it('invalidateLlmCliPath forces the next use to re-resolve', async () => {
    const target = `${HOME}/.local/bin/claude`;
    const a = agent();
    const persist = vi.fn();
    await ensureMemberLlmCli(a, getProvider('claude'), { exec: fakeExec({ 'local-bin': existsAnswer([target]) }).exec, homeDir: HOME, persist, now });
    invalidateLlmCliPath(a, persist);
    expect(a.llmCli).toBeUndefined();
    const again = fakeExec({ 'local-bin': existsAnswer([target]) });
    const r = await ensureMemberLlmCli(a, getProvider('claude'), { exec: again.exec, homeDir: HOME, persist, now });
    expect(r).toMatchObject({ ok: true, reprobed: true });
    expect(again.calls.length).toBeGreaterThan(1);
  });

  it('a Windows PowerShell member is verified with an encoded Test-Path check', async () => {
    const target = `${WHOME}\\AppData\\Roaming\\npm\\agy.cmd`;
    const a = agent({ os: 'windows', shell: 'pwsh7', llmProvider: 'agy', llmCli: { provider: 'agy', path: target, source: 'npm-prefix', resolvedAt: 'x' } });
    const { exec, calls } = fakeExec({ verify: existsAnswer([target], true) });
    const r = await ensureMemberLlmCli(a, getProvider('agy'), { exec, homeDir: WHOME, persist: () => {}, now });
    expect(r).toMatchObject({ ok: true, path: target, reprobed: false });
    expect(decodePs(calls[0].cmd)).toContain(`Test-Path -LiteralPath $fleetCliCandidate -PathType Leaf`);
  });
});
