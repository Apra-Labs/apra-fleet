import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runUpdate } from '../src/cli/update.js';
import { serverVersion } from '../src/version.js';

vi.mock('node:fs');
vi.mock('node:os');
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
      end: vi.fn(),
    } as any);

    // Default fs behavior
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ llm: 'gemini', skill: 'pm' }));
    vi.mocked(fs.chmodSync).mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('already up to date — prints message and exits', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: serverVersion.split('_')[0] }),
    } as any);

    await runUpdate();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('is up to date.'));
    expect(fetch).toHaveBeenCalledTimes(1); // Only check, no download
    expect(spawn).not.toHaveBeenCalled();
  });

  it('newer available — downloads and spawns installer', async () => {
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
      ['install', '--llm', 'gemini', '--skill', 'pm'],
      expect.objectContaining({ detached: true })
    );
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('missing install-config.json — uses defaults with warning', async () => {
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
      ['install', '--llm', 'claude', '--skill', 'all'],
      expect.anything()
    );
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('invalid install-config.json — uses defaults with warning', async () => {
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
      ['install', '--llm', 'claude', '--skill', 'all'],
      expect.anything()
    );
    expect(process.exit).toHaveBeenCalledWith(0);
  });
});
