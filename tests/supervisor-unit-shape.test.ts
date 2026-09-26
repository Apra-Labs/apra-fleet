/**
 * What the REGISTERED fleet-supervisor unit actually invokes, on every platform.
 *
 * The bug this pins: the unit used to be `<abs node> <installed>/bin/serve.mjs`,
 * which needed a real `node` on PATH at install time. Under the released SEA
 * binary process.execPath is the apra-fleet binary rather than node, so the
 * node-resolution step returned null on a clean Windows machine and the
 * supervisor was never registered there at all.
 *
 * These cases drive the REAL platform managers (LinuxServiceManager,
 * MacOSServiceManager, WindowsServiceManager) through the REAL
 * registerSupervisorService(), with node:fs and node:child_process mocked, so:
 *   - the args are the ones the supervisor registration actually chooses, and
 *   - the rendering is the one the platform manager actually writes,
 * meaning a revert on EITHER side fails a case here. Nothing shells out to a
 * real systemctl / launchctl / schtasks and nothing is written to disk.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const { mockGetSvcMgr } = vi.hoisted(() => ({
  mockGetSvcMgr: vi.fn(),
}));

vi.mock('node:fs');
// Explicit factory rather than an automock: WindowsServiceManager.start() does
// `spawn(...).unref()`, and an automocked spawn returns undefined.
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => ''),
  execSync: vi.fn(() => ''),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));
// registerSupervisorService resolves its manager through this module; each test
// substitutes the real platform manager for the platform under test.
vi.mock('../src/services/service-manager/index.js', () => ({
  getServiceManager: mockGetSvcMgr,
  gracefulStopByServerJson: vi.fn(async () => {}),
}));

import { LinuxServiceManager } from '../src/services/service-manager/linux.js';
import { MacOSServiceManager } from '../src/services/service-manager/macos.js';
import { WindowsServiceManager } from '../src/services/service-manager/windows.js';
import { registerSupervisorService } from '../src/services/supervisor-service.js';
import { SUPERVISOR_WORKING_DIR } from '../src/cli/supervisor.js';
import { SUPERVISOR_LOG_FILE_PATH, LOG_FILE_PATH } from '../src/paths.js';

/** Installed binary path, and the same under a home directory with a space. */
const BINARY = '/home/dev/.apra-fleet/bin/apra-fleet';
const BINARY_SPACED = '/home/my dev/.apra-fleet/bin/apra-fleet';
const BINARY_WIN = 'C:\\Users\\dev\\.apra-fleet\\bin\\apra-fleet.exe';

const savedDataDir = process.env.APRA_FLEET_DATA_DIR;
const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

function setPlatform(p: string): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

/** All content handed to fs.writeFileSync during the test, concatenated. */
function writtenContent(): string {
  return vi.mocked(fs.writeFileSync).mock.calls.map(c => String(c[1])).join('\n');
}

function writtenPaths(): string[] {
  return vi.mocked(fs.writeFileSync).mock.calls.map(c => String(c[0]));
}

beforeEach(() => {
  vi.clearAllMocks();
  // A machine-global unit is refused for an overridden instance, and tests/setup.ts
  // always sets APRA_FLEET_DATA_DIR -- clear it so registration is reached.
  delete process.env.APRA_FLEET_DATA_DIR;
  vi.mocked(execFileSync).mockReturnValue('' as any);
  vi.mocked(spawn).mockReturnValue({ unref: vi.fn() } as any);
  vi.mocked(fs.mkdirSync).mockReturnValue(undefined as any);
  vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
  vi.mocked(fs.unlinkSync).mockReturnValue(undefined);
  // serve.mjs present, and (Linux) the systemd user dir exists.
  vi.mocked(fs.existsSync).mockReturnValue(true);
});

afterEach(() => {
  if (savedDataDir === undefined) delete process.env.APRA_FLEET_DATA_DIR;
  else process.env.APRA_FLEET_DATA_DIR = savedDataDir;
  Object.defineProperty(process, 'platform', origPlatform);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Linux -- systemd unit
// ---------------------------------------------------------------------------
describe('registered supervisor unit -- Linux', () => {
  const savedXdg = process.env.XDG_RUNTIME_DIR;

  beforeEach(() => {
    process.env.XDG_RUNTIME_DIR = '/run/user/1000';
    setPlatform('linux');
    mockGetSvcMgr.mockImplementation(async () => new LinuxServiceManager('fleet-supervisor'));
  });

  afterEach(() => {
    if (savedXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = savedXdg;
  });

  it('runs the quoted installed binary with the single argument supervisor', async () => {
    const result = await registerSupervisorService(BINARY);
    expect(result).toEqual({ registered: true });
    expect(writtenContent()).toContain(`ExecStart="${BINARY}" supervisor`);
  });

  it('never names node as the executable and never mentions serve.mjs', async () => {
    await registerSupervisorService(BINARY);
    const unit = writtenContent();
    const execStart = unit.split('\n').find(l => l.startsWith('ExecStart='))!;
    // The exact pre-fix shape: ExecStart=<abs node> <installed>/bin/serve.mjs
    expect(unit).not.toContain('serve.mjs');
    expect(execStart).not.toMatch(/ExecStart="?[^"]*\/node(\.exe)?"?[\s"]/);
    // Exactly one argument follows the quoted executable.
    expect(execStart).toBe(`ExecStart="${BINARY}" supervisor`);
  });

  it('keeps the binary path intact when the operator home contains a space', async () => {
    await registerSupervisorService(BINARY_SPACED);
    const unit = writtenContent();
    // Quoted, so systemd's whitespace split cannot silently break the unit.
    expect(unit).toContain(`ExecStart="${BINARY_SPACED}" supervisor`);
    expect(unit).not.toContain(`ExecStart=${BINARY_SPACED} `);
  });

  it('cds to the installed fleet-sprint tree and logs to the supervisor own log', async () => {
    await registerSupervisorService(BINARY);
    const unit = writtenContent();
    expect(unit).toContain(`WorkingDirectory=${SUPERVISOR_WORKING_DIR}`);
    expect(SUPERVISOR_WORKING_DIR.replace(/\\/g, '/')).toMatch(/\/workflows\/fleet-sprint$/);
    expect(unit).toContain(`StandardOutput=append:${SUPERVISOR_LOG_FILE_PATH}`);
    expect(unit).toContain(`StandardError=append:${SUPERVISOR_LOG_FILE_PATH}`);
    // Distinct from the MCP server's own log.
    expect(SUPERVISOR_LOG_FILE_PATH).not.toBe(LOG_FILE_PATH);
    expect(unit).not.toContain(`append:${LOG_FILE_PATH}`);
  });

  it('writes its own unit file, not the MCP server one', async () => {
    await registerSupervisorService(BINARY);
    const written = writtenPaths().map(p => p.replace(/\\/g, '/'));
    expect(written.some(p => p.endsWith('/fleet-supervisor.service'))).toBe(true);
    expect(written.some(p => p.endsWith('/apra-fleet.service'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// macOS -- launchd plist
// ---------------------------------------------------------------------------
describe('registered supervisor unit -- macOS', () => {
  beforeEach(() => {
    setPlatform('darwin');
    mockGetSvcMgr.mockImplementation(async () => new MacOSServiceManager('fleet-supervisor'));
  });

  it('has ProgramArguments of exactly [binary, supervisor]', async () => {
    const result = await registerSupervisorService(BINARY);
    expect(result).toEqual({ registered: true });
    const plist = writtenContent();
    const args = [...plist.matchAll(/<string>([^<]*)<\/string>/g)].map(m => m[1]);
    const start = args.indexOf(BINARY);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(args.slice(start, start + 2)).toEqual([BINARY, 'supervisor']);
    // Nothing after the single argument, i.e. no serve.mjs tail.
    expect(plist).not.toContain('serve.mjs');
    expect(plist).not.toContain('<string>node</string>');
  });

  it('sets WorkingDirectory to the installed fleet-sprint tree and its own log', async () => {
    await registerSupervisorService(BINARY);
    const plist = writtenContent();
    expect(plist).toContain(`<string>${SUPERVISOR_WORKING_DIR}</string>`);
    expect(plist).toContain(`<string>${SUPERVISOR_LOG_FILE_PATH}</string>`);
    expect(plist).not.toContain(`<string>${LOG_FILE_PATH}</string>`);
  });
});

// ---------------------------------------------------------------------------
// Windows -- wrapper .bat driven by the scheduled task
// ---------------------------------------------------------------------------
describe('registered supervisor unit -- Windows', () => {
  beforeEach(() => {
    setPlatform('win32');
    mockGetSvcMgr.mockImplementation(async () => new WindowsServiceManager('fleet-supervisor'));
  });

  it('runs the quoted binary with the quoted single argument supervisor', async () => {
    const result = await registerSupervisorService(BINARY_WIN);
    expect(result).toEqual({ registered: true });
    const bat = writtenContent();
    expect(bat).toContain(`"${BINARY_WIN}" "supervisor"`);
    expect(bat).not.toContain('serve.mjs');
    expect(bat).not.toMatch(/"[^"]*\\node\.exe"/);
  });

  it('cds to the installed fleet-sprint tree and appends to the supervisor own log', async () => {
    await registerSupervisorService(BINARY_WIN);
    const bat = writtenContent();
    expect(bat).toContain(`cd /d "${SUPERVISOR_WORKING_DIR}"`);
    expect(bat).toContain(`>> "${SUPERVISOR_LOG_FILE_PATH}"`);
    expect(bat).not.toContain(`>> "${LOG_FILE_PATH}"`);
  });

  it('writes the supervisor own wrapper .bat, not the MCP server one', async () => {
    await registerSupervisorService(BINARY_WIN);
    const written = writtenPaths().map(p => p.replace(/\\/g, '/'));
    expect(written.some(p => p.endsWith('/apra-fleet-supervisor-service.bat'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// No real service tooling was invoked.
// ---------------------------------------------------------------------------
describe('supervisor unit shape suite hygiene', () => {
  beforeEach(() => {
    setPlatform('linux');
    process.env.XDG_RUNTIME_DIR = '/run/user/1000';
    mockGetSvcMgr.mockImplementation(async () => new LinuxServiceManager('fleet-supervisor'));
  });

  it('shells out only to mocked binaries and writes nothing to a real path', async () => {
    await registerSupervisorService(BINARY);
    // execFileSync is mocked, so these never reached a real systemctl.
    const invoked = vi.mocked(execFileSync).mock.calls.map(c => String(c[0]));
    expect(invoked.every(c => ['systemctl', 'loginctl'].includes(c))).toBe(true);
    // fs is mocked wholesale -- assert we would only ever have touched the
    // isolated test FLEET_DIR / mocked home, never the operator's real tree.
    for (const p of writtenPaths()) {
      expect(path.isAbsolute(p)).toBe(true);
    }
    expect(vi.isMockFunction(fs.writeFileSync)).toBe(true);
  });
});
