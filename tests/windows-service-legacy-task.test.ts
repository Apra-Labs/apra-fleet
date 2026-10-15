/**
 * Upgrading a legacy ApraFleet task (registered by apra-fleet 0.4.3 with
 * `schtasks /sc onlogon` from an elevated shell): detection, reuse of a task
 * that is ours (including a wrapper path split at a space), and the manual-fix
 * guidance in install/status/stop. apra-fleet never elevates anything itself.
 * Everything is faked: schtasks, reg, node:fs and node:child_process are
 * injected/mocked -- no real scheduled task or install dir is touched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

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
  WindowsServiceManager, legacyTaskProblems, schtasksErrorReason,
  buildTaskXml, encodeTaskXml, launcherArguments, launcherPathFor,
  legacyTaskFix, legacyTaskGuidance,
} from '../src/services/service-manager/windows.js';
import { formatServiceLabel } from '../src/cli/status.js';
import path from 'node:path';
import { BIN_DIR } from '../src/cli/config.js';

const WRAPPER = 'C:\\Users\\u\\.apra-fleet\\bin\\apra-fleet-service.bat';
const LAUNCHER = launcherPathFor(WRAPPER);
const WSCRIPT = 'C:\\Windows\\System32\\wscript.exe';
const NOTICE = 'C:\\data\\service-notice.json';
const LOG = 'C:\\log.txt';
const ENV = { USERDOMAIN: 'HOST', USERNAME: 'u' };

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

describe('schtasksErrorReason', () => {
  it('drops execFileSync\'s "Command failed" line and joins the rest', () => {
    expect(schtasksErrorReason('Command failed: schtasks /create /tn ApraFleet /xml x /f\r\nERROR: Access is denied.\r\n'))
      .toBe('ERROR: Access is denied.');
    expect(schtasksErrorReason('')).toBe('(no error text)');
  });
});

/** schtasks fake: an existing task (legacy by default) that /create cannot replace. */
function legacyWorld(opts: { legacyXml?: string; noTask?: boolean } = {}) {
  const calls: string[][] = [];
  const schtasks = vi.fn((args: string[]) => {
    calls.push(args);
    switch (args[0]) {
      case '/create':
        throw new Error('Command failed: schtasks /create\r\nERROR: Access is denied.');
      case '/query':
        if (opts.noTask) throw new Error('ERROR: The system cannot find the file specified.');
        return args.includes('/xml') ? (opts.legacyXml ?? LEGACY_XML) : '';
      default:
        throw new Error(`unexpected schtasks ${args.join(' ')}`);
    }
  });
  const reg = vi.fn((args: string[]) => { if (args[0] !== 'add') throw new Error('not found'); return ''; });
  return { schtasks, reg, calls };
}

function mgrFor(w: ReturnType<typeof legacyWorld>, wrapper = WRAPPER) {
  return new WindowsServiceManager('mcp-server', w.schtasks, wrapper, {
    runReg: w.reg, env: ENV, probeWsh: () => true, stoppedByUser: () => true, noticePath: NOTICE,
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

  it('reuses the old task and prints the exact manual fix (never deletes it itself)', async () => {
    const w = legacyWorld();
    expect(await mgrFor(w).register('x.exe', [], LOG)).toBe('reused');
    expect(w.calls.some(c => c[0] === '/delete')).toBe(false);
    expect(w.calls.filter(c => c[0] === '/create')).toHaveLength(1);
    const text = out();
    expect(text).toContain('no automatic revive after a crash');
    expect(text).toContain('the server runs in a visible console window');
    expect(text).toContain("'apra-fleet stop' cannot disable the task");
    expect(text).toContain('Run as administrator');
    expect(text).toContain('schtasks /delete /tn ApraFleet /f');
    expect(text).toMatch(/then, from a normal prompt \(do not run the install itself elevated\):\s+apra-fleet install --force$/m);
  });

  it('persists the guidance for a detached install: notice file + service log', async () => {
    await mgrFor(legacyWorld()).register('x.exe', [], LOG);
    const noticeWrite = vi.mocked(fs.writeFileSync).mock.calls.find(c => c[0] === NOTICE);
    expect(noticeWrite).toBeDefined();
    const saved = JSON.parse(String(noticeWrite![1]));
    expect(saved.text).toContain('schtasks /delete /tn ApraFleet /f');
    expect(saved.text).toContain('no automatic revive after a crash');
    const logAppend = vi.mocked(fs.appendFileSync).mock.calls.find(c => c[0] === LOG);
    expect(String(logAppend?.[1])).toMatch(/apra-fleet install: The ApraFleet scheduled task was registered by an older apra-fleet/);
    expect(vi.mocked(fs.unlinkSync).mock.calls.some(c => c[0] === NOTICE)).toBe(false);
  });

  it('installing the current task clears a pending notice', async () => {
    const schtasks = vi.fn(() => 'SUCCESS');
    const mgr = new WindowsServiceManager('mcp-server', schtasks, WRAPPER, {
      runReg: vi.fn(() => { throw new Error('not found'); }), env: ENV, probeWsh: () => true, noticePath: NOTICE,
    });
    expect(await mgr.register('x.exe', [], LOG)).toBe('created');
    expect(vi.mocked(fs.unlinkSync).mock.calls.some(c => c[0] === NOTICE)).toBe(true);
    expect(vi.mocked(fs.writeFileSync).mock.calls.some(c => c[0] === NOTICE)).toBe(false);
  });

  it('an interactive install marks the persisted notice as already shown', async () => {
    const mgr = new WindowsServiceManager('mcp-server', legacyWorld().schtasks, WRAPPER, {
      runReg: vi.fn(), env: ENV, probeWsh: () => true, noticePath: NOTICE, interactive: () => true,
    });
    await mgr.register('x.exe', [], LOG);
    const saved = JSON.parse(String(vi.mocked(fs.writeFileSync).mock.calls.find(c => c[0] === NOTICE)![1]));
    expect(saved.shownAt).toBeDefined();
  });

  it('0.4.3 wrapper split at a space (unquoted /tr): ours, no throw -> guidance + HKCU Run autostart', async () => {
    const spaced = 'C:\\Users\\John Smith\\.apra-fleet\\bin\\apra-fleet-service.bat';
    const splitXml = LEGACY_XML.replace(`<Command>${WRAPPER}</Command>`,
      '<Command>C:\\Users\\John</Command><Arguments>Smith\\.apra-fleet\\bin\\apra-fleet-service.bat</Arguments>');
    // The split task never starts the server: no "visible console" claim.
    expect(legacyTaskProblems(splitXml, { launcherPath: launcherPathFor(spaced), launcherExpected: true, wrapperPath: spaced }))
      .toEqual(['no-revive', 'split-path', 'elevated']);
    const w = legacyWorld({ legacyXml: splitXml });
    expect(await mgrFor(w, spaced).register('x.exe', [], LOG)).toBe('run-key');
    expect(w.reg).toHaveBeenCalledWith(expect.arrayContaining(['add']));
    expect(out()).toContain('the task command is split at a space in the install path');
    expect(out()).not.toContain('visible console window');
    expect(out()).toContain('schtasks /delete /tn ApraFleet /f');
    // The guidance stays pending for a detached install (not cleared by the Run-key path).
    expect(vi.mocked(fs.writeFileSync).mock.calls.some(c => c[0] === NOTICE)).toBe(true);
    expect(vi.mocked(fs.unlinkSync).mock.calls.some(c => c[0] === NOTICE)).toBe(false);
  });

  it('start() with a split task and the Run entry launches the Run-entry way, not the broken task', async () => {
    const spaced = 'C:\\Users\\John Smith\\.apra-fleet\\bin\\apra-fleet-service.bat';
    const splitXml = LEGACY_XML.replace(`<Command>${WRAPPER}</Command>`,
      '<Command>C:\\Users\\John</Command><Arguments>Smith\\.apra-fleet\\bin\\apra-fleet-service.bat</Arguments>');
    const calls: string[][] = [];
    const schtasks = vi.fn((args: string[]) => { calls.push(args); return args.includes('/xml') ? splitXml : ''; });
    const spawnDetached = vi.fn();
    const mgr = new WindowsServiceManager('mcp-server', schtasks, spaced, {
      runReg: vi.fn(() => ''), env: ENV, probeWsh: () => true, noticePath: NOTICE, spawnDetached,
    });
    await mgr.start();
    expect(calls.some(c => c[0] === '/run')).toBe(false);
    expect(spawnDetached).toHaveBeenCalledWith(expect.stringMatching(/wscript\.exe$/i), expect.arrayContaining(['//B']));
  });

  it('a task running some OTHER program is still refused loudly', async () => {
    const other = legacyWorld({ legacyXml: LEGACY_XML.replace(`<Command>${WRAPPER}</Command>`, '<Command>C:\\other\\x.bat</Command><Arguments>y</Arguments>') });
    await expect(mgrFor(other).register('x.exe', [], LOG)).rejects.toThrow(/existing ApraFleet task runs C:\\other\\x\.bat/);
  });

  it('a current-form task that /create cannot replace is reused silently (no guidance)', async () => {
    const w = legacyWorld({ legacyXml: CURRENT_QUERIED_XML });
    expect(await mgrFor(w).register('x.exe', [], LOG)).toBe('reused');
    expect(out()).not.toContain('schtasks /delete');
    expect(vi.mocked(fs.writeFileSync).mock.calls.some(c => c[0] === NOTICE)).toBe(false);
  });

  it('no task and /create refused -> HKCU Run fallback says why schtasks failed', async () => {
    const w = legacyWorld({ noTask: true });
    expect(await mgrFor(w).register('x.exe', [], LOG)).toBe('run-key');
    expect(w.reg).toHaveBeenCalledWith(expect.arrayContaining(['add']));
    expect(out()).toContain('schtasks /create failed: ERROR: Access is denied.');
    expect(out()).not.toMatch(/Command failed/);
  });
});

describe('status and stop with a legacy task installed', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockGracefulStop.mockResolvedValue(true);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  const queryRunner = (xml: string) => vi.fn((args: string[]) => {
    if (args[0] === '/change') throw new Error('ERROR: Access is denied.');
    if (args.includes('/xml')) return xml;
    if (args.includes('csv')) return '"\\ApraFleet","N/A","Running"\r\n';
    return '';
  });

  it('status shows "legacy task (upgrade needed: ...)" plus the fix', async () => {
    const mgr = new WindowsServiceManager('mcp-server', queryRunner(LEGACY_XML), WRAPPER, { runReg: vi.fn(), stoppedByUser: () => false });
    const st = await mgr.query();
    expect(formatServiceLabel(st)).toBe(
      'installed (enabled -- legacy task (upgrade needed: no automatic revive after a crash; ' +
      "the server runs in a visible console window; 'apra-fleet stop' cannot disable the task))",
    );
    expect(st.notice).toBe([
      'To upgrade it, run once from an elevated prompt (Run as administrator):',
      '    schtasks /delete /tn ApraFleet /f',
      'then, from a normal prompt (do not run the install itself elevated):',
      '    apra-fleet install --force',
    ].join('\n'));
  });

  it('status and stop give no legacy advice for a foreign task named ApraFleet', async () => {
    const foreign = LEGACY_XML.replace(`<Command>${WRAPPER}</Command>`, '<Command>C:\\other\\x.bat</Command>');
    const st = await new WindowsServiceManager('mcp-server', queryRunner(foreign), WRAPPER, { runReg: vi.fn(), stoppedByUser: () => false }).query();
    expect(st.notice).toBeUndefined();
    expect(st.detail ?? '').not.toMatch(/legacy/);
    await new WindowsServiceManager('mcp-server', queryRunner(foreign), WRAPPER, { runReg: vi.fn() }).stop();
    expect(warn.mock.calls.map(c => c.join(' ')).join('\n')).not.toContain('schtasks /delete');
  });

  it('status of a current task has no legacy hint', async () => {
    const mgr = new WindowsServiceManager('mcp-server', queryRunner(CURRENT_QUERIED_XML), WRAPPER, { runReg: vi.fn(), stoppedByUser: () => false });
    const st = await mgr.query();
    expect(formatServiceLabel(st)).toBe('installed (enabled)');
    expect(st.notice).toBeUndefined();
  });

  it('stop prints the legacy guidance when disabling is denied, and still stops the server', async () => {
    const mgr = new WindowsServiceManager('mcp-server', queryRunner(LEGACY_XML), WRAPPER, { runReg: vi.fn() });
    expect(await mgr.stop()).toBe(true);
    expect(mockGracefulStop).toHaveBeenCalled();
    const text = warn.mock.calls.map(c => c.join(' ')).join('\n');
    expect(text).toMatch(/Could not disable the ApraFleet task \(ERROR: Access is denied\.\)/);
    expect(text).toContain('no automatic revive after a crash');
    expect(text).toContain('schtasks /delete /tn ApraFleet /f');
    expect(text).toMatch(/then, from a normal prompt[^\n]*:\s+apra-fleet install --force/);
    expect(text).toMatch(/A stop made with 'apra-fleet stop' still holds/);
  });

  it('stop on a current task that cannot be disabled keeps the plain warning', async () => {
    const mgr = new WindowsServiceManager('mcp-server', queryRunner(CURRENT_QUERIED_XML), WRAPPER, { runReg: vi.fn() });
    await mgr.stop();
    const text = warn.mock.calls.map(c => c.join(' ')).join('\n');
    expect(text).toMatch(/Could not disable the ApraFleet task/);
    // The stopped-by-user marker is honoured by every launch: no "may start again" scare.
    expect(text).not.toMatch(/may start the server again/);
    expect(text).toMatch(/A stop made with 'apra-fleet stop' still holds/);
    expect(text).not.toContain('schtasks /delete');
  });

  it('a user-owned old-form task (no "elevated" problem) is fixed by a plain re-install', async () => {
    const userOwnedOld = CURRENT_QUERIED_XML.replace(/<Repetition>[\s\S]*?<\/Repetition>/, '');
    const st = await new WindowsServiceManager('mcp-server', queryRunner(userOwnedOld), WRAPPER, { runReg: vi.fn(), stoppedByUser: () => false }).query();
    expect(st.detail).toBe('legacy task (upgrade needed: no automatic revive after a crash)');
    expect(st.notice).toBe('To upgrade it, run from a normal prompt:\n    apra-fleet install --force');
    expect(st.notice).not.toMatch(/elevated|schtasks/);
    expect(legacyTaskGuidance(['no-revive'])).not.toMatch(/elevated|schtasks \/delete/);
    expect(legacyTaskFix(['no-revive', 'elevated'])).toContain('schtasks /delete /tn ApraFleet /f');
  });
});

describe('legacyTaskFix names an install command that works for a standalone install', () => {
  it('the running installer names its own path, not a bare apra-fleet (not on PATH)', () => {
    const exe = 'C:\\Users\\x\\Downloads\\apra-fleet-installer-win-x64.exe';
    expect(legacyTaskFix(['no-revive'], exe)).toBe(`To upgrade it, run from a normal prompt:\n    ${exe} install --force`);
    expect(legacyTaskFix(['no-revive', 'elevated'], exe)).toContain(`\n    ${exe} install --force`);
  });

  it('the installed binary (status, stop) points at the downloaded installer', () => {
    const fix = legacyTaskFix(['no-revive'], path.join(BIN_DIR, 'apra-fleet.exe'));
    expect(fix).toContain('<the apra-fleet installer .exe you downloaded> install --force');
    expect(fix).not.toMatch(/^ +apra-fleet install --force$/m);
  });

  it('npm global / dev (node) keeps apra-fleet install --force', () => {
    expect(legacyTaskFix(['no-revive'], 'C:\\Program Files\\nodejs\\node.exe')).toContain('    apra-fleet install --force');
  });
});

describe('apra-fleet never runs anything elevated', () => {
  it('no RunAs / requireAdministrator anywhere in src', async () => {
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
          for (const m of text.matchAll(/-Verb\s+RunAs|\brunas(\.exe)?\b|requireAdministrator|HighestAvailable/gi)) {
            hits.push(`${realPath.relative(root, p).replace(/\\/g, '/')}: ${m[0]}`);
          }
        }
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});
