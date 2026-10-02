/**
 * GitHub #585 recovery: the Windows user-level task definition and its
 * lifecycle. A standard (non-admin) user can only register a task whose
 * LogonTrigger is scoped to their own account, so register() writes a UTF-16
 * task XML and runs schtasks /create /xml; a repeating TimeTrigger revives a
 * dead server (Task Scheduler's RestartOnFailure never fires for a killed or
 * non-zero-exit process); stop disables the task so the trigger cannot undo
 * a deliberate stop; start re-enables it; HKCU Run is the last resort.
 *
 * Everything goes through injected runners -- no real schtasks/reg call, no
 * scheduled task, no registry write. The wrapper and XML land in a temp dir.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { mockGracefulStop, order } = vi.hoisted(() => ({
  mockGracefulStop: vi.fn<(fallback?: (pid: number) => void) => Promise<boolean>>(),
  order: [] as string[],
}));
vi.mock('../src/services/service-manager/index.js', () => ({
  gracefulStopByServerJson: mockGracefulStop,
}));
// Never touch the real data dir's backoff file from a unit test.
vi.mock('../src/services/service-start-guard.js', () => ({
  clearServiceStartFailures: vi.fn(),
}));

import {
  WindowsServiceManager, buildTaskXml, resolveTaskUserId, localStartBoundary, repeatMinutesFrom,
  RUN_KEY, RUN_VALUE, buildWrapperBat, buildLauncherJs, launcherPathFor, launcherArguments, wscriptPath,
} from '../src/services/service-manager/windows.js';
import { spawnSync } from 'node:child_process';
import { formatServiceLabel } from '../src/cli/status.js';

const USER_ENV = { USERDOMAIN: 'BOX', USERNAME: 'alice' };
const NOW = new Date(2026, 9, 2, 14, 7, 31);

function between(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map(m => m[1]);
}

describe('buildTaskXml', () => {
  const xml = buildTaskXml({ command: 'C:\\b\\w.bat', userId: 'BOX\\alice', startBoundary: '2026-10-02T14:07:00', repeatMinutes: 5 });

  it('scopes the LogonTrigger to the current user (the only form a standard user may register)', () => {
    const [logon] = between(xml, 'LogonTrigger');
    expect(logon).toContain('<UserId>BOX\\alice</UserId>');
    expect(logon).toContain('<Enabled>true</Enabled>');
  });

  it('adds an indefinitely repeating TimeTrigger as the revive mechanism', () => {
    const [time] = between(xml, 'TimeTrigger');
    expect(time).toContain('<Interval>PT5M</Interval>');
    expect(time).toContain('<StopAtDurationEnd>false</StopAtDurationEnd>');
    expect(time).not.toContain('<Duration>'); // no Duration = repeat forever
    expect(time).toContain('<StartBoundary>2026-10-02T14:07:00</StartBoundary>');
  });

  it('IgnoreNew + no time limit + start when available + no battery stops', () => {
    const [settings] = between(xml, 'Settings');
    expect(settings).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
    expect(settings).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
    expect(settings).toContain('<StartWhenAvailable>true</StartWhenAvailable>');
    expect(settings).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
    expect(settings).toContain('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>');
    expect(settings).toContain('<Enabled>true</Enabled>');
  });

  it('never relies on RestartOnFailure and never runs elevated or as a system account', () => {
    expect(xml).not.toMatch(/RestartOnFailure/);
    expect(xml).not.toMatch(/HighestAvailable|S-1-5-18|SYSTEM|ServiceAccount|Password|S4U/);
    const [principal] = between(xml, 'Principals');
    expect(principal).toContain('<UserId>BOX\\alice</UserId>');
    expect(principal).toContain('<LogonType>InteractiveToken</LogonType>');
    expect(principal).toContain('<RunLevel>LeastPrivilege</RunLevel>');
    expect(between(xml, 'Command')).toEqual(['C:\\b\\w.bat']);
  });

  it('XML-escapes every interpolated value', () => {
    const evil = buildTaskXml({
      command: `C:\\Users\\O'Neil & <Co>\\"w".bat`, userId: 'R&D\\a<b>', startBoundary: '2026-01-01T00:00:00', repeatMinutes: 5,
    });
    expect(evil).toContain('<Command>C:\\Users\\O&apos;Neil &amp; &lt;Co&gt;\\&quot;w&quot;.bat</Command>');
    expect(evil).toContain('<UserId>R&amp;D\\a&lt;b&gt;</UserId>');
    // Exactly one raw '&' per escape sequence -- no unescaped ampersand.
    expect(evil.replace(/&(amp|lt|gt|quot|apos);/g, '')).not.toContain('&');
  });
});

describe('task user, start boundary, repeat interval', () => {
  it('resolves DOMAIN\\user from USERDOMAIN/USERNAME without a shell', () => {
    const whoami = vi.fn(() => 'x\\y');
    expect(resolveTaskUserId(USER_ENV, whoami)).toBe('BOX\\alice');
    expect(whoami).not.toHaveBeenCalled();
  });

  it('falls back to whoami when the env lacks USERDOMAIN', () => {
    expect(resolveTaskUserId({ USERNAME: 'alice' }, () => 'box\\alice\r\n')).toBe('box\\alice');
  });

  it('formats a local StartBoundary', () => {
    expect(localStartBoundary(NOW)).toBe('2026-10-02T14:07:00');
  });

  it('honours the test-only interval override within 1..1440, else 5', () => {
    expect(repeatMinutesFrom({})).toBe(5);
    expect(repeatMinutesFrom({ APRA_FLEET_TASK_REPEAT_MINUTES: '1' })).toBe(1);
    expect(repeatMinutesFrom({ APRA_FLEET_TASK_REPEAT_MINUTES: '0' })).toBe(5);
    expect(repeatMinutesFrom({ APRA_FLEET_TASK_REPEAT_MINUTES: 'abc' })).toBe(5);
  });
});

describe('WindowsServiceManager lifecycle', () => {
  let dir: string;
  let wrapper: string;
  let schtasks: ReturnType<typeof vi.fn>;
  let reg: ReturnType<typeof vi.fn>;
  let spawned: Array<[string, string[]]>;
  let taskExists: boolean;
  let runKey: boolean;
  let createXml: Buffer | null;
  let createFails: boolean;

  function mgr(env: Record<string, string | undefined> = USER_ENV) {
    return new WindowsServiceManager(schtasks as any, wrapper, {
      runReg: reg as any, env, now: () => NOW, spawnDetached: (c, a) => { spawned.push([c, a]); order.push(`spawn ${c} ${a.join(' ')}`); },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    order.length = 0;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-wintask-'));
    wrapper = path.join(dir, 'apra-fleet-service.bat');
    spawned = [];
    taskExists = true;
    runKey = false;
    createXml = null;
    createFails = false;
    schtasks = vi.fn((args: string[]) => {
      order.push(`schtasks ${args.join(' ')}`);
      if (args[0] === '/create') {
        if (createFails) throw new Error('ERROR: Access is denied.');
        createXml = fs.readFileSync(args[4]);
        taskExists = true;
        return 'SUCCESS';
      }
      if (args[0] === '/query' || args[0] === '/change' || args[0] === '/delete') {
        if (!taskExists) throw new Error('ERROR: The system cannot find the file specified.');
        if (args.includes('csv')) return '"\\ApraFleet","N/A","Ready"\r\n';
        return '';
      }
      return '';
    });
    reg = vi.fn((args: string[]) => {
      order.push(`reg ${args.join(' ')}`);
      if (args[0] === 'add') { runKey = true; return ''; }
      if (!runKey) throw new Error('ERROR: The system was unable to find the specified registry key or value.');
      if (args[0] === 'delete') runKey = false;
      return '';
    });
    mockGracefulStop.mockImplementation(async () => { order.push('graceful-stop'); return true; });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('register writes a UTF-16LE (BOM) task XML for the current user, /create /xml /f, then removes the XML', async () => {
    expect(await mgr().register('C:\\bin\\apra-fleet.exe', ['--transport', 'http'], 'C:\\log.txt')).toBe('created');
    expect(createXml).not.toBeNull();
    expect([createXml![0], createXml![1]]).toEqual([0xff, 0xfe]);
    const xml = createXml!.subarray(2).toString('utf16le');
    expect(xml).toContain('encoding="UTF-16"');
    expect(xml).toContain('<UserId>BOX\\alice</UserId>');
    // Hidden launch: wscript runs the JScript launcher, never the .bat directly.
    expect(xml).toContain('<Command>C:\\Windows\\System32\\wscript.exe</Command>');
    expect(xml).toContain(`<Arguments>//B //Nologo //E:JScript &quot;${launcherPathFor(wrapper)}&quot;</Arguments>`);
    expect(xml).not.toContain(`<Command>${wrapper}</Command>`);
    expect(fs.readFileSync(launcherPathFor(wrapper), 'utf8')).toContain(JSON.stringify(wrapper));
    expect(xml).toContain('<Interval>PT5M</Interval>');
    expect(xml).toContain('<StartBoundary>2026-10-02T14:07:00</StartBoundary>');
    const create = schtasks.mock.calls.find(c => c[0][0] === '/create')![0];
    expect(create).toEqual(['/create', '/tn', 'ApraFleet', '/xml', path.join(dir, 'apra-fleet-task.xml'), '/f']);
    expect(fs.existsSync(path.join(dir, 'apra-fleet-task.xml'))).toBe(false);
    expect(fs.readFileSync(wrapper, 'utf8')).toContain('set APRA_FLEET_SERVICE=1');
  });

  it('the interval override reaches the registered XML', async () => {
    await mgr({ ...USER_ENV, APRA_FLEET_TASK_REPEAT_MINUTES: '1' }).register('x.exe', [], 'l');
    expect(createXml!.subarray(2).toString('utf16le')).toContain('<Interval>PT1M</Interval>');
  });

  it('a created task removes a stale HKCU Run fallback entry', async () => {
    runKey = true;
    await mgr().register('x.exe', [], 'l');
    expect(reg).toHaveBeenCalledWith(['delete', RUN_KEY, '/v', RUN_VALUE, '/f']);
    expect(runKey).toBe(false);
  });

  it('stop disables the task BEFORE shutting the server down', async () => {
    await mgr().stop();
    expect(schtasks).toHaveBeenCalledWith(['/change', '/tn', 'ApraFleet', '/disable']);
    const disableAt = order.indexOf('schtasks /change /tn ApraFleet /disable');
    expect(disableAt).toBeGreaterThanOrEqual(0);
    expect(disableAt).toBeLessThan(order.indexOf('graceful-stop'));
  });

  it('stop still shuts the server down (and warns) when the task cannot be disabled', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    schtasks.mockImplementation((args: string[]) => {
      if (args[0] === '/change') throw new Error('ERROR: Access is denied.');
      return '';
    });
    expect(await mgr().stop()).toBe(true);
    expect(mockGracefulStop).toHaveBeenCalled();
    expect(warn.mock.calls.join(' ')).toMatch(/Could not disable the ApraFleet task/);
    warn.mockRestore();
  });

  it('start re-enables the task, then runs it', async () => {
    await mgr().start();
    const enableAt = order.indexOf('schtasks /change /tn ApraFleet /enable');
    expect(enableAt).toBeGreaterThanOrEqual(0);
    expect(spawned).toEqual([['schtasks', ['/run', '/tn', 'ApraFleet']]]);
    expect(enableAt).toBeLessThan(order.indexOf('spawn schtasks /run /tn ApraFleet'));
  });

  it('query reports a disabled task as stopped by the user', async () => {
    schtasks.mockImplementation((args: string[]) => (args.includes('/xml')
      ? '<Task><Settings><Enabled>false</Enabled></Settings></Task>'
      : '"\\ApraFleet","N/A","Disabled"\r\n'));
    const st = await mgr().query();
    expect(st).toMatchObject({ installed: true, running: false, enabled: false });
    expect(formatServiceLabel(st)).toBe("installed (disabled -- stopped by user -- 'apra-fleet start' re-enables it)");
    expect(formatServiceLabel({ installed: true, running: true, enabled: true })).toBe('installed (enabled)');
  });

  describe('HKCU Run last-resort fallback', () => {
    beforeEach(() => { taskExists = false; createFails = true; });

    it('XML create denied and no task to reuse -> per-user Run entry for the wrapper, result run-key', async () => {
      expect(await mgr().register('x.exe', [], 'l')).toBe('run-key');
      expect(reg).toHaveBeenCalledWith(['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d',
        `"C:\\Windows\\System32\\wscript.exe" //B //Nologo //E:JScript "${launcherPathFor(wrapper)}"`, '/f']);
      expect(RUN_KEY.startsWith('HKCU\\')).toBe(true);
    });

    it('start launches the wrapper directly (no task), status/isInstalled report it, uninstall removes it', async () => {
      await mgr().register('x.exe', [], 'l');
      const m = mgr();
      expect(await m.isInstalled()).toBe(true);
      const st = await m.query();
      expect(st).toMatchObject({ installed: true, enabled: true });
      expect(formatServiceLabel(st)).toMatch(/HKCU Run -- no automatic restart/);
      await m.start();
      expect(spawned).toEqual([['cmd.exe', ['/d', '/c', wrapper]]]);
      await m.unregister();
      expect(runKey).toBe(false);
      expect(await m.isInstalled()).toBe(false);
      expect(fs.existsSync(wrapper)).toBe(false);
    });

    it('stop with only a Run entry does not try to disable a task', async () => {
      await mgr().register('x.exe', [], 'l');
      await mgr().stop();
      expect(schtasks.mock.calls.some(c => c[0][0] === '/change')).toBe(false);
      expect(mockGracefulStop).toHaveBeenCalled();
    });
  });
});

describe('service wrapper and hidden launcher', () => {
  it('the wrapper re-creates a missing log dir before the >> redirect, after setting the service marker', () => {
    const bat = buildWrapperBat('C:\\b\\apra-fleet.exe', ['--transport', 'http'], 'C:\\Users\\a\\.apra-fleet\\data\\fleet.log');
    const lines = bat.split('\r\n');
    expect(lines).toEqual([
      '@echo off',
      'set APRA_FLEET_SERVICE=1',
      'if not exist "C:\\Users\\a\\.apra-fleet\\data\\" mkdir "C:\\Users\\a\\.apra-fleet\\data"',
      '"C:\\b\\apra-fleet.exe" "--transport" "http" >> "C:\\Users\\a\\.apra-fleet\\data\\fleet.log" 2>&1',
    ]);
  });

  it('the launcher runs the wrapper with window style 0, waits, and returns its exit code; path escaped', () => {
    const js = buildLauncherJs('C:\\Users\\O\'N "x"\\b\\apra-fleet-service.bat');
    expect(js).toContain('var wrapper = "C:\\\\Users\\\\O\'N \\"x\\"\\\\b\\\\apra-fleet-service.bat";');
    expect(js).toContain("WScript.Quit(shell.Run('\"' + wrapper + '\"', 0, true));");
  });

  it('wscript is resolved from SystemRoot and the launcher arguments quote its path', () => {
    expect(wscriptPath({ SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\wscript.exe');
    expect(launcherArguments('C:\\a b\\l.js')).toBe('//B //Nologo //E:JScript "C:\\a b\\l.js"');
    expect(launcherPathFor('C:\\x y\\bin\\apra-fleet-service.bat')).toBe('C:\\x y\\bin\\apra-fleet-service.js');
  });

  it('register creates a missing log dir', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-logdir-'));
    try {
      const m = new WindowsServiceManager((() => 'SUCCESS') as any, path.join(dir, 'bin', 'apra-fleet-service.bat'), {
        runReg: (() => { throw new Error('absent'); }) as any, env: USER_ENV, now: () => NOW, spawnDetached: () => {},
      });
      const log = path.join(dir, 'data', 'nested', 'fleet.log');
      await m.register('x.exe', [], log);
      expect(fs.existsSync(path.dirname(log))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Real wscript run (no scheduled task): the generated launcher + wrapper run
  // hidden, the server inherits the service marker, a deleted log dir is
  // re-created, and the server's exit code reaches the caller (Task
  // Scheduler's Last Result). Paths contain spaces, & and an apostrophe.
  it.runIf(process.platform === 'win32')('real wscript: hidden run propagates the exit code, marker and log dir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet wsh & o'k "));
    try {
      const script = path.join(dir, 'server.js');
      fs.writeFileSync(script, "process.stdout.write('marker=' + process.env.APRA_FLEET_SERVICE); process.exit(7);");
      const wrapper = path.join(dir, 'bin', 'apra-fleet-service.bat');
      const log = path.join(dir, 'data', 'fleet.log');
      fs.mkdirSync(path.dirname(wrapper), { recursive: true });
      fs.writeFileSync(wrapper, buildWrapperBat(process.execPath, [script], log));
      fs.writeFileSync(launcherPathFor(wrapper), buildLauncherJs(wrapper));
      expect(fs.existsSync(path.dirname(log))).toBe(false); // the wrapper must create it
      const args = launcherArguments(launcherPathFor(wrapper)).split(' ').slice(0, 3).concat(launcherPathFor(wrapper));
      const r = spawnSync(wscriptPath(process.env), args, { encoding: 'utf8', timeout: 60_000 });
      expect(r.status).toBe(7);
      expect(fs.readFileSync(log, 'utf8')).toContain('marker=1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
