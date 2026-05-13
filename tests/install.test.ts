import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runInstall, installGbrain, _setSeaOverride, _setManifestOverride } from '../src/cli/install.js';

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

describe('installGbrain()', () => {
  const mockHome = '/mock/home';
  const gbrainDir = path.join(mockHome, 'gbrain');

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHome);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('skips with warning when bun not found', () => {
    vi.mocked(execFileSync).mockImplementation((cmd: any) => {
      if (cmd === 'bun') throw new Error('bun: command not found');
      return undefined as any;
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    installGbrain();

    const warns = warnSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(warns).toContain('bun not found');

    // git clone should not be called
    const cloneCall = vi.mocked(execFileSync).mock.calls.find(
      c => c[0] === 'git' && Array.isArray(c[1]) && c[1].includes('clone')
    );
    expect(cloneCall).toBeUndefined();
  });

  it('skips with "already installed" when gbrain --version succeeds', () => {
    // bun --version succeeds; gbrainDir exists; gbrain --version succeeds
    vi.mocked(fs.existsSync).mockImplementation((p: any) => p.toString() === gbrainDir);
    vi.mocked(execFileSync).mockReturnValue('1.0.0\n' as any);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    installGbrain();

    const logs = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logs).toContain('already installed');

    // git clone should not be called
    const cloneCall = vi.mocked(execFileSync).mock.calls.find(
      c => c[0] === 'git' && Array.isArray(c[1]) && c[1].includes('clone')
    );
    expect(cloneCall).toBeUndefined();
  });

  it('calls git clone when gbrainDir does not exist', () => {
    // bun --version succeeds; gbrainDir does NOT exist
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(execFileSync).mockReturnValue(undefined as any);

    installGbrain();

    const cloneCall = vi.mocked(execFileSync).mock.calls.find(
      c => c[0] === 'git' && Array.isArray(c[1]) && c[1].includes('clone')
    );
    expect(cloneCall).toBeDefined();
    expect(cloneCall![1]).toContain(gbrainDir);
  });

  it('calls bun install and bun link after cloning', () => {
    // bun --version succeeds; gbrainDir does NOT exist
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(execFileSync).mockReturnValue(undefined as any);

    installGbrain();

    const bunInstallCall = vi.mocked(execFileSync).mock.calls.find(
      c => c[0] === 'bun' && Array.isArray(c[1]) && c[1][0] === 'install'
    );
    expect(bunInstallCall).toBeDefined();

    const bunLinkCall = vi.mocked(execFileSync).mock.calls.find(
      c => c[0] === 'bun' && Array.isArray(c[1]) && c[1][0] === 'link'
    );
    expect(bunLinkCall).toBeDefined();
  });
});

describe('--with-gbrain flag parsing', () => {
  it('--with-gbrain is in knownFlagExact (no unknown flag error)', async () => {
    // Minimal setup to get past flag validation — we just want to confirm no process.exit(1) for unknown flag
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
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(execFileSync).mockReturnValue(undefined as any);

    // Should not throw or call process.exit with error
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    await runInstall(['--with-gbrain']);
    // process.exit(1) should NOT have been called (unknown flag path)
    const errorExits = exitSpy.mock.calls.filter(c => c[0] === 1);
    expect(errorExits).toHaveLength(0);

    exitSpy.mockRestore();
    _setSeaOverride(null);
    _setManifestOverride(null);
  });
});
