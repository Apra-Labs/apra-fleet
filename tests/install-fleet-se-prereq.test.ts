import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import {
  runInstall,
  checkFleetSePrereqs,
  _setSeaOverride,
  _setManifestOverride,
  _setFleetSePrereqProbes,
  _resetFleetSePrereqProbes,
  _realFleetSePrereqProbes,
} from '../src/cli/install.js';

// apra-fleet-i9ag.13 -- fleet-se (fleet-sprint, supervisor, bd) requires a
// system Node.js >= 22.16.0 and npm. runInstall must fail loudly, up front,
// before stopping/writing anything, when workflows are being installed and
// either is missing. Home, fs and child_process are fully mocked (same
// sandboxing as install-dolt.test.ts); probes are injected fakes.

vi.mock('node:os', () => ({
  default: {
    homedir: vi.fn(() => '/mock/home'),
    platform: vi.fn(() => 'linux'),
  }
}));
vi.mock('node:fs');
vi.mock('node:child_process');

const BASE_MANIFEST = {
  version: '0.1.0', hooks: {}, scripts: {}, skills: {}, fleetSkills: {}, agents: {}, workflows: {},
};

const probes = (node: string | null, npm: string | null) => ({
  nodeVersion: () => node,
  npmVersion: () => npm,
});

describe('checkFleetSePrereqs', () => {
  it('fails when node is not on PATH', () => {
    const r = checkFleetSePrereqs(probes(null, '10.9.0'));
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['node']);
    expect(r.message).toContain('Node.js not found on PATH');
    expect(r.message).toContain('fleet-se requires Node.js 22.16+ and npm. Install them and re-run, or use --workflows none to install the core only.');
  });

  it('fails when node is 22.15.9', () => {
    const r = checkFleetSePrereqs(probes('v22.15.9', '10.9.0'));
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['node']);
    expect(r.message).toContain('Node.js v22.15.9 found, 22.16.0+ required');
  });

  it('fails when node is 20.x', () => {
    const r = checkFleetSePrereqs(probes('v20.11.0\n', '10.9.0'));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('Node.js v20.11.0 found, 22.16.0+ required');
  });

  it('fails when node version is unparseable', () => {
    expect(checkFleetSePrereqs(probes('garbage', '10.9.0')).ok).toBe(false);
  });

  it('fails when npm is not on PATH', () => {
    const r = checkFleetSePrereqs(probes('v22.16.0', null));
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['npm']);
    expect(r.message).toContain('npm not found on PATH');
  });

  it('reports both causes when node and npm are missing', () => {
    const r = checkFleetSePrereqs(probes(null, null));
    expect(r.missing).toEqual(['node', 'npm']);
    expect(r.message).toContain('Node.js not found on PATH');
    expect(r.message).toContain('npm not found on PATH');
  });

  it('passes with node 22.16.0 and npm', () => {
    expect(checkFleetSePrereqs(probes('v22.16.0', '10.9.0'))).toEqual({ ok: true, missing: [], message: '' });
  });

  it('passes with node 23.0.0 and npm', () => {
    expect(checkFleetSePrereqs(probes('23.0.0', '11.0.0')).ok).toBe(true);
  });

  it('message is ASCII only', () => {
    expect(/^[\x00-\x7F]*$/.test(checkFleetSePrereqs(probes('v20.0.0', null)).message)).toBe(true);
  });
});

describe('real fleet-se prereq probes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('probes node with shell:true, same as npm (node/npm may be .cmd shims on Windows)', () => {
    vi.mocked(execFileSync).mockReturnValue('v22.16.0\n' as any);

    _realFleetSePrereqProbes.nodeVersion();
    _realFleetSePrereqProbes.npmVersion();

    expect(execFileSync).toHaveBeenCalledWith('node', ['--version'], expect.objectContaining({ shell: true }));
    expect(execFileSync).toHaveBeenCalledWith('npm', ['--version'], expect.objectContaining({ shell: true }));
  });
});

describe('runInstall fleet-se prerequisite gate', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/mock/home');
    vi.mocked(fs.existsSync).mockReturnValue(false);
    _setSeaOverride(false);
    _setManifestOverride(BASE_MANIFEST as any);
    process.env.APRA_FLEET_ENABLE_FLEET_SE_PREREQ_CHECK = '1';
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as any);
  });

  afterEach(() => {
    _setSeaOverride(null);
    _setManifestOverride(null);
    _resetFleetSePrereqProbes();
    delete process.env.APRA_FLEET_ENABLE_FLEET_SE_PREREQ_CHECK;
    vi.restoreAllMocks();
  });

  it('exits 1 with the prerequisite message before anything is stopped or written', async () => {
    _setFleetSePrereqProbes(probes('v20.11.0', null));

    await expect(runInstall([])).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errors = errorSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(errors).toContain('Node.js v20.11.0 found, 22.16.0+ required');
    expect(errors).toContain('npm not found on PATH');
    expect(errors).toContain('--workflows none');

    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(fs.copyFileSync).not.toHaveBeenCalled();
    expect(fs.rmSync).not.toHaveBeenCalled();
    expect(execSync).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('skips the check with --workflows none', async () => {
    const nodeVersion = vi.fn(() => null);
    const npmVersion = vi.fn(() => null);
    _setFleetSePrereqProbes({ nodeVersion, npmVersion });
    // The rest of the (fully mocked) install may or may not complete; only the gate matters here.
    await runInstall(['--workflows', 'none']).catch(() => {});

    expect(nodeVersion).not.toHaveBeenCalled();
    expect(npmVersion).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.map(c => c.join(' ')).join('\n')).not.toContain('fleet-se requires');
  });
});
