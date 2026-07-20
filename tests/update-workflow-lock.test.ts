import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInstall, _setSeaOverride, _setManifestOverride } from '../src/cli/install.js';

// apra-fleet-7pm.10 -- update-time lock test (test only, no code change to
// install.ts/workflow-assets.ts). runUpdate() re-invokes `install --force
// --llm <llm> --skill <skill> --workflows <mode>` (see src/cli/update.ts);
// this exercises that exact re-invoked install path with a locked built-in
// workflow directory to confirm the EBUSY retry/skip behavior 7pm.5
// implemented for install.ts also holds when triggered via an update, not
// just a fresh install. See docs/workflow-subsystem-plan.md Section 6.
//
// This test does NOT touch src/cli/install.ts or src/cli/config.ts -- it only
// imports and exercises the existing runInstall() surface, mirroring the
// EBUSY scenario already covered for a plain install in
// tests/install-workflows.test.ts.

vi.mock('node:os', () => ({
  default: {
    homedir: vi.fn(() => '/mock/home'),
    platform: vi.fn(() => 'linux'),
  }
}));
vi.mock('node:fs');
vi.mock('node:child_process');

const mockHome = '/mock/home';
const WORKFLOWS_DIR = path.join(mockHome, '.apra-fleet', 'workflows');

const NEW_MANIFEST = {
  version: '0.1.0', hooks: {}, scripts: {}, skills: {}, fleetSkills: {}, agents: {}, workflows: {},
  workflowRuntime: {
    '@apralabs/apra-fleet-workflow/package.json': '@apralabs/apra-fleet-workflow/package.json',
  },
  agentSchemas: {
    'agentSchemas/pm.schema.json': 'vendor/apra-pm/agents/schemas/pm.schema.json',
  },
  builtinWorkflows: {
    'auto-sprint/workflow.json': 'auto-sprint/workflow.json',
    'auto-sprint/main.mjs': 'auto-sprint/main.mjs',
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

describe('update-triggered re-install: EBUSY handling on a locked built-in workflow directory', () => {
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

  it('a re-invoked install --force with a locked built-in dir warns + skips that dir instead of failing the update', async () => {
    const autoSprintDest = path.join(WORKFLOWS_DIR, 'auto-sprint');
    vi.mocked(fs.renameSync).mockImplementation(((_src: any, dest: any) => {
      if (dest === autoSprintDest) {
        const err: NodeJS.ErrnoException = new Error('resource busy or locked');
        err.code = 'EBUSY';
        throw err;
      }
      return undefined as any;
    }) as any);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Mirrors exactly the argv runUpdate() spawns for the re-invoked installer
    // (src/cli/update.ts: ['install', '--force', '--llm', <llm>, '--skill', <skill>, '--workflows', <mode>]).
    await expect(
      runInstall(['--force', '--llm', 'claude', '--skill', 'none', '--workflows', 'all'])
    ).resolves.toBeUndefined();

    const warns = warnSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(warns).toContain('workflows/auto-sprint');
    expect(warns).toContain('locked');

    // hello-world (not locked) still got its rename call through -- only the
    // locked directory is skipped, the rest of the update proceeds normally.
    const helloWorldDest = path.join(WORKFLOWS_DIR, 'hello-world');
    const renameCalls = vi.mocked(fs.renameSync).mock.calls;
    expect(renameCalls.some(c => c[1] === helloWorldDest)).toBe(true);

    warnSpy.mockRestore();
  }, 10000);
});
