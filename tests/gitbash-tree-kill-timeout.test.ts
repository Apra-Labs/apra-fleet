// A Git Bash member's execute_command timeout kill must take down the WHOLE
// process tree, on both the SSH path (ssh.ts killRemoteTree) and the local
// path (strategy.ts killTree -> killLocalProcessTree).
//
// Real-run shape this models: the command's subshell bash -> sh.exe (MSYS) ->
// a fork stub -> PING.EXE (native). MSYS exec breaks the WINDOWS parent link
// of sh.exe (its Windows parent is a fork child that exited when it exec'd),
// so `taskkill /T` from the root never reaches sh.exe or anything under it.
// The MSYS /proc ppid links are intact. Root cause and fix: gitBashTreeKill
// in src/os/windows-gitbash.ts.
//
// No Windows host is needed. Each test drives a real timeout through the real
// ssh.ts / strategy.ts code with the transport mocked, captures the kill that
// code issues, runs that kill through a real bash against a fake /proc (with
// `taskkill` and `kill` shadowed by recorders), and replays the recorded
// actions on a fake Windows process table whose taskkill /T follows only
// live Windows parent links, as the real one does.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Agent } from '../src/types.js';

// The real execFileSync, for running the captured kill through bash: the
// node:child_process mock below replaces it for the code under test.
const realChildProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');

// --- Fake process table ----------------------------------------------------

interface Proc {
  name: string;
  winpid: number;
  /** Windows ParentProcessId; may name a pid that no longer exists. */
  winParent?: number;
  /** MSYS pid and MSYS parent, for processes MSYS knows about. */
  msys?: number;
  ppid?: number;
}

/**
 * Remote / local-usr-bin shape. `top` is the wrapper bash the member runs the
 * command in; `cmdRoot` is the backgrounded subshell (FLEET_PID winpid 9200).
 * sh.exe's Windows parent 9250 (the fork child that exec'd it) is gone.
 */
function commandTree(topWinpid: number, topWinParent?: number): Proc[] {
  return [
    { name: 'top bash', winpid: topWinpid, winParent: topWinParent, msys: 100, ppid: 1 },
    { name: 'subshell bash', winpid: 9200, winParent: topWinpid, msys: 200, ppid: 100 },
    { name: 'sh.exe', winpid: 9300, winParent: 9250, msys: 300, ppid: 200 },
    { name: 'fork stub', winpid: 9400, winParent: 9300, msys: 400, ppid: 300 },
    { name: 'PING.EXE', winpid: 9401, winParent: 9400 },
    // Bystanders: never targeted.
    { name: 'unrelated bash', winpid: 9500, msys: 500, ppid: 1 },
    { name: 'unrelated native', winpid: 9600, winParent: 9500 },
  ];
}
const BYSTANDERS = ['unrelated bash', 'unrelated native'];

type Action = { kind: 'taskkill'; winpid: number } | { kind: 'kill9'; msys: number };

/** Replay kill actions in order; returns the names of surviving processes. */
function survivorsAfter(procs: Proc[], actions: Action[]): string[] {
  const alive = new Map(procs.map((p) => [p.winpid, p]));
  for (const a of actions) {
    if (a.kind === 'kill9') {
      for (const [w, p] of alive) if (p.msys === a.msys) alive.delete(w);
      continue;
    }
    if (!alive.has(a.winpid)) continue;
    // taskkill /T: the pid plus every live process whose chain of LIVE
    // Windows parents reaches it, all taken from one snapshot.
    const doomed = new Set([a.winpid]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [w, p] of alive) {
        if (!doomed.has(w) && p.winParent !== undefined && doomed.has(p.winParent) && alive.has(p.winParent)) {
          doomed.add(w);
          grew = true;
        }
      }
    }
    for (const w of doomed) alive.delete(w);
  }
  return [...alive.values()].map((p) => p.name).sort();
}

function bashPath(): string {
  return '/bin/bash';
}
const NO_BASH = process.platform === 'win32' || !fs.existsSync('/bin/bash');

let scratch: string;

/** Run a Git Bash kill command against a fake /proc built from `procs`. */
function runGitBashKill(command: string, procs: Proc[]): Action[] {
  const procDir = path.join(scratch, `proc-${Math.random().toString(36).slice(2)}`);
  for (const p of procs) {
    if (p.msys === undefined) continue;
    fs.mkdirSync(path.join(procDir, String(p.msys)), { recursive: true });
    fs.writeFileSync(path.join(procDir, String(p.msys), 'ppid'), `${p.ppid}\n`);
    fs.writeFileSync(path.join(procDir, String(p.msys), 'winpid'), `${p.winpid}\n`);
  }
  const script = path.join(scratch, 'kill.sh');
  fs.writeFileSync(script, command.split('/proc/[0-9]*').join(`${procDir}/[0-9]*`));
  const log = path.join(scratch, 'kill.log');
  fs.writeFileSync(log, '');
  const prelude = `taskkill() { echo "TK $*" >> '${log}'; }; kill() { echo "K $*" >> '${log}'; }; . '${script}'`;
  // execFileSync is mocked for the local-path tests, so use the real one.
  if (!cp.realExecFileSync) cp.realExecFileSync = realChildProcess.execFileSync;
  cp.realExecFileSync(bashPath(), ['-c', prelude], { stdio: 'ignore', timeout: 20_000 });
  const actions: Action[] = [];
  for (const line of fs.readFileSync(log, 'utf-8').split('\n')) {
    const tk = /^TK \/\/F \/\/T \/\/PID (\d+)$/.exec(line);
    if (tk) { actions.push({ kind: 'taskkill', winpid: Number(tk[1]) }); continue; }
    const k = /^K -9 (\d+)$/.exec(line);
    if (k) { actions.push({ kind: 'kill9', msys: Number(k[1]) }); continue; }
    if (line.trim()) throw new Error(`unexpected kill action: ${line}`);
  }
  return actions;
}

// --- child_process / ssh2 doubles -----------------------------------------

const cp = vi.hoisted(() => ({
  execFileCalls: [] as Array<{ file: string; args: string[] }>,
  execSyncCalls: [] as Array<{ command: string; shell?: string }>,
  children: [] as Array<EventEmitter & { pid: number }>,
  nextPid: 9100,
  realExecFileSync: undefined as undefined | typeof import('node:child_process').execFileSync,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  cp.realExecFileSync = actual.execFileSync;
  return {
    ...actual,
    spawn: vi.fn(() => {
      const child = Object.assign(new EventEmitter(), {
        pid: cp.nextPid,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        stdin: { end: vi.fn() },
        kill: vi.fn(),
        exitCode: null,
        signalCode: null,
      });
      cp.children.push(child);
      return child;
    }),
    execFileSync: vi.fn((file: string, args: string[]) => {
      cp.execFileCalls.push({ file, args });
      return Buffer.from('');
    }),
    execSync: vi.fn((command: string, opts?: { shell?: string }) => {
      cp.execSyncCalls.push({ command, shell: opts?.shell });
      return Buffer.from('');
    }),
  };
});

class MockStream extends EventEmitter {
  stderr = new EventEmitter();
  end = vi.fn();
  close = vi.fn();
}
class MockClient extends EventEmitter {
  streams: MockStream[] = [];
  execCalls: string[] = [];
  end = vi.fn(() => { this.emit('close'); });
  connect(): void { this.emit('ready'); }
  exec(command: string, cb: (err: Error | null, stream?: MockStream) => void): void {
    this.execCalls.push(command);
    const s = new MockStream();
    this.streams.push(s);
    cb(null, s);
  }
}
let clients: MockClient[] = [];
vi.mock('ssh2', () => ({
  Client: vi.fn().mockImplementation(function mockClientCtor() {
    const c = new MockClient();
    clients.push(c);
    return c;
  }),
}));

// Host-independent: windowsExecutable resolves to a fixed absolute System32 path (as it does on win32).
vi.mock('../src/os/windows-executable.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/os/windows-executable.js')>()),
  windowsExecutable: (name: string) => `C:\\Windows\\System32\\${name.replace(/\.exe$/i, '')}.exe`,
}));
const TASKKILL_EXE = 'C:\\Windows\\System32\\taskkill.exe';

// --- Pinned kill strings for the other shells (byte-identical to before) ---

const POSIX_KILL_9200 = '_fleet_kill_tree() { for _fleet_child in $(pgrep -P "$1" 2>/dev/null); do _fleet_kill_tree "$_fleet_child"; done; kill -9 "$1" 2>/dev/null; }; _fleet_kill_tree 9200; true';
const POWERSHELL_KILL_9200 = 'taskkill /F /T /PID 9200';

type Trigger = 'inactivity' | 'max-total' | 'abort';
const TRIGGERS: Trigger[] = ['inactivity', 'max-total', 'abort'];

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-gitbash-tree-kill-'));
  cp.execFileCalls.length = 0;
  cp.execSyncCalls.length = 0;
  cp.children.length = 0;
  cp.nextPid = 9100;
  clients = [];
});
afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

// --- SSH path ---------------------------------------------------------------

function remoteAgent(overrides: Partial<Agent>): Agent {
  return {
    id: `agent-${Math.random().toString(36).slice(2)}`,
    friendlyName: 'tree-kill-member',
    host: `test-host-${Math.random().toString(36).slice(2)}`,
    port: 22,
    username: 'testuser',
    workFolder: '/home/testuser/work',
    llmProvider: 'claude',
    os: 'linux',
    ...overrides,
  } as Agent;
}

describe('SSH path: a timed-out command on a remote member gets a whole-tree kill', () => {
  let ssh: typeof import('../src/services/ssh.js');

  beforeEach(async () => {
    vi.resetModules();
    ssh = await import('../src/services/ssh.js');
    vi.useFakeTimers();
  });
  afterEach(() => {
    ssh.closeAllConnections();
    vi.useRealTimers();
  });

  /** Drive one timeout/abort and return the kill command sent on a fresh channel. */
  async function killCommandFor(agent: Agent, trigger: Trigger): Promise<string> {
    const ac = new AbortController();
    const run = ssh.execCommand(agent, 'sh -c "ping -n 300 127.0.0.1"', 1000,
      trigger === 'max-total' ? 1500 : undefined, undefined, trigger === 'abort' ? ac.signal : undefined);
    run.catch(() => {});
    await flush();
    const cmdStream = clients[0].streams[0];
    cmdStream.emit('data', Buffer.from('FLEET_PID:9200\n'));
    if (trigger === 'inactivity') await vi.advanceTimersByTimeAsync(1000);
    if (trigger === 'max-total') {
      await vi.advanceTimersByTimeAsync(800);
      cmdStream.emit('data', Buffer.from('still pinging\n'));
      await vi.advanceTimersByTimeAsync(800);
    }
    if (trigger === 'abort') ac.abort();
    await expect(run).rejects.toThrow(trigger === 'abort' ? /aborted/ : trigger === 'max-total' ? /max total time/ : /timed out/);
    await flush();
    const execs = clients.flatMap((c) => c.execCalls);
    expect(execs.length, `exec calls: ${JSON.stringify(execs)}`).toBe(2);
    return execs[1];
  }

  for (const trigger of TRIGGERS) {
    it.skipIf(NO_BASH)(`gitbash, ${trigger}: no descendant of the command survives, bystanders do`, async () => {
      const kill = await killCommandFor(remoteAgent({ os: 'windows', shell: 'gitbash' }), trigger);
      const procs = commandTree(9150);
      const survivors = survivorsAfter(procs, runGitBashKill(kill, procs));
      expect(survivors).toEqual(['top bash', ...BYSTANDERS].sort());
    });
  }

  it('linux, macOS and PowerShell members still get their unchanged kill command', async () => {
    expect(await killCommandFor(remoteAgent({ os: 'linux' }), 'inactivity')).toBe(POSIX_KILL_9200);
    clients = [];
    expect(await killCommandFor(remoteAgent({ os: 'macos' }), 'inactivity')).toBe(POSIX_KILL_9200);
    clients = [];
    expect(await killCommandFor(remoteAgent({ os: 'windows' }), 'inactivity')).toBe(POWERSHELL_KILL_9200);
    clients = [];
    expect(await killCommandFor(remoteAgent({ os: 'windows', shell: 'powershell' }), 'max-total')).toBe(POWERSHELL_KILL_9200);
  });
});

// --- Local path ---------------------------------------------------------------

const GITBASH_SHELL = 'C:/Program Files/Git/bin/bash.exe';

describe('Local path: a timed-out command on a local Windows member gets a whole-tree kill', () => {
  let strategyMod: typeof import('../src/services/strategy.js');
  let platform: PropertyDescriptor | undefined;

  beforeEach(async () => {
    vi.resetModules();
    strategyMod = await import('../src/services/strategy.js');
    const { WindowsGitBashCommands } = await import('../src/os/windows-gitbash.js');
    const { WindowsCommands } = await import('../src/os/windows.js');
    const { LinuxCommands } = await import('../src/os/linux.js');
    vi.spyOn(WindowsGitBashCommands.prototype, 'cleanExec').mockImplementation((command: string) => ({ command, env: {}, shell: GITBASH_SHELL }));
    vi.spyOn(WindowsCommands.prototype, 'cleanExec').mockImplementation((command: string) => ({ command, env: {}, shell: 'powershell.exe' }));
    vi.spyOn(LinuxCommands.prototype, 'cleanExec').mockImplementation((command: string) => ({ command, env: {}, shell: '/bin/bash' }));
    platform = Object.getOwnPropertyDescriptor(process, 'platform');
    vi.useFakeTimers();
  });
  afterEach(() => {
    if (platform) Object.defineProperty(process, 'platform', platform);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function setPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
  }

  function localAgent(overrides: Partial<Agent>): Agent {
    return {
      id: `agent-${Math.random().toString(36).slice(2)}`,
      friendlyName: 'tree-kill-local',
      agentType: 'local',
      workFolder: scratch,
      llmProvider: 'claude',
      os: 'windows',
      ...overrides,
    } as Agent;
  }

  /** Drive one timeout/abort through LocalStrategy; `marker` is the FLEET_PID line, if any. */
  async function driveLocal(agent: Agent, trigger: Trigger, marker: string | undefined): Promise<void> {
    const ac = new AbortController();
    const run = strategyMod.getStrategy(agent).execCommand('sh -c "ping -n 300 127.0.0.1"', 1000,
      trigger === 'max-total' ? 1500 : undefined, undefined, trigger === 'abort' ? ac.signal : undefined);
    run.catch(() => {});
    await flush();
    const child = cp.children[0] as unknown as { stdout: EventEmitter };
    if (marker) child.stdout.emit('data', Buffer.from(marker));
    if (trigger === 'inactivity') await vi.advanceTimersByTimeAsync(1000);
    if (trigger === 'max-total') {
      await vi.advanceTimersByTimeAsync(800);
      child.stdout.emit('data', Buffer.from('still pinging\n'));
      await vi.advanceTimersByTimeAsync(800);
    }
    if (trigger === 'abort') ac.abort();
    await expect(run).rejects.toThrow(trigger === 'abort' ? /aborted/ : trigger === 'max-total' ? /max total time/ : /timed out/);
  }

  /** The kill actions the local kill issued, in order, against `procs`. */
  function localActions(procs: Proc[]): Action[] {
    const actions: Action[] = [];
    for (const call of cp.execFileCalls) {
      if (call.file === GITBASH_SHELL) {
        expect(call.args[0]).toBe('-c');
        actions.push(...runGitBashKill(call.args[1], procs));
      } else if (call.file === TASKKILL_EXE) {
        expect(call.args.slice(0, 3)).toEqual(['/F', '/T', '/PID']);
        actions.push({ kind: 'taskkill', winpid: Number(call.args[3]) });
      } else {
        throw new Error(`unexpected execFileSync: ${call.file}`);
      }
    }
    return actions;
  }

  for (const trigger of TRIGGERS) {
    it.skipIf(NO_BASH)(`gitbash via the Git launcher, ${trigger}: no descendant survives, bystanders do`, async () => {
      setPlatform('win32');
      // child.pid 9100 is the native Git launcher; the MSYS bash under it is
      // 9150. FLEET_PID names the live subshell 9200.
      await driveLocal(localAgent({ shell: 'gitbash' }), trigger, 'FLEET_PID:9200\n');
      const procs: Proc[] = [{ name: 'launcher', winpid: 9100 }, ...commandTree(9150, 9100)];
      expect(survivorsAfter(procs, localActions(procs))).toEqual(BYSTANDERS.slice().sort());
    });
  }

  it.skipIf(NO_BASH)('gitbash, no FLEET_PID marker (winpid read lost the race): the walk from child.pid still reaches every descendant', async () => {
    setPlatform('win32');
    // child.pid 9100 is the MSYS bash itself (usr/bin/bash.exe spawned directly).
    await driveLocal(localAgent({ shell: 'gitbash' }), 'inactivity', undefined);
    const procs = commandTree(9100);
    expect(survivorsAfter(procs, localActions(procs))).toEqual(BYSTANDERS.slice().sort());
  });

  it('PowerShell local member: only the direct taskkill.exe /F /T, exactly as before', async () => {
    setPlatform('win32');
    await driveLocal(localAgent({ shell: 'powershell' }), 'inactivity', 'FLEET_PID:9200\n');
    expect(cp.execFileCalls).toEqual([{ file: TASKKILL_EXE, args: ['/F', '/T', '/PID', '9100'] }]);
    expect(cp.execSyncCalls).toEqual([]);
  });

  for (const [osName, plat] of [['linux', 'linux'], ['macos', 'darwin']] as const) {
    it(`${osName} local member: the unchanged killPid string through the member shell`, async () => {
      setPlatform(plat);
      cp.nextPid = 9200;
      await driveLocal(localAgent({ os: osName }), 'inactivity', 'FLEET_PID:9200\n');
      expect(cp.execSyncCalls).toEqual([{ command: POSIX_KILL_9200, shell: '/bin/bash' }]);
      expect(cp.execFileCalls).toEqual([]);
    });
  }
});
