import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  runInstall,
  _setSeaOverride,
  _setManifestOverride,
  _setDoltStepDeps,
  _resetDoltStepDeps,
} from '../src/cli/install.js';
import { BEADS_PACKAGE, BEADS_VERSION } from '../src/cli/beads-pin.js';
import { DOLT_VERSION } from '../src/cli/dolt-install.js';

// Every seam call stubs the PATH dolt probe (no shadowing dolt), so no test
// reaches a dolt on the host's PATH.
const setDoltDeps = (o: any) => _setDoltStepDeps({ probePathDolt: () => null, ...o });

// End-to-end coverage of the installer's bd / dolt version pin with REAL fake
// executables: a fake `bd` placed first on PATH and a fake `dolt` in the
// sandbox BIN_DIR, run for real through child_process. Same harness style as
// install-member.test.ts / install-force.test.ts (runInstall in-process, an
// in-memory fs for everything the installer writes, a stub service manager),
// except that:
//   - node:fs is mocked for the installer only; the fake executables are real
//     files in a per-test temp dir (written with the real fs);
//   - execFileSync runs the REAL child_process for bd and the fake dolt;
//     npm and every other command are stubbed (no real bd/dolt/npm is
//     installed or changed, no network);
//   - the Dolt download goes through the _setDoltStepDeps seam.
// The pm installer (apra-pm/install.mjs) runs as a real node subprocess with
// HOME/USERPROFILE pointed at the sandbox and the fake bd first on PATH.

const { sandboxRoot, sandboxHome, realFs, realCp } = vi.hoisted(() => {
  // vi.hoisted runs before imports: reach the real modules via require-free
  // dynamic access through process.getBuiltinModule (Node >= 22.3).
  const getBuiltin = (process as any).getBuiltinModule as (id: string) => any;
  const rfs = getBuiltin('node:fs');
  const ros = getBuiltin('node:os');
  const rpath = getBuiltin('node:path');
  const root = rfs.mkdtempSync(rpath.join(ros.tmpdir(), 'y1vf-pin-'));
  return {
    sandboxRoot: root as string,
    sandboxHome: rpath.join(root, 'home') as string,
    realFs: rfs as typeof import('node:fs'),
    realCp: getBuiltin('node:child_process') as typeof import('node:child_process'),
  };
});

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    default: {
      ...actual,
      homedir: vi.fn(() => sandboxHome),
      platform: vi.fn(() => actual.platform()),
      hostname: vi.fn(() => 'pin-sandbox-host'),
      userInfo: vi.fn(() => ({ username: 'sandbox-user' })),
    },
  };
});
vi.mock('node:fs');
vi.mock('node:child_process');
vi.mock('../src/services/service-manager/index.js', () => ({
  getServiceManager: vi.fn(async () => ({
    register: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({ installed: false, running: false }),
    isInstalled: vi.fn().mockResolvedValue(false),
    unregister: vi.fn().mockResolvedValue(undefined),
  })),
}));

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PM_INSTALLER = path.join(REPO_ROOT, 'packages', 'apra-fleet-se', 'apra-pm', 'install.mjs');
const BIN_DIR = path.join(sandboxHome, '.apra-fleet', 'bin');
const FAKE_PATH_DIR = path.join(sandboxRoot, 'fake-path');
const PINNED_DOLT = DOLT_VERSION.replace(/^v/, '');

/**
 * Write a fake executable that prints `output` for any arguments and returns
 * the path to invoke. One helper, explicit per-platform branch: Windows gets a
 * .cmd shim (found through PATH + PATHEXT), everything else a POSIX sh script
 * made executable with chmod 755.
 */
function writeFakeExecutable(dir: string, name: string, output: string): string {
  realFs.mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') {
    const file = path.join(dir, `${name}.cmd`);
    realFs.writeFileSync(file, `@echo off\r\necho ${output}\r\n`);
    return file;
  }
  const file = path.join(dir, name);
  realFs.writeFileSync(file, `#!/bin/sh\necho '${output.replace(/'/g, `'\\''`)}'\n`);
  realFs.chmodSync(file, 0o755);
  return file;
}

function sha(file: string): string {
  return crypto.createHash('sha256').update(realFs.readFileSync(file)).digest('hex');
}

/** Every file under dir (relative paths), or [] when dir is absent. */
function listTree(dir: string): string[] {
  if (!realFs.existsSync(dir)) return [];
  return (realFs.readdirSync(dir, { recursive: true }) as string[]).map(String).sort();
}

const OUTSIDE_WATCH = [process.env.HOME, process.env.USERPROFILE, process.env.APRA_FLEET_DATA_DIR]
  .filter((d): d is string => Boolean(d));

let memFiles: Map<string, string>;
let execCalls: string[];
let savedPath: string | undefined;
let outsideBefore: Map<string, string[]>;

function installMemFs() {
  memFiles = new Map();
  const key = (p: any) => p.toString();
  vi.mocked(fs.existsSync).mockImplementation((p: any) => {
    const k = key(p);
    if (k.includes('version.json') || k.includes('hooks-config.json')) return true;
    if (memFiles.has(k)) return true;
    // The fake dolt lives on the REAL fs inside the sandbox BIN_DIR.
    return k.startsWith(BIN_DIR) && realFs.existsSync(k);
  });
  vi.mocked(fs.readFileSync).mockImplementation(((p: any) => {
    const k = key(p);
    if (memFiles.has(k)) return memFiles.get(k)!;
    if (k.includes('version.json')) return JSON.stringify({ version: '0.1.0' });
    if (k.includes('hooks-config.json')) return JSON.stringify({ hooks: { PostToolUse: [] } });
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }) as any);
  vi.mocked(fs.writeFileSync).mockImplementation(((p: any, d: any) => { memFiles.set(key(p), String(d)); }) as any);
  vi.mocked(fs.appendFileSync).mockImplementation(((p: any, d: any) => { memFiles.set(key(p), (memFiles.get(key(p)) ?? '') + String(d)); }) as any);
  vi.mocked(fs.readdirSync).mockReturnValue([] as any);
  vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
  vi.mocked(fs.chmodSync).mockImplementation(() => {});
  vi.mocked(fs.copyFileSync).mockImplementation(() => {});
  vi.mocked(fs.rmSync).mockImplementation(() => undefined as any);
}

/** The installer's exec: real for bd and the sandbox fakes, stubbed for everything else. */
function routeExec() {
  vi.mocked(execFileSync).mockImplementation(((cmd: string, args: string[] = [], opts: any) => {
    execCalls.push([cmd, ...args].join(' '));
    if (cmd === 'bd' || String(cmd).startsWith(sandboxRoot)) {
      return realCp.execFileSync(cmd, args, { ...opts, env: process.env });
    }
    if (cmd === 'npm') throw Object.assign(new Error('npm stubbed in this test'), { code: 'ENOENT' });
    return '';
  }) as any);
}

const logs = () => vi.mocked(console.log).mock.calls.map(c => c.join(' ')).join('\n');
const warns = () => vi.mocked(console.warn).mock.calls.map(c => c.join(' ')).join('\n');
const errs = () => vi.mocked(console.error).mock.calls.map(c => c.join(' ')).join('\n');
const summaryLine = (label: string) => logs().split('\n').find(l => l.trim().startsWith(`${label}:`)) ?? '';

/** Every path the installer wrote through the (mocked) fs. */
function installerWrites(): string[] {
  const m = vi.mocked(fs);
  return [
    ...m.writeFileSync.mock.calls.map(c => String(c[0])),
    ...m.appendFileSync.mock.calls.map(c => String(c[0])),
    ...m.mkdirSync.mock.calls.map(c => String(c[0])),
    ...m.copyFileSync.mock.calls.map(c => String(c[1])),
  ];
}

/** A path the sandbox owns: this test's temp root or the runner's sandbox data dir. */
function insideSandbox(p: string): boolean {
  const roots = [sandboxRoot, process.env.APRA_FLEET_DATA_DIR].filter((r): r is string => Boolean(r));
  return roots.some(r => path.resolve(p).startsWith(path.resolve(r)));
}

beforeAll(() => {
  outsideBefore = new Map(OUTSIDE_WATCH.map(d => [d, listTree(d)]));
});

afterAll(() => {
  // No leftovers: the whole sandbox goes, and nothing appeared outside it.
  realFs.rmSync(sandboxRoot, { recursive: true, force: true });
  expect(realFs.existsSync(sandboxRoot)).toBe(false);
  for (const [d, before] of outsideBefore) expect(listTree(d)).toEqual(before);
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(os.homedir).mockReturnValue(sandboxHome);
  realFs.rmSync(FAKE_PATH_DIR, { recursive: true, force: true });
  realFs.rmSync(BIN_DIR, { recursive: true, force: true });
  installMemFs();
  execCalls = [];
  routeExec();
  savedPath = process.env.PATH;
  process.env.PATH = `${FAKE_PATH_DIR}${path.delimiter}${process.env.PATH ?? ''}`;
  _setSeaOverride(false);
  _setManifestOverride({ version: '0.1.0', hooks: {}, scripts: {}, skills: {}, fleetSkills: {}, agents: {}, workflows: {} } as any);
  process.env.APRA_FLEET_ENABLE_DOLT_INSTALL = '1';
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = undefined;
});

afterEach(() => {
  process.env.PATH = savedPath;
  _setSeaOverride(null);
  _setManifestOverride(null);
  _resetDoltStepDeps();
  delete process.env.APRA_FLEET_ENABLE_DOLT_INSTALL;
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

/** Dolt step seam: verify runs the REAL fake dolt in BIN_DIR; the download rewrites it as the pinned version. */
function doltSeam(downloads: string[]) {
  setDoltDeps({
    verifyDolt: (async (p: string) => {
      const out = String(realCp.execFileSync(p, ['version'], { encoding: 'utf-8', shell: process.platform === 'win32' }));
      return { version: /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? out.trim(), serverOk: true };
    }) as any,
    downloadAndExtractDolt: (async (binDir: string) => {
      downloads.push(binDir);
      return writeFakeExecutable(binDir, 'dolt', `dolt version ${PINNED_DOLT}`);
    }) as any,
  });
}

describe('installer version pin in a sandbox (fake bd / dolt executables)', () => {
  it('step 2: a fake bd 1.4.0 first on PATH -> non-zero exit naming host, found, expected and fix; summary repeats it; the fake bd is untouched', async () => {
    const bd = writeFakeExecutable(FAKE_PATH_DIR, 'bd', 'bd version 1.4.0 (fake)');
    const before = sha(bd);
    doltSeam([]);

    await runInstall([]);

    expect(process.exitCode).toBe(1);
    const w = warns();
    expect(w).toContain('version mismatch on pin-sandbox-host');
    expect(w).toContain('found 1.4.0 (PATH)');
    expect(w).toContain(`expected ${BEADS_VERSION}`);
    expect(w).toContain(`Fix: install the pinned ${BEADS_PACKAGE}`);
    const beads = summaryLine('Beads');
    expect(beads).toContain('MISMATCH');
    expect(beads).toContain('found 1.4.0');
    expect(beads).toContain(`expected ${BEADS_VERSION}`);
    expect(beads).toContain('Fix:');
    expect(errs()).toContain('found 1.4.0');
    // The real fake bd ran, and was never replaced or removed.
    expect(execCalls).toContain('bd --version');
    expect(execCalls.some(c => c.startsWith('npm'))).toBe(false);
    expect(sha(bd)).toBe(before);
  });

  it('step 3: a fake bd 1.3.x -> exit 0 and the summary shows the bd version', async () => {
    writeFakeExecutable(FAKE_PATH_DIR, 'bd', 'bd version 1.3.5 (fake)');
    doltSeam([]);

    await runInstall([]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(summaryLine('Beads')).toContain('bd version 1.3.5 (fake)');
    expect(warns()).not.toContain('version mismatch');
  });

  it('step 4: a fake BIN_DIR dolt reporting 2.1.0 is replaced via the stubbed pinned download; the summary reports the pinned version', async () => {
    writeFakeExecutable(FAKE_PATH_DIR, 'bd', `bd version ${BEADS_VERSION} (fake)`);
    const dolt = writeFakeExecutable(BIN_DIR, 'dolt', 'dolt version 2.1.0');
    expect(String(realCp.execFileSync(dolt, ['version'], { encoding: 'utf-8', shell: process.platform === 'win32' }))).toContain('2.1.0');
    const downloads: string[] = [];
    doltSeam(downloads);

    await runInstall([]);

    expect(downloads).toEqual([BIN_DIR]);
    expect(summaryLine('Dolt')).toContain(PINNED_DOLT);
    expect(summaryLine('Dolt')).not.toContain('MISMATCH');
    expect(String(realCp.execFileSync(dolt, ['version'], { encoding: 'utf-8', shell: process.platform === 'win32' }))).toContain(PINNED_DOLT);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('step 6: the installer wrote nothing outside the sandbox dirs', async () => {
    writeFakeExecutable(FAKE_PATH_DIR, 'bd', 'bd version 1.4.0 (fake)');
    writeFakeExecutable(BIN_DIR, 'dolt', 'dolt version 2.1.0');
    doltSeam([]);

    await runInstall([]);

    const writes = installerWrites();
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.filter(p => !insideSandbox(p))).toEqual([]);
  });
});

describe('pm installer version pin in a sandbox (real node subprocess, fake bd on PATH)', () => {
  function runPm(bdOutput: string) {
    const home = path.join(sandboxRoot, `pm-home-${crypto.randomBytes(4).toString('hex')}`);
    realFs.mkdirSync(home, { recursive: true });
    writeFakeExecutable(FAKE_PATH_DIR, 'bd', bdOutput);
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APRA_FLEET_DATA_DIR: path.join(home, 'data'),
      PATH: `${FAKE_PATH_DIR}${path.delimiter}${savedPath ?? ''}`,
    };
    const r = realCp.spawnSync(process.execPath, [PM_INSTALLER, '--llm', 'claude', '--force'], {
      cwd: path.dirname(PM_INSTALLER), env, encoding: 'utf-8', windowsHide: true, timeout: 60_000,
    });
    return { status: r.status, out: `${r.stdout}\n${r.stderr}`, home };
  }

  it('step 5: fake bd 1.4.0 -> non-zero exit with found/expected/fix', () => {
    const r = runPm('bd version 1.4.0 (fake)');
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('version mismatch on');
    expect(r.out).toContain('found 1.4.0');
    expect(r.out).toContain(`expected ${BEADS_VERSION}`);
    expect(r.out).toContain(`Fix: install the pinned ${BEADS_PACKAGE}`);
    expect(r.out).not.toContain('beads OK');
  });

  it('step 5: fake bd 1.3.x -> exit 0 and beads OK', () => {
    const r = runPm('bd version 1.3.2 (fake)');
    expect(r.out).toContain('beads OK: bd version 1.3.2 (fake)');
    expect(r.status).toBe(0);
    // Everything it installed landed under the sandbox home.
    expect(listTree(r.home).length).toBeGreaterThan(0);
  });
});
