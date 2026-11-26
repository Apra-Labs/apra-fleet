/**
 * member_detail session status: which signal produced busy, and no false busy
 * from unrelated processes of the same CLI name.
 *
 * The POSIX probe (LinuxCommands.fleetProcessCheck) is exercised for REAL: the
 * mocked strategy runs the generated command in bash with stub `pgrep`/`ps`
 * binaries that serve a simulated process table, so grep/awk/tr and the
 * command builder's own matching logic decide the verdict -- not the test.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { memberDetail } from '../src/tools/member-detail.js';
import { inFlightAgents } from '../src/services/in-flight-agents.js';
import { setStoredPid, clearStoredPid } from '../src/utils/agent-helpers.js';
import { getOsCommands } from '../src/os/index.js';
import { FLEET_TASK_PROMPT_FILE } from '../src/os/os-commands.js';
import { parseFleetProcessCheck } from '../src/services/session-status.js';
import type { SSHExecResult } from '../src/types.js';

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();
const mockTestConnection = vi.fn<() => Promise<{ ok: boolean; latencyMs: number; error?: string }>>();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: mockTestConnection,
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

const posixOnly = process.platform === 'win32' ? describe.skip : describe;

const FOLDER = '/work/repo';
const SESSION = '0b7c9a52-5d1e-4f6a-9c3e-2a1b0c9d8e7f';
const DISPATCH_INSTRUCTION = `Your task is described in ${FLEET_TASK_PROMPT_FILE} in the current directory. Read that file first, then execute the task.`;

let stubDir: string;
let procFile: string;

/** Simulated process table: [pid, full argv as ps would print it]. */
function setProcs(procs: Array<[number, string]>): void {
  fs.writeFileSync(procFile, procs.map(([pid, args]) => `${pid}\t${args}\n`).join(''));
}

function runProbe(cmd: string): SSHExecResult {
  const stdout = execFileSync('bash', ['-c', cmd], {
    encoding: 'utf-8',
    env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}`, FAKE_PROCS: procFile },
  });
  return { stdout, stderr: '', code: 0 };
}

function setupMock(): void {
  mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 3 });
  mockExecCommand.mockImplementation(async (cmd: string) => {
    if (cmd.includes('pgrep')) return runProbe(cmd);
    if (cmd.includes('.credentials.json')) return { stdout: 'missing', stderr: '', code: 0 };
    if (cmd.includes('--version')) return { stdout: '1.0.42', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  });
}

async function sessionOf(overrides: Record<string, unknown> = {}): Promise<{ session: Record<string, unknown>; compact: string; id: string }> {
  const member = makeTestAgent({ friendlyName: 'status-member', os: 'linux', workFolder: FOLDER, llmProvider: 'claude', ...overrides });
  addAgent(member);
  const json = JSON.parse(await memberDetail({ member_id: member.id, format: 'json' }));
  const compact = await memberDetail({ member_id: member.id, format: 'compact' });
  return { session: json.session, compact, id: member.id };
}

posixOnly('member_detail session status (real POSIX probe over a simulated process table)', () => {
  beforeAll(() => {
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-status-stub-'));
    procFile = path.join(stubDir, 'procs.tsv');
    // pgrep -f <ERE>: pids whose argv matches.
    fs.writeFileSync(path.join(stubDir, 'pgrep'),
      '#!/bin/bash\nwhile IFS=$\'\\t\' read -r pid args; do printf \'%s\\n\' "$args" | grep -Eq -- "$2" && echo "$pid"; done < "$FAKE_PROCS"\nexit 0\n',
      { mode: 0o755 });
    // ps -o <fmt> -p <pids...>: pids comma- or space-separated (both shapes
    // POSIX ps accepts); prints "<pid> <args>" when fmt has pid=, else args.
    fs.writeFileSync(path.join(stubDir, 'ps'), [
      '#!/bin/bash',
      'fmt=""; pids=""',
      'while [ $# -gt 0 ]; do case "$1" in -o) fmt="$2"; shift 2;; -p) shift; pids="$*"; break;; *) shift;; esac; done',
      'want=",$(echo $pids | tr \' \' \',\'),"',
      'while IFS=$\'\\t\' read -r pid args; do case "$want" in *",$pid,"*)',
      '  case "$fmt" in *pid=*) printf \'%s %s\\n\' "$pid" "$args";; *) printf \'%s\\n\' "$args";; esac;; esac',
      'done < "$FAKE_PROCS"',
      '',
    ].join('\n'), { mode: 0o755 });
  });

  afterAll(() => {
    fs.rmSync(stubDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    setupMock();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('stale stored pid, fleet process gone, no dispatch in flight -> idle with no busy source', async () => {
    setProcs([]);
    const member = makeTestAgent({ os: 'linux', workFolder: FOLDER, sessionId: SESSION });
    setStoredPid(member.id, 999999);
    try {
      addAgent(member);
      const json = JSON.parse(await memberDetail({ member_id: member.id, format: 'json' }));
      expect(json.session.status).toBe('idle');
      expect(json.session.statusSource).toBeNull();
      expect(json.session.busyPid).toBeNull();
    } finally {
      clearStoredPid(member.id);
    }
  });

  it('unrelated same-name processes (operator CLI in the folder, --resume of the session, a sibling-folder dispatch) -> idle, not busy', async () => {
    setProcs([
      [101, 'claude'],
      [102, `claude --add-dir ${FOLDER}`],
      [103, `/bin/bash -c cd "${FOLDER}" && claude --resume ${SESSION}`],
      [104, `bash -c cd "${FOLDER}-wt" && claude -p "${DISPATCH_INSTRUCTION}"`],
    ]);
    const { session, compact } = await sessionOf({ sessionId: SESSION });
    expect(session.status).toMatch(/^idle \(unrelated .+ processes running\)$/);
    expect(session.statusSource).toBeNull();
    expect(compact).not.toMatch(/\(busy/);
  });

  it('a fleet dispatch for this member found by the probe -> busy via fleet-process with the matched pid', async () => {
    setProcs([
      [101, 'claude'],
      [205, `bash -c cd "${FOLDER}" && claude -p "${DISPATCH_INSTRUCTION}" --output-format json`],
    ]);
    const { session, compact } = await sessionOf();
    expect(session.status).toBe('busy');
    expect(session.statusSource).toBe('fleet-process');
    expect(session.busyPid).toBe(205);
    expect(compact).toContain('(busy via fleet-process pid=205)');
  });

  it('the dispatched CLI itself matches by session id when the wrapper is not visible', async () => {
    setProcs([[306, `claude -p ${DISPATCH_INSTRUCTION} --resume ${SESSION}`]]);
    const { session } = await sessionOf({ sessionId: SESSION });
    expect(session.status).toBe('busy');
    expect(session.busyPid).toBe(306);
  });

  it('a genuine in-flight dispatch -> busy via in-flight-dispatch with the stored dispatch pid, without probing', async () => {
    setProcs([]);
    const member = makeTestAgent({ os: 'linux', workFolder: FOLDER });
    addAgent(member);
    inFlightAgents.add(member.id);
    setStoredPid(member.id, 4242);
    try {
      const json = JSON.parse(await memberDetail({ member_id: member.id, format: 'json' }));
      expect(json.session.status).toBe('busy');
      expect(json.session.statusSource).toBe('in-flight-dispatch');
      expect(json.session.busyPid).toBe(4242);
      expect(mockExecCommand.mock.calls.some(([c]) => c.includes('pgrep'))).toBe(false);
      const compact = await memberDetail({ member_id: member.id, format: 'compact' });
      expect(compact).toContain('(busy via in-flight-dispatch pid=4242)');
    } finally {
      inFlightAgents.delete(member.id);
      clearStoredPid(member.id);
    }
  });
});

describe('fleetProcessCheck command shape per OS module', () => {
  const decodePs = (cmd: string): string => {
    const m = /^powershell -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(cmd);
    expect(m).not.toBeNull();
    return Buffer.from(m![1], 'base64').toString('utf16le');
  };

  it('linux/macos: requires the dispatch marker and a quoted (anchored) folder or the session id; prints the matched pid', () => {
    for (const osName of ['linux', 'macos'] as const) {
      const cmd = getOsCommands(osName).fleetProcessCheck(FOLDER, SESSION, 'claude');
      expect(cmd).toContain('grep "\\.fleet-task\\.md"');
      expect(cmd).toContain(`grep -E "(\\"/work/repo\\"|${SESSION})"`);
      expect(cmd).toContain('echo "fleet-busy $FLEET_PID"');
      expect(cmd).toContain('ps -o pid=,args=');
    }
  });

  it('windows (powershell) and gitbash: one encoded Win32_Process script with the same marker + owner match', () => {
    for (const cmds of [getOsCommands('windows'), getOsCommands('windows', 'gitbash')]) {
      const script = decodePs(cmds.fleetProcessCheck('C:\\work\\repo', SESSION, 'claude'));
      expect(script).toContain("Get-CimInstance Win32_Process -Filter \"Name LIKE 'claude%'\"");
      expect(script).toContain("$_.CommandLine.Contains('.fleet-task.md')");
      expect(script).toContain(`$_.CommandLine.Contains('"C:\\work\\repo"')`);
      expect(script).toContain(`$_.CommandLine.Contains('${SESSION}')`);
      expect(script).toContain("echo ('fleet-busy ' + $fleet[0].ProcessId)");
      expect(script).not.toMatch(/;\s*elseif/);
    }
  });

  it('the dispatch marker equals the prompt file execute_prompt names', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'tools', 'execute-prompt.ts'), 'utf-8');
    expect(src).toContain(`const promptFileName = \`${FLEET_TASK_PROMPT_FILE}\`;`);
  });

  it('parseFleetProcessCheck reads the pid and accepts the legacy bare form', () => {
    expect(parseFleetProcessCheck('fleet-busy 123\n')).toEqual({ state: 'fleet-busy', pid: 123 });
    expect(parseFleetProcessCheck('fleet-busy')).toEqual({ state: 'fleet-busy' });
    expect(parseFleetProcessCheck('other-busy')).toEqual({ state: 'other-busy' });
    expect(parseFleetProcessCheck('idle')).toEqual({ state: 'idle' });
  });
});
