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
    await runInstall(['--llm', 'gemini', '--skill', 'none']);

    const writeCall = vi.mocked(fs.writeFileSync).mock.calls.find(c => c[0] === configPath);
    const data = JSON.parse(writeCall![1] as string);
    expect(data.providers.gemini.skill).toBe('none');
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
      const ps = p.toString();
      if (ps.includes('version.json')) return true;
      if (ps.includes('hooks-config.json')) return true;
      if (ps.includes('apra-pm') && ps.includes('agents')) return true;
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
    setup('gemini');
    await runInstall(['--llm', 'gemini']);

    const writtenPaths = vi.mocked(fs.writeFileSync).mock.calls.map(c => c[0].toString());
    expect(writtenPaths.some(p => p.includes('auto-sprint-args'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// npm dist-fallback coverage: when packages/apra-fleet-se/apra-pm is absent (npm-published
// package, no submodule checked out), install falls back to the vendored
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
      if (ps.includes('apra-pm')) return false; // no submodule -- npm install
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
      if (ps.includes('apra-pm')) return false; // no submodule -- npm install
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

    // npm install -g @beads/bd@1.0.4 should NOT have been called
    const npmCall = vi.mocked(execFileSync).mock.calls.find(
      c => c[0] === 'npm' && Array.isArray(c[1]) && c[1].includes('@beads/bd@1.0.4')
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
