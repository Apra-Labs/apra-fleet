/**
 * execute_command with a live secret: network policy is decided before a mint, so
 * a refused secret never runs its script, and every token sent is redacted. The
 * script is real and the store is real; the member shell is a mock, so the network
 * commands here never run.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { mockExecCommand, mockConfirm } = vi.hoisted(() => ({
  mockExecCommand: vi.fn(),
  mockConfirm: vi.fn(),
}));

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({ execCommand: mockExecCommand, testConnection: vi.fn().mockResolvedValue({ ok: true }) }),
}));

vi.mock('../src/services/auth-socket.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/auth-socket.js')>()),
  collectOobConfirm: mockConfirm,
}));

// Calls through by default; a test can force two different tokens on two resolves.
vi.mock('../src/services/live-secret-cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/live-secret-cache.js')>();
  return { ...actual, resolveCommandSecret: vi.fn(actual.resolveCommandSecret) };
});

import { credentialDelete, credentialSet, credentialUpdate, prepareLiveSecret, saveLiveSecret } from '../src/services/credential-store.js';
import { resetLiveTokenCache, resolveCommandSecret } from '../src/services/live-secret-cache.js';
import { executeCommand } from '../src/tools/execute-command.js';
import { addAgent } from '../src/services/registry.js';
import { backupAndResetRegistry, makeTestLocalAgent, restoreRegistry, resultText } from './test-helpers.js';

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

let tmp: string;
let names: string[];
let member: ReturnType<typeof makeTestLocalAgent>;

function liveSecret(label: string, policy: 'allow' | 'confirm' | 'deny', members?: string): { name: string; runs: () => number } {
  const name = `${label}_${RUN}`;
  names.push(name);
  const counter = path.join(tmp, `${label}.runs`);
  const js = path.join(tmp, `${label}.js`);
  fs.writeFileSync(js, `require('fs').appendFileSync(${JSON.stringify(counter)}, 'x');
    process.stdout.write(JSON.stringify({ token: 'plain-token-value', expires_at: new Date(Date.now() + 3600000).toISOString() }));`);
  saveLiveSecret(prepareLiveSecret(name, { program: process.execPath, args: [js], env: [] }));
  credentialUpdate(name, { network_policy: policy, ...(members ? { members } : {}) });
  return { name, runs: () => (fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').length : 0) };
}

async function run(command: string, restart_command?: string): Promise<string> {
  return resultText(await executeCommand({
    member_id: member.id, command, restart_command, timeout_s: 30, long_running: false, max_retries: 0,
  } as never));
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-policy-'));
  names = [];
  backupAndResetRegistry();
  member = makeTestLocalAgent({ friendlyName: `live-policy-${RUN}`, workFolder: tmp });
  addAgent(member);
  resetLiveTokenCache();
  mockExecCommand.mockReset();
  mockExecCommand.mockResolvedValue({ stdout: 'ran', stderr: '', code: 0 });
  mockConfirm.mockReset();
});

afterEach(() => {
  for (const n of names) {
    try { credentialDelete(n); } catch { /* already removed */ }
  }
  restoreRegistry();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('network policy comes before the mint', () => {
  it('deny: a network command is blocked and the script never runs', async () => {
    const s = liveSecret('deny', 'deny');
    const out = await run(`curl https://example.test -H {{secret.${s.name}}}`);
    expect(out).toContain('network_policy=deny');
    expect(s.runs()).toBe(0);
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('deny on a secret used only in restart_command also stops the mint', async () => {
    const s = liveSecret('denyrestart', 'deny');
    const out = await run('curl https://example.test', `echo {{secret.${s.name}}}`);
    expect(out).toContain('network_policy=deny');
    expect(s.runs()).toBe(0);
  });

  it('a secret name holding a network word is not a network tool: no refusal, no prompt', async () => {
    const denied = liveSecret('kb-http-token', 'deny');
    await run(`myapp --token {{secret.${denied.name}}}`);
    expect(denied.runs()).toBe(1);
    expect(mockExecCommand).toHaveBeenCalledTimes(1);

    const asked = liveSecret('ssh-fetch-key', 'confirm');
    await run(`myapp --token {{secret.${asked.name}}}`);
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(asked.runs()).toBe(1);
  });

  it('a real network tool beside such a name is still blocked', async () => {
    const s = liveSecret('kb-http-other', 'deny');
    const out = await run(`curl https://example.test -H {{secret.${s.name}}}`);
    expect(out).toContain('network_policy=deny');
    expect(s.runs()).toBe(0);
  });

  it('deny does not apply to a command with no network tool, which still mints', async () => {
    const s = liveSecret('denylocal', 'deny');
    await run(`echo {{secret.${s.name}}}`);
    expect(s.runs()).toBe(1);
    expect(mockExecCommand).toHaveBeenCalledTimes(1);
  });

  it('confirm refused: the user is asked first and the script never runs', async () => {
    const s = liveSecret('confirmno', 'confirm');
    mockConfirm.mockResolvedValue({ confirmed: false });
    const out = await run(`curl https://example.test -H {{secret.${s.name}}}`);
    expect(out).toContain('was not confirmed');
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(s.runs()).toBe(0);
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('confirm accepted: asked exactly once, then it mints and the command runs', async () => {
    const s = liveSecret('confirmyes', 'confirm');
    const order: string[] = [];
    mockConfirm.mockImplementation(async () => {
      order.push(`runs at confirm: ${s.runs()}`);
      return { confirmed: true };
    });
    await run(`curl https://example.test -H {{secret.${s.name}}}`, `curl https://example.test -H {{secret.${s.name}}}`);
    expect(order).toEqual(['runs at confirm: 0']);
    expect(s.runs()).toBe(1);
    expect(mockExecCommand).toHaveBeenCalledTimes(1);
  });

  it('a member it is not shared with is refused without a prompt or a mint', async () => {
    const s = liveSecret('notyours', 'confirm', 'someone-else');
    const out = await run(`curl https://example.test -H {{secret.${s.name}}}`);
    expect(out).toContain('not accessible to member');
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(s.runs()).toBe(0);
  });

  it('a static secret with confirm is still asked once, after it resolves', async () => {
    const name = `static_${RUN}`;
    names.push(name);
    credentialSet(name, 'static-value', true, 'confirm');
    mockConfirm.mockResolvedValue({ confirmed: true });
    await run(`curl https://example.test -H {{secret.${name}}}`);
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockExecCommand).toHaveBeenCalledTimes(1);
  });
});

describe('redaction with a token that changed between command and restart_command', () => {
  it('both tokens are redacted when a refresh falls between the two resolves', async () => {
    const name = `refreshed_${RUN}`;
    const meta = { name, scope: 'persistent' as const, kind: 'live' as const, network_policy: 'allow' as const, created_at: 'x', allowedMembers: '*' as const };
    vi.mocked(resolveCommandSecret)
      .mockResolvedValueOnce({ plaintext: 'tok-before-refresh', meta })
      .mockResolvedValueOnce({ plaintext: 'tok-after-refresh', meta });
    mockExecCommand.mockResolvedValue({ stdout: 'tok-before-refresh tok-after-refresh', stderr: 'tok-after-refresh', code: 0 });

    const out = await run(`echo {{secret.${name}}}`, `echo {{secret.${name}}}`);

    expect(out).not.toContain('tok-before-refresh');
    expect(out).not.toContain('tok-after-refresh');
    expect(out).toContain(`[REDACTED:${name}]`);
  });
});
