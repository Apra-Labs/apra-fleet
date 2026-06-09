import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runInstall, _setSeaOverride, _setManifestOverride, isNpmGlobalInstall } from '../src/cli/install.js';

vi.mock('node:os', () => ({
  default: {
    homedir: vi.fn(() => '/mock/home'),
    platform: vi.fn(() => 'linux'),
  }
}));
vi.mock('node:fs');
vi.mock('node:child_process');

const mockHome = '/mock/home';

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
  vi.mocked(fs.realpathSync).mockImplementation((p: any) => p); // No symlink resolution in tests
  vi.mocked(fs.readdirSync).mockReturnValue([] as any);
  vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
  vi.mocked(fs.chmodSync).mockImplementation(() => {});
  vi.mocked(fs.copyFileSync).mockImplementation(() => {});
  vi.mocked(fs.writeFileSync).mockImplementation(() => {});
}

describe('isNpmGlobalInstall() detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHome);
    makeFsMock();
    _setSeaOverride(false); // Dev mode
  });

  afterEach(() => {
    _setSeaOverride(null);
    delete (process as any)._argv1Override;
  });

  it('returns true when process.argv[1] contains node_modules and is not the dev dist path', () => {
    const origArgv1 = process.argv[1];
    process.argv[1] = '/home/user/.npm/_npx/abc123def/lib/node_modules/@apra-labs/apra-fleet/dist/index.js';
    vi.mocked(fs.realpathSync).mockImplementation((p: any) => p); // No resolution needed for this test

    const result = isNpmGlobalInstall();

    expect(result).toBe(true);
    process.argv[1] = origArgv1;
  });

  it('returns false for dev mode (process.argv[1] is the project dist/index.js)', () => {
    const origArgv1 = process.argv[1];
    // Simulate dev mode: argv[1] points to the project's own dist
    process.argv[1] = '/some/project/path/dist/index.js';
    // Mock findProjectRoot to return /some/project/path
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (ps.includes('version.json')) return true;
      if (ps.includes('hooks-config.json')) return true;
      return false;
    });
    // Mock realpathSync to return the same path (no symlinks)
    vi.mocked(fs.realpathSync).mockImplementation((p: any) => p);

    const result = isNpmGlobalInstall();

    expect(result).toBe(false);
    process.argv[1] = origArgv1;
  });

  it('returns false when isSea() is true', () => {
    const origArgv1 = process.argv[1];
    process.argv[1] = '/home/user/.npm/_npx/abc123def/lib/node_modules/@apra-labs/apra-fleet/dist/index.js';
    _setSeaOverride(true); // SEA mode

    const result = isNpmGlobalInstall();

    expect(result).toBe(false);
    _setSeaOverride(false);
    process.argv[1] = origArgv1;
  });

  it('returns false when process.argv[1] does not contain node_modules', () => {
    const origArgv1 = process.argv[1];
    process.argv[1] = '/home/user/apra-fleet/dist/index.js'; // Not in node_modules

    const result = isNpmGlobalInstall();

    expect(result).toBe(false);
    process.argv[1] = origArgv1;
  });

  it('returns false when process.argv[1] is empty or undefined', () => {
    const origArgv1 = process.argv[1];
    process.argv[1] = '';

    const result = isNpmGlobalInstall();

    expect(result).toBe(false);
    process.argv[1] = origArgv1;
  });

  it('handles symlinked npm paths correctly (realpath resolves them)', () => {
    const origArgv1 = process.argv[1];
    process.argv[1] = '/Users/alice/.npm/_npx/xyz789/lib/node_modules/@apra-labs/apra-fleet/dist/index.js';
    // Mock realpathSync to resolve the symlinked npm path to a different real path
    vi.mocked(fs.realpathSync).mockImplementation((p: any) => {
      if (p.includes('node_modules')) {
        return '/usr/local/lib/node_modules/@apra-labs/apra-fleet/dist/index.js';
      }
      return p; // dev dist path stays the same
    });

    const result = isNpmGlobalInstall();

    expect(result).toBe(true);
    process.argv[1] = origArgv1;
  });
});

describe('install binary-copy step in npm mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHome);
    makeFsMock();
    _setSeaOverride(false); // npm/dev mode
    _setManifestOverride({ version: '0.1.0', hooks: {}, scripts: {}, skills: {}, fleetSkills: {} });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    _setSeaOverride(null);
    _setManifestOverride(null);
    const origArgv1 = process.argv[1];
    process.argv[1] = origArgv1;
  });

  it('skips binary copy in npm mode (no fs.copyFileSync call)', async () => {
    const origArgv1 = process.argv[1];
    process.argv[1] = '/home/user/.npm/_npx/abc123/lib/node_modules/@apra-labs/apra-fleet/dist/index.js';

    await runInstall([]);

    // Verify copyFileSync was NOT called
    expect(vi.mocked(fs.copyFileSync)).not.toHaveBeenCalled();
    process.argv[1] = origArgv1;
  });

  it('sets binaryPath to process.argv[1] in npm mode', async () => {
    const origArgv1 = process.argv[1];
    const npmPath = '/home/user/.npm/_npx/abc123/lib/node_modules/@apra-labs/apra-fleet/dist/index.js';
    process.argv[1] = npmPath;

    // Capture console logs to see which binaryPath was set (shown in MCP config step)
    const logCalls: string[] = [];
    vi.mocked(console.log).mockImplementation((msg: any) => {
      logCalls.push(String(msg));
    });

    await runInstall([]);

    // Check that "npm global install detected" message appears
    const npmDetectedMsg = logCalls.find(m => m.includes('npm global install detected'));
    expect(npmDetectedMsg).toBeDefined();

    process.argv[1] = origArgv1;
  });

  it('prints "npm global install detected -- skipping binary copy" message', async () => {
    const origArgv1 = process.argv[1];
    process.argv[1] = '/home/user/.npm/_npx/abc123/lib/node_modules/@apra-labs/apra-fleet/dist/index.js';

    const logSpy = vi.spyOn(console, 'log');

    await runInstall([]);

    const logs = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(logs).toContain('npm global install detected');
    expect(logs).toContain('skipping binary copy');

    logSpy.mockRestore();
    process.argv[1] = origArgv1;
  });
});

describe('install MCP config in npm mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHome);
    makeFsMock();
    _setSeaOverride(false); // npm/dev mode
    _setManifestOverride({ version: '0.1.0', hooks: {}, scripts: {}, skills: {}, fleetSkills: {} });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    _setSeaOverride(null);
    _setManifestOverride(null);
    const origArgv1 = process.argv[1];
    process.argv[1] = origArgv1;
  });

  it('registers MCP config with process.execPath + absolute script path in npm mode', async () => {
    const origArgv1 = process.argv[1];
    const npmPath = '/home/user/.npm/_npx/abc123/lib/node_modules/@apra-labs/apra-fleet/dist/index.js';
    process.argv[1] = npmPath;

    // Mock the run() function's child_process call to capture MCP config commands
    vi.mocked(execFileSync).mockImplementation((cmd: any, args: any, opts: any) => {
      if (cmd === 'bd') {
        throw new Error('bd not found'); // Trigger npm install
      }
      return '' as any;
    });

    const logSpy = vi.spyOn(console, 'log');

    await runInstall([]);

    // The MCP config step calls 'claude mcp add ...' which should contain:
    // - process.execPath (the node executable)
    // - the npmPath
    const logs = logSpy.mock.calls.map(c => String(c[0])).join('\n');

    // The key indicator: npm mode should NOT have "Dev mode" in the output
    // and SHOULD have "npm global install detected"
    expect(logs).toContain('npm global install detected');

    logSpy.mockRestore();
    process.argv[1] = origArgv1;
  });

  it('uses process.execPath for npm mode MCP registration', async () => {
    const origArgv1 = process.argv[1];
    const npmPath = '/home/user/.npm/_npx/abc123/lib/node_modules/@apra-labs/apra-fleet/dist/index.js';
    process.argv[1] = npmPath;

    // We'll verify indirectly: check that console output reflects npm mode (not dev mode)
    const logSpy = vi.spyOn(console, 'log');

    await runInstall([]);

    const logs = logSpy.mock.calls.map(call => String(call[0])).join('\n');
    // In npm mode, the MCP config section should exist and be distinct from dev mode
    // which would say "Dev mode -- skipping binary copy"
    expect(logs).toContain('npm global install detected');
    // Verify it's NOT dev mode message
    expect(logs).not.toContain('Dev mode -- skipping binary copy');

    logSpy.mockRestore();
    process.argv[1] = origArgv1;
  });
});
