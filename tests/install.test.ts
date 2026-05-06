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
      JSON.stringify({ llm: 'claude', skill: 'all' }, null, 2),
      { mode: 0o600 }
    );
  });

  it('writes custom config with --llm and --skill flags', async () => {
    await runInstall(['--llm', 'gemini', '--skill', 'none']);

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      configPath,
      JSON.stringify({ llm: 'gemini', skill: 'none' }, null, 2),
      { mode: 0o600 }
    );
  });

  it('handles --llm=value and --no-skill shorthand', async () => {
    await runInstall(['--llm=codex', '--no-skill']);

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      configPath,
      JSON.stringify({ llm: 'codex', skill: 'none' }, null, 2),
      { mode: 0o600 }
    );
  });

  it('persists specific skill mode (fleet)', async () => {
    await runInstall(['--skill', 'fleet']);

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      configPath,
      JSON.stringify({ llm: 'claude', skill: 'fleet' }, null, 2),
      { mode: 0o600 }
    );
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

  it('installs Beads when bd not found — step [8/8] appears in output', async () => {
    // First call: bd --version throws (not installed); second call: npm install succeeds
    vi.mocked(execFileSync)
      .mockImplementationOnce(() => { throw new Error('bd: command not found'); })
      .mockImplementation(() => undefined as any);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runInstall([]);

    const logs = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logs).toContain('[8/8] Installing Beads task tracker...');

    logSpy.mockRestore();
  });

  it('skips npm install when bd is already installed', async () => {
    // bd --version succeeds — already installed
    vi.mocked(execFileSync).mockReturnValue('bd 1.2.3\n' as any);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runInstall([]);

    const logs = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logs).toContain('[8/8] Installing Beads task tracker...');

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
