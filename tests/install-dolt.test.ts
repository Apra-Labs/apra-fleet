import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runInstall,
  _setSeaOverride,
  _setManifestOverride,
  _setDoltStepDeps,
  _resetDoltStepDeps,
} from '../src/cli/install.js';

// apra-fleet-ire.4 -- vitest coverage for how install.ts's dolt CLI install
// step (wired in apra-fleet-ire.3) behaves end-to-end: graceful degradation
// on a download failure, idempotence (zero download calls) when a working
// dolt binary is already present, re-download when an existing binary is
// broken, and step-counter integrity ([n/total] labels stay contiguous with
// the dolt step folded in). Unit coverage for the underlying primitives
// (resolveDoltAsset / downloadAndExtractDolt / verifyDolt themselves) lives
// in dolt-install.test.ts (apra-fleet-ire.1/.2) -- this file exercises the
// wiring via install.ts's injectable _setDoltStepDeps seam.
//
// install.ts's doltStepEnabled() skips the whole step under NODE_ENV=test
// (set globally by tests/setup.ts) unless APRA_FLEET_ENABLE_DOLT_INSTALL=1 is
// also set -- an explicit opt-in escape hatch for tests like these that
// specifically want to exercise the step (with fakes injected).

vi.mock('node:os', () => ({
  default: {
    homedir: vi.fn(() => '/mock/home'),
    platform: vi.fn(() => 'linux'),
  }
}));
vi.mock('node:fs');
vi.mock('node:child_process');

const mockHome = '/mock/home';
const DOLT_BINARY_NAME = process.platform === 'win32' ? 'dolt.exe' : 'dolt';
const DOLT_PATH = path.join(mockHome, '.apra-fleet', 'bin', DOLT_BINARY_NAME);

const BASE_MANIFEST = {
  version: '0.1.0', hooks: {}, scripts: {}, skills: {}, fleetSkills: {}, agents: {}, workflows: {},
};

function makeFsMock(existingDolt = false) {
  vi.mocked(fs.existsSync).mockImplementation((p: any) => {
    const ps = p.toString();
    if (ps.includes('version.json')) return true;
    if (ps.includes('hooks-config.json')) return true;
    if (existingDolt && ps === DOLT_PATH) return true;
    return false;
  });
  vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
    const ps = p.toString();
    if (ps.includes('version.json')) return JSON.stringify({ version: '0.1.0' });
    if (ps.includes('hooks-config.json')) return JSON.stringify({ hooks: { PostToolUse: [] } });
    return '';
  });
  vi.mocked(fs.readdirSync).mockReturnValue([] as any);
  vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
  vi.mocked(fs.chmodSync).mockImplementation(() => {});
  vi.mocked(fs.copyFileSync).mockImplementation(() => {});
  vi.mocked(fs.writeFileSync).mockImplementation(() => {});
  vi.mocked(fs.rmSync).mockImplementation(() => undefined as any);
}

describe('dolt CLI install step wiring (apra-fleet-ire.4)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHome);
    makeFsMock();
    _setSeaOverride(false);
    _setManifestOverride(BASE_MANIFEST as any);
    process.env.APRA_FLEET_ENABLE_DOLT_INSTALL = '1';
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    _setSeaOverride(null);
    _setManifestOverride(null);
    _resetDoltStepDeps();
    delete process.env.APRA_FLEET_ENABLE_DOLT_INSTALL;
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('degrades gracefully: a download failure warns (not throws) and the summary reports "not available"', async () => {
    const downloadAndExtractDolt = vi.fn().mockRejectedValue(new Error('network unreachable'));
    const verifyDolt = vi.fn();
    _setDoltStepDeps({ downloadAndExtractDolt, verifyDolt } as any);

    await expect(runInstall([])).resolves.toBeUndefined();

    expect(downloadAndExtractDolt).toHaveBeenCalledTimes(1);

    const warns = warnSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(warns).toContain('Dolt install skipped');
    expect(warns).toContain('network unreachable');

    const logs = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logs).toMatch(/Dolt:\s+not available/);
  });

  it('is idempotent: makes zero download calls when a working dolt binary is already present', async () => {
    makeFsMock(true); // a dolt binary already exists at DOLT_PATH
    const downloadAndExtractDolt = vi.fn();
    const verifyDolt = vi.fn().mockResolvedValue({ version: '2.2.0', serverOk: true });
    _setDoltStepDeps({ downloadAndExtractDolt, verifyDolt } as any);

    await runInstall([]);

    expect(downloadAndExtractDolt).not.toHaveBeenCalled();
    expect(verifyDolt).toHaveBeenCalledTimes(1);
    expect(verifyDolt).toHaveBeenCalledWith(DOLT_PATH);

    const logs = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logs).toMatch(/Dolt:\s+2\.2\.0/);
  });

  it('re-downloads when the existing binary is broken, then reports the freshly-verified version', async () => {
    makeFsMock(true); // existsSync(DOLT_PATH) is true, but the binary is broken
    const downloadAndExtractDolt = vi.fn().mockResolvedValue(DOLT_PATH);
    const verifyDolt = vi.fn()
      .mockRejectedValueOnce(new Error('dolt: command not found')) // initial already-installed check fails
      .mockResolvedValueOnce({ version: '2.2.0', serverOk: true }); // post-(re)download check succeeds
    _setDoltStepDeps({ downloadAndExtractDolt, verifyDolt } as any);

    await runInstall([]);

    expect(downloadAndExtractDolt).toHaveBeenCalledTimes(1);
    expect(verifyDolt).toHaveBeenCalledTimes(2);

    const logs = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logs).toMatch(/Dolt:\s+2\.2\.0/);
  });

  it('prints contiguous [n/total] step labels with the dolt step included', async () => {
    _setDoltStepDeps({
      downloadAndExtractDolt: vi.fn().mockResolvedValue(DOLT_PATH),
      verifyDolt: vi.fn().mockResolvedValue({ version: '2.2.0', serverOk: true }),
    } as any);

    await runInstall([]);

    const stepLines = logSpy.mock.calls
      .map(c => c.join(' '))
      .filter(line => /^\s*\[\d+\/\d+\]/.test(line));

    expect(stepLines.length).toBeGreaterThan(0);

    const parsed = stepLines.map(line => {
      const m = line.match(/\[(\d+)\/(\d+)\]/)!;
      return { n: Number(m[1]), total: Number(m[2]), line };
    });

    // Every printed step line should agree on the same total step count.
    const totals = new Set(parsed.map(p => p.total));
    expect(totals.size).toBe(1);

    // Step numbers are contiguous 1..total, with no gaps or repeats.
    const ns = parsed.map(p => p.n).sort((a, b) => a - b);
    expect(ns).toEqual(Array.from({ length: ns.length }, (_, i) => i + 1));

    const doltLine = parsed.find(p => p.line.includes('Installing Dolt CLI'));
    expect(doltLine).toBeDefined();
  });

  it('never fails the install, and never leaves the step counter mid-sequence, when verifyDolt itself rejects', async () => {
    const downloadAndExtractDolt = vi.fn().mockResolvedValue(DOLT_PATH);
    const verifyDolt = vi.fn().mockRejectedValue(new Error('dolt sql-server crashed'));
    _setDoltStepDeps({ downloadAndExtractDolt, verifyDolt } as any);

    await expect(runInstall([])).resolves.toBeUndefined();

    const warns = warnSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(warns).toContain('Dolt install skipped');
    expect(warns).toContain('dolt sql-server crashed');

    const logs = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logs).toMatch(/Dolt:\s+not available/);
    // Install must still reach and print the final Beads step, i.e. it did not hang/abort.
    expect(logs).toContain('Installing Beads task tracker...');
  });
});
