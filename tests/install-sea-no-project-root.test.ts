/**
 * Regression test: standalone SEA binary install must not crash during the
 * PM skill step (step 7/14) when there is no repo checkout anywhere on disk.
 *
 * PR #305 added a repo-root skills/pm/ directory and had install.ts overlay
 * it onto the installed PM skill in SEA mode by calling findProjectRoot() --
 * unaware that the actual PM skill source of truth had already moved to
 * packages/apra-fleet-se/apra-pm/skills/pm/ in an earlier restructure. A
 * third-party user who just downloaded apra-fleet-installer-*.exe from CI has
 * no repo checkout anywhere on their machine, so version.json (and everything
 * else findProjectRoot() looks for) genuinely does not exist -- this threw
 * "Cannot find project root (version.json not found)" and aborted the whole
 * install. Fixed by deleting the repo-root skills/pm/ directory (its content
 * now lives at the correct package path) and removing the now-dead overlay
 * call entirely.
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
