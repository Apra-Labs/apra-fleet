import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
