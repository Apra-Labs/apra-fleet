import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runUpdate } from '../src/cli/update.js';
import { serverVersion } from '../src/version.js';

// Simulate SEA mode so the existing update tests exercise the binary-download path.
// The npm-redirect path is tested separately in tests/update-npm.test.ts.
vi.mock('../src/cli/install.js', () => ({
  isSea: vi.fn(() => true),
  isNpmGlobalInstall: vi.fn(() => false),
  _setSeaOverride: vi.fn(),
}));

vi.mock('node:fs');
vi.mock('node:os', () => {
  const mockOs = {
    homedir: vi.fn(() => '/mock/home'),
    tmpdir: vi.fn(() => '/tmp'),
    platform: vi.fn(() => 'linux'),
  };
  return {
    ...mockOs,
    default: mockOs,
  };
});
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({
    unref: vi.fn(),
  })),
}));

describe('runUpdate (T6)', () => {
  const mockTmpDir = '/tmp';
  const mockConfigPath = '/mock/home/.apra-fleet/data/install-config.json';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
    vi.mocked(os.tmpdir).mockReturnValue(mockTmpDir);
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // Mock fs.createWriteStream
    vi.mocked(fs.createWriteStream).mockReturnValue({
      write: vi.fn(),
      end: vi.fn(function(this: any) {
        if (this._onFinish) this._onFinish();
      }),
      on: vi.fn(function(this: any, event, cb) {
        if (event === 'finish') this._onFinish = cb;
      }),
    } as any);

    // Default fs behavior
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ llm: 'gemini', skill: 'pm' }));
    vi.mocked(fs.chmodSync).mockImplementation(() => {});
    vi.mocked(fs.renameSync).mockImplementation(() => undefined as any);
    vi.mocked(fs.rmSync).mockImplementation(() => undefined as any);
    vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
    vi.mocked(fs.writeFileSync).mockImplementation(() => undefined as any);
    vi.mocked(fs.readdirSync).mockReturnValue([] as any);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('already up to date -- prints message and exits', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: serverVersion.split('_')[0] }),
    } as any);

    await runUpdate();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('is up to date.'));
    expect(fetch).toHaveBeenCalledTimes(1); // Only check, no download
    expect(spawn).not.toHaveBeenCalled();
  });

  it('newer available -- downloads and spawns installer', async () => {
    const newerVersion = 'v99.9.9';
    const assetUrl = 'https://example.com/installer.exe';
    
    // Mock API response
    vi.mocked(fetch).mockImplementation(async (url: any) => {
      if (url.toString().includes('releases/latest')) {
        return {
          ok: true,
          json: async () => ({
            tag_name: newerVersion,
            assets: [
              { name: `apra-fleet-installer-linux-x64`, browser_download_url: assetUrl }
            ]
          }),
        } as any;
      }
      if (url === assetUrl) {
        return {
          ok: true,
          body: {
            pipeTo: async () => {}
          }
        } as any;
      }
      return { ok: false } as any;
    });

    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    await runUpdate();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining(`Updating to ${newerVersion}`));
    expect(fetch).toHaveBeenCalledWith(assetUrl);
    
    // Check installer spawn
    expect(spawn).toHaveBeenCalledWith(
      expect.stringContaining('apra-fleet-installer-linux-x64'),
      ['install', '--force', '--llm', 'gemini', '--skill', 'pm', '--workflows', 'all'],
      expect.objectContaining({ detached: true })
    );
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('missing install-config.json -- uses defaults with warning', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    vi.mocked(fetch).mockImplementation(async (url: any) => {
      if (url.toString().includes('releases/latest')) {
        return {
          ok: true,
          json: async () => ({
            tag_name: 'v99.9.9',
            assets: [{ name: `apra-fleet-installer-linux-x64`, browser_download_url: 'http://foo' }]
          }),
        } as any;
      }
      return {
        ok: true,
        body: { pipeTo: async () => {} }
      } as any;
    });

    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    await runUpdate();

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('install-config.json missing'));
    expect(spawn).toHaveBeenCalledWith(
      expect.anything(),
      ['install', '--force', '--llm', 'claude', '--skill', 'all', '--workflows', 'all'],
      expect.anything()
    );
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('invalid install-config.json -- uses defaults with warning', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('invalid json');

    vi.mocked(fetch).mockImplementation(async (url: any) => {
      if (url.toString().includes('releases/latest')) {
        return {
          ok: true,
          json: async () => ({
            tag_name: 'v99.9.9',
            assets: [{ name: `apra-fleet-installer-linux-x64`, browser_download_url: 'http://foo' }]
          }),
        } as any;
      }
      return {
        ok: true,
        body: { pipeTo: async () => {} }
      } as any;
    });

    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    await runUpdate();

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Could not parse install-config.json'));
    expect(spawn).toHaveBeenCalledWith(
      expect.anything(),
      ['install', '--force', '--llm', 'claude', '--skill', 'all', '--workflows', 'all'],
      expect.anything()
    );
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  // apra-fleet-7pm.10 -- read-back of persisted workflowsMode threaded into the
  // re-invoked install --force so a prior `--workflows none` choice survives an
  // update instead of silently reverting to the `all` default.
  it('install-config.json with workflowsMode "none" -- threads --workflows none into the re-invoked install', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      providers: {
        gemini: { skill: 'pm', workflowsMode: 'none', installedAt: '2026-01-01T00:00:00.000Z' },
      },
    }));

    vi.mocked(fetch).mockImplementation(async (url: any) => {
      if (url.toString().includes('releases/latest')) {
        return {
          ok: true,
          json: async () => ({
            tag_name: 'v99.9.9',
            assets: [{ name: `apra-fleet-installer-linux-x64`, browser_download_url: 'http://foo' }]
          }),
        } as any;
      }
      return { ok: true, body: { pipeTo: async () => {} } } as any;
    });

    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    await runUpdate();

    expect(spawn).toHaveBeenCalledWith(
      expect.anything(),
      ['install', '--force', '--llm', 'gemini', '--skill', 'pm', '--workflows', 'none'],
      expect.anything()
    );
  });

  it('install-config.json with workflowsMode field absent (older format) -- defaults to --workflows all', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      providers: {
        gemini: { skill: 'pm', installedAt: '2026-01-01T00:00:00.000Z' },
      },
    }));

    vi.mocked(fetch).mockImplementation(async (url: any) => {
      if (url.toString().includes('releases/latest')) {
        return {
          ok: true,
          json: async () => ({
            tag_name: 'v99.9.9',
            assets: [{ name: `apra-fleet-installer-linux-x64`, browser_download_url: 'http://foo' }]
          }),
        } as any;
      }
      return { ok: true, body: { pipeTo: async () => {} } } as any;
    });

    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    await runUpdate();

    expect(spawn).toHaveBeenCalledWith(
      expect.anything(),
      ['install', '--force', '--llm', 'gemini', '--skill', 'pm', '--workflows', 'all'],
      expect.anything()
    );
  });
});
