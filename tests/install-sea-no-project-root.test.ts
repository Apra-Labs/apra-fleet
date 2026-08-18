/**
 * Regression test: standalone SEA binary install must not crash while
 * overlaying the repo-root skills/pm/ additions during the PM skill step.
 *
 * That overlay is only possible when a git checkout happens to sit on disk
 * next to the SEA binary; a third-party user who just downloaded
 * apra-fleet-installer-*.exe from CI has no such checkout anywhere on their
 * machine, so version.json (and everything else findProjectRoot() looks for)
 * genuinely does not exist. Before the fix, this threw
 * "Cannot find project root (version.json not found)" partway through
 * install (step 7/14, "Installing PM skill...") and aborted the whole run.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
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

describe('SEA install with no project root on disk (apra-fleet-installer.exe scenario)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHome);

    // Nothing resembling a repo checkout exists anywhere -- version.json is
    // never found, no matter how far up findProjectRoot() walks.
    const fileState = new Map<string, string>();
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (ps.includes('version.json')) return false;
      if (ps.includes('hooks-config.json')) return true;
      if (fileState.has(ps)) return true;
      return false;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (fileState.has(ps)) return fileState.get(ps)!;
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
    vi.mocked(fs.rmSync).mockImplementation(() => {});

    vi.mocked(execSync).mockImplementation((cmd: any) => {
      const c = cmd.toString();
      if (c === 'pgrep -x apra-fleet') throw Object.assign(new Error('no match'), { status: 1 });
      return '' as any;
    });

    _setSeaOverride(true);
    _setManifestOverride({
      version: '0.1.0',
      hooks: {},
      scripts: {},
      skills: {},
      fleetSkills: {},
      agents: {},
      workflows: {},
    });
  });

  afterEach(() => {
    _setSeaOverride(null);
    _setManifestOverride(null);
  });

  it('installs the PM skill from manifest assets without throwing', async () => {
    await expect(runInstall(['install', '--force'])).resolves.not.toThrow();
  });
});
