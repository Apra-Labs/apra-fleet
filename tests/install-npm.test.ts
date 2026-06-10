import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
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
  // realpathSync is NOT mocked here: isNpmGlobalInstall() uses a .git-existence check,
  // not a realpath path-comparison. No symlink resolution is performed by the current code.
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

  it('returns true when process.argv[1] contains node_modules and .git is absent at project root', () => {
    // Exercises the decisive .git branch: node_modules present + no .git => npm mode.
    // existsSync returns false for .git (only true for version.json/hooks-config.json),
    // so isNpmGlobalInstall() returns !false = true.
    const origArgv1 = process.argv[1];
    process.argv[1] = '/home/user/.npm/_npx/abc123def/lib/node_modules/@apralabs/apra-fleet/dist/index.js';

    const result = isNpmGlobalInstall();

    expect(result).toBe(true);
    process.argv[1] = origArgv1;
  });

  it('returns false for dev mode (process.argv[1] does not contain node_modules -- early guard fires)', () => {
    const origArgv1 = process.argv[1];
    // Simulate dev mode: argv[1] is the project's own dist path (no node_modules).
    // The node_modules early-return fires before the .git check is ever reached.
    process.argv[1] = '/some/project/path/dist/index.js';

    const result = isNpmGlobalInstall();

    expect(result).toBe(false);
    process.argv[1] = origArgv1;
  });

  it('returns false when isSea() is true', () => {
    const origArgv1 = process.argv[1];
    process.argv[1] = '/home/user/.npm/_npx/abc123def/lib/node_modules/@apralabs/apra-fleet/dist/index.js';
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

  it('returns true when findProjectRoot() throws (no version.json found up the tree -- catch branch)', () => {
    // Exercises the catch branch: argv[1] contains node_modules so we pass the early guard,
    // but existsSync returns false for every version.json check so findProjectRoot() throws.
    // The catch block returns true (assume npm, not in a known git repo).
    // This would FAIL if the catch block returned false or re-threw.
    const origArgv1 = process.argv[1];
    process.argv[1] = '/home/user/.npm/_npx/abc123/lib/node_modules/@apralabs/apra-fleet/dist/index.js';
    // No version.json anywhere => findProjectRoot() exhausts 5 hops and throws.
    vi.mocked(fs.existsSync).mockImplementation((_p: any) => false);

    const result = isNpmGlobalInstall();

    expect(result).toBe(true); // catch => npm mode
    process.argv[1] = origArgv1;
  });

  it('returns false when process.argv[1] is under node_modules AND .git present (dev with node_modules path -- .git branch independently exercised)', () => {
    // Complements the "early guard" dev test above: this variant DOES reach the .git branch
    // because argv[1] contains node_modules (a developer who npm-linked into a git checkout).
    // With .git present, must return false. Removing or inverting the .git check would flip this.
    const origArgv1 = process.argv[1];
    process.argv[1] = '/home/dev/src/node_modules/.bin/apra-fleet'; // node_modules present
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (ps.includes('version.json')) return true;
      if (ps.includes('.git')) return true; // developer git checkout
      if (ps.includes('hooks-config.json')) return true;
      return false;
    });

    const result = isNpmGlobalInstall();

    expect(result).toBe(false);
    process.argv[1] = origArgv1;
  });

  it('returns false (dev) when process.argv[1] is under node_modules AND .git exists at project root', () => {
    // REGRESSION TEST: this is the exact real-world scenario that was broken and hand-fixed.
    // argv[1] contains node_modules (passes the early guard), but existsSync('.git') returns
    // true (a git checkout). isNpmGlobalInstall() must return false (dev/git-checkout mode).
    // This test would FAIL if the .git branch were removed or inverted.
    const origArgv1 = process.argv[1];
    process.argv[1] = '/home/dev/projects/node_modules/@apralabs/apra-fleet/dist/index.js';
    // Override existsSync: version.json present (so findProjectRoot succeeds) AND .git present.
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (ps.includes('version.json')) return true;
      if (ps.includes('.git')) return true; // git checkout -- has .git
      if (ps.includes('hooks-config.json')) return true;
      return false;
    });

    const result = isNpmGlobalInstall();

    expect(result).toBe(false); // .git present => dev mode, NOT npm
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
    process.argv[1] = '/home/user/.npm/_npx/abc123/lib/node_modules/@apralabs/apra-fleet/dist/index.js';

    await runInstall([]);

    // Verify copyFileSync was NOT called
    expect(vi.mocked(fs.copyFileSync)).not.toHaveBeenCalled();
    process.argv[1] = origArgv1;
  });

  it('sets binaryPath to process.argv[1] in npm mode (flows into claude MCP script arg)', async () => {
    const origArgv1 = process.argv[1];
    const npmPath = '/home/user/.npm/_npx/abc123/lib/node_modules/@apralabs/apra-fleet/dist/index.js';
    process.argv[1] = npmPath;

    await runInstall([]);

    // binaryPath is set to process.argv[1] in npm mode and flows into mcpConfig.args[0],
    // which is the second segment of the claude registration command. Assert on the real
    // execSync command, not just a log string.
    const calls = vi.mocked(execSync).mock.calls.map(c => String(c[0]));
    const mcpAdd = calls.find(c => c.includes('claude mcp add'));
    expect(mcpAdd).toBeDefined();
    // Must carry the npm script path (binaryPath) -- this fails against the pre-fix code
    // that dropped mcpConfig.args[0].
    expect(mcpAdd).toContain(npmPath);

    process.argv[1] = origArgv1;
  });

  it('prints "npm global install detected -- skipping binary copy" message', async () => {
    const origArgv1 = process.argv[1];
    process.argv[1] = '/home/user/.npm/_npx/abc123/lib/node_modules/@apralabs/apra-fleet/dist/index.js';

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
    const npmPath = '/home/user/.npm/_npx/abc123/lib/node_modules/@apralabs/apra-fleet/dist/index.js';
    process.argv[1] = npmPath;

    await runInstall([]);

    // run() calls the mocked execSync; the claude registration command must carry BOTH the
    // node executable (process.execPath) AND the npm script path (process.argv[1]).
    const calls = vi.mocked(execSync).mock.calls.map(c => String(c[0]));
    const mcpAdd = calls.find(c => c.includes('claude mcp add'));
    expect(mcpAdd).toBeDefined();
    expect(mcpAdd).toContain(process.execPath); // node executable
    expect(mcpAdd).toContain(npmPath);          // script path -- fails against pre-fix code

    process.argv[1] = origArgv1;
  });

  it('uses process.execPath for npm mode MCP registration', async () => {
    const origArgv1 = process.argv[1];
    const npmPath = '/home/user/.npm/_npx/abc123/lib/node_modules/@apralabs/apra-fleet/dist/index.js';
    process.argv[1] = npmPath;

    await runInstall([]);

    const calls = vi.mocked(execSync).mock.calls.map(c => String(c[0]));
    const mcpAdd = calls.find(c => c.includes('claude mcp add'));
    expect(mcpAdd).toBeDefined();
    // Both segments are quoted so paths with spaces survive; assert the exact registered form.
    expect(mcpAdd).toBe(
      `claude mcp add --scope user apra-fleet -- "${process.execPath}" "${npmPath}"`
    );

    process.argv[1] = origArgv1;
  });
});
