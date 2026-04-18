/**
 * Tests for --force flag, busy-server prompt, and unknown flag rejection (#96).
 * Uses _setSeaOverride to simulate SEA mode so the process-detection guard fires.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { runInstall, isApraFleetRunning, killApraFleet, _setSeaOverride, _setManifestOverride } from '../src/cli/install.js';

vi.mock('node:os', () => ({
  default: {
    homedir: vi.fn(() => '/mock/home'),
    platform: vi.fn(() => 'linux'),
  }
}));
vi.mock('node:fs');
vi.mock('node:child_process');

const mockHome = '/mock/home';

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

// Make pgrep -x succeed (server running) on Linux, fail on others
function mockServerRunning() {
  vi.mocked(execSync).mockImplementation((cmd: any) => {
    const c = cmd.toString();
    if (c === 'pgrep -x apra-fleet') return 'apra-fleet' as any;
    if (c.startsWith('tasklist')) return 'apra-fleet.exe  1234 Console' as any;
    return '' as any;
  });
}

// Make pgrep -x throw exit 1 (no server)
function mockServerNotRunning() {
  vi.mocked(execSync).mockImplementation((cmd: any) => {
    const c = cmd.toString();
    if (c === 'pgrep -x apra-fleet') {
      throw Object.assign(new Error('no match'), { status: 1 });
    }
    return '' as any;
  });
}

describe('install --force (#96)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHome);
    makeFsMock();
    // Simulate SEA mode so the process-detection guard runs
    _setSeaOverride(true);
    // Provide an empty manifest so loadManifest() doesn't call getSeaAsset()
    _setManifestOverride({ version: '0.1.0', hooks: {}, scripts: {}, skills: {}, fleetSkills: {} });
  });

  afterEach(() => {
    _setSeaOverride(null);
    _setManifestOverride(null);
    Object.defineProperty(process, 'platform', { value: process.platform, configurable: true });
  });

  it('no server running — installs without prompt', async () => {
    mockServerNotRunning();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    await expect(runInstall(['--skill', 'none'])).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('server running, no --force — prints error and exits 1 (Linux)', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    mockServerRunning();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runInstall(['--skill', 'none'])).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    const errText = errorSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(errText).toContain('apra-fleet is currently running');
    expect(errText).toContain('--force');
    expect(errText).toContain('pkill -x apra-fleet');

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('server running, no --force — prints taskkill hint on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    mockServerRunning();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runInstall(['--skill', 'none'])).rejects.toThrow('exit');
    const errText = errorSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(errText).toContain('taskkill /F /IM apra-fleet.exe');

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('server running, --force — kills server and completes install (Linux)', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const killCalls: string[] = [];
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      const c = cmd.toString();
      if (c === 'pgrep -x apra-fleet') return 'apra-fleet' as any;
      if (c === 'pkill -x apra-fleet') { killCalls.push(c); return '' as any; }
      return '' as any;
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    await expect(runInstall(['--skill', 'none', '--force'])).resolves.toBeUndefined();
    expect(killCalls).toContain('pkill -x apra-fleet');
    expect(exitSpy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it('server running, --force — kills server and completes install (Windows)', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const killCalls: string[] = [];
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      const c = cmd.toString();
      if (c.startsWith('tasklist')) return 'apra-fleet.exe  1234' as any;
      if (c.startsWith('taskkill')) { killCalls.push(c); return '' as any; }
      return '' as any;
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    await expect(runInstall(['--skill', 'none', '--force'])).resolves.toBeUndefined();
    expect(killCalls).toContain('taskkill /F /IM apra-fleet.exe');
    expect(exitSpy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it('--force install success message includes "Restart Claude Code"', async () => {
    mockServerRunning();
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      const c = cmd.toString();
      if (c === 'pgrep -x apra-fleet') return 'apra-fleet' as any;
      return '' as any;
    });
    const logLines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => { logLines.push(args.join(' ')); });

    await runInstall(['--skill', 'none', '--force']);

    expect(logLines.join('\n')).toContain('Restart Claude Code to reload the MCP server.');
  });

  it('no --force, no running server — success message does NOT include restart note', async () => {
    mockServerNotRunning();
    const logLines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => { logLines.push(args.join(' ')); });

    await runInstall(['--skill', 'none']);

    expect(logLines.join('\n')).not.toContain('Restart Claude Code to reload the MCP server.');
  });

  it('unknown flag errors with non-zero exit', async () => {
    mockServerNotRunning();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runInstall(['--typo-flag'])).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy.mock.calls.map(c => c.join(' ')).join('\n')).toContain('Unknown option "--typo-flag"');

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe('isApraFleetRunning / killApraFleet helpers (#96)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: process.platform, configurable: true });
  });

  it('isApraFleetRunning returns true when pgrep -x exits 0 (Linux)', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    vi.mocked(execSync).mockImplementation(() => '' as any);
    expect(isApraFleetRunning()).toBe(true);
  });

  it('isApraFleetRunning returns false when pgrep -x exits non-zero (Linux)', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    vi.mocked(execSync).mockImplementation(() => { throw Object.assign(new Error('no match'), { status: 1 }); });
    expect(isApraFleetRunning()).toBe(false);
  });

  it('isApraFleetRunning returns true when tasklist output contains apra-fleet.exe (Windows)', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    vi.mocked(execSync).mockReturnValue('apra-fleet.exe  1234 Console' as any);
    expect(isApraFleetRunning()).toBe(true);
  });

  it('isApraFleetRunning returns false when tasklist output does not contain apra-fleet.exe (Windows)', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    vi.mocked(execSync).mockReturnValue('No tasks are running which match the specified criteria.' as any);
    expect(isApraFleetRunning()).toBe(false);
  });

  it('killApraFleet calls pkill -x apra-fleet on Linux', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const calls: string[] = [];
    vi.mocked(execSync).mockImplementation((cmd: any) => { calls.push(cmd.toString()); return '' as any; });
    killApraFleet();
    expect(calls).toContain('pkill -x apra-fleet');
  });

  it('killApraFleet calls taskkill on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const calls: string[] = [];
    vi.mocked(execSync).mockImplementation((cmd: any) => { calls.push(cmd.toString()); return '' as any; });
    killApraFleet();
    expect(calls).toContain('taskkill /F /IM apra-fleet.exe');
  });
});
