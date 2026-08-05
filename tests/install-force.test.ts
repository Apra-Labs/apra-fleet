/**
 * Tests for --force flag, busy-server prompt, and unknown flag rejection (#96).
 * Uses _setSeaOverride to simulate SEA mode so the process-detection guard fires.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { runInstall, isApraFleetRunning, killApraFleet, _setSeaOverride, _setManifestOverride, _setInstallForceTimingOverride } from '../src/cli/install.js';

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

// Executable path reported for the running server. Under the mocked home's
// install prefix (BIN_DIR = <home>/.apra-fleet/bin), so the scoped guard
// (apra-fleet-1aw, src/cli/install-guard.ts) classifies it as relevant to this
// install and the guard still fires.
const runningExePath = `${mockHome}/.apra-fleet/bin/apra-fleet`;

/**
 * Answer the executable-path lookups install-guard.ts issues for a running
 * server (Linux: readlink /proc/<pid>/exe, macOS: ps -o comm=, Windows:
 * Get-Process ... "<pid>|<path>"). Returns null for unrelated commands so
 * callers can fall through to their own handling.
 */
function exeLookupResult(c: string, exePath: string = runningExePath): string | null {
  if (c.startsWith('readlink -f /proc/') || c.startsWith('ps -p ')) return `${exePath}\n`;
  if (c.startsWith('powershell')) return `5678|${exePath}\n`;
  return null;
}

// Make pgrep -x succeed (server running) on Linux, fail on others
function mockServerRunning() {
  vi.mocked(execSync).mockImplementation((cmd: any) => {
    const c = cmd.toString();
    if (c === 'pgrep -x apra-fleet') return '5678\n' as any;
    if (c.startsWith('tasklist')) return '"apra-fleet.exe","5678","Console","1","14,000 K"\n' as any;
    const exe = exeLookupResult(c);
    if (exe !== null) return exe as any;
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
    let killed = false;
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      const c = cmd.toString();
      if (c === 'pgrep -x apra-fleet') {
        if (killed) throw Object.assign(new Error('no match'), { status: 1 });
        return '5678\n' as any;
      }
      if (c === 'pkill -x apra-fleet') { killCalls.push(c); killed = true; return '' as any; }
      const exe = exeLookupResult(c);
      if (exe !== null) return exe as any;
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
    let killed = false;
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      const c = cmd.toString();
      if (c.startsWith('tasklist')) {
        return killed
          ? 'INFO: No tasks are running which match the specified criteria.' as any
          : '"apra-fleet.exe","5678","Console","1","14,000 K"\n' as any;
      }
      if (c.startsWith('taskkill')) { killCalls.push(c); killed = true; return '' as any; }
      const exe = exeLookupResult(c);
      if (exe !== null) return exe as any;
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
    let killed = false;
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      const c = cmd.toString();
      if (c === 'pgrep -x apra-fleet') {
        if (killed) throw Object.assign(new Error('no match'), { status: 1 });
        return '5678\n' as any;
      }
      if (c === 'pkill -x apra-fleet') { killed = true; return '' as any; }
      const exe = exeLookupResult(c);
      if (exe !== null) return exe as any;
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

describe('install --skip-running-check (apra-fleet-fyc.2.5.1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHome);
    makeFsMock();
    _setSeaOverride(true);
    _setManifestOverride({ version: '0.1.0', hooks: {}, scripts: {}, skills: {}, fleetSkills: {} });
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  });

  afterEach(() => {
    _setSeaOverride(null);
    _setManifestOverride(null);
    Object.defineProperty(process, 'platform', { value: process.platform, configurable: true });
  });

  it('relevant running server (install-prefix match) + --skip-running-check: proceeds without exit(1), does not kill anything', async () => {
    mockServerRunning(); // runningExePath is under BIN_DIR -- classifyRunningServer() reports relevant: true
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(runInstall(['--skill', 'none', '--skip-running-check'])).resolves.toBeUndefined();

    expect(exitSpy).not.toHaveBeenCalled();
    const errText = errorSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(errText).not.toContain('apra-fleet is currently running');
    const logText = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logText).toContain('--skip-running-check set');
    // Unlike --force, --skip-running-check must never stop the other instance.
    const calls = vi.mocked(execSync).mock.calls.map(c => c[0].toString());
    expect(calls).not.toContain('pkill -x apra-fleet');
    expect(calls).not.toContain('taskkill /F /IM apra-fleet.exe');

    exitSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('no running server + --skip-running-check: installs normally (flag is a no-op when the guard would not have fired anyway)', async () => {
    mockServerNotRunning();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    await expect(runInstall(['--skill', 'none', '--skip-running-check'])).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it('relevant running server, no --skip-running-check and no --force: still blocks with exit 1, and the hint mentions --skip-running-check', async () => {
    mockServerRunning();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runInstall(['--skill', 'none'])).rejects.toThrow('exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errText = errorSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(errText).toContain('apra-fleet is currently running');
    expect(errText).toContain('--skip-running-check');

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('--skip-running-check is accepted as a known flag (does not trip the unknown-flag rejection)', async () => {
    mockServerNotRunning();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runInstall(['--skill', 'none', '--skip-running-check'])).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe('install --force still-running after kill (apra-fleet-l7n.3.2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHome);
    makeFsMock();
    _setSeaOverride(true);
    _setManifestOverride({ version: '0.1.0', hooks: {}, scripts: {}, skills: {}, fleetSkills: {} });
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  });

  afterEach(() => {
    _setSeaOverride(null);
    _setManifestOverride(null);
    Object.defineProperty(process, 'platform', { value: process.platform, configurable: true });
  });

  it('does NOT print "Stopped running server." and surfaces a clear error when the process is still running after kill', async () => {
    // isApraFleetRunning() (via pgrep) keeps reporting the server running even
    // after killApraFleet()'s SIGTERM/SIGKILL escalation -- the process could
    // not be stopped.
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      const c = cmd.toString();
      if (c === 'pgrep -x apra-fleet') return '5678\n' as any;
      // pkill (SIGTERM and SIGKILL escalation) "succeeds" as a command but
      // never actually terminates the process in this scenario.
      if (c === 'pkill -x apra-fleet' || c === 'pkill -9 -x apra-fleet') return '' as any;
      const exe = exeLookupResult(c);
      if (exe !== null) return exe as any;
      return '' as any;
    });
    const logLines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => { logLines.push(args.join(' ')); });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    await expect(runInstall(['--skill', 'none', '--force'])).rejects.toThrow('exit');

    expect(logLines.join('\n')).not.toContain('Stopped running server.');
    expect(exitSpy).toHaveBeenCalledWith(1);
    const errText = errorSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(errText).toContain('could not stop the running apra-fleet server');
    expect(errText).toContain('pkill -x apra-fleet');

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('complementary case: still prints "Stopped running server." when the process does stop', async () => {
    let killed = false;
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      const c = cmd.toString();
      if (c === 'pgrep -x apra-fleet') {
        if (killed) throw Object.assign(new Error('no match'), { status: 1 });
        return '5678\n' as any;
      }
      if (c === 'pkill -x apra-fleet') { killed = true; return '' as any; }
      const exe = exeLookupResult(c);
      if (exe !== null) return exe as any;
      return '' as any;
    });
    const logLines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => { logLines.push(args.join(' ')); });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    await expect(runInstall(['--skill', 'none', '--force'])).resolves.toBeUndefined();

    expect(logLines.join('\n')).toContain('Stopped running server.');
    expect(exitSpy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });
});

describe('install --force ETXTBSY regression: survives first SIGTERM (apra-fleet-l7n.2.2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHome);
    makeFsMock();
    _setSeaOverride(true);
    _setManifestOverride({ version: '0.1.0', hooks: {}, scripts: {}, skills: {}, fleetSkills: {} });
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    // Generous, deterministic timing so the poll loop gets several iterations
    // regardless of host scheduling jitter (default TEST timing is intentionally
    // tiny to keep the rest of the suite fast).
    _setInstallForceTimingOverride({ pollIntervalMs: 5, graceMs: 30, killGraceMs: 15 });
  });

  afterEach(() => {
    _setSeaOverride(null);
    _setManifestOverride(null);
    _setInstallForceTimingOverride(null);
    Object.defineProperty(process, 'platform', { value: process.platform, configurable: true });
  });

  it('does not copy the binary until the process is confirmed gone, and escalates to SIGKILL after the grace window', async () => {
    // Ordered trace of every observable event so we can assert relative ordering,
    // not just presence/absence.
    const seq: string[] = [];
    let sigkillIssued = false;

    vi.mocked(execSync).mockImplementation((cmd: any) => {
      const c = cmd.toString();
      if (c === 'pgrep -x apra-fleet') {
        if (sigkillIssued) {
          // Only reports gone once the process has been escalated against.
          seq.push('pgrep:gone');
          throw Object.assign(new Error('no match'), { status: 1 });
        }
        seq.push('pgrep:running');
        return '5678\n' as any;
      }
      if (c === 'pkill -x apra-fleet') {
        seq.push('kill:term');
        return '' as any;
      }
      if (c === 'pkill -9 -x apra-fleet') {
        sigkillIssued = true;
        seq.push('kill:sigkill');
        return '' as any;
      }
      const exe = exeLookupResult(c);
      if (exe !== null) return exe as any;
      return '' as any;
    });
    vi.mocked(fs.copyFileSync).mockImplementation(() => { seq.push('copyFileSync'); });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    await expect(runInstall(['--skill', 'none', '--force'])).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();

    // (2) SIGKILL escalation occurred, and only after multiple polls during the
    // graceful-SIGTERM window -- not a single check followed by a fixed sleep.
    const runningPollsBeforeEscalation = seq.slice(0, seq.indexOf('kill:sigkill')).filter(s => s === 'pgrep:running').length;
    expect(seq).toContain('kill:term');
    expect(seq).toContain('kill:sigkill');
    expect(runningPollsBeforeEscalation).toBeGreaterThan(1);

    // (1) The binary copy never happens while isApraFleetRunning() would still
    // report true -- it only happens after the last observed check reported gone.
    const copyIdx = seq.indexOf('copyFileSync');
    const lastRunningIdx = seq.lastIndexOf('pgrep:running');
    const sigkillIdx = seq.indexOf('kill:sigkill');
    expect(copyIdx).toBeGreaterThan(-1);
    expect(copyIdx).toBeGreaterThan(lastRunningIdx);
    expect(copyIdx).toBeGreaterThan(sigkillIdx);

    exitSpy.mockRestore();
  });
});

describe('isApraFleetRunning / killApraFleet helpers (#96)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: process.platform, configurable: true });
  });

  it('isApraFleetRunning returns true when pgrep finds a different PID (Linux)', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    vi.mocked(execSync).mockReturnValue('5678\n' as any);
    expect(isApraFleetRunning()).toBe(true);
  });

  it('isApraFleetRunning returns false when pgrep finds only the current PID (Linux)', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    vi.mocked(execSync).mockReturnValue(`${process.pid}\n` as any);
    expect(isApraFleetRunning()).toBe(false);
  });

  it('isApraFleetRunning returns false when pgrep exits non-zero (Linux)', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    vi.mocked(execSync).mockImplementation(() => { throw Object.assign(new Error('no match'), { status: 1 }); });
    expect(isApraFleetRunning()).toBe(false);
  });

  it('isApraFleetRunning returns true when tasklist CSV contains a different PID (Windows)', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    vi.mocked(execSync).mockReturnValue('"apra-fleet.exe","5678","Console","1","14,000 K"' as any);
    expect(isApraFleetRunning()).toBe(true);
  });

  it('isApraFleetRunning returns false when tasklist CSV contains only the current PID (Windows)', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    vi.mocked(execSync).mockReturnValue(`"apra-fleet.exe","${process.pid}","Console","1","14,000 K"` as any);
    expect(isApraFleetRunning()).toBe(false);
  });

  it('isApraFleetRunning returns false when tasklist finds no match (Windows)', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    vi.mocked(execSync).mockReturnValue('INFO: No tasks are running which match the specified criteria.' as any);
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

// --- apra-fleet-1aw: the guard is scoped to THIS install, not to the OS-global
// process name. An apra-fleet server that is neither recorded live in the data
// dir being targeted nor running from the install prefix being written must not
// block the install (that is what made ci.yml's clean-temp-prefix install step
// unreplayable on any box already running a fleet server).
describe('install running-server guard is scoped to the install target (apra-fleet-1aw)', () => {
  const originalDataDir = process.env.APRA_FLEET_DATA_DIR;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHome);
    makeFsMock();
    _setSeaOverride(true);
    _setManifestOverride({ version: '0.1.0', hooks: {}, scripts: {}, skills: {}, fleetSkills: {} });
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    delete process.env.APRA_FLEET_DATA_DIR;
  });

  afterEach(() => {
    _setSeaOverride(null);
    _setManifestOverride(null);
    if (originalDataDir === undefined) delete process.env.APRA_FLEET_DATA_DIR;
    else process.env.APRA_FLEET_DATA_DIR = originalDataDir;
    Object.defineProperty(process, 'platform', { value: process.platform, configurable: true });
  });

  /** Running server whose executable lives at `exePath` (Linux shape). */
  function mockUnrelatedServerRunning(exePath: string) {
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      const c = cmd.toString();
      if (c === 'pgrep -x apra-fleet') return '5678\n' as any;
      const exe = exeLookupResult(c, exePath);
      if (exe !== null) return exe as any;
      return '' as any;
    });
  }

  it('unrelated running server (different data dir AND different prefix) — install completes without --force and without killing it', async () => {
    // No server.json in the targeted data dir, and the running binary lives
    // outside the install prefix: nothing to do with this install.
    mockUnrelatedServerRunning('/opt/other-prefix/bin/apra-fleet');
    const logLines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => { logLines.push(args.join(' ')); });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    await expect(runInstall(['--skill', 'none'])).resolves.toBeUndefined();

    expect(exitSpy).not.toHaveBeenCalled();
    const log = logLines.join('\n');
    expect(log).toContain('unrelated apra-fleet server');
    expect(log).toContain('5678');
    expect(log).not.toContain('Stopped running server.');
    // The unrelated server was never signalled.
    const cmds = vi.mocked(execSync).mock.calls.map(c => c[0].toString());
    expect(cmds).not.toContain('pkill -x apra-fleet');
    expect(cmds).not.toContain('pkill -9 -x apra-fleet');

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('running server whose executable path cannot be resolved is treated as unrelated (never silently reinstates the global refusal)', async () => {
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      const c = cmd.toString();
      if (c === 'pgrep -x apra-fleet') return '5678\n' as any;
      return '' as any; // readlink yields nothing
    });
    const logLines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => { logLines.push(args.join(' ')); });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    await expect(runInstall(['--skill', 'none'])).resolves.toBeUndefined();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(logLines.join('\n')).toContain('executable path could not be determined');

    exitSpy.mockRestore();
  });

  it('live server recorded in the SAME data dir — guard still fires with the existing error and exit 1', async () => {
    mockUnrelatedServerRunning('/opt/other-prefix/bin/apra-fleet');
    // server.json in the targeted data dir records a live pid (this process).
    const prevRead = vi.mocked(fs.readFileSync).getMockImplementation()!;
    vi.mocked(fs.readFileSync).mockImplementation((p: any, ...rest: any[]) => {
      const ps = p.toString();
      if (ps.includes('server.json')) {
        return JSON.stringify({ pid: process.pid, url: 'http://127.0.0.1:9999/mcp' }) as any;
      }
      return prevRead(p, ...rest);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    await expect(runInstall(['--skill', 'none'])).rejects.toThrow('exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errText = errorSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(errText).toContain('apra-fleet is currently running');
    expect(errText).toContain('recorded live in the data dir');

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('running server whose executable is under the install prefix — guard still fires even when the data dirs differ', async () => {
    process.env.APRA_FLEET_DATA_DIR = '/tmp/some-isolated-data-dir';
    mockUnrelatedServerRunning(`${mockHome}/.apra-fleet/bin/apra-fleet`);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    await expect(runInstall(['--skill', 'none'])).rejects.toThrow('exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errText = errorSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(errText).toContain('apra-fleet is currently running');
    expect(errText).toContain('inside the install prefix being written');

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('a sibling prefix that merely shares a name prefix does not count as "under" the install prefix', async () => {
    mockUnrelatedServerRunning(`${mockHome}/.apra-fleet/bin-old/apra-fleet`);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    await expect(runInstall(['--skill', 'none'])).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });
});
