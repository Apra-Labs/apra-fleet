import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInstall, _setSeaOverride, _setManifestOverride } from '../src/cli/install.js';
import { writeInstallConfig, INSTALL_CONFIG_PATH } from '../src/cli/config.js';

// apra-fleet-7pm.5 -- install.ts additive workflow-install step
// (~/.apra-fleet/node_modules, /schemas, /workflows/{fleet-sprint,hello-world}),
// the --workflows <all|none> flag, and install-config workflowsMode persistence.
// See docs/workflow-subsystem-plan.md Section 6 / Section 2.1.

vi.mock('node:os', () => ({
  default: {
    homedir: vi.fn(() => '/mock/home'),
    platform: vi.fn(() => 'linux'),
  }
}));
vi.mock('node:fs');
vi.mock('node:child_process');

const mockHome = '/mock/home';
const NODE_MODULES_DIR = path.join(mockHome, '.apra-fleet', 'node_modules');
const SCHEMAS_DIR = path.join(mockHome, '.apra-fleet', 'schemas');
const WORKFLOWS_DIR = path.join(mockHome, '.apra-fleet', 'workflows');

const OLD_MANIFEST = { version: '0.1.0', hooks: {}, scripts: {}, skills: {}, fleetSkills: {}, agents: {}, workflows: {} };

const NEW_MANIFEST = {
  ...OLD_MANIFEST,
  workflowRuntime: {
    '@apralabs/apra-fleet-workflow/package.json': '@apralabs/apra-fleet-workflow/package.json',
    '@apralabs/apra-fleet-workflow/src/index.js': '@apralabs/apra-fleet-workflow/src/index.js',
    '@apralabs/apra-fleet-client/package.json': '@apralabs/apra-fleet-client/package.json',
    'ajv/package.json': 'ajv/package.json',
  },
  agentSchemas: {
    'agentSchemas/pm.schema.json': 'packages/apra-fleet-se/apra-pm/agents/schemas/pm.schema.json',
  },
  builtinWorkflows: {
    'fleet-sprint/workflow.json': 'fleet-sprint/workflow.json',
    'fleet-sprint/main.mjs': 'fleet-sprint/main.mjs',
    'hello-world/workflow.json': 'hello-world/workflow.json',
    'hello-world/main.mjs': 'hello-world/main.mjs',
  },
};

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
  vi.mocked(fs.rmSync).mockImplementation(() => undefined as any);
  vi.mocked(fs.renameSync).mockImplementation(() => undefined as any);
}

describe('install-config workflowsMode persistence (writeInstallConfig unit test)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHome);
    makeFsMock();
  });

  it('defaults workflowsMode to "all" when not specified', () => {
    writeInstallConfig('claude', 'all');
    const call = vi.mocked(fs.writeFileSync).mock.calls.find(c => c[0] === INSTALL_CONFIG_PATH);
    expect(call).toBeDefined();
    const data = JSON.parse(call![1] as string);
    expect(data.providers.claude.workflowsMode).toBe('all');
  });

  it('persists workflowsMode "none" when passed explicitly', () => {
    writeInstallConfig('claude', 'all', 'none');
    const call = vi.mocked(fs.writeFileSync).mock.calls.find(c => c[0] === INSTALL_CONFIG_PATH);
    const data = JSON.parse(call![1] as string);
    expect(data.providers.claude.workflowsMode).toBe('none');
  });
});

describe('runInstall --workflows flag -> install-config.json (T: apra-fleet-7pm.5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHome);
    makeFsMock();
    _setSeaOverride(false);
    _setManifestOverride(OLD_MANIFEST as any);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    _setSeaOverride(null);
    _setManifestOverride(null);
  });

  it('a default install writes workflowsMode: "all"', async () => {
    await runInstall([]);
    const call = vi.mocked(fs.writeFileSync).mock.calls.find(c => c[0] === path.join(mockHome, '.apra-fleet', 'data', 'install-config.json'));
    const data = JSON.parse(call![1] as string);
    expect(data.providers.claude.workflowsMode).toBe('all');
  });

  it('--workflows none writes workflowsMode: "none"', async () => {
    await runInstall(['--workflows', 'none']);
    const call = vi.mocked(fs.writeFileSync).mock.calls.find(c => c[0] === path.join(mockHome, '.apra-fleet', 'data', 'install-config.json'));
    const data = JSON.parse(call![1] as string);
    expect(data.providers.claude.workflowsMode).toBe('none');
  });

  it('--workflows=none (equals form) writes workflowsMode: "none"', async () => {
    await runInstall(['--workflows=none']);
    const call = vi.mocked(fs.writeFileSync).mock.calls.find(c => c[0] === path.join(mockHome, '.apra-fleet', 'data', 'install-config.json'));
    const data = JSON.parse(call![1] as string);
    expect(data.providers.claude.workflowsMode).toBe('none');
  });

  it('rejects an invalid --workflows value', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    await expect(runInstall(['--workflows', 'bogus'])).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});

describe('runInstall --workflows none: byte-identical existing-step behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHome);
    makeFsMock();
    _setSeaOverride(false);
    _setManifestOverride(OLD_MANIFEST as any);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    _setSeaOverride(null);
    _setManifestOverride(null);
  });

  it('emits no workflow-runtime step line and no workflow-dir writes when --workflows none', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runInstall(['--skill', 'none', '--workflows', 'none']);
    const logs = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logs).not.toContain('Installing workflow runtime');
    // Pre-workflow-subsystem numbering preserved: base=6 steps (no skills, no service in dev
    // mode) +1 dolt (apra-fleet-ire.3, unconditional) = 7.
    expect(logs).toContain('[7/7]');

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls.map(c => c[0].toString());
    expect(writeCalls.some(p => p.startsWith(NODE_MODULES_DIR))).toBe(false);
    expect(writeCalls.some(p => p.startsWith(SCHEMAS_DIR))).toBe(false);
    expect(writeCalls.some(p => p.startsWith(WORKFLOWS_DIR))).toBe(false);
    logSpy.mockRestore();
  });
});

describe('runInstall workflow-runtime extraction (new manifest)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHome);
    makeFsMock();
    _setSeaOverride(false);
    _setManifestOverride(NEW_MANIFEST as any);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    _setSeaOverride(null);
    _setManifestOverride(null);
  });

  it('extracts node_modules packages grouped by top-level package name (extract-to-temp-then-rename)', async () => {
    await runInstall(['--skill', 'none']);

    const renameCalls = vi.mocked(fs.renameSync).mock.calls;
    const workflowPkgDest = path.join(NODE_MODULES_DIR, '@apralabs', 'apra-fleet-workflow');
    const clientPkgDest = path.join(NODE_MODULES_DIR, '@apralabs', 'apra-fleet-client');
    const ajvPkgDest = path.join(NODE_MODULES_DIR, 'ajv');

    expect(renameCalls.some(c => c[1] === workflowPkgDest)).toBe(true);
    expect(renameCalls.some(c => c[1] === clientPkgDest)).toBe(true);
    expect(renameCalls.some(c => c[1] === ajvPkgDest)).toBe(true);

    // The temp source dir for each rename is a sibling of the final dir (extract-to-temp-then-rename).
    const workflowRename = renameCalls.find(c => c[1] === workflowPkgDest)!;
    expect((workflowRename[0] as string).startsWith(`${workflowPkgDest}.tmp-`)).toBe(true);
  });

  it('writes agent schemas under ~/.apra-fleet/schemas (agentSchemas/ prefix stripped)', async () => {
    await runInstall(['--skill', 'none']);
    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls.map(c => c[0].toString());
    expect(writeCalls).toContain(path.join(SCHEMAS_DIR, 'pm.schema.json'));
  });

  it('clears+extracts only the named built-in workflow subdirectory, never the workflows/ root', async () => {
    await runInstall(['--skill', 'none']);

    const renameCalls = vi.mocked(fs.renameSync).mock.calls;
    const fleetSprintDest = path.join(WORKFLOWS_DIR, 'fleet-sprint');
    const helloWorldDest = path.join(WORKFLOWS_DIR, 'hello-world');
    expect(renameCalls.some(c => c[1] === fleetSprintDest)).toBe(true);
    expect(renameCalls.some(c => c[1] === helloWorldDest)).toBe(true);

    // clearDirSync/rmSync must never target the workflows/ root itself.
    const rmCalls = vi.mocked(fs.rmSync).mock.calls.map(c => c[0].toString());
    expect(rmCalls).not.toContain(WORKFLOWS_DIR);
  });

  it('writes workflows/.installed.json with the built-in list and installed version', async () => {
    await runInstall(['--skill', 'none']);
    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const installedCall = writeCalls.find(c => c[0] === path.join(WORKFLOWS_DIR, '.installed.json'));
    expect(installedCall).toBeDefined();
    const data = JSON.parse(installedCall![1] as string);
    expect(data.builtin.sort()).toEqual(['fleet-sprint', 'hello-world']);
    expect(typeof data.version).toBe('string');
  });
});

describe('runInstall old-manifest compatibility (no workflow asset sections)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHome);
    makeFsMock();
    _setSeaOverride(false);
    _setManifestOverride(OLD_MANIFEST as any);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    _setSeaOverride(null);
    _setManifestOverride(null);
  });

  it('skips the workflow step with a warning instead of crashing when manifest keys are absent', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(runInstall(['--skill', 'none'])).resolves.toBeUndefined();
    const warns = warnSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(warns).toContain('no workflow-subsystem assets');

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls.map(c => c[0].toString());
    expect(writeCalls.some(p => p.startsWith(NODE_MODULES_DIR))).toBe(false);
    expect(writeCalls.some(p => p.startsWith(SCHEMAS_DIR))).toBe(false);
    warnSpy.mockRestore();
  });
});

describe('runInstall EBUSY handling on a locked built-in workflow directory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHome);
    makeFsMock();
    _setSeaOverride(false);
    _setManifestOverride(NEW_MANIFEST as any);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    _setSeaOverride(null);
    _setManifestOverride(null);
  });

  it('warns and skips only the locked directory, install still exits 0 (resolves)', async () => {
    const fleetSprintDest = path.join(WORKFLOWS_DIR, 'fleet-sprint');
    vi.mocked(fs.renameSync).mockImplementation(((_src: any, dest: any) => {
      if (dest === fleetSprintDest) {
        const err: NodeJS.ErrnoException = new Error('resource busy or locked');
        err.code = 'EBUSY';
        throw err;
      }
      return undefined as any;
    }) as any);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(runInstall(['--skill', 'none'])).resolves.toBeUndefined();

    const warns = warnSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(warns).toContain('workflows/fleet-sprint');
    expect(warns).toContain('locked');

    // hello-world (not locked) still got its rename call through.
    const helloWorldDest = path.join(WORKFLOWS_DIR, 'hello-world');
    const renameCalls = vi.mocked(fs.renameSync).mock.calls;
    expect(renameCalls.some(c => c[1] === helloWorldDest)).toBe(true);

    warnSpy.mockRestore();
  }, 10000);
});

// apra-fleet-eft.19.2 -- regression coverage for apra-fleet-eft.19 (dev-mode
// install omits undici, crashing apra-fleet-client's transport.mjs with
// ERR_MODULE_NOT_FOUND). Every other suite in this file drives buildDevManifest()
// indirectly through a fully mocked node:fs (via _setManifestOverride), which
// can't observe what buildDevManifest() itself actually collects from disk.
// This suite unmocks node:fs for one test and calls the real buildDevManifest()
// (exposed as _buildDevManifestForTest) against this repo's real project root,
// so it fails if the undici collectPackageTree() call is ever dropped again.
describe('buildDevManifest bundles undici (regression for apra-fleet-eft.19)', () => {
  afterEach(() => {
    // Restore automocking for node:fs/node:child_process so later test files
    // (and, if vitest re-orders within this file, later tests here) get the
    // mocked fs used by every other suite above.
    vi.doMock('node:fs');
    vi.doMock('node:child_process');
  });

  it('includes an undici package-tree entry in the workflowRuntime manifest', async () => {
    vi.resetModules();
    vi.doUnmock('node:fs');
    vi.doUnmock('node:child_process');

    const real = await vi.importActual<typeof import('../src/cli/install.js')>('../src/cli/install.js');

    const testDir = path.dirname(fileURLToPath(import.meta.url));
    const projectRoot = path.resolve(testDir, '..');

    const manifest = real._buildDevManifestForTest(projectRoot);

    expect(manifest.workflowRuntime).toBeDefined();
    const keys = Object.keys(manifest.workflowRuntime ?? {});

    // Names undici explicitly: fails if the undici collectPackageTree() call
    // (apra-fleet-eft.19.1) is ever dropped from buildDevManifest again.
    expect(keys.some(k => k === 'undici/package.json')).toBe(true);
    expect(keys.some(k => k.startsWith('undici/'))).toBe(true);

    // undici-types is intentionally excluded (types-only, no runtime require
    // in undici's lib) -- assert the fix didn't over-bundle it either.
    expect(keys.some(k => k.startsWith('undici-types/'))).toBe(false);
  });
});

// apra-fleet-eft.84 -- regression coverage for a live install crash: adding
// scripts/agent-doc-partials/ (a subdirectory under scripts/, holding
// non-.mjs partial template files) made buildDevManifest()'s scripts loop --
// which used a bare fs.readdirSync() with no withFileTypes/isFile() check --
// emit the directory itself as a manifest.scripts entry. Whatever later reads
// that path as a file (dev-mode install's asset extraction) then crashed with
// EISDIR. Uses the same real-filesystem pattern as the undici suite above,
// since every other suite in this file drives buildDevManifest() through a
// fully mocked node:fs that can't observe a real subdirectory under scripts/.
describe('buildDevManifest scripts manifest excludes directories (regression for apra-fleet-eft.84)', () => {
  afterEach(() => {
    vi.doMock('node:fs');
    vi.doMock('node:child_process');
  });

  it('only emits real files under scripts/, never a subdirectory path', async () => {
    vi.resetModules();
    vi.doUnmock('node:fs');
    vi.doUnmock('node:child_process');

    const real = await vi.importActual<typeof import('../src/cli/install.js')>('../src/cli/install.js');
    const fsReal = await vi.importActual<typeof import('node:fs')>('node:fs');
    const pathReal = await vi.importActual<typeof import('node:path')>('node:path');

    const testDir = path.dirname(fileURLToPath(import.meta.url));
    const projectRoot = path.resolve(testDir, '..');

    const manifest = real._buildDevManifestForTest(projectRoot);

    // Sanity: scripts/agent-doc-partials/ actually exists on disk in this
    // repo, so this test is exercising the real regression, not a no-op.
    expect(fsReal.existsSync(pathReal.join(projectRoot, 'scripts', 'agent-doc-partials'))).toBe(true);

    expect('agent-doc-partials' in manifest.scripts).toBe(false);
    for (const [key, relPath] of Object.entries(manifest.scripts)) {
      const stat = fsReal.statSync(pathReal.join(projectRoot, relPath));
      expect(stat.isFile(), `manifest.scripts['${key}'] (${relPath}) must be a file, not a directory`).toBe(true);
    }
  });

  // apra-fleet-eft.84.2 -- dedicated hermetic fixture pinning the same
  // regression, independent of this repo's current scripts/ layout (the test
  // above depends on scripts/agent-doc-partials/ continuing to exist on disk).
  // Builds a minimal fixture project root whose scripts/ dir mirrors the real
  // layout that crashed dev-mode install: a flat non-.mjs script alongside a
  // subdirectory holding its own file. Every other buildDevManifest() input
  // (packages/, dist/, vendor/, examples/) is optional -- guarded by
  // fs.existsSync in the real function -- so omitting them from the fixture
  // just yields empty manifest sections, not a crash.
  it('fixture root: scripts/ subdirectory never becomes a flat manifest key, and every emitted script is EISDIR-safe to read', async () => {
    vi.resetModules();
    vi.doUnmock('node:fs');
    vi.doUnmock('node:child_process');

    const real = await vi.importActual<typeof import('../src/cli/install.js')>('../src/cli/install.js');
    const fsReal = await vi.importActual<typeof import('node:fs')>('node:fs');
    const pathReal = await vi.importActual<typeof import('node:path')>('node:path');
    const osReal = await vi.importActual<typeof import('node:os')>('node:os');

    const fixtureRoot = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'apra-fleet-eft84-2-'));
    try {
      fsReal.mkdirSync(pathReal.join(fixtureRoot, 'hooks'), { recursive: true });
      fsReal.mkdirSync(pathReal.join(fixtureRoot, 'scripts', 'agent-doc-partials'), { recursive: true });
      // Flat .cjs/.sh-style script -- must survive as a flat manifest.scripts key.
      fsReal.writeFileSync(pathReal.join(fixtureRoot, 'scripts', 'sync-agent-docs.mjs.helper.cjs'), '// fixture script\n');
      fsReal.writeFileSync(pathReal.join(fixtureRoot, 'scripts', 'recovery.sh'), '#!/bin/sh\necho fixture\n');
      // Subdirectory (mirrors scripts/agent-doc-partials/) with a file inside --
      // pre-fix this whole directory was emitted as ONE flat manifest.scripts
      // entry (`agent-doc-partials` -> `scripts/agent-doc-partials`), and reading
      // that path as a file crashed with EISDIR.
      fsReal.writeFileSync(pathReal.join(fixtureRoot, 'scripts', 'agent-doc-partials', 'header.md'), '# fixture partial\n');
      fsReal.writeFileSync(pathReal.join(fixtureRoot, 'version.json'), JSON.stringify({ version: '0.0.0-fixture' }));

      const manifest = real._buildDevManifestForTest(fixtureRoot);

      // The bare directory name must NEVER appear as a flat manifest.scripts key.
      expect('agent-doc-partials' in manifest.scripts).toBe(false);
      expect(Object.values(manifest.scripts)).not.toContain('scripts/agent-doc-partials');

      // The flat sibling scripts are still collected as expected.
      expect(manifest.scripts['recovery.sh']).toBe('scripts/recovery.sh');
      expect(manifest.scripts['sync-agent-docs.mjs.helper.cjs']).toBe('scripts/sync-agent-docs.mjs.helper.cjs');

      // Every manifest.scripts value must resolve to a real file, and reading
      // it must not throw EISDIR -- the exact failure extractAsset() hit at
      // install step [3/12] when a directory was emitted as a flat key.
      expect(Object.keys(manifest.scripts).length).toBeGreaterThan(0);
      for (const [key, relPath] of Object.entries(manifest.scripts)) {
        const fullPath = pathReal.join(fixtureRoot, relPath);
        const stat = fsReal.statSync(fullPath);
        expect(stat.isFile(), `manifest.scripts['${key}'] (${relPath}) must be a file, not a directory`).toBe(true);
        expect(() => fsReal.readFileSync(fullPath), `reading manifest.scripts['${key}'] (${relPath}) must not throw EISDIR`).not.toThrow();
      }
    } finally {
      fsReal.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});

// apra-fleet-eft.86.2 -- regression coverage for bug apra-fleet-eft.86 (dev-mode
// install silently skipped the entire workflow subsystem because
// buildDevManifest()'s agentSchemasDir/wfPath still pointed at the retired
// vendor/apra-pm path instead of packages/apra-fleet-se/apra-pm, so
// hasWorkflowSubsystemAssets() saw agentSchemas as undefined and the installer
// warned-and-skipped instead of installing). Fixed by apra-fleet-eft.86.1. Uses
// the same real-filesystem pattern as the undici/eft.84 suites above, since this
// exercises buildDevManifest()'s own disk resolution against this repo's real
// project root -- the mocked-fs runInstall() suites elsewhere in this file can't
// observe that.
describe('buildDevManifest workflow-subsystem asset resolution (regression for apra-fleet-eft.86)', () => {
  afterEach(() => {
    vi.doMock('node:fs');
    vi.doMock('node:child_process');
  });

  it('emits non-empty agentSchemas/workflowRuntime/builtinWorkflows against the real repo root, and hasWorkflowSubsystemAssets() gates true', async () => {
    vi.resetModules();
    vi.doUnmock('node:fs');
    vi.doUnmock('node:child_process');

    const installReal = await vi.importActual<typeof import('../src/cli/install.js')>('../src/cli/install.js');
    const wfAssetsReal = await vi.importActual<typeof import('../src/cli/workflow-assets.js')>('../src/cli/workflow-assets.js');
    const fsReal = await vi.importActual<typeof import('node:fs')>('node:fs');
    const pathReal = await vi.importActual<typeof import('node:path')>('node:path');

    const testDir = pathReal.dirname(fileURLToPath(import.meta.url));
    const projectRoot = pathReal.resolve(testDir, '..');

    const manifest = installReal._buildDevManifestForTest(projectRoot);

    // agentSchemas: non-empty, keys derive from
    // packages/apra-fleet-se/apra-pm/agents/schemas (doer-input.json/doer-output.json
    // are two of the real files that live there).
    expect(manifest.agentSchemas).toBeDefined();
    const schemaKeys = Object.keys(manifest.agentSchemas!);
    expect(schemaKeys.length).toBeGreaterThan(0);
    expect(schemaKeys.some((k) => k.endsWith('doer-input.json'))).toBe(true);
    expect(schemaKeys.some((k) => k.endsWith('doer-output.json'))).toBe(true);

    expect(manifest.workflowRuntime).toBeDefined();
    expect(Object.keys(manifest.workflowRuntime!).length).toBeGreaterThan(0);

    expect(manifest.builtinWorkflows).toBeDefined();
    expect(Object.keys(manifest.builtinWorkflows!).length).toBeGreaterThan(0);

    // The exact AND-gate that silently disabled the workflow-subsystem install
    // pre-fix (agentSchemas undefined -> false).
    expect(wfAssetsReal.hasWorkflowSubsystemAssets(manifest as any)).toBe(true);

    // Guard against regression: no manifest asset key resolves through the
    // retired vendor/apra-pm path.
    const allAssetValues = [
      ...Object.values(manifest.agentSchemas!),
      ...Object.values(manifest.workflowRuntime!),
      ...Object.values(manifest.builtinWorkflows!),
    ];
    expect(allAssetValues.length).toBeGreaterThan(0);
    for (const diskRelPath of allAssetValues) {
      expect(diskRelPath).not.toContain('vendor/apra-pm');
    }

    // The resolved agentSchemas/workflowRuntime/builtinWorkflows source paths
    // exist on disk at the resolved location (root-relative, per
    // collectPackageTree()).
    for (const diskRelPath of allAssetValues) {
      const full = pathReal.join(projectRoot, diskRelPath);
      expect(fsReal.existsSync(full), `${diskRelPath} must exist on disk at ${full}`).toBe(true);
    }
  });

  // End-to-end assertion (mirrors the eft.86 acceptance + apra-fleet-9te.4.5
  // dependency): extract the real dev-mode manifest's workflow-subsystem assets
  // (via the SAME extractWorkflowSubsystemAssets() code path install.ts's
  // installer and workflow.ts's self-heal both use) into a fresh temp HOME, then
  // assert $HOME/.apra-fleet/workflows exists and the fleet-sprint workflow is
  // resolvable via workflow.ts's own resolveWorkflowEntry() -- no "workflow
  // \"fleet-sprint\" not found" / no "no workflow-subsystem assets (older
  // manifest)" skip.
  it('after extracting the dev-mode manifest into a fresh temp HOME, ~/.apra-fleet/workflows exists and fleet-sprint resolves', async () => {
    vi.resetModules();
    vi.doUnmock('node:fs');
    vi.doUnmock('node:child_process');
    vi.doUnmock('node:os');

    const fsReal = await vi.importActual<typeof import('node:fs')>('node:fs');
    const pathReal = await vi.importActual<typeof import('node:path')>('node:path');
    const osReal = await vi.importActual<typeof import('node:os')>('node:os');

    const savedHome = process.env.HOME;
    const savedUserProfile = process.env.USERPROFILE;
    const tmpHome = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'apra-fleet-eft86-2-home-'));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;

    try {
      // Re-import fresh (module-cache-cleared) copies so config.js's
      // FLEET_BASE = path.join(os.homedir(), '.apra-fleet') is computed against
      // tmpHome, not whatever HOME was set to when this file's earlier suites
      // first loaded config.js.
      const installReal = await vi.importActual<typeof import('../src/cli/install.js')>('../src/cli/install.js');
      const wfAssetsReal = await vi.importActual<typeof import('../src/cli/workflow-assets.js')>('../src/cli/workflow-assets.js');
      const workflowReal = await vi.importActual<typeof import('../src/cli/workflow.js')>('../src/cli/workflow.js');
      const configReal = await vi.importActual<typeof import('../src/cli/config.js')>('../src/cli/config.js');

      expect(configReal.WORKFLOWS_DIR).toBe(pathReal.join(tmpHome, '.apra-fleet', 'workflows'));

      const testDir = pathReal.dirname(fileURLToPath(import.meta.url));
      const projectRoot = pathReal.resolve(testDir, '..');
      const manifest = installReal._buildDevManifestForTest(projectRoot);
      expect(wfAssetsReal.hasWorkflowSubsystemAssets(manifest as any)).toBe(true);

      wfAssetsReal.extractWorkflowSubsystemAssets({
        manifest: manifest as any,
        extractAssetBuffer: (key: string) => fsReal.readFileSync(pathReal.join(projectRoot, key)),
        version: '0.0.0-eft86-2-test',
        includeBuiltins: true,
      });

      expect(fsReal.existsSync(configReal.WORKFLOWS_DIR)).toBe(true);
      const fleetSprintDir = pathReal.join(configReal.WORKFLOWS_DIR, 'fleet-sprint');
      expect(fsReal.existsSync(fleetSprintDir)).toBe(true);

      const deps = {
        workflowsDir: configReal.WORKFLOWS_DIR,
        exists: (p: string) => fsReal.existsSync(p),
        readFile: (p: string) => fsReal.readFileSync(p, 'utf-8'),
      } as any;

      // Must not throw "workflow \"fleet-sprint\" not found" / any WorkflowError.
      const entry = workflowReal.resolveWorkflowEntry(deps, 'fleet-sprint');
      expect(fsReal.existsSync(entry)).toBe(true);
    } finally {
      if (savedHome !== undefined) process.env.HOME = savedHome;
      else delete process.env.HOME;
      if (savedUserProfile !== undefined) process.env.USERPROFILE = savedUserProfile;
      else delete process.env.USERPROFILE;
      fsReal.rmSync(tmpHome, { recursive: true, force: true });
    }
  }, 20000);
});

// apra-fleet-kuh.2 -- regression coverage for the npm-installed-tree path
// resolution bug. buildDevManifest() runs at `apra-fleet install` time inside a
// REAL npm install, where root is node_modules/@apralabs/apra-fleet and npm
// HOISTS the workflow-runtime deps (ajv, undici, fast-uri, ...) up to a PARENT
// node_modules. The pre-fix code probed a fixed root/node_modules/<dep>, which
// misses every hoisted dep, so the workflowRuntime section failed its existsSync
// gate and silently dropped out -- leaving `apra-fleet workflow fleet-sprint`
// dead with no error. resolveNodeModulesDir() walks the node_modules chain up
// from root like Node's own resolver, finding the deps wherever npm placed them.
//
// This fixture reproduces the exact hoisted layout (deps at
// <parent>/node_modules/<dep>, package at <parent>/node_modules/@apralabs/apra-fleet)
// so the assertion pins the real breakage rather than this repo's dev-checkout
// layout (where nothing is hoisted above the root and the bug is invisible).
describe('buildDevManifest resolves hoisted node_modules deps (regression for apra-fleet-kuh.2)', () => {
  afterEach(() => {
    vi.doMock('node:fs');
    vi.doMock('node:child_process');
  });

  it('populates workflowRuntime from a hoisted (npm-installed) layout, and every value resolves via join(root, value)', async () => {
    vi.resetModules();
    vi.doUnmock('node:fs');
    vi.doUnmock('node:child_process');

    const real = await vi.importActual<typeof import('../src/cli/install.js')>('../src/cli/install.js');
    const fsReal = await vi.importActual<typeof import('node:fs')>('node:fs');
    const pathReal = await vi.importActual<typeof import('node:path')>('node:path');
    const osReal = await vi.importActual<typeof import('node:os')>('node:os');

    const parent = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'apra-fleet-kuh2-npm-'));
    try {
      // Deps HOISTED to the top-level node_modules (npm's real behavior for a
      // single installed package). Each gets a package.json so collectPackageTree
      // has a file to emit.
      const HOISTED_DEPS = ['ajv', 'fast-deep-equal', 'fast-uri', 'json-schema-traverse', 'require-from-string', 'undici'];
      for (const dep of HOISTED_DEPS) {
        const d = pathReal.join(parent, 'node_modules', dep);
        fsReal.mkdirSync(d, { recursive: true });
        fsReal.writeFileSync(pathReal.join(d, 'package.json'), JSON.stringify({ name: dep, version: '0.0.0' }));
        fsReal.writeFileSync(pathReal.join(d, 'index.js'), `module.exports = ${JSON.stringify(dep)};\n`);
      }

      // The installed package root -- node_modules/@apralabs/apra-fleet, with NO
      // node_modules of its own (the pre-fix root/node_modules/<dep> probe fails here).
      const root = pathReal.join(parent, 'node_modules', '@apralabs', 'apra-fleet');
      fsReal.mkdirSync(root, { recursive: true });

      // Unconditional buildDevManifest() inputs (read without an existsSync guard).
      fsReal.mkdirSync(pathReal.join(root, 'hooks'), { recursive: true });
      fsReal.writeFileSync(pathReal.join(root, 'hooks', 'noop.sh'), '#!/bin/sh\n');
      fsReal.mkdirSync(pathReal.join(root, 'scripts'), { recursive: true });
      fsReal.writeFileSync(pathReal.join(root, 'scripts', 'fleet-statusline.sh'), '#!/bin/sh\n');
      fsReal.writeFileSync(pathReal.join(root, 'version.json'), JSON.stringify({ version: '0.0.0-kuh2-fixture' }));

      // First-party workflow-runtime packages -- shipped under root/packages/ by the
      // files allowlist (src/ + package.json, the latter needed for their exports maps).
      for (const pkg of ['apra-fleet-workflow', 'apra-fleet-client']) {
        const base = pathReal.join(root, 'packages', pkg);
        fsReal.mkdirSync(pathReal.join(base, 'src'), { recursive: true });
        fsReal.writeFileSync(pathReal.join(base, 'package.json'), JSON.stringify({ name: `@apralabs/${pkg}`, type: 'module', main: 'src/index.mjs' }));
        fsReal.writeFileSync(pathReal.join(base, 'src', 'index.mjs'), 'export const ok = true;\n');
      }

      // Pre-fix probe target must be absent -- this is what silently disabled the section.
      expect(fsReal.existsSync(pathReal.join(root, 'node_modules', 'ajv'))).toBe(false);

      const manifest = real._buildDevManifestForTest(root);

      // The section must be populated despite the deps being hoisted above root.
      expect(manifest.workflowRuntime).toBeDefined();
      const keys = Object.keys(manifest.workflowRuntime!);
      // Both first-party packages AND every hoisted dep are represented.
      expect(keys.some((k) => k.startsWith('@apralabs/apra-fleet-workflow/'))).toBe(true);
      expect(keys.some((k) => k.startsWith('@apralabs/apra-fleet-client/'))).toBe(true);
      for (const dep of HOISTED_DEPS) {
        expect(keys.some((k) => k.startsWith(`${dep}/`)), `workflowRuntime must include hoisted dep '${dep}'`).toBe(true);
      }

      // Every manifest value is a root-relative disk path (with `../` segments for
      // hoisted deps) that must resolve back to a real file via join(root, value) --
      // the exact dev-mode extractAsset() contract.
      for (const [key, diskVal] of Object.entries(manifest.workflowRuntime!)) {
        const full = pathReal.join(root, diskVal);
        expect(fsReal.existsSync(full), `workflowRuntime['${key}'] (${diskVal}) must resolve on disk`).toBe(true);
      }
    } finally {
      fsReal.rmSync(parent, { recursive: true, force: true });
    }
  });
});
