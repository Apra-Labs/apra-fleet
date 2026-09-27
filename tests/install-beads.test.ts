import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  runInstall,
  _setSeaOverride,
  _setManifestOverride,
  _setBeadsStepDeps,
  _resetBeadsStepDeps,
  _setDoltStepDeps,
  _resetDoltStepDeps,
} from '../src/cli/install.js';

// apra-fleet-i9ag.13.3 -- vitest coverage for how install.ts's beads step
// (rewired in apra-fleet-i9ag.13.2) behaves end-to-end: it installs the release
// binary and reports its real version, it is idempotent when a working bd is
// already present, it re-downloads a broken one, and -- deliberately UNLIKE the
// dolt step -- a failure is FATAL and loud rather than a warn-and-continue. Unit
// coverage for the underlying primitives (resolveBeadsAsset /
// downloadAndExtractBeads / verifyBeads) lives in beads-install.test.ts; this
// file exercises the wiring via install.ts's injectable _setBeadsStepDeps seam.
//
// install.ts's beadsStepEnabled() skips the whole step under NODE_ENV=test (set
// globally by tests/setup.ts) unless APRA_FLEET_ENABLE_BEADS_INSTALL=1 is also
// set. That gate exists because the real asset is ~53MB: it is OFF by default so
// a normal `npm test` run downloads nothing, and these tests opt in explicitly
// with fakes injected so they download nothing either.

vi.mock('node:os', () => ({
  default: {
    homedir: vi.fn(() => '/mock/home'),
    platform: vi.fn(() => 'linux'),
  }
}));
vi.mock('node:fs');
vi.mock('node:child_process');

const mockHome = '/mock/home';
const BEADS_BINARY_NAME = process.platform === 'win32' ? 'bd.exe' : 'bd';
const BEADS_PATH = path.join(mockHome, '.apra-fleet', 'bin', BEADS_BINARY_NAME);

const BASE_MANIFEST = {
  version: '0.1.0', hooks: {}, scripts: {}, skills: {}, fleetSkills: {}, agents: {}, workflows: {},
};

function makeFsMock(existingBeads = false) {
  vi.mocked(fs.existsSync).mockImplementation((p: any) => {
    const ps = p.toString();
    if (ps.includes('version.json')) return true;
    if (ps.includes('hooks-config.json')) return true;
    if (existingBeads && ps === BEADS_PATH) return true;
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

/** Every npm invocation made during the install, whatever it was for. */
function npmCalls() {
  return vi.mocked(execFileSync).mock.calls.filter(
    c => typeof c[0] === 'string' && /(^|[\\/])npm(\.cmd)?$/.test(c[0] as string),
  );
}

describe('beads CLI install step wiring (apra-fleet-i9ag.13.3)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHome);
    makeFsMock();
    _setSeaOverride(false);
    _setManifestOverride(BASE_MANIFEST as any);
    process.env.APRA_FLEET_ENABLE_BEADS_INSTALL = '1';
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    _setSeaOverride(null);
    _setManifestOverride(null);
    _resetBeadsStepDeps();
    _resetDoltStepDeps();
    delete process.env.APRA_FLEET_ENABLE_BEADS_INSTALL;
    delete process.env.APRA_FLEET_ENABLE_DOLT_INSTALL;
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('installs the release binary and reports the real installed version in the summary', async () => {
    const downloadAndExtractBeads = vi.fn().mockResolvedValue(BEADS_PATH);
    const verifyBeads = vi.fn().mockResolvedValue('1.3.0');
    _setBeadsStepDeps({ downloadAndExtractBeads, verifyBeads } as any);

    await expect(runInstall([])).resolves.toBeUndefined();

    expect(downloadAndExtractBeads).toHaveBeenCalledTimes(1);
    expect(verifyBeads).toHaveBeenCalledWith(BEADS_PATH);

    const logs = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logs).toContain('Installing Beads task tracker...');
    // The summary reports the version resolved from the INSTALLED PATH, not a
    // bare `bd` PATH probe (BIN_DIR is not on PATH, so that used to print
    // "not available" for a perfectly good install).
    expect(logs).toMatch(/Beads:\s+1\.3\.0/);
    expect(logs).not.toMatch(/Beads:\s+not available/);
  });

  it('is idempotent: makes zero download calls when a working bd is already present', async () => {
    makeFsMock(true); // a bd binary already exists at BEADS_PATH
    const downloadAndExtractBeads = vi.fn();
    const verifyBeads = vi.fn().mockResolvedValue('1.3.0');
    _setBeadsStepDeps({ downloadAndExtractBeads, verifyBeads } as any);

    await runInstall([]);

    expect(downloadAndExtractBeads).not.toHaveBeenCalled();
    expect(verifyBeads).toHaveBeenCalledTimes(1);
    expect(verifyBeads).toHaveBeenCalledWith(BEADS_PATH);

    const logs = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logs).toMatch(/Beads:\s+1\.3\.0/);
  });

  it('re-downloads when the existing binary is broken, then reports the freshly-verified version', async () => {
    makeFsMock(true); // existsSync(BEADS_PATH) is true, but the binary is broken
    const downloadAndExtractBeads = vi.fn().mockResolvedValue(BEADS_PATH);
    const verifyBeads = vi.fn()
      .mockRejectedValueOnce(new Error('bd: cannot execute binary file')) // already-installed check fails
      .mockResolvedValueOnce('1.3.0');                                    // post-(re)download check succeeds
    _setBeadsStepDeps({ downloadAndExtractBeads, verifyBeads } as any);

    await runInstall([]);

    expect(downloadAndExtractBeads).toHaveBeenCalledTimes(1);
    expect(verifyBeads).toHaveBeenCalledTimes(2);

    const logs = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logs).toMatch(/Beads:\s+1\.3\.0/);
  });

  // The core of the bug: this used to warn and continue, so install reported
  // success on a host that ended up with no bd at all.
  it('is FATAL and loud when the download fails: exits non-zero, names beads and the reason', async () => {
    const downloadAndExtractBeads = vi.fn().mockRejectedValue(new Error('network unreachable'));
    _setBeadsStepDeps({ downloadAndExtractBeads, verifyBeads: vi.fn() } as any);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    try {
      await expect(runInstall([])).rejects.toThrow('process.exit called');
      expect(exitSpy).toHaveBeenCalledWith(1);

      const errors = errorSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(errors).toMatch(/Beads/);
      expect(errors).toContain('network unreachable');
      // The message names the resolved asset so the operator can retry the URL by hand.
      expect(errors).toMatch(/beads_1\.3\.0_/);

      // Never the old skipped-and-continuing warning.
      const warns = warnSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(warns).not.toContain('Beads install skipped');
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('is FATAL and loud when the checksum verify fails', async () => {
    const downloadAndExtractBeads = vi.fn().mockRejectedValue(
      new Error('Checksum mismatch for beads release asset "beads_1.3.0_linux_amd64.tar.gz": expected sha256 aaa, got bbb'),
    );
    _setBeadsStepDeps({ downloadAndExtractBeads, verifyBeads: vi.fn() } as any);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    try {
      await expect(runInstall([])).rejects.toThrow('process.exit called');
      expect(exitSpy).toHaveBeenCalledWith(1);

      const errors = errorSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(errors).toContain('Checksum mismatch');
      expect(errors).toMatch(/Beads/);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('is FATAL and loud when verifyBeads itself rejects after a successful download', async () => {
    const downloadAndExtractBeads = vi.fn().mockResolvedValue(BEADS_PATH);
    const verifyBeads = vi.fn().mockRejectedValue(new Error('bd: cannot execute binary file'));
    _setBeadsStepDeps({ downloadAndExtractBeads, verifyBeads } as any);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    try {
      await expect(runInstall([])).rejects.toThrow('process.exit called');
      expect(exitSpy).toHaveBeenCalledWith(1);
      const errors = errorSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(errors).toContain('cannot execute binary file');
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('never invokes npm for beads on any path -- success, already-installed, or failure', async () => {
    // (a) fresh install
    _setBeadsStepDeps({
      downloadAndExtractBeads: vi.fn().mockResolvedValue(BEADS_PATH),
      verifyBeads: vi.fn().mockResolvedValue('1.3.0'),
    } as any);
    await runInstall([]);
    expect(npmCalls()).toEqual([]);

    // (b) already installed
    vi.clearAllMocks();
    makeFsMock(true);
    vi.mocked(os.homedir).mockReturnValue(mockHome);
    _setBeadsStepDeps({
      downloadAndExtractBeads: vi.fn(),
      verifyBeads: vi.fn().mockResolvedValue('1.3.0'),
    } as any);
    await runInstall([]);
    expect(npmCalls()).toEqual([]);

    // (c) failure path
    vi.clearAllMocks();
    makeFsMock();
    vi.mocked(os.homedir).mockReturnValue(mockHome);
    _setBeadsStepDeps({
      downloadAndExtractBeads: vi.fn().mockRejectedValue(new Error('network unreachable')),
      verifyBeads: vi.fn(),
    } as any);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    try {
      await expect(runInstall([])).rejects.toThrow('process.exit called');
      expect(npmCalls()).toEqual([]);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('performs no download at all when the opt-in gate is unset (the default for npm test)', async () => {
    delete process.env.APRA_FLEET_ENABLE_BEADS_INSTALL;
    const downloadAndExtractBeads = vi.fn();
    const verifyBeads = vi.fn();
    _setBeadsStepDeps({ downloadAndExtractBeads, verifyBeads } as any);

    await expect(runInstall([])).resolves.toBeUndefined();

    expect(downloadAndExtractBeads).not.toHaveBeenCalled();
    expect(verifyBeads).not.toHaveBeenCalled();

    const logs = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    // The step still announces itself (step numbering stays contiguous), it just
    // does nothing -- and it must NOT become fatal merely because it was gated off.
    expect(logs).toContain('Installing Beads task tracker...');
    expect(logs).toMatch(/Beads:\s+not available/);
  });

  it('prints contiguous [n/total] step labels with the beads step included', async () => {
    _setBeadsStepDeps({
      downloadAndExtractBeads: vi.fn().mockResolvedValue(BEADS_PATH),
      verifyBeads: vi.fn().mockResolvedValue('1.3.0'),
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

    const totals = new Set(parsed.map(p => p.total));
    expect(totals.size).toBe(1);

    const ns = parsed.map(p => p.n).sort((a, b) => a - b);
    expect(ns).toEqual(Array.from({ length: ns.length }, (_, i) => i + 1));

    const beadsLine = parsed.find(p => p.line.includes('Installing Beads task tracker'));
    expect(beadsLine).toBeDefined();
  });

  it('leaves the dolt step non-fatal: a REAL injected dolt failure still only warns and the install succeeds', async () => {
    // Guards the deliberate asymmetry from the other side -- making beads fatal
    // must not have made dolt fatal too. An earlier version of this test left
    // the dolt step GATED OFF, so it never induced a dolt failure at all and
    // only asserted the gated-off "not available" line -- the name overclaimed
    // what was actually exercised. It now opts the dolt step IN
    // (APRA_FLEET_ENABLE_DOLT_INSTALL=1) and injects a REJECTING
    // downloadAndExtractDolt through the dolt step-deps seam, so the failure
    // path is genuinely taken: it must warn, leave dolt "not available", and
    // still let the install finish successfully with beads installed.
    process.env.APRA_FLEET_ENABLE_DOLT_INSTALL = '1';
    const downloadAndExtractDolt = vi.fn().mockRejectedValue(new Error('dolt mirror unreachable'));
    _setDoltStepDeps({ downloadAndExtractDolt, verifyDolt: vi.fn() } as any);
    _setBeadsStepDeps({
      downloadAndExtractBeads: vi.fn().mockResolvedValue(BEADS_PATH),
      verifyBeads: vi.fn().mockResolvedValue('1.3.0'),
    } as any);

    await expect(runInstall([])).resolves.toBeUndefined();

    // The dolt failure really happened (not skipped by the gate) ...
    expect(downloadAndExtractDolt).toHaveBeenCalledTimes(1);
    const warns = warnSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(warns).toMatch(/Dolt install skipped -- dolt mirror unreachable/);
    // ... and was NON-FATAL: no error-level abort, install resolved, beads fine.
    const errors = errorSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(errors).not.toMatch(/Dolt/i);

    const logs = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logs).toMatch(/Dolt:\s+not available/);
    expect(logs).toMatch(/Beads:\s+1\.3\.0/);
    expect(logs).toContain('installed successfully');
  });
});
