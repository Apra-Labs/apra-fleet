/**
 * AGY explicit project binding (docs/compose-permissions-design.md section 8):
 * `agy --new-project` creates the member's project, its id is stored as
 * Agent.agyProjectId, compose_permissions writes only that project's file, and
 * every dispatch passes `--project <id>`.
 *
 * The member-side scripts are executed for real (LocalStrategy / bash), with a
 * node stand-in for the agy binary (tests/fixtures/fake-agy.cjs) that behaves
 * the way agy 1.2.11 was observed to: it creates <uuid>.json and logs
 * `created project "<name>" (id=<uuid>)` to --log-file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent, getAgent } from '../src/services/registry.js';
import { getStrategy } from '../src/services/strategy.js';
import {
  ensureAgyProject,
  provisionAgyProject,
  parseAgyNewProjectResult,
  parseAgyProjectProbe,
  buildAgyNewProjectScript,
  buildAgyProjectProbeScript,
  isValidAgyProjectId,
  setAgyCommandForTests,
  AgyProjectError,
} from '../src/services/agy-project.js';
import { buildAgyNodeCommand, AgyProvider } from '../src/providers/agy.js';
import { getOsCommands } from '../src/os/index.js';
import { getProvider } from '../src/providers/index.js';
import type { Agent } from '../src/types.js';

const HOST_OS: 'windows' | 'macos' | 'linux' =
  process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
const FAKE_AGY = path.resolve(__dirname, 'fixtures', 'fake-agy.cjs');
function fakeAgy(opts: { mode?: string; argsFile?: string } = {}): { file: string; args: string[] } {
  const args = [FAKE_AGY, '--fake-home', fakeHome];
  if (opts.mode) args.push('--fake-mode', opts.mode);
  if (opts.argsFile) args.push('--fake-args-file', opts.argsFile);
  return { file: process.execPath, args };
}

const scratchDirs: string[] = [];
function makeScratch(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

function projectsDir(home: string): string {
  return path.join(home, '.gemini', 'config', 'projects');
}

function listProjects(home: string): string[] {
  try {
    return fs.readdirSync(projectsDir(home)).sort();
  } catch {
    return [];
  }
}

let fakeHome: string;

beforeEach(() => {
  backupAndResetRegistry();
  fakeHome = makeScratch('fleet-agy-proj-home-');
  vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
});

afterEach(() => {
  restoreRegistry();
  vi.restoreAllMocks();
  setAgyCommandForTests(undefined);
  for (const dir of scratchDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  }
});

function localAgyAgent(overrides: Partial<Agent> = {}): Agent {
  return makeTestAgent({
    friendlyName: 'agy-proj',
    agentType: 'local',
    host: undefined,
    port: undefined,
    username: undefined,
    authType: undefined,
    encryptedPassword: undefined,
    llmProvider: 'agy',
    os: HOST_OS,
    workFolder: makeScratch('fleet-agy-proj-work-'),
    ...overrides,
  });
}

const res = (stdout: string, code = 0, stderr = '') => ({ stdout, stderr, code });

describe('parseAgyNewProjectResult -- exactly one confirmed id', () => {
  const id = '1afd6dbb-498f-4918-a9d9-6da64b75a204';
  const line = (o: object) => `noise\nFLEET_AGY_NEW_PROJECT:${JSON.stringify(o)}\n`;

  it('returns the single new id when agy\'s log names the same id', () => {
    expect(parseAgyNewProjectResult(res(line({ created: [id], logIds: [id], status: 0 })))).toBe(id);
  });

  it('fails when no project file was created', () => {
    expect(() => parseAgyNewProjectResult(res(line({ created: [], logIds: [], status: 0 }))))
      .toThrow(/exactly one project file .* found 0/);
  });

  it('fails when two project files appeared (never guesses)', () => {
    expect(() => parseAgyNewProjectResult(res(line({ created: [id, 'e7160b25-85b1-499b-96bd-525fa3156179'], logIds: [id], status: 0 }))))
      .toThrow(/found 2/);
  });

  it('fails when agy\'s log does not confirm the new file\'s id', () => {
    expect(() => parseAgyNewProjectResult(res(line({ created: [id], logIds: ['d05acf31-20d9-4102-8642-347a062c8997'], status: 0 }))))
      .toThrow(/refusing to bind an unconfirmed project id/);
    expect(() => parseAgyNewProjectResult(res(line({ created: [id], logIds: [], status: 0 }))))
      .toThrow(/no created project/);
  });

  it('fails when agy exited nonzero or could not start', () => {
    expect(() => parseAgyNewProjectResult(res(line({ created: [id], logIds: [id], status: 1, stderrTail: 'boom' }))))
      .toThrow(/agy exited 1: boom/);
    expect(() => parseAgyNewProjectResult(res(line({ created: [], logIds: [], status: null, spawnError: 'spawn agy ENOENT' }))))
      .toThrow(/agy could not be started: spawn agy ENOENT/);
  });

  it('fails when the member-side script produced no result line', () => {
    expect(() => parseAgyNewProjectResult(res('', 1, 'node: command not found'))).toThrow(AgyProjectError);
  });
});

describe('parseAgyProjectProbe', () => {
  it('reads each state and rejects missing output', () => {
    for (const state of ['ok', 'missing', 'corrupt', 'id_mismatch']) {
      expect(parseAgyProjectProbe(res(`FLEET_AGY_PROJECT:${JSON.stringify({ state })}`))).toBe(state);
    }
    expect(() => parseAgyProjectProbe(res('garbage'))).toThrow(/probe produced no result/);
  });

  it('refuses ids that are not plain uuids before embedding them in a script', () => {
    expect(isValidAgyProjectId('1afd6dbb-498f-4918-a9d9-6da64b75a204')).toBe(true);
    expect(isValidAgyProjectId('../default-cli-project')).toBe(false);
    expect(isValidAgyProjectId('a b')).toBe(false);
    expect(() => buildAgyProjectProbeScript('x"; rm -rf /')).toThrow(AgyProjectError);
  });
});

describe('member-side scripts use no shell-variable expansion', () => {
  it('resolves home in node (os.homedir) and spawns agy without a shell', () => {
    const script = buildAgyNewProjectScript({ workFolder: '/home/u/repo', model: 'm' });
    expect(script).toContain("require('os').homedir()");
    expect(script).toContain('cp.spawnSync(');
    expect(script).not.toMatch(/\$HOME|\$env:|~\//);
    expect(script).not.toContain('shell: true');
    const probe = buildAgyProjectProbeScript('1afd6dbb-498f-4918-a9d9-6da64b75a204');
    expect(probe).not.toMatch(/\$HOME|\$env:|~\//);
    // Windows delivery is the encoded-PowerShell wrapper (Windows-safe).
    expect(buildAgyNodeCommand(script, 'windows')).toMatch(/^powershell -EncodedCommand [A-Za-z0-9+/=]+$/);
    expect(buildAgyNodeCommand(script, 'linux')).toMatch(/^cat << 'FLEET_NODE_EOF' \| node --input-type=commonjs -\n/);
  });

  it('passes --new-project, --log-file and a no-tools prompt to agy', () => {
    const script = buildAgyNewProjectScript({ workFolder: 'C:\\w', model: 'gemini-3.8-flash-low' });
    expect(script).toContain('"--new-project"');
    expect(script).toContain('"--log-file"');
    expect(script).toContain('"--output-format","json"');
    expect(script).toContain('Do not use any tools.');
    expect(script).not.toContain('--dangerously-skip-permissions');
  });
});

describe('provisionAgyProject -- real script runs', { timeout: 60000 }, () => {
  it('creates exactly one project and returns the id agy logged (host shell)', async () => {
    const agent = localAgyAgent();
    const argsFile = path.join(makeScratch('fleet-agy-args-'), 'args.jsonl');
    const id = await provisionAgyProject(agent, undefined, fakeAgy({ argsFile }));
    expect(isValidAgyProjectId(id)).toBe(true);
    expect(listProjects(fakeHome)).toEqual([`${id}.json`]);
    const project = JSON.parse(fs.readFileSync(path.join(projectsDir(fakeHome), `${id}.json`), 'utf-8'));
    expect(project.id).toBe(id);
    const argv = JSON.parse(fs.readFileSync(argsFile, 'utf-8').trim());
    expect(argv).toContain('--new-project');
    expect(argv[argv.indexOf('--add-dir') + 1]).toBe(agent.workFolder);
    // the log file is removed after the id is read from it
    expect(fs.existsSync(argv[argv.indexOf('--log-file') + 1])).toBe(false);
  });

  it('runs through LocalStrategy for Windows gitbash and PowerShell members', async () => {
    if (process.platform !== 'win32') return;
    for (const shell of ['gitbash', undefined] as const) {
      const agent = localAgyAgent({ os: 'windows', shell });
      const strategy = getStrategy(agent);
      const id = await provisionAgyProject(agent, (c, t) => strategy.execCommand(c, t), fakeAgy());
      expect(listProjects(fakeHome)).toContain(`${id}.json`);
    }
  });

  it('runs the POSIX heredoc form under bash', async () => {
    const agent = localAgyAgent({ os: 'linux' });
    const exec = async (cmd: string) => {
      try {
        return { stdout: execSync('bash', { input: cmd, encoding: 'utf-8' }), stderr: '', code: 0 };
      } catch (e: any) {
        if (e.code === 'ENOENT') return undefined as any;
        throw e;
      }
    };
    const probe = await exec('echo ok');
    if (!probe) return; // no bash on this host
    const id = await provisionAgyProject(agent, exec, fakeAgy());
    expect(listProjects(fakeHome)).toEqual([`${id}.json`]);
  });

  it('fails loudly on zero, two, or unconfirmed new projects', async () => {
    const agent = localAgyAgent();
    await expect(provisionAgyProject(agent, undefined, fakeAgy({ mode: 'none' }))).rejects.toThrow(/found 0/);
    await expect(provisionAgyProject(agent, undefined, fakeAgy({ mode: 'two' }))).rejects.toThrow(/found 2/);
    await expect(provisionAgyProject(agent, undefined, fakeAgy({ mode: 'mismatch' }))).rejects.toThrow(/unconfirmed/);
    await expect(provisionAgyProject(agent, undefined, fakeAgy({ mode: 'fail' }))).rejects.toThrow(/agy exited 3/);
  });

  it('never spawns the real agy under the test suite when no stand-in is set', async () => {
    const agent = localAgyAgent();
    await expect(provisionAgyProject(agent)).rejects.toThrow(/agy exited 97/);
    expect(listProjects(fakeHome)).toEqual([]);
  });

  it('serializes concurrent provisioning on one machine so each member gets its own id', async () => {
    const a = localAgyAgent({ friendlyName: 'agy-a' });
    const b = localAgyAgent({ friendlyName: 'agy-b' });
    const [idA, idB] = await Promise.all([
      provisionAgyProject(a, undefined, fakeAgy()),
      provisionAgyProject(b, undefined, fakeAgy()),
    ]);
    expect(idA).not.toBe(idB);
    expect(listProjects(fakeHome)).toEqual([`${idA}.json`, `${idB}.json`].sort());
  });
});

describe('ensureAgyProject -- upgrade path and self-heal', { timeout: 60000 }, () => {
  beforeEach(() => setAgyCommandForTests(fakeAgy()));

  it('provisions and persists an id for an agy member registered without one', async () => {
    const agent = localAgyAgent();
    addAgent(agent);
    const r = await ensureAgyProject(agent);
    expect(r.provisioned).toBe('no_project_id');
    expect(getAgent(agent.id)?.agyProjectId).toBe(r.projectId);
    expect(agent.agyProjectId).toBe(r.projectId);
  });

  it('keeps a valid id without running agy', async () => {
    const agent = localAgyAgent();
    addAgent(agent);
    const first = await ensureAgyProject(agent);
    const argsFile = path.join(makeScratch('fleet-agy-args-'), 'args.jsonl');
    setAgyCommandForTests(fakeAgy({ argsFile }));
    const second = await ensureAgyProject(agent);
    expect(second).toEqual({ projectId: first.projectId });
    expect(fs.existsSync(argsFile)).toBe(false);
  });

  it('re-provisions when the project file is missing, corrupt, or names another id', async () => {
    const agent = localAgyAgent();
    addAgent(agent);
    const { projectId } = await ensureAgyProject(agent);
    const file = path.join(projectsDir(fakeHome), `${projectId}.json`);

    fs.rmSync(file);
    const afterMissing = await ensureAgyProject(agent);
    expect(afterMissing.provisioned).toBe('missing');
    expect(afterMissing.projectId).not.toBe(projectId);

    fs.writeFileSync(path.join(projectsDir(fakeHome), `${afterMissing.projectId}.json`), 'not json{');
    const afterCorrupt = await ensureAgyProject(agent);
    expect(afterCorrupt.provisioned).toBe('corrupt');

    fs.writeFileSync(path.join(projectsDir(fakeHome), `${afterCorrupt.projectId}.json`), JSON.stringify({ id: 'someone-else' }));
    const afterMismatch = await ensureAgyProject(agent);
    expect(afterMismatch.provisioned).toBe('id_mismatch');
    expect(getAgent(agent.id)?.agyProjectId).toBe(afterMismatch.projectId);
  });

  it('does not write the registry when persist is false (register_member path)', async () => {
    const agent = localAgyAgent();
    const r = await ensureAgyProject(agent, { persist: false });
    expect(agent.agyProjectId).toBe(r.projectId);
    expect(getAgent(agent.id)).toBeUndefined();
  });

  it('refuses non-agy members', async () => {
    await expect(ensureAgyProject(localAgyAgent({ llmProvider: 'claude' }))).rejects.toThrow(/not an agy member/);
  });
});

describe('AgyProvider -- dispatch always binds --project', () => {
  const agy = new AgyProvider();

  it('adds --project <id> to the POSIX prompt command', () => {
    const cmd = agy.buildPromptCommand({ folder: '/w', promptFile: 'p.md', projectId: '1afd6dbb-498f-4918-a9d9-6da64b75a204' });
    expect(cmd).toContain('agy --add-dir "/w" --project "1afd6dbb-498f-4918-a9d9-6da64b75a204" --model');
  });

  it('adds --project <id> on every OS command path (PowerShell, gitbash, linux)', () => {
    const opts = { folder: 'C:\\w', promptFile: 'p.md', projectId: '1afd6dbb-498f-4918-a9d9-6da64b75a204' };
    for (const [os_, shell] of [['windows', undefined], ['windows', 'gitbash'], ['linux', undefined]] as const) {
      const cmd = getOsCommands(os_, shell).buildAgentPromptCommand(agy, opts as any);
      expect(cmd).toContain('--project "1afd6dbb-498f-4918-a9d9-6da64b75a204"');
      expect(() => getOsCommands(os_, shell).buildAgentPromptCommand(agy, { ...opts, projectId: undefined } as any)).toThrow();
    }
  });

  it('leaves other providers\' Windows and POSIX dispatch commands byte-identical when a projectId is present', () => {
    for (const name of ['claude', 'codex', 'copilot', 'opencode'] as const) {
      const p = getProvider(name);
      for (const [os_, shell] of [['windows', undefined], ['windows', 'gitbash'], ['linux', undefined]] as const) {
        const base = { folder: '/w', promptFile: 'p.md', sessionId: 's-1' };
        expect(getOsCommands(os_, shell).buildAgentPromptCommand(p, { ...base, projectId: 'x' } as any))
          .toBe(getOsCommands(os_, shell).buildAgentPromptCommand(p, base as any));
      }
    }
  });

  it('throws instead of dispatching without a project id', () => {
    expect(() => agy.buildPromptCommand({ folder: '/w', promptFile: 'p.md' })).toThrow(/without a valid agy project id/);
    expect(() => agy.projectFlag(undefined)).toThrow();
    expect(() => agy.projectFlag('bad id')).toThrow();
  });

  it('permissionConfigPaths names only the member\'s own project file', () => {
    const agent = localAgyAgent({ agyProjectId: '1afd6dbb-498f-4918-a9d9-6da64b75a204' });
    expect(agy.permissionConfigPaths(agent)).toEqual(['~/.gemini/config/projects/1afd6dbb-498f-4918-a9d9-6da64b75a204.json']);
    expect(() => agy.permissionConfigPaths(localAgyAgent())).toThrow(/no agy project id/);
    expect(() => agy.permissionConfigPaths(undefined)).toThrow();
  });

  it('composePermissionConfig emits only the nested permissionGrants block', () => {
    const agent = localAgyAgent({ agyProjectId: '1afd6dbb-498f-4918-a9d9-6da64b75a204', os: 'linux' });
    const [cfg] = agy.composePermissionConfig('reviewer', ['Read', 'Bash(git:*)'], agent) as Array<Record<string, any>>;
    expect(Object.keys(cfg)).toEqual(['permissionGrants']);
    expect(Object.keys(cfg.permissionGrants)).toEqual(['permissionGrants']);
    expect(cfg.permissionGrants.permissionGrants.allow).toEqual(['read_file(*)', 'command(git)']);
    expect(cfg.permissionGrants.permissionGrants.deny).toContain('mcp(apra-fleet/remove_member)');
  });

  it('seeds no workspace trust', async () => {
    const exec = vi.fn();
    const r = await agy.ensureWorkspaceTrusted('/w', exec as any, 'linux');
    expect(r.seeded).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('folder-matching leftovers are gone', () => {
  it('has no references to the deleted folder-matching code in src/', () => {
    const srcDir = path.resolve(__dirname, '..', 'src');
    const banned = [
      'purgeConflictingProjects', 'buildAgyPurgeScript', 'buildAgyPurgeCommand', 'cleanGlobalAgySettings',
      'requiresGitAwareness', 'detectIsGit', 'toAgyFileUri', 'normalizeAgyUri', 'fleet-${agent.id}',
    ];
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (/\.(ts|js|mjs)$/.test(entry.name)) {
          const text = fs.readFileSync(p, 'utf-8');
          for (const b of banned) if (text.includes(b)) hits.push(`${path.relative(srcDir, p)}: ${b}`);
        }
      }
    };
    walk(srcDir);
    expect(hits).toEqual([]);
  });
});
