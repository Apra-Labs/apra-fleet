/**
 * Upgrading a legacy ApraFleet task (registered by apra-fleet 0.4.3 with
 * `schtasks /sc onlogon` from an elevated shell): detection, the one-time
 * elevated DELETE (nothing else elevated) followed by a non-elevated create,
 * and the guidance fallback. Everything is faked: schtasks, reg, the elevated
 * runner, node:fs and node:child_process are injected/mocked -- no real
 * scheduled task, UAC prompt or install dir is touched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const { mockGracefulStop } = vi.hoisted(() => ({
  mockGracefulStop: vi.fn<(fallback?: (pid: number) => void) => Promise<boolean>>(),
}));
vi.mock('../src/services/service-manager/index.js', () => ({
  gracefulStopByServerJson: mockGracefulStop,
  getServiceManager: vi.fn(),
}));
vi.mock('../src/services/service-start-guard.js', () => ({
  clearServiceStartFailures: vi.fn(),
}));
vi.mock('node:fs');
vi.mock('node:child_process');

import {
  WindowsServiceManager, legacyTaskProblems, elevationPromptAllowed, elevatedSchtasksScript,
  buildTaskXml, encodeTaskXml, launcherArguments, launcherPathFor,
  LEGACY_TASK_DELETE_ARGV, UAC_DECLINED_EXIT,
} from '../src/services/service-manager/windows.js';

const WRAPPER = 'C:\\Users\\u\\.apra-fleet\\bin\\apra-fleet-service.bat';
const LAUNCHER = launcherPathFor(WRAPPER);
const WSCRIPT = 'C:\\Windows\\System32\\wscript.exe';
const DELETE_ARGV = ['/delete', '/tn', 'ApraFleet', '/f'];

/** What `schtasks /query /xml` returns for a 0.4.3 task (`/create /sc onlogon /rl limited /tr <bat>`). */
const LEGACY_XML = [
  '<?xml version="1.0" encoding="UTF-16"?>',
  '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
  '  <RegistrationInfo><URI>\\ApraFleet</URI></RegistrationInfo>',
  '  <Principals><Principal id="Author"><UserId>S-1-5-21-1-2-3-1001</UserId>',
  '    <LogonType>InteractiveToken</LogonType></Principal></Principals>',
  '  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><Enabled>true</Enabled></Settings>',
  '  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>',
  `  <Actions Context="Author"><Exec><Command>${WRAPPER}</Command></Exec></Actions>`,
  '</Task>',
].join('\r\n');

/** The current task as `schtasks /query /xml` normalizes it (shape captured from a live install). */
const CURRENT_QUERIED_XML = [
  '<?xml version="1.0" encoding="UTF-16"?>',
  '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
  '  <Principals><Principal id="Author"><UserId>S-1-5-21-1-2-3-1001</UserId>',
  '    <LogonType>InteractiveToken</LogonType></Principal></Principals>',
  '  <Settings><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy></Settings>',
  '  <Triggers>',
  '    <LogonTrigger><UserId>HOST\\u</UserId></LogonTrigger>',
  '    <TimeTrigger><StartBoundary>2026-10-04T18:10:00</StartBoundary><Repetition><Interval>PT5M</Interval></Repetition></TimeTrigger>',
  '  </Triggers>',
  `  <Actions Context="Author"><Exec><Command>${WSCRIPT}</Command>`,
  `    <Arguments>//B //Nologo //E:JScript "${LAUNCHER}"</Arguments></Exec></Actions>`,
  '</Task>',
].join('\r\n');

const currentBuiltXml = (hidden = true) => buildTaskXml({
  command: hidden ? WSCRIPT : WRAPPER,
  arguments: hidden ? launcherArguments(LAUNCHER) : undefined,
  userId: 'HOST\\u', startBoundary: '2026-10-04T18:10:00', repeatMinutes: 5,
});

describe('legacyTaskProblems', () => {
  it('classes the 0.4.3 onlogon task as legacy with every missing feature', () => {
    expect(legacyTaskProblems(LEGACY_XML, { launcherPath: LAUNCHER, launcherExpected: true }))
      .toEqual(['no-revive', 'visible-console', 'elevated']);
    // UTF-16 output (as schtasks emits it) parses the same.
    expect(legacyTaskProblems(encodeTaskXml(LEGACY_XML), { launcherPath: LAUNCHER, launcherExpected: true }))
      .toEqual(['no-revive', 'visible-console', 'elevated']);
    // WSH disabled: the console window is not a legacy property, the rest still is.
    expect(legacyTaskProblems(LEGACY_XML, { launcherPath: LAUNCHER, launcherExpected: false }))
      .toEqual(['no-revive', 'elevated']);
  });

  it('never classes the current task as legacy', () => {
    for (const raw of [CURRENT_QUERIED_XML, currentBuiltXml(), encodeTaskXml(currentBuiltXml())]) {
      expect(legacyTaskProblems(raw, { launcherPath: LAUNCHER, launcherExpected: true })).toEqual([]);
    }
    // Current definition with WSH disabled runs the .bat directly: still not legacy.
    expect(legacyTaskProblems(currentBuiltXml(false), { launcherPath: LAUNCHER, launcherExpected: false })).toEqual([]);
  });

  it('flags each missing feature independently', () => {
    const noRepeat = CURRENT_QUERIED_XML.replace(/<Repetition>[\s\S]*?<\/Repetition>/, '');
    expect(legacyTaskProblems(noRepeat, { launcherPath: LAUNCHER, launcherExpected: true })).toEqual(['no-revive']);
    const anyUser = CURRENT_QUERIED_XML.replace('<UserId>HOST\\u</UserId>', '');
    expect(legacyTaskProblems(anyUser, { launcherPath: LAUNCHER, launcherExpected: true })).toEqual(['elevated']);
    const otherLauncher = CURRENT_QUERIED_XML.replace(LAUNCHER, 'C:\\other\\x.js');
    expect(legacyTaskProblems(otherLauncher, { launcherPath: LAUNCHER, launcherExpected: true })).toEqual(['visible-console']);
  });

  it('makes no claim about XML without a <Triggers> section', () => {
    expect(legacyTaskProblems(`<Task><Actions><Exec><Command>${WRAPPER}</Command></Exec></Actions></Task>`,
      { launcherPath: LAUNCHER, launcherExpected: true })).toEqual([]);
  });
});

describe('elevationPromptAllowed', () => {
  const DESKTOP = { SESSIONNAME: 'Console' };
  const TTY = { stdin: true, stdout: true };
  it('allows an interactive desktop console', () => {
    expect(elevationPromptAllowed(DESKTOP, TTY)).toBe(true);
    expect(elevationPromptAllowed({ ...DESKTOP, CI: 'false' }, TTY)).toBe(true);
  });
  it.each([
    ['no stdin TTY', DESKTOP, { stdin: false, stdout: true }],
    ['no stdout TTY', DESKTOP, { stdin: true, stdout: false }],
    ['CI', { ...DESKTOP, CI: 'true' }, TTY],
    ['APRA_FLEET_NONINTERACTIVE', { ...DESKTOP, APRA_FLEET_NONINTERACTIVE: '1' }, TTY],
    ['SSH_CONNECTION', { ...DESKTOP, SSH_CONNECTION: '1.2.3.4 5 6.7.8.9 22' }, TTY],
    ['SSH_CLIENT', { ...DESKTOP, SSH_CLIENT: '1.2.3.4 5 22' }, TTY],
    ['no logon session', {}, TTY],
  ])('refuses: %s', (_name, env, tty) => {
    expect(elevationPromptAllowed(env as Record<string, string>, tty)).toBe(false);
  });
});

/** schtasks fake with a stateful task: legacy until the elevated delete removes it. */
function legacyWorld(opts: { elevatedExit?: number; deleteWorks?: boolean; createAfterDelete?: boolean } = {}) {
  let present = true;
  let createdNew = false;
  const calls: string[][] = [];
  const order: string[] = [];
  const schtasks = vi.fn((args: string[]) => {
    calls.push(args);
    order.push(`schtasks ${args.join(' ')}`);
    switch (args[0]) {
      case '/create':
        if (present || opts.createAfterDelete === false) throw new Error('ERROR: Access is denied.');
        present = true; createdNew = true; return 'SUCCESS';
      case '/query':
        if (!present) throw new Error('ERROR: The system cannot find the file specified.');
        return args.includes('/xml') ? (createdNew ? CURRENT_QUERIED_XML : LEGACY_XML) : '';
      case '/change':
        if (!createdNew) throw new Error('ERROR: Access is denied.');
        return 'SUCCESS';
      default:
        throw new Error(`unexpected schtasks ${args.join(' ')}`);
    }
  });
  const elevated = vi.fn((argv: readonly string[]) => {
    order.push(`ELEVATED ${argv.join(' ')}`);
    const code = opts.elevatedExit ?? 0;
    if (code === 0 && opts.deleteWorks !== false) present = false;
    return code;
  });
  const reg = vi.fn((args: string[]) => { if (args[0] !== 'add') throw new Error('not found'); return ''; });
  return { schtasks, elevated, reg, calls, order, isPresent: () => present };
}

function mgrFor(w: ReturnType<typeof legacyWorld>, canPrompt: boolean | undefined, env: Record<string, string> = { USERDOMAIN: 'HOST', USERNAME: 'u' }) {
  return new WindowsServiceManager(w.schtasks, WRAPPER, {
    runReg: w.reg, env, probeWsh: () => true, stoppedByUser: () => true,
    runElevatedSchtasks: w.elevated,
    ...(canPrompt === undefined ? {} : { canPromptElevation: () => canPrompt }),
  });
}

describe('register() with a legacy task it cannot replace', () => {
  let log: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  const out = () => [...log.mock.calls, ...warn.mock.calls].map(c => c.join(' ')).join('\n');

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    vi.mocked(fs.existsSync).mockReturnValue(true);
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { log.mockRestore(); warn.mockRestore(); });

  it('interactive: ONE elevated call with exactly the delete argv, then the normal non-elevated create', async () => {
    const w = legacyWorld();
    expect(await mgrFor(w, true).register('C:\\bin\\apra-fleet.exe', ['--transport', 'http'], 'C:\\log.txt')).toBe('created');
    expect(w.elevated).toHaveBeenCalledTimes(1);
    expect(w.elevated.mock.calls[0][0]).toEqual(DELETE_ARGV);
    expect(w.order).toEqual([
      expect.stringMatching(/^schtasks \/create \/tn ApraFleet \/xml .* \/f$/),
      'schtasks /query /tn ApraFleet /xml',
      'ELEVATED /delete /tn ApraFleet /f',
      'schtasks /query /tn ApraFleet', // verifies the task is gone
      expect.stringMatching(/^schtasks \/create \/tn ApraFleet \/xml .* \/f$/),
    ]);
    // The non-elevated runner never deletes the task itself.
    expect(w.calls.some(c => c[0] === '/delete')).toBe(false);
    expect(out()).toMatch(/one-time Windows elevation \(UAC\) whose ONLY action is: schtasks \/delete \/tn ApraFleet \/f/);
    expect(out()).toMatch(/new task was created without elevation/);
  });

  it.each([
    ['declined', { elevatedExit: UAC_DECLINED_EXIT }, /Elevation declined/],
    ['failed', { elevatedExit: 5 }, /elevated delete failed \(exit code 5\)/],
    ['reported success but the task is still there', { deleteWorks: false }, /task still exists/],
  ])('elevation %s -> keeps reusing the old task and prints the fix', async (_n, opts, why) => {
    const w = legacyWorld(opts);
    expect(await mgrFor(w, true).register('x.exe', [], 'C:\\log.txt')).toBe('reused');
    expect(w.elevated).toHaveBeenCalledTimes(1);
    expect(w.isPresent()).toBe(true);
    expect(w.calls.filter(c => c[0] === '/create')).toHaveLength(1);
    const text = out();
    expect(text).toMatch(why);
    expect(text).toContain('no automatic revive after a crash');
    expect(text).toContain('the server runs in a visible console window');
    expect(text).toContain("'apra-fleet stop' cannot disable the task");
    expect(text).toContain('schtasks /delete /tn ApraFleet /f');
    expect(text).toMatch(/then, from a normal prompt:\s+apra-fleet install/);
  });

  it('non-interactive: never calls the elevated runner, reuses and prints the fix', async () => {
    const w = legacyWorld();
    expect(await mgrFor(w, false).register('x.exe', [], 'C:\\log.txt')).toBe('reused');
    expect(w.elevated).not.toHaveBeenCalled();
    expect(out()).toContain('schtasks /delete /tn ApraFleet /f');
    expect(out()).toContain('no automatic revive after a crash');
  });

  describe('default prompt gate (stdin/stdout TTY + env)', () => {
    const ttyDesc = {
      in: Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'),
      out: Object.getOwnPropertyDescriptor(process.stdout, 'isTTY'),
    };
    const setTty = (v: boolean) => {
      Object.defineProperty(process.stdin, 'isTTY', { value: v, configurable: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: v, configurable: true });
    };
    afterEach(() => {
      for (const [stream, d] of [[process.stdin, ttyDesc.in], [process.stdout, ttyDesc.out]] as const) {
        if (d) Object.defineProperty(stream, 'isTTY', d); else delete (stream as { isTTY?: boolean }).isTTY;
      }
    });
    const base = { USERDOMAIN: 'HOST', USERNAME: 'u', SESSIONNAME: 'Console' };

    it('positive control: a TTY desktop console prompts', async () => {
      setTty(true);
      const w = legacyWorld();
      expect(await mgrFor(w, undefined, base).register('x.exe', [], 'C:\\log.txt')).toBe('created');
      expect(w.elevated).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['no TTY (apra-fleet update runs install detached)', false, {}],
      ['CI', true, { CI: 'true' }],
      ['SSH', true, { SSH_CONNECTION: '10.0.0.1 50000 10.0.0.2 22' }],
      ['APRA_FLEET_NONINTERACTIVE', true, { APRA_FLEET_NONINTERACTIVE: '1' }],
    ])('%s -> never prompts', async (_n, tty, extra) => {
      setTty(tty as boolean);
      const w = legacyWorld();
      expect(await mgrFor(w, undefined, { ...base, ...(extra as Record<string, string>) }).register('x.exe', [], 'C:\\log.txt')).toBe('reused');
      expect(w.elevated).not.toHaveBeenCalled();
    });
  });

  it('a current-form task that /create cannot replace is reused silently (no prompt, no guidance)', async () => {
    const w = legacyWorld();
    const schtasks = vi.fn((args: string[]) => {
      if (args[0] === '/create') throw new Error('ERROR: Access is denied.');
      return CURRENT_QUERIED_XML;
    });
    const mgr = new WindowsServiceManager(schtasks, WRAPPER, {
      runReg: w.reg, env: { USERDOMAIN: 'HOST', USERNAME: 'u' }, probeWsh: () => true,
      runElevatedSchtasks: w.elevated, canPromptElevation: () => true,
    });
    expect(await mgr.register('x.exe', [], 'C:\\log.txt')).toBe('reused');
    expect(w.elevated).not.toHaveBeenCalled();
    expect(out()).not.toContain('schtasks /delete');
  });

  it('the default elevated runner is one Start-Process -Verb RunAs of schtasks.exe with exactly the delete argv', async () => {
    const w = legacyWorld();
    vi.mocked(execFileSync).mockImplementation((() => {
      throw Object.assign(new Error('declined'), { status: UAC_DECLINED_EXIT });
    }) as any);
    const mgr = new WindowsServiceManager(w.schtasks, WRAPPER, {
      runReg: w.reg, env: { USERDOMAIN: 'HOST', USERNAME: 'u', SystemRoot: 'C:\\Windows' }, probeWsh: () => true,
      canPromptElevation: () => true,
    });
    expect(await mgr.register('x.exe', [], 'C:\\log.txt')).toBe('reused');
    expect(out()).toMatch(/Elevation declined/);
    const psCalls = vi.mocked(execFileSync).mock.calls;
    expect(psCalls).toHaveLength(1);
    const [file, argv] = psCalls[0] as unknown as [string, string[]];
    expect(file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(argv.slice(0, -1)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
    const script = Buffer.from(argv[argv.length - 1], 'base64').toString('utf16le');
    expect(script).toBe(elevatedSchtasksScript(DELETE_ARGV));
    expect(script).toContain("Start-Process -FilePath 'schtasks.exe' -ArgumentList @('/delete','/tn','ApraFleet','/f') -Verb RunAs -Wait -PassThru");
    expect(script.match(/RunAs/g)).toHaveLength(1);
  });
});

describe('nothing else is ever run elevated', () => {
  it('RunAs / the elevated runner appear only for the legacy-task delete', async () => {
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const realPath = await vi.importActual<typeof import('node:path')>('node:path');
    const root = realPath.resolve(__dirname, '..', 'src');
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const e of realFs.readdirSync(dir, { withFileTypes: true })) {
        const p = realPath.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|mts|cts|js|mjs)$/.test(e.name)) {
          const text = realFs.readFileSync(p, 'utf8');
          // Verb RunAs, runas.exe, ShellExecute "runas", requireAdministrator manifests.
          for (const m of text.matchAll(/-Verb\s+RunAs|\brunas(\.exe)?\b|requireAdministrator|HighestAvailable/gi)) {
            hits.push(`${realPath.relative(root, p).replace(/\\/g, '/')}: ${m[0]}`);
          }
        }
      }
    };
    walk(root);
    expect(hits).toEqual(['services/service-manager/windows.ts: -Verb RunAs']);

    const src = realFs.readFileSync(realPath.join(root, 'services', 'service-manager', 'windows.ts'), 'utf8');
    // Exactly one call site of the elevated runner, with the fixed delete argv.
    expect(src.match(/this\.runElevatedSchtasks\(/g)).toEqual(['this.runElevatedSchtasks(']);
    expect(src).toContain('this.runElevatedSchtasks(LEGACY_TASK_DELETE_ARGV)');
    expect(LEGACY_TASK_DELETE_ARGV).toEqual(DELETE_ARGV);
    expect(Object.isFrozen(LEGACY_TASK_DELETE_ARGV)).toBe(true);
  });
});
