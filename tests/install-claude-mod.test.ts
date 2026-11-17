/**
 * fleet-status Claude Code mod: `apra-fleet install --llm claude` installs it
 * into a local folder marketplace (<FLEET_BASE>/claude-plugins) and registers
 * it with the claude CLI; only when that succeeds is apra-fleet's own
 * statusLine entry removed. A user's own statusLine is never touched (any
 * provider). Uninstall removes the mod.
 *
 * Real filesystem under an isolated temp HOME (never the real profile); the
 * claude CLI is faked through _setClaudeModDeps.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { applyIsolatedHome } from './helpers/isolated-home.mjs';

const iso = await applyIsolatedHome('apra-fleet-claude-mod-');
// config.ts / paths.ts read the home at module load: import them only now.
vi.resetModules();
const mod = await import('../src/cli/claude-mod.js');
const config = await import('../src/cli/config.js');
const install = await import('../src/cli/install.js');

const HOME = iso.tempHome;
const FLEET_BASE = path.join(HOME, '.apra-fleet');
const PLUGINS_DIR = path.join(FLEET_BASE, 'claude-plugins');
const claudePaths = () => config.getProviderInstallConfig('claude');
const OUR_STATUSLINE = () => ({ type: 'command', command: path.join(FLEET_BASE, 'scripts', 'fleet-statusline.sh') });
const FOREIGN_STATUSLINE = { type: 'command', command: '/usr/local/bin/my-own-status.sh', padding: 1 };

function readSettings(): any {
  const f = claudePaths().settingsFile;
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : {};
}
function writeSettings(obj: any): void {
  const f = claudePaths().settingsFile;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(obj, null, 2));
}

/** A fake claude CLI recording argv; `fail` makes the matching subcommand exit non-zero. */
function fakeClaude(opts: { missing?: boolean; fail?: (args: string[]) => boolean } = {}) {
  const calls: string[][] = [];
  mod._setClaudeModDeps({
    resolveClaude: () => (opts.missing ? null : '/fake/bin/claude'),
    exec: (file, args, timeoutMs) => {
      expect(file).toBe('/fake/bin/claude');
      expect(timeoutMs).toBeGreaterThan(0);
      calls.push(args);
      if (opts.fail?.(args)) {
        throw Object.assign(new Error('exited 1'), { status: 1, stderr: "error: unknown command 'plugin'\n" });
      }
    },
  });
  return calls;
}

const MARKETPLACE_ADD = ['plugin', 'marketplace', 'add', PLUGINS_DIR, '--scope', 'user'];
const PLUGIN_INSTALL = ['plugin', 'install', 'fleet-status@apra-fleet-local', '--scope', 'user'];

// A small manifest over the REAL repo assets the install step needs (dev mode:
// asset keys are repo-relative paths), plus the real mod section.
function testManifest(withMod = true): any {
  const real = install._buildDevManifestForTest(path.resolve(__dirname, '..'));
  return {
    version: '0.0.0-test',
    hooks: { 'hooks-config.json': 'hooks/hooks-config.json' },
    scripts: { 'fleet-statusline.sh': 'scripts/fleet-statusline.sh' },
    skills: {}, fleetSkills: {}, agents: {}, workflows: {},
    ...(withMod ? { claudePlugins: real.claudePlugins } : {}),
  };
}

async function runClaudeInstall(): Promise<string> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await install.runInstall(['--llm', 'claude', '--skill', 'none', '--workflows', 'none']);
  return log.mock.calls.map((c) => c.join(' ')).join('\n');
}

beforeAll(() => {
  expect(config.FLEET_BASE).toBe(FLEET_BASE); // isolation took effect
});
afterAll(async () => {
  await iso.restore();
});

beforeEach(() => {
  process.env.APRA_FLEET_ENABLE_CLAUDE_MOD_STEP = '1';
  install._setSeaOverride(false);
  install._setManifestOverride(testManifest());
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  fs.rmSync(path.join(HOME, '.claude'), { recursive: true, force: true });
  fs.rmSync(FLEET_BASE, { recursive: true, force: true });
});
afterEach(() => {
  delete process.env.APRA_FLEET_ENABLE_CLAUDE_MOD_STEP;
  mod._resetClaudeModDeps();
  install._setSeaOverride(null);
  install._setManifestOverride(null);
  vi.restoreAllMocks();
});

describe('packaging', () => {
  it('dev manifest ships only the mod runtime files', () => {
    const m = install._buildDevManifestForTest(path.resolve(__dirname, '..'));
    expect(Object.keys(m.claudePlugins ?? {}).sort()).toEqual([
      'fleet-status/.claude-plugin/plugin.json',
      'fleet-status/hooks/hooks.json',
      'fleet-status/hooks/register.tsx',
      'fleet-status/types/index.d.ts',
    ]);
    expect(m.claudePlugins!['fleet-status/hooks/register.tsx']).toBe('plugins/claude-code/fleet-status/hooks/register.tsx');
  });

  it('isClaudeModRuntimeFile excludes authoring-only files', () => {
    expect(mod.isClaudeModRuntimeFile('hooks/register.tsx')).toBe(true);
    expect(mod.isClaudeModRuntimeFile('tsconfig.json')).toBe(false);
    expect(mod.isClaudeModRuntimeFile('.claude-plugin/types/claude-code/index.d.ts')).toBe(false);
    expect(mod.isClaudeModRuntimeFile('tests/fleet-status.test.tsx')).toBe(false);
    expect(mod.isClaudeModRuntimeFile('.claude-plugin/plugin.json')).toBe(true);
  });
});

describe('claude spawn (no shell)', () => {
  it('POSIX / claude.exe: argv passed as-is', () => {
    expect(mod.claudeSpawnSpec('/usr/bin/claude', ['plugin', 'install', 'x'], 'linux'))
      .toEqual({ cmd: '/usr/bin/claude', argv: ['plugin', 'install', 'x'], verbatim: false });
    expect(mod.claudeSpawnSpec('C:\\bin\\claude.exe', ['a b'], 'win32').verbatim).toBe(false);
  });

  it('win32 claude.cmd: explicit cmd.exe line with every spaced path quoted', () => {
    const spec = mod.claudeSpawnSpec(
      'C:\\Program Files\\nodejs\\claude.cmd',
      ['plugin', 'marketplace', 'add', 'C:\\Users\\First Last\\.apra-fleet\\claude-plugins', '--scope', 'user'],
      'win32', 'C:\\Windows\\system32\\cmd.exe');
    expect(spec.cmd).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(spec.verbatim).toBe(true);
    expect(spec.argv).toEqual(['/d', '/s', '/c',
      '""C:\\Program Files\\nodejs\\claude.cmd" plugin marketplace add "C:\\Users\\First Last\\.apra-fleet\\claude-plugins" --scope user"']);
  });
});

describe('install --llm claude: fleet-status mod', () => {
  it('success: lays out the marketplace, runs both claude commands, removes OUR statusLine', async () => {
    writeSettings({ statusLine: OUR_STATUSLINE(), theme: 'dark' });
    const calls = fakeClaude();

    const out = await runClaudeInstall();

    expect(calls).toEqual([MARKETPLACE_ADD, PLUGIN_INSTALL]);
    const market = JSON.parse(fs.readFileSync(path.join(PLUGINS_DIR, '.claude-plugin', 'marketplace.json'), 'utf-8'));
    expect(market.name).toBe('apra-fleet-local');
    expect(market.plugins).toEqual([expect.objectContaining({ name: 'fleet-status', source: './fleet-status' })]);
    expect(fs.existsSync(path.join(PLUGINS_DIR, 'fleet-status', '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(fs.existsSync(path.join(PLUGINS_DIR, 'fleet-status', 'hooks', 'register.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(PLUGINS_DIR, 'fleet-status', 'tsconfig.json'))).toBe(false);

    const s = readSettings();
    expect(s.statusLine).toBeUndefined();
    expect(s.theme).toBe('dark');
    expect(out).toContain('Claude mod:  fleet-status installed');
  });

  it('success with no statusLine at all: none is written', async () => {
    fakeClaude();
    await runClaudeInstall();
    expect(readSettings().statusLine).toBeUndefined();
  });

  it('claude missing: keeps (writes) the statusLine script and says why', async () => {
    const calls = fakeClaude({ missing: true });
    const out = await runClaudeInstall();
    expect(calls).toEqual([]);
    expect(mod.isApraFleetStatusLine(readSettings().statusLine)).toBe(true);
    expect(out).toContain("fleet-status mod not installed: the 'claude' CLI was not found on PATH");
    expect(out).toContain('Claude mod:  fleet-status skipped:');
  });

  it('mod already registered but claude now missing: refreshes the files, keeps the statusLine off', async () => {
    fakeClaude();
    await runClaudeInstall();
    writeSettings({ ...readSettings(), enabledPlugins: { 'fleet-status@apra-fleet-local': true } });
    const stale = path.join(PLUGINS_DIR, 'fleet-status', 'hooks', 'old-module.tsx');
    fs.writeFileSync(stale, '// stale');
    const calls = fakeClaude({ missing: true });

    const out = await runClaudeInstall();

    expect(calls).toEqual([]);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(path.join(PLUGINS_DIR, 'fleet-status', 'hooks', 'register.tsx'))).toBe(true);
    expect(readSettings().statusLine).toBeUndefined();
    expect(out).toContain('already registered; files refreshed');
  });

  it('old claude (plugin subcommand fails): keeps the statusLine and reports the failing command', async () => {
    writeSettings({ statusLine: OUR_STATUSLINE() });
    const calls = fakeClaude({ fail: (a) => a[0] === 'plugin' });
    const out = await runClaudeInstall();
    expect(calls).toEqual([MARKETPLACE_ADD]); // stops at the first failure
    expect(mod.isApraFleetStatusLine(readSettings().statusLine)).toBe(true);
    expect(out).toMatch(/fleet-status mod not installed: 'claude plugin marketplace add' failed \(exit 1: error: unknown command 'plugin'\)/);
  });

  it('plugin install fails after marketplace add: keeps the statusLine', async () => {
    writeSettings({ statusLine: OUR_STATUSLINE() });
    fakeClaude({ fail: (a) => a[1] === 'install' });
    const out = await runClaudeInstall();
    expect(mod.isApraFleetStatusLine(readSettings().statusLine)).toBe(true);
    expect(out).toContain("'claude plugin install fleet-status@apra-fleet-local' failed");
  });

  it('build without the mod packaged: keeps the statusLine, never calls claude', async () => {
    install._setManifestOverride(testManifest(false));
    const calls = fakeClaude();
    const out = await runClaudeInstall();
    expect(calls).toEqual([]);
    expect(mod.isApraFleetStatusLine(readSettings().statusLine)).toBe(true);
    expect(out).toContain('not packaged');
  });

  it('a foreign statusLine is never removed on success', async () => {
    writeSettings({ statusLine: FOREIGN_STATUSLINE });
    fakeClaude();
    await runClaudeInstall();
    expect(readSettings().statusLine).toEqual(FOREIGN_STATUSLINE);
  });

  it('a foreign statusLine is never overwritten on failure', async () => {
    writeSettings({ statusLine: FOREIGN_STATUSLINE });
    fakeClaude({ missing: true });
    const out = await runClaudeInstall();
    expect(readSettings().statusLine).toEqual(FOREIGN_STATUSLINE);
    expect(out).toContain('Kept your existing statusLine');
  });

  it('re-install is idempotent and drops files a newer mod no longer ships', async () => {
    const calls = fakeClaude();
    await runClaudeInstall();
    const stale = path.join(PLUGINS_DIR, 'fleet-status', 'hooks', 'old-module.tsx');
    fs.writeFileSync(stale, '// left over from an older mod version');

    await runClaudeInstall();

    expect(calls).toEqual([MARKETPLACE_ADD, PLUGIN_INSTALL, MARKETPLACE_ADD, PLUGIN_INSTALL]);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(path.join(PLUGINS_DIR, 'fleet-status', 'hooks', 'register.tsx'))).toBe(true);
    expect(readSettings().statusLine).toBeUndefined();
  });

  it('test-mode gate: without the opt-in env var the step never runs and the statusLine is kept', async () => {
    delete process.env.APRA_FLEET_ENABLE_CLAUDE_MOD_STEP;
    const calls = fakeClaude();
    const out = await runClaudeInstall();
    expect(calls).toEqual([]);
    expect(fs.existsSync(PLUGINS_DIR)).toBe(false);
    expect(mod.isApraFleetStatusLine(readSettings().statusLine)).toBe(true);
    expect(out).not.toContain('Claude mod:');
  });
});

describe('foreign statusLine, other providers', () => {
  it('agy install never overwrites a user statusLine', async () => {
    const paths = config.getProviderInstallConfig('agy');
    fs.mkdirSync(path.dirname(paths.settingsFile), { recursive: true });
    fs.writeFileSync(paths.settingsFile, JSON.stringify({ statusLine: FOREIGN_STATUSLINE }));
    const calls = fakeClaude();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await install.runInstall(['--llm', 'agy', '--skill', 'none', '--workflows', 'none']);
    expect(JSON.parse(fs.readFileSync(paths.settingsFile, 'utf-8')).statusLine).toEqual(FOREIGN_STATUSLINE);
    expect(calls).toEqual([]); // the mod is Claude-only
  });
});

describe('uninstall: fleet-status mod', () => {
  // uninstallClaudeMod is what runUninstall calls for the claude provider
  // (under --skill all, before cleanupSettings); its wiring and --dry-run line
  // are pinned by tests/uninstall.test.ts's command-surface fixture.
  function uninstallMod(dryRun = false): string {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const found = mod.uninstallClaudeMod(claudePaths(), dryRun);
    const out = log.mock.calls.map((c) => c.join(' ')).join('\n');
    log.mockRestore();
    return `${found}\n${out}`;
  }

  it('runs plugin uninstall + marketplace remove, then removes the folder and leftover settings keys', async () => {
    fakeClaude();
    await runClaudeInstall();
    // what the real claude CLI leaves in settings after install
    writeSettings({ ...readSettings(), enabledPlugins: { 'fleet-status@apra-fleet-local': true, 'other@x': true },
      extraKnownMarketplaces: { 'apra-fleet-local': { source: { source: 'directory', path: PLUGINS_DIR } } },
      statusLine: FOREIGN_STATUSLINE });
    const calls = fakeClaude();

    const out = uninstallMod();

    expect(calls).toEqual([
      ['plugin', 'uninstall', 'fleet-status@apra-fleet-local', '--scope', 'user'],
      ['plugin', 'marketplace', 'remove', 'apra-fleet-local'],
    ]);
    expect(fs.existsSync(PLUGINS_DIR)).toBe(false);
    const s = readSettings();
    expect(s.enabledPlugins).toEqual({ 'other@x': true });
    expect(s.extraKnownMarketplaces).toEqual({});
    expect(s.statusLine).toEqual(FOREIGN_STATUSLINE); // never ours to remove
    expect(out).toContain(`Removing fleet-status Claude Code mod (fleet-status@apra-fleet-local): ${PLUGINS_DIR}`);
  });

  it('is best-effort: claude CLI failures (already removed) do not stop the folder removal', async () => {
    fakeClaude();
    await runClaudeInstall();
    fakeClaude({ fail: () => true });
    expect(uninstallMod()).toMatch(/^true/);
    expect(fs.existsSync(PLUGINS_DIR)).toBe(false);
  });

  it('claude CLI missing: still removes the folder and the settings keys', async () => {
    fakeClaude();
    await runClaudeInstall();
    writeSettings({ enabledPlugins: { 'fleet-status@apra-fleet-local': true }, extraKnownMarketplaces: { 'apra-fleet-local': {} } });
    const calls = fakeClaude({ missing: true });
    uninstallMod();
    expect(calls).toEqual([]);
    expect(fs.existsSync(PLUGINS_DIR)).toBe(false);
    expect(readSettings()).toEqual({ enabledPlugins: {}, extraKnownMarketplaces: {} });
  });

  it('dry-run prints the plan and changes nothing', async () => {
    fakeClaude();
    await runClaudeInstall();
    const calls = fakeClaude();
    const out = uninstallMod(true);
    expect(calls).toEqual([]);
    expect(fs.existsSync(PLUGINS_DIR)).toBe(true);
    expect(out).toContain('Removing fleet-status Claude Code mod');
  });

  it('nothing installed: returns false, no line, no claude calls', () => {
    const calls = fakeClaude();
    const out = uninstallMod();
    expect(calls).toEqual([]);
    expect(out).toBe('false\n');
  });
});
