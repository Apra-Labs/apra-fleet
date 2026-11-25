/**
 * Secret rotation vs. a long_running task: the task resolved {{secret.NAME}}
 * once at launch, so monitor_task and credential_store_set/delete must say
 * loudly when the bound secret changed -- without leaking the value or its
 * fingerprint, and with an OS-correct stop step.
 *
 * Only dummy values created here; APRA_FLEET_DATA_DIR is the per-run test
 * sandbox set by tests/setup.ts (asserted below).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { SSHExecResult } from '../src/types.js';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();
const logged: string[] = [];

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({ execCommand: mockExecCommand, testConnection: vi.fn(), close: vi.fn() }),
}));
vi.mock('../src/services/cloud/lifecycle.js', () => ({
  ensureCloudReady: (agent: unknown) => Promise.resolve(agent),
}));
vi.mock('../src/services/auth-socket.js', () => ({
  collectOobApiKey: vi.fn(),
}));
vi.mock('../src/utils/log-helpers.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/utils/log-helpers.js')>();
  const capture = (...args: unknown[]) => { logged.push(args.map(a => String(a)).join(' ')); };
  return { ...orig, logLine: capture, logWarn: capture, logError: capture };
});

import { monitorTask } from '../src/tools/monitor-task.js';
import { credentialStoreSet } from '../src/tools/credential-store-set.js';
import { credentialStoreDelete } from '../src/tools/credential-store-delete.js';
import * as authSocket from '../src/services/auth-socket.js';
import { encryptPassword } from '../src/utils/crypto.js';
import {
  credentialSet,
  credentialDelete,
  registerTaskCredentials,
  getTaskSecretChanges,
} from '../src/services/credential-store.js';

const sha = (v: string) => crypto.createHash('sha256').update(v, 'utf8').digest('hex');

function decodeEncoded(cmd: string): string {
  const m = cmd.match(/powershell -EncodedCommand (\S+)/);
  return m ? Buffer.from(m[1], 'base64').toString('utf16le') : '';
}

let seq = 0;
function uniqueName(): string {
  seq += 1;
  return `ROT_DUMMY_${Date.now().toString(36)}_${seq}`;
}
function uniqueTaskId(): string {
  seq += 1;
  return `task-rot${Date.now().toString(36)}${seq}`;
}

// The tools' existing status glyphs, spelled as escapes (ASCII-only repo rule).
const CHECK = String.fromCodePoint(0x2713);
const DONE = String.fromCodePoint(0x2705);

const OLD = 'dummy-old-value-7f3a';
const NEW = 'dummy-new-value-91bc';

function assertNoLeak(text: string): void {
  for (const v of [OLD, NEW]) {
    expect(text).not.toContain(v);
    expect(text).not.toContain(sha(v));
  }
}

describe('monitor_task / credential_store secret rotation warning', () => {
  const consoleCalls: string[] = [];
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    logged.length = 0;
    consoleCalls.length = 0;
    for (const m of ['log', 'error', 'warn', 'info'] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { consoleCalls.push(a.map(String).join(' ')); });
    }
    mockExecCommand.mockImplementation(async (cmd: string) => {
      if (cmd.includes('status.json')) return { stdout: '{"status":"running","retries":0}', stderr: '', code: 0 };
      if (cmd.includes('task.pid') || decodeEncoded(cmd).includes('task.pid')) return { stdout: 'alive', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    restoreRegistry();
    assertNoLeak(logged.join('\n'));
    assertNoLeak(consoleCalls.join('\n'));
  });

  it('runs against the sandboxed data dir, never the real profile', () => {
    const dataDir = process.env.APRA_FLEET_DATA_DIR ?? '';
    expect(dataDir).not.toBe('');
    expect(path.resolve(dataDir)).not.toBe(path.join(os.homedir(), '.apra-fleet', 'data'));
  });

  it('linux member: rotated secret -> secretChanges + warning with a kill of task.pid, no leak', async () => {
    const name = uniqueName();
    const taskId = uniqueTaskId();
    credentialSet(name, OLD, true, 'allow');
    registerTaskCredentials(taskId, [{ name, plaintext: OLD }]);
    const agent = makeTestAgent({ friendlyName: 'rot-linux', os: 'linux' as any });
    addAgent(agent);

    const before = await monitorTask({ member_id: agent.id, task_id: taskId, auto_stop: false });
    expect(JSON.parse(before).secretChanges).toBeUndefined();
    expect(before).not.toContain('secretWarning');

    credentialSet(name, NEW, true, 'allow');
    const out = await monitorTask({ member_id: agent.id, task_id: taskId, auto_stop: false });
    const parsed = JSON.parse(out);
    expect(parsed.secretChanges).toEqual([{ name, change: 'rotated' }]);
    expect(parsed.secretWarning).toContain('OLD value');
    expect(parsed.secretWarning).toContain(`kill -9 "$p"`);
    expect(parsed.secretWarning).toContain(`~/.fleet-tasks/${taskId}/task.pid`);
    expect(parsed.secretWarning).toContain('long_running=true');
    expect(parsed.secretWarning).not.toContain('Stop-Process');
    assertNoLeak(out);
    credentialDelete(name);
  });

  it('windows member: warning carries Stop-Process on the task.pid PID (encoded, shell-agnostic)', async () => {
    const name = uniqueName();
    const taskId = uniqueTaskId();
    credentialSet(name, OLD, false, 'allow');
    registerTaskCredentials(taskId, [{ name, plaintext: OLD }]);
    const agent = makeTestAgent({ friendlyName: 'rot-win', os: 'windows' as any });
    addAgent(agent);

    credentialDelete(name);
    const out = await monitorTask({ member_id: agent.id, task_id: taskId, auto_stop: false });
    const parsed = JSON.parse(out);
    expect(parsed.secretChanges).toEqual([{ name, change: 'deleted' }]);
    const warning: string = parsed.secretWarning;
    expect(warning).toContain('Stop-Process');
    expect(warning).toContain(`%USERPROFILE%\\.fleet-tasks\\${taskId}\\task.pid`);
    expect(warning).toContain('credential_store_set');
    expect(warning).not.toContain('kill -9');
    const script = decodeEncoded(warning);
    expect(script).toContain(`$env:USERPROFILE\\.fleet-tasks\\${taskId}\\task.pid`);
    // Wrapper first (ends the retry loop), then the snapshotted children.
    const kidsAt = script.indexOf('$kids = @(Get-CimInstance');
    const stopWrapperAt = script.indexOf('Stop-Process -Id $p');
    const stopKidsAt = script.indexOf('foreach ($k in $kids)');
    expect(kidsAt).toBeGreaterThan(-1);
    expect(stopWrapperAt).toBeGreaterThan(kidsAt);
    expect(stopKidsAt).toBeGreaterThan(stopWrapperAt);
    assertNoLeak(out);
  });

  it('expired secret is reported as expired and NOT deleted by monitor_task', async () => {
    const name = uniqueName();
    const taskId = uniqueTaskId();
    credentialSet(name, OLD, true, 'allow', '*', 0.001);
    registerTaskCredentials(taskId, [{ name, plaintext: OLD }]);
    await new Promise(r => setTimeout(r, 20));
    const agent = makeTestAgent({ friendlyName: 'rot-exp', os: 'linux' as any });
    addAgent(agent);

    const out = await monitorTask({ member_id: agent.id, task_id: taskId, auto_stop: false });
    expect(JSON.parse(out).secretChanges).toEqual([{ name, change: 'expired' }]);
    // Still there: a second check still says expired (a deletion would say deleted).
    expect(getTaskSecretChanges(taskId)).toEqual([{ name, change: 'expired' }]);
    credentialDelete(name);
  });

  it('member-scoped secret: no denial side effect, unchanged value -> no field', async () => {
    const name = uniqueName();
    const taskId = uniqueTaskId();
    credentialSet(name, OLD, true, 'allow', ['someone-else']);
    registerTaskCredentials(taskId, [{ name, plaintext: OLD }]);
    const agent = makeTestAgent({ friendlyName: 'rot-scoped', os: 'linux' as any });
    addAgent(agent);
    const out = await monitorTask({ member_id: agent.id, task_id: taskId, auto_stop: false });
    const parsed = JSON.parse(out);
    expect(parsed).not.toHaveProperty('secretChanges');
    expect(parsed).not.toHaveProperty('secretWarning');
    credentialDelete(name);
  });

  it('credential_store_set overwrite and credential_store_delete name the bound task id; unbound output unchanged', async () => {
    const name = uniqueName();
    const unbound = uniqueName();
    const taskId = uniqueTaskId();
    credentialSet(name, OLD, true, 'allow');
    registerTaskCredentials(taskId, [{ name, plaintext: OLD }]);

    // Same value again: nothing changed for the task -> no notice.
    vi.mocked(authSocket.collectOobApiKey).mockResolvedValue({ password: encryptPassword(OLD) });
    const same = await credentialStoreSet({ name, prompt: 'p', persist: true, network_policy: 'allow', members: '*' });
    expect(same).toBe(`${CHECK} ${name} stored [persistent]. Use {{secret.${name}}} in commands.`);

    vi.mocked(authSocket.collectOobApiKey).mockResolvedValue({ password: encryptPassword(NEW) });
    const setOut = await credentialStoreSet({ name, prompt: 'p', persist: true, network_policy: 'allow', members: '*' });
    expect(setOut).toContain(taskId);
    expect(setOut).toContain('previous value');
    expect(setOut).toContain('monitor_task');
    assertNoLeak(setOut);

    const unboundSet = await credentialStoreSet({ name: unbound, prompt: 'p', persist: false, network_policy: 'allow', members: '*' });
    expect(unboundSet).toBe(`${CHECK} ${unbound} stored [session]. Use {{secret.${unbound}}} in commands.`);

    const delOut = await credentialStoreDelete({ name });
    expect(delOut.startsWith(`${DONE} Credential "${name}" deleted.`)).toBe(true);
    expect(delOut).toContain(taskId);
    assertNoLeak(delOut);

    expect(await credentialStoreDelete({ name: unbound })).toBe(`${DONE} Credential "${unbound}" deleted.`);
  });
});
