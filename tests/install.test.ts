import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runInstall, _setSeaOverride, _setManifestOverride } from '../src/cli/install.js';

vi.mock('node:os', () => ({
  default: {
    homedir: vi.fn(() => '/mock/home'),
    platform: vi.fn(() => 'linux'),
  }
}));
vi.mock('node:fs');
vi.mock('node:child_process');

// apra-fleet-le1.1.3: install.ts imports isCodeIntelEnabled/writeRepoCodeIntelConfig
// directly from repo-config.js, which reads/writes via 'fs/promises' -- NOT
// the 'node:fs' mocked above. A node:fs mock does not intercept fs/promises
// calls (see apra-fleet-tm7.22), so without mocking this module directly,
// those two calls would perform real disk I/O against process.cwd() (the
// real repoCwd) every time a test makes isGitRepo true. Mocking the module
// keeps every test in this file writing nowhere real.
const mockIsCodeIntelEnabled = vi.hoisted(() => vi.fn());
const mockWriteRepoCodeIntelConfig = vi.hoisted(() => vi.fn());

vi.mock('../src/services/knowledge/repo-config.js', () => ({
  isCodeIntelEnabled: mockIsCodeIntelEnabled,
  writeRepoCodeIntelConfig: mockWriteRepoCodeIntelConfig,
}));

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
    await runInstall(['--llm', 'copilot', '--skill', 'none']);

    const writeCall = vi.mocked(fs.writeFileSync).mock.calls.find(c => c[0] === configPath);
    const data = JSON.parse(writeCall![1] as string);
    expect(data.providers.copilot.skill).toBe('none');
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

describe('dev-mode agent install carries nested agents/schemas and agents/_shared (GAP A)', () => {
  const mockHome = '/mock/home';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHome);

    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const ps = p.toString().replace(/\\/g, '/');
      if (ps.includes('version.json')) return true;
      if (ps.includes('hooks-config.json')) return true;
      // Match the apra-pm package by its full package path, not a bare
      // "apra-pm" substring: an invoking path such as .../vendor-sync-apra-pm/...
      // or a checkout under a dir literally named apra-pm must NOT be treated
      // as the package directory (see apra-fleet-c96).
      if (/apra-fleet-se\/apra-pm(\/|$)/.test(ps) && ps.includes('agents')) return true;
      return false;
    });

    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (ps.includes('version.json')) return JSON.stringify({ version: '0.1.0' });
      if (ps.includes('hooks-config.json')) return JSON.stringify({ hooks: { PostToolUse: [] } });
      if (ps.replace(/\\/g, '/').endsWith('agents/schemas/doer-output.json')) return '{"type":"object"}';
      if (ps.replace(/\\/g, '/').endsWith('agents/_shared/GRAPH-SEMANTICS.md')) return '# Graph semantics';
      if (ps.replace(/\\/g, '/').endsWith('agents/doer.md')) {
        return '---\nname: doer\ndescription: Does work\ntools: [Read, Edit, Write, Bash]\n---\nDoer body';
      }
      return '';
    });

    vi.mocked(fs.readdirSync).mockImplementation((p: any) => {
      const ps = p.toString().replace(/\\/g, '/');
      if (ps.endsWith('packages/apra-fleet-se/apra-pm/agents')) {
        return [
          { name: 'doer.md', isDirectory: () => false },
          { name: 'schemas', isDirectory: () => true },
          { name: '_shared', isDirectory: () => true },
        ] as any;
      }
      if (ps.endsWith('packages/apra-fleet-se/apra-pm/agents/schemas')) {
        return [{ name: 'doer-output.json', isDirectory: () => false }] as any;
      }
      if (ps.endsWith('packages/apra-fleet-se/apra-pm/agents/_shared')) {
        return [{ name: 'GRAPH-SEMANTICS.md', isDirectory: () => false }] as any;
      }
      return [];
    });

    vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
    vi.mocked(fs.chmodSync).mockImplementation(() => {});
    vi.mocked(fs.copyFileSync).mockImplementation(() => {});
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    _setSeaOverride(false);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    _setSeaOverride(null);
    _setManifestOverride(null);
  });

  it('writes nested agents/schemas/*.json and agents/_shared/*.md under the agents dest dir', async () => {
    await runInstall([]);

    const agentsDestDir = path.join(mockHome, '.claude', 'agents');
    const writtenPaths = vi.mocked(fs.writeFileSync).mock.calls.map(c => c[0].toString());

    expect(writtenPaths).toContain(path.join(agentsDestDir, 'schemas', 'doer-output.json'));
    expect(writtenPaths).toContain(path.join(agentsDestDir, '_shared', 'GRAPH-SEMANTICS.md'));
    expect(writtenPaths).toContain(path.join(agentsDestDir, 'doer.md'));
  });
});

describe('auto-sprint-args skill install (GAP B)', () => {
  const mockHome = '/mock/home';

  function setup(llm: string) {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHome);

    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (ps.includes('version.json')) return true;
      if (ps.includes('hooks-config.json')) return true;
      if (ps.replace(/\\/g, '/').includes('packages/apra-fleet-se/apra-pm/.claude/skills/auto-sprint-args')) return true;
      return false;
    });

    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (ps.includes('version.json')) return JSON.stringify({ version: '0.1.0' });
      if (ps.includes('hooks-config.json')) return JSON.stringify({ hooks: { PostToolUse: [] } });
      if (ps.replace(/\\/g, '/').endsWith('auto-sprint-args/SKILL.md')) return '---\nname: auto-sprint-args\n---\nArgs contract';
      return '';
    });

    vi.mocked(fs.readdirSync).mockImplementation((p: any) => {
      const ps = p.toString().replace(/\\/g, '/');
      if (ps.endsWith('packages/apra-fleet-se/apra-pm/.claude/skills/auto-sprint-args')) {
        return [{ name: 'SKILL.md', isDirectory: () => false }] as any;
      }
      return [];
    });

    vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
    vi.mocked(fs.chmodSync).mockImplementation(() => {});
    vi.mocked(fs.copyFileSync).mockImplementation(() => {});
    vi.mocked(fs.rmSync).mockImplementation(() => undefined as any);
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    _setSeaOverride(false);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  }

  afterEach(() => {
    _setSeaOverride(null);
    _setManifestOverride(null);
  });

  it('installs the skill into ~/.claude/skills/auto-sprint-args for claude', async () => {
    setup('claude');
    await runInstall([]);

    const skillDest = path.join(mockHome, '.claude', 'skills', 'auto-sprint-args', 'SKILL.md');
    const writtenPaths = vi.mocked(fs.writeFileSync).mock.calls.map(c => c[0].toString());
    expect(writtenPaths).toContain(skillDest);
  });

  it('does not install the skill for non-claude providers', async () => {
    setup('copilot');
    await runInstall(['--llm', 'copilot']);

    const writtenPaths = vi.mocked(fs.writeFileSync).mock.calls.map(c => c[0].toString());
    expect(writtenPaths.some(p => p.includes('auto-sprint-args'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// npm dist-fallback coverage: when packages/apra-fleet-se/apra-pm is absent (npm-published
// package, apra-pm package dir not present), install falls back to the
// dist/ copies that scripts/dist-pm.mjs produces at publish time. Same GAP
// A/B nested-directory bug applies to this branch independently of the
// vendor/ branch covered above -- both must carry schemas/, _shared/, and the
// auto-sprint-args skill.
// ---------------------------------------------------------------------------

describe('npm dist-fallback: agent install carries nested agents/schemas and agents/_shared', () => {
  const mockHome = '/mock/home';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHome);

    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const ps = p.toString().replace(/\\/g, '/');
      if (ps.includes('version.json')) return true;
      if (ps.includes('hooks-config.json')) return true;
      if (/apra-fleet-se\/apra-pm(\/|$)/.test(ps)) return false; // apra-pm package dir absent (see apra-fleet-c96)
      if (ps.includes('dist/agents')) return true; // matches dist/agents and its schemas/_shared subdirs
      return false;
    });

    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (ps.includes('version.json')) return JSON.stringify({ version: '0.1.0' });
      if (ps.includes('hooks-config.json')) return JSON.stringify({ hooks: { PostToolUse: [] } });
      if (ps.replace(/\\/g, '/').endsWith('dist/agents/schemas/doer-output.json')) return '{"type":"object"}';
      if (ps.replace(/\\/g, '/').endsWith('dist/agents/_shared/GRAPH-SEMANTICS.md')) return '# Graph semantics';
      if (ps.replace(/\\/g, '/').endsWith('dist/agents/doer.md')) {
        return '---\nname: doer\ndescription: Does work\ntools: [Read, Edit, Write, Bash]\n---\nDoer body';
      }
      return '';
    });

    vi.mocked(fs.readdirSync).mockImplementation((p: any) => {
      const ps = p.toString().replace(/\\/g, '/');
      if (ps.endsWith('dist/agents')) {
        return [
          { name: 'doer.md', isDirectory: () => false },
          { name: 'schemas', isDirectory: () => true },
          { name: '_shared', isDirectory: () => true },
        ] as any;
      }
      if (ps.endsWith('dist/agents/schemas')) {
        return [{ name: 'doer-output.json', isDirectory: () => false }] as any;
      }
      if (ps.endsWith('dist/agents/_shared')) {
        return [{ name: 'GRAPH-SEMANTICS.md', isDirectory: () => false }] as any;
      }
      return [];
    });

    vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
    vi.mocked(fs.chmodSync).mockImplementation(() => {});
    vi.mocked(fs.copyFileSync).mockImplementation(() => {});
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    _setSeaOverride(false);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    _setSeaOverride(null);
    _setManifestOverride(null);
  });

  it('writes nested agents/schemas/*.json and agents/_shared/*.md from dist/agents when vendor is absent', async () => {
    await runInstall([]);

    const agentsDestDir = path.join(mockHome, '.claude', 'agents');
    const writtenPaths = vi.mocked(fs.writeFileSync).mock.calls.map(c => c[0].toString());

    expect(writtenPaths).toContain(path.join(agentsDestDir, 'schemas', 'doer-output.json'));
    expect(writtenPaths).toContain(path.join(agentsDestDir, '_shared', 'GRAPH-SEMANTICS.md'));
    expect(writtenPaths).toContain(path.join(agentsDestDir, 'doer.md'));
  });
});

describe('npm dist-fallback: auto-sprint-args skill install', () => {
  const mockHome = '/mock/home';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHome);

    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const ps = p.toString().replace(/\\/g, '/');
      if (ps.includes('version.json')) return true;
      if (ps.includes('hooks-config.json')) return true;
      if (/apra-fleet-se\/apra-pm(\/|$)/.test(ps)) return false; // apra-pm package dir absent (see apra-fleet-c96)
      if (ps.endsWith('dist/skills/auto-sprint-args')) return true;
      return false;
    });

    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (ps.includes('version.json')) return JSON.stringify({ version: '0.1.0' });
      if (ps.includes('hooks-config.json')) return JSON.stringify({ hooks: { PostToolUse: [] } });
      if (ps.replace(/\\/g, '/').endsWith('dist/skills/auto-sprint-args/SKILL.md')) return '---\nname: auto-sprint-args\n---\nArgs contract';
      return '';
    });

    vi.mocked(fs.readdirSync).mockImplementation((p: any) => {
      const ps = p.toString().replace(/\\/g, '/');
      if (ps.endsWith('dist/skills/auto-sprint-args')) {
        return [{ name: 'SKILL.md', isDirectory: () => false }] as any;
      }
      return [];
    });

    vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
    vi.mocked(fs.chmodSync).mockImplementation(() => {});
    vi.mocked(fs.copyFileSync).mockImplementation(() => {});
    vi.mocked(fs.rmSync).mockImplementation(() => undefined as any);
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    _setSeaOverride(false);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    _setSeaOverride(null);
    _setManifestOverride(null);
  });

  it('installs the skill from dist/skills/auto-sprint-args into ~/.claude/skills/auto-sprint-args when vendor is absent', async () => {
    await runInstall([]);

    const skillDest = path.join(mockHome, '.claude', 'skills', 'auto-sprint-args', 'SKILL.md');
    const writtenPaths = vi.mocked(fs.writeFileSync).mock.calls.map(c => c[0].toString());
    expect(writtenPaths).toContain(skillDest);
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

  it('installs Beads when bd not found — step appears in output', async () => {
    // First call: bd --version throws (not installed); second call: npm install succeeds
    vi.mocked(execFileSync)
      .mockImplementationOnce(() => { throw new Error('bd: command not found'); })
      .mockImplementation(() => undefined as any);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runInstall([]);

    const logs = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logs).toContain('Installing Beads task tracker...');

    logSpy.mockRestore();
  });

  it('skips npm install when bd is already installed', async () => {
    // bd --version succeeds — already installed
    vi.mocked(execFileSync).mockReturnValue('bd 1.2.3\n' as any);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runInstall([]);

    const logs = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logs).toContain('Installing Beads task tracker...');

    // npm install -g @beads/bd@1.1.2 should NOT have been called
    const npmCall = vi.mocked(execFileSync).mock.calls.find(
      c => c[0] === 'npm' && Array.isArray(c[1]) && c[1].includes('@beads/bd@1.1.2')
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

// T3.4 (F9b, D8): installer copies the repo's committed
// .fleet/kb-canonical-global.json (when present) into the shared global KB
// data dir so every project on the machine can see it.
describe('install step 9 -- global bible copy (T3.4, F9b, D8)', () => {
  // FLEET_DIR (src/paths.ts) resolves from APRA_FLEET_DATA_DIR (set by
  // tests/setup.ts to a real tmp dir), NOT the mocked os.homedir() -- the env
  // var takes precedence in paths.ts's own resolution order.
  const globalBibleDestDir = path.join(process.env.APRA_FLEET_DATA_DIR!, 'knowledge', 'global');
  const globalBibleDestPath = path.join(globalBibleDestDir, 'kb-canonical-global.json');
  const globalBibleSrcPath = path.join(process.cwd(), '.fleet', 'kb-canonical-global.json');

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHome);
    makeFsMock();
    _setSeaOverride(false);
    _setManifestOverride({ version: '0.1.0', hooks: {}, scripts: {}, skills: {}, fleetSkills: {} });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    _setSeaOverride(null);
    _setManifestOverride(null);
  });

  it('file present -> copied to the shared global KB data dir (content equality via copyFileSync args)', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (ps.includes('version.json')) return true;
      if (ps.includes('hooks-config.json')) return true;
      if (ps === globalBibleSrcPath) return true;
      return false;
    });

    await runInstall([]);

    const copyCall = vi.mocked(fs.copyFileSync).mock.calls.find(c => c[0] === globalBibleSrcPath);
    expect(copyCall).toBeDefined();
    expect(copyCall![1]).toBe(globalBibleDestPath);
  });

  it('absent -> install path unaffected (no copy attempted, install still succeeds)', async () => {
    // Default makeFsMock() already returns false for kb-canonical-global.json.
    await expect(runInstall([])).resolves.toBeUndefined();

    const copyCall = vi.mocked(fs.copyFileSync).mock.calls.find(c => c[0] === globalBibleSrcPath);
    expect(copyCall).toBeUndefined();
  });

  it('target dir is auto-created when the source bible is present', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (ps.includes('version.json')) return true;
      if (ps.includes('hooks-config.json')) return true;
      if (ps === globalBibleSrcPath) return true;
      return false;
    });

    await runInstall([]);

    const mkdirCall = vi.mocked(fs.mkdirSync).mock.calls.find(c => c[0] === globalBibleDestDir);
    expect(mkdirCall).toBeDefined();
    expect(mkdirCall![1]).toEqual({ recursive: true });
  });

  it('copy failure does not throw out of the install step (non-fatal, warns)', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (ps.includes('version.json')) return true;
      if (ps.includes('hooks-config.json')) return true;
      if (ps === globalBibleSrcPath) return true;
      return false;
    });
    vi.mocked(fs.copyFileSync).mockImplementation((src: any) => {
      if (src === globalBibleSrcPath) throw new Error('EACCES: permission denied');
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(runInstall([])).resolves.toBeUndefined();

    const warns = warnSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(warns).toContain('Global knowledge bible copy skipped');
  });
});

// apra-fleet-tm7.22: the KB + code-intelligence step writes two MACHINE-GLOBAL
// artifacts (~/.apra-fleet/data/code-intelligence/config.json and the
// ~/.claude/CLAUDE.md routing block). Those are deliberately NOT gated on the
// per-repo opt-out flag any more -- apra-fleet-le1.1.2's isCodeIntelEnabled
// gate was over-broad (it withheld machine-wide config because ONE repo opted
// out) and install-order dependent, and it was redundant with the per-repo
// runtime check in getProvider() (RepoDisabledProvider). These tests pin that:
// even with the repo opted out, both global artifacts are still written, and
// install never consults isCodeIntelEnabled at all.
// isCodeIntelEnabled/writeRepoCodeIntelConfig are mocked directly (see the
// module-level vi.mock above): they read/write via 'fs/promises', which the
// blanket node:fs mock in this file does NOT intercept, so mocking node:fs
// alone would leave every call here hitting the real filesystem at the real
// process.cwd() (the MOCKING GOTCHA this bead calls out). os.homedir() is
// mocked to /mock/home, so nothing here can touch the real ~/.claude or
// ~/.apra-fleet either.
describe('machine-global code-intelligence setup is not gated on the per-repo opt-out (apra-fleet-tm7.22)', () => {
  const ciConfigPath = path.join(mockHome, '.apra-fleet', 'data', 'code-intelligence', 'config.json');
  const claudeMdPath = path.join(mockHome, '.claude', 'CLAUDE.md');
  const sentinel = '<!-- apra-fleet:code-intelligence -->';

  function setupGitRepo(): void {
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (ps.includes('version.json')) return true;
      if (ps.includes('hooks-config.json')) return true;
      if (ps === path.join(process.cwd(), '.git')) return true; // isGitRepo gate
      return false; // includes claudeMdPath -- no pre-existing file/sentinel
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHome);
    makeFsMock();
    setupGitRepo();
    mockWriteRepoCodeIntelConfig.mockResolvedValue(undefined);
    _setSeaOverride(false);
    _setManifestOverride({ version: '0.1.0', hooks: {}, scripts: {}, skills: {}, fleetSkills: {} });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    _setSeaOverride(null);
    _setManifestOverride(null);
  });

  it('repo opted out (enabled=false): still writes both the provider config.json and the CLAUDE.md routing block', async () => {
    mockIsCodeIntelEnabled.mockResolvedValue(false);

    await runInstall([]);

    const writeCall = vi.mocked(fs.writeFileSync).mock.calls.find(c => c[0] === ciConfigPath);
    expect(writeCall).toBeDefined();
    expect(JSON.parse(writeCall![1] as string)).toEqual({ provider: 'gitnexus' });
    const appendCall = vi.mocked(fs.appendFileSync).mock.calls.find(c => c[0] === claudeMdPath);
    expect(appendCall).toBeDefined();
    expect((appendCall![1] as string)).toContain(sentinel);
  });

  it('--no-code-intel: records the per-repo opt-out but still writes both global artifacts', async () => {
    mockIsCodeIntelEnabled.mockResolvedValue(false);

    await runInstall(['--no-code-intel']);

    expect(mockWriteRepoCodeIntelConfig).toHaveBeenCalledWith(process.cwd(), { enabled: false });
    expect(vi.mocked(fs.writeFileSync).mock.calls.find(c => c[0] === ciConfigPath)).toBeDefined();
    expect(vi.mocked(fs.appendFileSync).mock.calls.find(c => c[0] === claudeMdPath)).toBeDefined();
  });

  it('never reads the per-repo flag: install does not call isCodeIntelEnabled at all', async () => {
    mockIsCodeIntelEnabled.mockResolvedValue(false);

    await runInstall([]);

    expect(mockIsCodeIntelEnabled).not.toHaveBeenCalled();
  });

  it('repo opted in / no config: writes both the provider config.json and the CLAUDE.md routing block', async () => {
    mockIsCodeIntelEnabled.mockResolvedValue(true);

    await runInstall([]);

    const writeCall = vi.mocked(fs.writeFileSync).mock.calls.find(c => c[0] === ciConfigPath);
    expect(writeCall).toBeDefined();
    expect(JSON.parse(writeCall![1] as string)).toEqual({ provider: 'gitnexus' });
    const appendCall = vi.mocked(fs.appendFileSync).mock.calls.find(c => c[0] === claudeMdPath);
    expect(appendCall).toBeDefined();
    expect((appendCall![1] as string)).toContain(sentinel);
  });
});

// apra-fleet-le1.1.3, apra-fleet-le1.1.4: the --code-intel / --no-code-intel
// flags must record the choice via writeRepoCodeIntelConfig(repoCwd, {enabled}),
// and a bare install (neither flag) must not write any config at all -- an
// absent file has to stay distinguishable from an explicit choice (see
// isCodeIntelEnabled's backward-compat default).
describe('--code-intel / --no-code-intel flags record the opt-in/opt-out choice (apra-fleet-le1.1.4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHome);
    makeFsMock();
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (ps.includes('version.json')) return true;
      if (ps.includes('hooks-config.json')) return true;
      if (ps === path.join(process.cwd(), '.git')) return true; // isGitRepo gate
      return false;
    });
    mockIsCodeIntelEnabled.mockResolvedValue(true);
    mockWriteRepoCodeIntelConfig.mockResolvedValue(undefined);
    _setSeaOverride(false);
    _setManifestOverride({ version: '0.1.0', hooks: {}, scripts: {}, skills: {}, fleetSkills: {} });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    _setSeaOverride(null);
    _setManifestOverride(null);
  });

  it('--no-code-intel writes { enabled: false } to <repoCwd>/.apra-fleet/code-intel.json', async () => {
    await runInstall(['--no-code-intel']);

    expect(mockWriteRepoCodeIntelConfig).toHaveBeenCalledWith(process.cwd(), { enabled: false });
  });

  it('--code-intel writes { enabled: true } to <repoCwd>/.apra-fleet/code-intel.json', async () => {
    await runInstall(['--code-intel']);

    expect(mockWriteRepoCodeIntelConfig).toHaveBeenCalledWith(process.cwd(), { enabled: true });
  });

  it('bare install (neither flag) does not write any code-intel config at all', async () => {
    await runInstall([]);

    expect(mockWriteRepoCodeIntelConfig).not.toHaveBeenCalled();
  });
});
