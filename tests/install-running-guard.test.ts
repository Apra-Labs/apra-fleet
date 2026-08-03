/**
 * Tests for apra-fleet-fyc.2.5.2: the install running-process guard scoping.
 *
 * apra-fleet-fyc.2.5.1 changed isApraFleetRunning() (machine-wide) to also
 * consult isApraFleetRunningAtDifferentRoot(targetRoot) before blocking/killing:
 * an install whose target root (FLEET_BASE) differs from every other running
 * apra-fleet instance's resolved install root should proceed without the
 * "currently running" block, while an install into the SAME root as a running
 * instance must still be blocked (unless --force or --skip-running-check).
 *
 * Follows tests/install-force.test.ts conventions: _setSeaOverride to force
 * SEA mode (so the guard runs at all), mocked node:child_process execSync for
 * pgrep/pkill, mocked node:fs (including readlinkSync, which
 * getRunningInstanceBinaryPath() uses on Linux to resolve a PID's binary path).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { runInstall, _setSeaOverride, _setManifestOverride } from '../src/cli/install.js';

vi.mock('node:os', () => ({
  default: {
    homedir: vi.fn(() => '/mock/home'),
    platform: vi.fn(() => 'linux'),
  }
}));
vi.mock('node:fs');
vi.mock('node:child_process');

const mockHome = '/mock/home';
const SAME_ROOT = path.join(mockHome, '.apra-fleet'); // == FLEET_BASE under the mocked homedir
const OTHER_ROOT = '/isolated/other-prefix/.apra-fleet';
const RUNNING_PID = '5678';

function makeFsMock() {
  const fileState = new Map<string, string>();
  vi.mocked(fs.existsSync).mockImplementation((p: any) => {
    const ps = p.toString();
    if (ps.includes('version.json')) return true;
    if (ps.includes('hooks-config.json')) return true;
    if (fileState.has(ps)) return true;
    return false;
  });
  vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
    const ps = p.toString();
    if (fileState.has(ps)) return fileState.get(ps)!;
    if (ps.includes('version.json')) return JSON.stringify({ version: '0.1.0' });
    if (ps.includes('hooks-config.json')) return JSON.stringify({ hooks: { PostToolUse: [] } });
    return '';
  });
  vi.mocked(fs.writeFileSync).mockImplementation((p: any, content: any) => {
    fileState.set(p.toString(), content.toString());
  });
  vi.mocked(fs.readdirSync).mockReturnValue([] as any);
  vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
  vi.mocked(fs.chmodSync).mockImplementation(() => {});
  vi.mocked(fs.copyFileSync).mockImplementation(() => {});
}

// Simulates a running apra-fleet instance (PID RUNNING_PID) whose binary lives
// at <root>/bin/apra-fleet -- resolveRunningInstanceRoot() walks two dirname()s
// up from getRunningInstanceBinaryPath()'s result to recover `root`.
function mockServerRunningAtRoot(root: string) {
  vi.mocked(execSync).mockImplementation((cmd: any) => {
    const c = cmd.toString();
    if (c === 'pgrep -x apra-fleet') return `${RUNNING_PID}\n` as any;
    return '' as any;
  });
  vi.mocked(fs.readlinkSync).mockImplementation((p: any) => {
    const ps = p.toString();
    if (ps === `/proc/${RUNNING_PID}/exe`) return path.join(root, 'bin', 'apra-fleet');
    throw new Error(`unexpected readlinkSync target: ${ps}`);
  });
}

describe('install running-process guard scoping (apra-fleet-fyc.2.5.2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHome);
    makeFsMock();
    _setSeaOverride(true);
    _setManifestOverride({ version: '0.1.0', hooks: {}, scripts: {}, skills: {}, fleetSkills: {} } as any);
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  });

  afterEach(() => {
    _setSeaOverride(null);
    _setManifestOverride(null);
    Object.defineProperty(process, 'platform', { value: process.platform, configurable: true });
  });

  it('case 1: isolated-prefix install with an unrelated running server proceeds (no exit(1))', async () => {
    mockServerRunningAtRoot(OTHER_ROOT);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(runInstall(['--skill', 'none'])).resolves.toBeUndefined();

    expect(exitSpy).not.toHaveBeenCalled();
    const errText = errorSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(errText).not.toContain('apra-fleet is currently running');
    const logText = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logText).toContain('skipping running-process guard');

    exitSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('case 2: same-root install still blocks (exit 1) unless --force', async () => {
    mockServerRunningAtRoot(SAME_ROOT);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runInstall(['--skill', 'none'])).rejects.toThrow('exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errText = errorSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(errText).toContain('apra-fleet is currently running');

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('case 3: same-root install with --force proceeds and stops the server', async () => {
    mockServerRunningAtRoot(SAME_ROOT);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    await expect(runInstall(['--skill', 'none', '--force'])).resolves.toBeUndefined();

    expect(exitSpy).not.toHaveBeenCalled();
    const calls = vi.mocked(execSync).mock.calls.map(c => c[0].toString());
    expect(calls).toContain('pkill -x apra-fleet');

    exitSpy.mockRestore();
  });

  it('case 4: --skip-running-check bypasses the block even at the same root', async () => {
    mockServerRunningAtRoot(SAME_ROOT);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(runInstall(['--skill', 'none', '--skip-running-check'])).resolves.toBeUndefined();

    expect(exitSpy).not.toHaveBeenCalled();
    const errText = errorSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(errText).not.toContain('apra-fleet is currently running');
    const logText = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logText).toContain('skipping running-process guard');
    // --skip-running-check does not stop the running instance (unlike --force).
    const calls = vi.mocked(execSync).mock.calls.map(c => c[0].toString());
    expect(calls).not.toContain('pkill -x apra-fleet');

    exitSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('case 4b: --skip-running-check also bypasses when the running instance is at a different root', async () => {
    mockServerRunningAtRoot(OTHER_ROOT);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(runInstall(['--skill', 'none', '--skip-running-check'])).resolves.toBeUndefined();

    expect(exitSpy).not.toHaveBeenCalled();
    const logText = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logText).toContain('skipping running-process guard');

    exitSpy.mockRestore();
    logSpy.mockRestore();
  });
});
