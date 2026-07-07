import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
const configPath = path.join(mockHome, '.apra-fleet', 'data', 'install-config.json');

function makeFsMock() {
  vi.mocked(fs.existsSync).mockImplementation((p: any) => {
    const ps = p.toString();
    if (ps.includes('version.json')) return true;
    if (ps.includes('hooks-config.json')) return true;
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
}

describe('install config persistence (T5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHome);
    makeFsMock();
    _setSeaOverride(false); // Dev mode is fine for these tests
    _setManifestOverride({ version: '0.1.0', hooks: {}, scripts: {}, skills: {}, fleetSkills: {} });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    _setSeaOverride(null);
    _setManifestOverride(null);
  });

  it('writes default config when no flags provided', async () => {
    await runInstall([]);

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      configPath,
      expect.stringContaining('"claude":'),
      { mode: 0o600 }
    );
    const writeCall = vi.mocked(fs.writeFileSync).mock.calls.find(c => c[0] === configPath);
    const data = JSON.parse(writeCall![1] as string);
    expect(data.providers.claude.skill).toBe('all');
    expect(data.providers.claude.installedAt).toBeDefined();
  });

  it('writes custom config with --llm and --skill flags', async () => {
    await runInstall(['--llm', 'gemini', '--skill', 'none']);

    const writeCall = vi.mocked(fs.writeFileSync).mock.calls.find(c => c[0] === configPath);
    const data = JSON.parse(writeCall![1] as string);
    expect(data.providers.gemini.skill).toBe('none');
  });

  it('handles --llm=value and --no-skill shorthand', async () => {
    await runInstall(['--llm=codex', '--no-skill']);

    const writeCall = vi.mocked(fs.writeFileSync).mock.calls.find(c => c[0] === configPath);
    const data = JSON.parse(writeCall![1] as string);
    expect(data.providers.codex.skill).toBe('none');
  });

  it('persists specific skill mode (fleet)', async () => {
    await runInstall(['--skill', 'fleet']);

    const writeCall = vi.mocked(fs.writeFileSync).mock.calls.find(c => c[0] === configPath);
    const data = JSON.parse(writeCall![1] as string);
    expect(data.providers.claude.skill).toBe('fleet');
  });
});

describe('install step 8 — Beads task tracker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/mock/home');
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (ps.includes('version.json')) return true;
      if (ps.includes('hooks-config.json')) return true;
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
    _setSeaOverride(false);
    _setManifestOverride({ version: '0.1.0', hooks: {}, scripts: {}, skills: {}, fleetSkills: {} });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    _setSeaOverride(null);
    _setManifestOverride(null);
  });

  it('installs Beads when bd not found — step appears in output', async () => {
    // First call: bd --version throws (not installed); second call: npm install succeeds
    vi.mocked(execFileSync)
      .mockImplementationOnce(() => { throw new Error('bd: command not found'); })
      .mockImplementation(() => undefined as any);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runInstall([]);

    const logs = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logs).toContain('Installing Beads task tracker...');

    logSpy.mockRestore();
  });

  it('skips npm install when bd is already installed', async () => {
    // bd --version succeeds — already installed
    vi.mocked(execFileSync).mockReturnValue('bd 1.2.3\n' as any);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runInstall([]);

    const logs = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logs).toContain('Installing Beads task tracker...');

    // npm install -g @beads/bd should NOT have been called
    const npmCall = vi.mocked(execFileSync).mock.calls.find(
      c => c[0] === 'npm' && Array.isArray(c[1]) && c[1].includes('@beads/bd')
    );
    expect(npmCall).toBeUndefined();

    logSpy.mockRestore();
  });

  it('warns non-fatally when npm install fails', async () => {
    // bd --version throws, then npm install also throws
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('npm: not found'); });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Should not throw
    await expect(runInstall([])).resolves.toBeUndefined();

    const warns = warnSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(warns).toContain('Beads install skipped');

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

// T3.4 (F9b, D8): installer copies the repo's committed
// .fleet/kb-canonical-global.json (when present) into the shared global KB
// data dir so every project on the machine can see it.
describe('install step 9 -- global bible copy (T3.4, F9b, D8)', () => {
  // FLEET_DIR (src/paths.ts) resolves from APRA_FLEET_DATA_DIR (set by
  // tests/setup.ts to a real tmp dir), NOT the mocked os.homedir() -- the env
  // var takes precedence in paths.ts's own resolution order.
  const globalBibleDestDir = path.join(process.env.APRA_FLEET_DATA_DIR!, 'knowledge', 'global');
  const globalBibleDestPath = path.join(globalBibleDestDir, 'kb-canonical-global.json');
  const globalBibleSrcPath = path.join(process.cwd(), '.fleet', 'kb-canonical-global.json');

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHome);
    makeFsMock();
    _setSeaOverride(false);
    _setManifestOverride({ version: '0.1.0', hooks: {}, scripts: {}, skills: {}, fleetSkills: {} });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    _setSeaOverride(null);
    _setManifestOverride(null);
  });

  it('file present -> copied to the shared global KB data dir (content equality via copyFileSync args)', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (ps.includes('version.json')) return true;
      if (ps.includes('hooks-config.json')) return true;
      if (ps === globalBibleSrcPath) return true;
      return false;
    });

    await runInstall([]);

    const copyCall = vi.mocked(fs.copyFileSync).mock.calls.find(c => c[0] === globalBibleSrcPath);
    expect(copyCall).toBeDefined();
    expect(copyCall![1]).toBe(globalBibleDestPath);
  });

  it('absent -> install path unaffected (no copy attempted, install still succeeds)', async () => {
    // Default makeFsMock() already returns false for kb-canonical-global.json.
    await expect(runInstall([])).resolves.toBeUndefined();

    const copyCall = vi.mocked(fs.copyFileSync).mock.calls.find(c => c[0] === globalBibleSrcPath);
    expect(copyCall).toBeUndefined();
  });

  it('target dir is auto-created when the source bible is present', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (ps.includes('version.json')) return true;
      if (ps.includes('hooks-config.json')) return true;
      if (ps === globalBibleSrcPath) return true;
      return false;
    });

    await runInstall([]);

    const mkdirCall = vi.mocked(fs.mkdirSync).mock.calls.find(c => c[0] === globalBibleDestDir);
    expect(mkdirCall).toBeDefined();
    expect(mkdirCall![1]).toEqual({ recursive: true });
  });

  it('copy failure does not throw out of the install step (non-fatal, warns)', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (ps.includes('version.json')) return true;
      if (ps.includes('hooks-config.json')) return true;
      if (ps === globalBibleSrcPath) return true;
      return false;
    });
    vi.mocked(fs.copyFileSync).mockImplementation((src: any) => {
      if (src === globalBibleSrcPath) throw new Error('EACCES: permission denied');
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(runInstall([])).resolves.toBeUndefined();

    const warns = warnSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(warns).toContain('Global knowledge bible copy skipped');
  });
});
