/**
 * End-to-end through the real tool handlers: a long_running task launched by
 * execute_command resolves {{secret.NAME}} once, at launch. Rotating,
 * deleting or expiring that secret afterwards must surface loudly in
 * monitor_task and in credential_store_set/delete -- and nothing may leak
 * the old or new value or its sha256 into any tool result or log line.
 *
 * The member side is faked (strategy.execCommand): the launch returns the
 * readiness marker, the status/pid probes report a running task. Only dummy
 * values created here; APRA_FLEET_DATA_DIR is the per-run test sandbox set up
 * by tests/setup.ts + tests/global-setup.ts (asserted in the first test).
 *
 * FALSIFIABILITY: with the launch fingerprint comparison removed
 * (getTaskSecretChanges / getTasksHoldingStaleSecret in
 * src/services/credential-store.ts returning nothing), scenarios 1, 2 and 4
 * fail -- they expect secretChanges rotated/deleted that would never appear.
 * Scenario 8 fails if the stop step stops branching on the member OS.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry, resultText } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { executeCommand, TASK_READY_MARKER } from '../src/tools/execute-command.js';
import { monitorTask } from '../src/tools/monitor-task.js';
import { credentialStoreSet } from '../src/tools/credential-store-set.js';
import { credentialStoreDelete } from '../src/tools/credential-store-delete.js';
import * as authSocket from '../src/services/auth-socket.js';
import { credentialSet, credentialDelete, credentialList } from '../src/services/credential-store.js';
import { encryptPassword } from '../src/utils/crypto.js';
import { getActiveLogFile } from '../src/utils/log-helpers.js';
import type { SSHExecResult } from '../src/types.js';

const { mockExecCommand } = vi.hoisted(() => ({
  mockExecCommand: vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>(),
}));

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: vi.fn().mockResolvedValue({ ok: true, latencyMs: 1 }),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));
vi.mock('../src/services/cloud/lifecycle.js', () => ({
  ensureCloudReady: vi.fn((member: unknown) => Promise.resolve(member)),
}));
vi.mock('../src/services/auth-socket.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/auth-socket.js')>()),
  collectOobApiKey: vi.fn(),
}));

// The tools' existing status glyphs, spelled as escapes (ASCII-only repo rule).
const CHECK = String.fromCodePoint(0x2713);
const DONE = String.fromCodePoint(0x2705);

const OLD = 'dummy-rot-old-4c1e9a';
const NEW = 'dummy-rot-new-b72d05';
const sha = (v: string) => crypto.createHash('sha256').update(v, 'utf8').digest('hex');

/** Fields monitor_task returned before this change, for a running task. */
const BASE_KEYS = ['taskId', 'status', 'exitCode', 'retries', 'started', 'updated', 'pidAlive', 'logTail'];

function decodeEncoded(cmd: string): string {
  const m = cmd.match(/powershell -EncodedCommand (\S+)/);
  return m ? Buffer.from(m[1], 'base64').toString('utf16le') : '';
}

let seq = 0;
function uniqueName(): string {
  seq += 1;
  return `LRROT_${Date.now().toString(36)}_${seq}`;
}

/** Every tool result text seen in the current test, for the leak check. */
const seenTexts: string[] = [];
const consoleText: string[] = [];

function assertNoLeak(text: string): void {
  for (const v of [OLD, NEW]) {
    expect(text).not.toContain(v);
    expect(text).not.toContain(sha(v));
  }
}

async function launch(memberId: string, name: string): Promise<string> {
  const r = await executeCommand({
    member_id: memberId,
    command: `python train.py --token {{secret.${name}}}`,
    long_running: true,
    timeout_s: 5,
  } as any);
  const text = resultText(r);
  seenTexts.push(text);
  const m = text.match(/task_id=(task-[a-z0-9]+)/);
  expect(m, `launch did not return a task id: ${text}`).not.toBeNull();
  return m![1];
}

async function monitor(memberId: string, taskId: string): Promise<Record<string, unknown>> {
  const text = await monitorTask({ member_id: memberId, task_id: taskId, auto_stop: false });
  seenTexts.push(text);
  return JSON.parse(text);
}

function addMember(osName: 'linux' | 'windows', shell?: string) {
  const member = makeTestAgent({ friendlyName: `rot-${osName}-${seq}`, os: osName, shell } as any);
  addAgent(member);
  return member;
}

/**
 * Rotate a persisted secret the way a separate process (the CLI
 * `apra-fleet secret --set`) does: rewrite credentials.json with a temp file
 * plus rename, never touching this process's credential-store module state.
 */
function rotateInFileLikeAnotherProcess(name: string, value: string): void {
  const file = path.join(process.env.APRA_FLEET_DATA_DIR as string, 'credentials.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
  expect(data.credentials[name]).toBeDefined();
  data.credentials[name] = { ...data.credentials[name], encryptedValue: encryptPassword(value), created_at: new Date().toISOString() };
  const tmp = `${file}.other-process.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

describe('long_running task + secret rotation: loud warning through the real tool handlers', () => {
  let logSizeBefore = 0;

  beforeEach(() => {
    backupAndResetRegistry();
    mockExecCommand.mockReset();
    vi.mocked(authSocket.collectOobApiKey).mockReset();
    seenTexts.length = 0;
    consoleText.length = 0;
    for (const m of ['log', 'error', 'warn', 'info'] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { consoleText.push(a.map(String).join(' ')); });
    }
    const logFile = getActiveLogFile();
    logSizeBefore = logFile && fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
    mockExecCommand.mockImplementation(async (cmd: string) => {
      const plain = cmd + '\n' + decodeEncoded(cmd);
      if (plain.includes('run.sh') || plain.includes('run.ps1')) {
        return { stdout: `TASK_PID:4242\n${TASK_READY_MARKER}\n`, stderr: '', code: 0 };
      }
      if (plain.includes('status.json') && !plain.includes('task.pid')) {
        return { stdout: '{"status":"running","retries":0,"started":"2026-01-01T00:00:00Z","updated":"2026-01-01T00:00:00Z"}', stderr: '', code: 0 };
      }
      if (plain.includes('task.pid')) return { stdout: 'alive', stderr: '', code: 0 };
      return { stdout: 'step 12 auth ok', stderr: '', code: 0 };
    });
  });

  afterEach(() => {
    // Scenario 7: the leak check runs after EVERY scenario.
    for (const t of seenTexts) assertNoLeak(t);
    assertNoLeak(consoleText.join('\n'));
    const logFile = getActiveLogFile();
    if (logFile && fs.existsSync(logFile)) {
      const buf = fs.readFileSync(logFile);
      assertNoLeak(buf.subarray(logSizeBefore).toString('utf-8'));
    }
    vi.restoreAllMocks();
    restoreRegistry();
  });

  it('uses only the sandboxed data dir, never the real profile', () => {
    const dataDir = path.resolve(process.env.APRA_FLEET_DATA_DIR ?? '');
    expect(dataDir).not.toBe(path.resolve(''));
    expect(dataDir).not.toBe(path.join(os.homedir(), '.apra-fleet', 'data'));
    expect(dataDir.startsWith(path.resolve(os.tmpdir())) || !dataDir.startsWith(path.join(os.homedir(), '.apra-fleet'))).toBe(true);
  });

  it('1. overwrite after launch -> monitor_task reports rotated with restart guidance', async () => {
    const name = uniqueName();
    credentialSet(name, OLD, false, 'allow');
    const member = addMember('linux');
    const taskId = await launch(member.id, name);

    credentialSet(name, NEW, false, 'allow');
    const r = await monitor(member.id, taskId);
    expect(r.secretChanges).toEqual([{ name, change: 'rotated' }]);
    const w = String(r.secretWarning);
    expect(w).toContain(`${name} (rotated)`);
    expect(w).toContain('OLD value');
    expect(w).toContain('Restart it');
    expect(w).toContain('execute_command long_running=true');
    credentialDelete(name);
  });

  it('2. delete after launch -> monitor_task reports deleted', async () => {
    const name = uniqueName();
    credentialSet(name, OLD, true, 'allow');
    const member = addMember('linux');
    const taskId = await launch(member.id, name);

    credentialDelete(name);
    const r = await monitor(member.id, taskId);
    expect(r.secretChanges).toEqual([{ name, change: 'deleted' }]);
    expect(String(r.secretWarning)).toContain('set again with credential_store_set');
  });

  it('3. unchanged secret -> no field, no warning, same keys as before the change', async () => {
    const name = uniqueName();
    credentialSet(name, OLD, true, 'allow');
    const member = addMember('linux');
    const taskId = await launch(member.id, name);

    const r = await monitor(member.id, taskId);
    expect(Object.keys(r)).toEqual(BASE_KEYS);
    expect(r).not.toHaveProperty('secretChanges');
    expect(r).not.toHaveProperty('secretWarning');
    // Re-setting the same value is not a rotation.
    credentialSet(name, OLD, true, 'allow');
    expect(Object.keys(await monitor(member.id, taskId))).toEqual(BASE_KEYS);
    credentialDelete(name);
  });

  it('4. rotation written to credentials.json by another process -> next monitor_task reports rotated', async () => {
    const name = uniqueName();
    credentialSet(name, OLD, true, 'allow');
    const member = addMember('linux');
    const taskId = await launch(member.id, name);
    expect(Object.keys(await monitor(member.id, taskId))).toEqual(BASE_KEYS);

    rotateInFileLikeAnotherProcess(name, NEW);
    const r = await monitor(member.id, taskId);
    expect(r.secretChanges).toEqual([{ name, change: 'rotated' }]);
    credentialDelete(name);
  });

  it('5. expired secret -> reported expired, and monitor_task does NOT delete the entry', async () => {
    const name = uniqueName();
    credentialSet(name, OLD, true, 'allow', '*', 0.3);
    const member = addMember('linux');
    const taskId = await launch(member.id, name);
    await new Promise(r => setTimeout(r, 400));

    const r = await monitor(member.id, taskId);
    expect(r.secretChanges).toEqual([{ name, change: 'expired' }]);
    // credentialResolve would have deleted it; monitor_task must not.
    expect(credentialList().some(c => c.name === name)).toBe(true);
    const file = JSON.parse(fs.readFileSync(path.join(process.env.APRA_FLEET_DATA_DIR as string, 'credentials.json'), 'utf-8'));
    expect(file.credentials[name]).toBeDefined();
    const again = await monitor(member.id, taskId);
    expect(again.secretChanges).toEqual([{ name, change: 'expired' }]);
    credentialDelete(name);
  });

  it('6. credential_store_set overwrite and credential_store_delete list the bound task id; unbound output unchanged', async () => {
    const name = uniqueName();
    const unbound = uniqueName();
    credentialSet(name, OLD, true, 'allow');
    const member = addMember('linux');
    const taskId = await launch(member.id, name);

    vi.mocked(authSocket.collectOobApiKey).mockResolvedValue({ password: encryptPassword(NEW) });
    const setOut = await credentialStoreSet({ name, prompt: 'p', persist: true, network_policy: 'allow', members: '*' });
    seenTexts.push(setOut);
    expect(setOut.startsWith(`${CHECK} ${name} stored [persistent].`)).toBe(true);
    expect(setOut).toContain(taskId);
    expect(setOut).toContain('previous value');

    const delOut = await credentialStoreDelete({ name });
    seenTexts.push(delOut);
    expect(delOut.startsWith(`${DONE} Credential "${name}" deleted.`)).toBe(true);
    expect(delOut).toContain(taskId);

    vi.mocked(authSocket.collectOobApiKey).mockResolvedValue({ password: encryptPassword(NEW) });
    const unboundSet = await credentialStoreSet({ name: unbound, prompt: 'p', persist: true, network_policy: 'allow', members: '*' });
    seenTexts.push(unboundSet);
    expect(unboundSet).toBe(`${CHECK} ${unbound} stored [persistent]. Use {{secret.${unbound}}} in commands.`);
    const unboundDel = await credentialStoreDelete({ name: unbound });
    seenTexts.push(unboundDel);
    expect(unboundDel).toBe(`${DONE} Credential "${unbound}" deleted.`);
  });

  it.each([
    { label: 'linux', os: 'linux' as const, shell: undefined },
    { label: 'windows', os: 'windows' as const, shell: 'powershell5' },
  ])('8. $label member: the warning carries the OS-correct stop step, then relaunch', async (row) => {
    const name = uniqueName();
    credentialSet(name, OLD, false, 'allow');
    const member = addMember(row.os, row.shell);
    const taskId = await launch(member.id, name);
    credentialSet(name, NEW, false, 'allow');

    const w = String((await monitor(member.id, taskId)).secretWarning);
    const relaunchAt = w.indexOf('relaunch the command with execute_command long_running=true');
    expect(relaunchAt).toBeGreaterThan(-1);
    if (row.os === 'linux') {
      expect(w).toContain(`p=$(cat ~/.fleet-tasks/${taskId}/task.pid`);
      expect(w).toContain('kill -9 "$p"');
      expect(w).not.toContain('Stop-Process');
      expect(w.indexOf('kill -9 "$p"')).toBeLessThan(relaunchAt);
    } else {
      expect(w).not.toContain('kill -9');
      expect(w).not.toContain('~/.fleet-tasks');
      expect(w).toContain(`Stop-Process on the PID in %USERPROFILE%\\.fleet-tasks\\${taskId}\\task.pid`);
      const script = decodeEncoded(w);
      expect(script).toContain(`Get-Content "$env:USERPROFILE\\.fleet-tasks\\${taskId}\\task.pid"`);
      expect(script).toContain('Stop-Process -Id $p');
      expect(w.indexOf('Stop-Process')).toBeLessThan(relaunchAt);
    }
    credentialDelete(name);
  });
});
