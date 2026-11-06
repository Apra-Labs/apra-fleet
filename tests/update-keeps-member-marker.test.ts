/**
 * `apra-fleet update` on a member install: what it spawns, in a real temp data
 * dir, with the download and the spawn stubbed. A member keeps --member, so the
 * installer keeps the member-install marker; tests/install-member.test.ts runs
 * those same arguments through the real installer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: mockSpawn,
}));
vi.mock('../src/cli/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/cli/config.js')>()),
  readInstallConfig: () => ({ providers: { claude: { skill: 'all', workflowsMode: 'all' } } }),
}));
vi.mock('../src/version.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/version.js')>()),
  serverVersion: '0.0.1',
}));

import { _setSeaOverride } from '../src/cli/install.js';
import { clearMemberInstallMarker, writeMemberInstallMarker } from '../src/cli/install-guard.js';
import { runUpdate } from '../src/cli/update.js';
import { memberInstallArgs } from '../src/services/member-fleet-install.js';

const savedDataDir = process.env.APRA_FLEET_DATA_DIR;
let dataDir: string;

function stubRelease(): void {
  const platform = process.platform === 'win32' ? 'win-x64' : process.platform === 'darwin' ? 'darwin-arm64' : 'linux-x64';
  const assetName = `apra-fleet-installer-${platform}${process.platform === 'win32' ? '.exe' : ''}`;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('api.github.com')) {
      return { ok: true, json: async () => ({ tag_name: 'v99.0.0', assets: [{ name: assetName, browser_download_url: 'https://example.test/installer' }] }) };
    }
    return { body: new Blob(['x']).stream() };
  }));
}

async function spawnedArgs(): Promise<string[]> {
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
  await runUpdate();
  exit.mockRestore();
  expect(mockSpawn).toHaveBeenCalledTimes(1);
  return mockSpawn.mock.calls[0][1] as string[];
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-marker-'));
  process.env.APRA_FLEET_DATA_DIR = dataDir;
  mockSpawn.mockReset();
  mockSpawn.mockReturnValue({ unref: () => {} });
  stubRelease();
  _setSeaOverride(true);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  _setSeaOverride(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (savedDataDir === undefined) delete process.env.APRA_FLEET_DATA_DIR;
  else process.env.APRA_FLEET_DATA_DIR = savedDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('apra-fleet update', () => {
  it('on a member install runs the member install, so the marker stays', async () => {
    writeMemberInstallMarker('test', 7523);
    expect(await spawnedArgs()).toEqual(memberInstallArgs('claude'));
  });

  it('on a full install runs the full install, as before', async () => {
    clearMemberInstallMarker();
    expect(await spawnedArgs()).toEqual(['install', '--force', '--llm', 'claude', '--skill', 'all', '--workflows', 'all']);
  });
});
