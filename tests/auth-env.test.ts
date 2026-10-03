import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { decryptAuthEnvVars, buildAuthEnvFileContent, buildAuthEnvSourcePrefix } from '../src/utils/auth-env.js';
import { encryptPassword } from '../src/utils/crypto.js';
import type { Agent } from '../src/types.js';

// Obvious fakes only -- never a real credential.
const FAKE = 'sk-ant-api03-FAKE-not-a-real-key-0123456789';
// Exercises every quoting hazard: both quote kinds, $, backtick, backslash, newline.
const NASTY = `FAKE'quote"dq$HOME\`tick\\back\nline2`;

function makeAgent(envVars?: Record<string, string>): Agent {
  const encrypted = envVars
    ? Object.fromEntries(Object.entries(envVars).map(([k, v]) => [k, encryptPassword(v)]))
    : undefined;
  return {
    id: 'test-member', friendlyName: 'test', host: 'localhost', username: 'user',
    encryptedPassword: '', workFolder: '/tmp', encryptedEnvVars: encrypted,
  } as Agent;
}

function hasBin(cmd: string, args: string[]): boolean {
  try { return spawnSync(cmd, args, { stdio: 'ignore' }).status === 0; } catch { return false; }
}

describe('decryptAuthEnvVars', () => {
  it('returns {} for a member with no stored env vars', () => {
    expect(decryptAuthEnvVars(makeAgent())).toEqual({});
    expect(decryptAuthEnvVars({ ...makeAgent(), encryptedEnvVars: {} } as Agent)).toEqual({});
  });

  it('decrypts every stored var (registry format written by the current release)', () => {
    const agent = makeAgent({ ANTHROPIC_API_KEY: FAKE, CLAUDE_CODE_OAUTH_TOKEN: 'oauth-FAKE', CLAUDE_CONFIG_DIR: '/home/u/.cfg' });
    expect(decryptAuthEnvVars(agent)).toEqual({ ANTHROPIC_API_KEY: FAKE, CLAUDE_CODE_OAUTH_TOKEN: 'oauth-FAKE', CLAUDE_CONFIG_DIR: '/home/u/.cfg' });
  });

  it('rejects a stored name that is not a valid env var name', () => {
    const agent = { ...makeAgent(), encryptedEnvVars: { 'BAD;rm -rf': encryptPassword('x') } } as Agent;
    expect(() => decryptAuthEnvVars(agent)).toThrow(/Invalid stored env var name/);
  });
});

describe('buildAuthEnvSourcePrefix carries only the path', () => {
  it('POSIX: sources then deletes the file, chained with &&', () => {
    const p = buildAuthEnvSourcePrefix('/home/u/.apra-fleet-env-abc', true);
    expect(p).toBe(`. '/home/u/.apra-fleet-env-abc' && rm -f '/home/u/.apra-fleet-env-abc' && `);
  });

  it('PowerShell: parses the file into the process env, deletes it, fails loudly', () => {
    const p = buildAuthEnvSourcePrefix("C:/Users/o'neil/.apra-fleet-env-abc", false);
    expect(p).toContain("'C:/Users/o''neil/.apra-fleet-env-abc'");
    expect(p).toContain("SetEnvironmentVariable");
    expect(p).toContain("'Process'");
    expect(p).toContain('Remove-Item -LiteralPath $__fleetEnv');
    expect(p).toContain('exit 1');
  });
});

describe('buildAuthEnvFileContent', () => {
  it('POSIX: single-quoted export lines', () => {
    expect(buildAuthEnvFileContent({ A: 'v1', B: "it's" }, true)).toBe(`export A='v1'\nexport B='it'\\''s'\n`);
  });

  it('PowerShell: NAME=base64(utf8 value) lines (parsed, never executed)', () => {
    const c = buildAuthEnvFileContent({ ANTHROPIC_API_KEY: FAKE }, false);
    expect(c).toBe(`ANTHROPIC_API_KEY=${Buffer.from(FAKE).toString('base64')}\n`);
  });

  it('rejects an invalid env var name', () => {
    expect(() => buildAuthEnvFileContent({ 'X Y': 'v' }, true)).toThrow();
  });
});

// Round trips through a REAL shell: the CLI process (here: a child that
// prints the vars) receives the exact values, the file is gone afterwards, and
// the command line the shell was given never contained a value.
describe('staged env file round trip through a real shell', () => {
  const vars = { FLEET_T_KEY: FAKE, FLEET_T_NASTY: NASTY };

  it.skipIf(process.platform === 'win32' || !hasBin('bash', ['-c', 'true']))('bash: the child process inherits the exact values and the file is deleted', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-envt-')), 'env');
    fs.writeFileSync(file, buildAuthEnvFileContent(vars, true), { mode: 0o600 });
    const cmd = buildAuthEnvSourcePrefix(file, true) + `{ node -e 'process.stdout.write(JSON.stringify([process.env.FLEET_T_KEY, process.env.FLEET_T_NASTY]))'; }`;
    expect(cmd).not.toContain(FAKE);
    const r = spawnSync('bash', ['-c', cmd], { encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([FAKE, NASTY]);
    expect(fs.existsSync(file)).toBe(false);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32' || !hasBin('bash', ['-c', 'true']))('bash: a missing file stops the chain (no unauthenticated run)', () => {
    const cmd = buildAuthEnvSourcePrefix(path.join(os.tmpdir(), 'fleet-envt-does-not-exist'), true) + 'echo RAN';
    const r = spawnSync('bash', ['-c', cmd], { encoding: 'utf-8' });
    expect(r.stdout).not.toContain('RAN');
    expect(r.status).not.toBe(0);
  });

  it.skipIf(process.platform !== 'win32')('PowerShell: the child process inherits the exact values and the file is deleted', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-envt-'));
    const file = path.join(dir, 'env');
    fs.writeFileSync(file, buildAuthEnvFileContent(vars, false));
    const cmd = buildAuthEnvSourcePrefix(file, false) + `node -e "process.stdout.write(Buffer.from(JSON.stringify([process.env.FLEET_T_KEY, process.env.FLEET_T_NASTY])).toString('base64'))"`;
    expect(cmd).not.toContain(FAKE);
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(JSON.parse(Buffer.from(r.stdout.trim(), 'base64').toString('utf-8'))).toEqual([FAKE, NASTY]);
    expect(fs.existsSync(file)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(process.platform !== 'win32')('PowerShell: a missing file fails loudly (exit 1, no run)', () => {
    const cmd = buildAuthEnvSourcePrefix(path.join(os.tmpdir(), 'fleet-envt-does-not-exist'), false) + 'Write-Output RAN';
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf-8' });
    expect(r.stdout).not.toContain('RAN');
    expect(r.status).toBe(1);
  });
});
