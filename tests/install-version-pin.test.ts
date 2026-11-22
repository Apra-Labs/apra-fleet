import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  runInstall,
  _setSeaOverride,
  _setManifestOverride,
  _setDoltStepDeps,
  _resetDoltStepDeps,
} from '../src/cli/install.js';
import { BEADS_VERSION, BEADS_PACKAGE } from '../src/cli/beads-pin.js';
import { DOLT_VERSION } from '../src/cli/dolt-install.js';

// The installer's bd / dolt version pin, through runInstall: os/fs/child_process
// are mocked (in-memory, fake HOME under /mock), so nothing real is installed,
// downloaded or written. bd answers through the mocked execFileSync; the Dolt
// download/verify through the _setDoltStepDeps seam.

vi.mock('node:os', () => ({
  default: {
    homedir: vi.fn(() => '/mock/home'),
    platform: vi.fn(() => 'linux'),
    hostname: vi.fn(() => 'pin-test-host'),
  },
}));
vi.mock('node:fs');
vi.mock('node:child_process');

const HOME = '/mock/home';
const BIN_DIR = path.join(HOME, '.apra-fleet', 'bin');
const DOLT_PATH = path.join(BIN_DIR, process.platform === 'win32' ? 'dolt.exe' : 'dolt');
const PINNED_DOLT = DOLT_VERSION.replace(/^v/, '');

let pathBd: string | null;
let existing: Set<string>;

function setup() {
  vi.mocked(fs.existsSync).mockImplementation((p: any) => {
    const ps = p.toString();
    if (ps.includes('version.json') || ps.includes('hooks-config.json')) return true;
    return existing.has(ps);
  });
  vi.mocked(fs.readFileSync).mockImplementation(((p: any) => {
    const ps = p.toString();
    if (ps.includes('version.json')) return JSON.stringify({ version: '0.1.0' });
    if (ps.includes('hooks-config.json')) return JSON.stringify({ hooks: { PostToolUse: [] } });
    return '';
  }) as any);
  vi.mocked(fs.readdirSync).mockReturnValue([] as any);
  vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
  vi.mocked(fs.chmodSync).mockImplementation(() => {});
  vi.mocked(fs.copyFileSync).mockImplementation(() => {});
  vi.mocked(fs.writeFileSync).mockImplementation(() => {});
  vi.mocked(fs.rmSync).mockImplementation(() => undefined as any);
  vi.mocked(execFileSync).mockImplementation(((cmd: string, args: string[]) => {
    if (cmd === 'bd' && args?.[0] === '--version') {
      if (pathBd === null) throw new Error('bd: command not found');
      return pathBd;
    }
    if (cmd === 'npm') throw Object.assign(new Error('npm: command not found'), { code: 'ENOENT' });
    return '';
  }) as any);
}

const logs = () => vi.mocked(console.log).mock.calls.map(c => c.join(' ')).join('\n');
const warns = () => vi.mocked(console.warn).mock.calls.map(c => c.join(' ')).join('\n');
const errors = () => vi.mocked(console.error).mock.calls.map(c => c.join(' ')).join('\n');
const summaryLine = (label: string) => logs().split('\n').find(l => l.trim().startsWith(`${label}:`)) ?? '';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(os.homedir).mockReturnValue(HOME);
  pathBd = `bd version ${BEADS_VERSION} (test)\n`;
  existing = new Set();
  setup();
  _setSeaOverride(false);
  _setManifestOverride({ version: '0.1.0', hooks: {}, scripts: {}, skills: {}, fleetSkills: {}, agents: {}, workflows: {} } as any);
  process.env.APRA_FLEET_ENABLE_DOLT_INSTALL = '1';
  _setDoltStepDeps({
    downloadAndExtractDolt: vi.fn().mockResolvedValue(DOLT_PATH),
    verifyDolt: vi.fn().mockResolvedValue({ version: PINNED_DOLT, serverOk: true }),
  } as any);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = undefined;
});

afterEach(() => {
  _setSeaOverride(null);
  _setManifestOverride(null);
  _resetDoltStepDeps();
  delete process.env.APRA_FLEET_ENABLE_DOLT_INSTALL;
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('install: bd version pin', () => {
  it('bd matching the pinned major.minor: exit code stays 0 and the summary shows the bd version', async () => {
    pathBd = 'bd version 1.3.4 (test)\n';
    await runInstall([]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(summaryLine('Beads')).toContain('bd version 1.3.4');
    expect(warns()).not.toContain('version mismatch');
  });

  it('bd 1.4.0 on PATH: [!] lines name host, found, expected and fix; summary repeats it; exit non-zero; final stderr line names it', async () => {
    pathBd = 'bd version 1.4.0 (newer)\n';
    await runInstall([]);
    expect(process.exitCode).toBe(1);
    const w = warns();
    expect(w).toContain('[!] Beads (bd) version mismatch on pin-test-host');
    expect(w).toContain('found 1.4.0 (PATH)');
    expect(w).toContain(`expected ${BEADS_VERSION}`);
    expect(w).toContain(`[!] Fix: install the pinned ${BEADS_PACKAGE}`);
    const beads = summaryLine('Beads');
    expect(beads).toContain('MISMATCH');
    expect(beads).toContain('found 1.4.0');
    expect(beads).toContain(`expected ${BEADS_VERSION}`);
    expect(beads).toContain(`Fix: install the pinned ${BEADS_PACKAGE}`);
    // The fleet install itself still completed.
    expect(logs()).toContain('installed successfully');
    const lastErr = vi.mocked(console.error).mock.calls.at(-1)?.join(' ') ?? '';
    expect(lastErr).toContain('version mismatch on pin-test-host');
    expect(lastErr).toContain('found 1.4.0');
    // Never touches a bd it does not own: no npm call at all.
    expect(vi.mocked(execFileSync).mock.calls.some(c => c[0] === 'npm')).toBe(false);
  });

  it('bd missing keeps exit 0 with the existing non-fatal warning', async () => {
    pathBd = null;
    await runInstall([]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(warns()).toContain('[!] Beads (bd) NOT installed');
    expect(summaryLine('Beads')).toContain('not available');
    expect(errors()).not.toContain('version mismatch');
  });
});

describe('install: dolt version pin', () => {
  it('a BIN_DIR dolt reporting 2.1.0 is replaced via the pinned download and re-verified', async () => {
    existing.add(DOLT_PATH);
    const downloadAndExtractDolt = vi.fn().mockResolvedValue(DOLT_PATH);
    const verifyDolt = vi.fn()
      .mockResolvedValueOnce({ version: '2.1.0', serverOk: true })
      .mockResolvedValueOnce({ version: PINNED_DOLT, serverOk: true });
    _setDoltStepDeps({ downloadAndExtractDolt, verifyDolt } as any);
    await runInstall([]);
    expect(downloadAndExtractDolt).toHaveBeenCalledTimes(1);
    expect(downloadAndExtractDolt).toHaveBeenCalledWith(BIN_DIR);
    expect(verifyDolt).toHaveBeenCalledTimes(2);
    expect(summaryLine('Dolt')).toContain(PINNED_DOLT);
    expect(summaryLine('Dolt')).not.toContain('MISMATCH');
  });

  it('a failed replacement reports found/expected/fix loudly, never a silent skip', async () => {
    existing.add(DOLT_PATH);
    _setDoltStepDeps({
      downloadAndExtractDolt: vi.fn().mockRejectedValue(new Error('network unreachable')),
      verifyDolt: vi.fn().mockResolvedValue({ version: '2.1.0', serverOk: true }),
    } as any);
    await runInstall([]);
    const w = warns();
    expect(w).toContain('[!] Dolt version mismatch on pin-test-host');
    expect(w).toContain('found 2.1.0');
    expect(w).toContain(`expected ${PINNED_DOLT}`);
    expect(w).toContain('network unreachable');
    expect(w).toContain(`[!] Fix: re-run the install with network access so the pinned dolt ${DOLT_VERSION}`);
    expect(w).not.toContain('Dolt install skipped');
    const dolt = summaryLine('Dolt');
    expect(dolt).toContain('MISMATCH');
    expect(dolt).toContain('found 2.1.0');
    expect(dolt).toContain(`expected ${PINNED_DOLT}`);
  });

  it('a downloaded dolt that still reports another major.minor is a loud mismatch', async () => {
    existing.add(DOLT_PATH);
    _setDoltStepDeps({
      downloadAndExtractDolt: vi.fn().mockResolvedValue(DOLT_PATH),
      verifyDolt: vi.fn().mockResolvedValue({ version: '2.1.0', serverOk: true }),
    } as any);
    await runInstall([]);
    expect(warns()).toContain('the downloaded dolt reports 2.1.0');
    expect(summaryLine('Dolt')).toContain('MISMATCH');
  });
});
