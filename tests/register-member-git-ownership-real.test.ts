/**
 * [test] registration rejects a git-refused folder and accepts a pre-clone one
 * (apra-fleet-wgpx), against REAL temp git repos and the REAL local strategy.
 *
 * Method: a repo's real owner cannot be changed without root, so git is told
 * to treat every repo as foreign-owned with GIT_TEST_ASSUME_DIFFERENT_OWNER=1
 * (git's own switch for its ownership test-suite, honoured by release builds
 * of git >= 2.36). LocalStrategy runs commands under a rebuilt "clean" login
 * env that drops the test process's variables, so the switch is injected AT
 * THE EXEC BOUNDARY: the strategy is the real LocalStrategy wrapped so each
 * command is prefixed with an `export` of the switch (and an empty
 * GIT_CONFIG_GLOBAL so no ambient safe.directory can whitelist the repo).
 * Everything else -- the real git binary, real repos, the real command
 * builders -- is unmodified. Hermetic: temp registry (backupAndResetRegistry)
 * and temp dirs only.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { registerMember } from '../src/tools/register-member.js';
import { getAllAgents } from '../src/services/registry.js';

/** Shell prefix applied to every command the strategy runs; set per test. */
const execPrefix = vi.hoisted(() => ({ value: '' }));

vi.mock('../src/services/strategy.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/services/strategy.js')>();
  return {
    ...orig,
    getStrategy: (agent: never) => {
      const real = orig.getStrategy(agent);
      return new Proxy(real, {
        get(target, prop, recv) {
          if (prop === 'execCommand') {
            return (cmd: string, ...rest: unknown[]) =>
              (target.execCommand as (...a: unknown[]) => unknown)(execPrefix.value + cmd, ...rest);
          }
          const v = Reflect.get(target, prop, recv);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
    },
  };
});

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
}));

// compose_permissions writes (and reads back) a settings file ON THE MEMBER via
// the strategy above; against a fake strategy that read-back can never succeed,
// and register_member correctly refuses to report success when it fails. That
// axis is already covered by register-member.test.ts -- stub it to a success
// here so these cases test the VCS-provider axis alone. The literal is written
// as an escape so this source file stays ASCII (repo convention).
vi.mock('../src/tools/compose-permissions.js', () => ({
  composePermissions: vi.fn(async () => '\u2705 Permissions composed (test stub).'),
}));

// Provisioning role-agent files and seeding workspace trust are separate,
// already-covered SSH round trips that a fake strategy makes slow and
// meaningless here.
vi.mock('../src/services/agent-provisioner.js', () => ({
  provisionAgents: vi.fn(async () => ({ pushed: [], skipped: [], warning: undefined })),
}));
vi.mock('../src/utils/workspace-trust.js', () => ({
  seedWorkspaceTrust: vi.fn(async () => undefined),
}));

import { WindowsCommands } from '../src/os/index.js';
import { classifyGitProbeOutput } from '../src/services/git-access.js';


let tmp: string;

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}
function makeRepo(name: string, origin?: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  if (origin) git(dir, 'remote', 'add', 'origin', origin);
  return dir;
}
const reg = (name: string, work_folder: string) =>
  registerMember({ friendly_name: name, member_type: 'local', work_folder, llm_provider: 'claude' } as never);

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wgpx-own-'));
  fs.writeFileSync(path.join(tmp, 'empty.gitconfig'), '');
});
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

beforeEach(() => {
  backupAndResetRegistry();
  vi.clearAllMocks();
  execPrefix.value = `export GIT_CONFIG_GLOBAL='${path.join(tmp, 'empty.gitconfig')}' GIT_CONFIG_NOSYSTEM=1; `;
});
afterEach(() => {
  execPrefix.value = '';
  restoreRegistry();
});

describe('register_member against real git repos (apra-fleet-wgpx)', () => {
  it('rejects a repo git refuses (dubious ownership): isError text names both remedies, member not listed', async () => {
    const dir = makeRepo('refused', 'https://github.com/acme/widgets.git');
    execPrefix.value += 'export GIT_TEST_ASSUME_DIFFERENT_OWNER=1; ';
    const result = await reg('refused-member', dir);
    expect(result).toMatch(/^ERROR/);
    expect(result).toMatch(/dubious ownership/i);
    expect(result).toContain('safe.directory');
    expect(result).toMatch(/setowner|chown/);
    expect(getAllAgents().find(a => a.friendlyName === 'refused-member')).toBeUndefined();
  });

  it('accepts an empty temp folder (no repo yet) with the existing VCS warning', async () => {
    const dir = path.join(tmp, 'empty-folder');
    fs.mkdirSync(dir);
    execPrefix.value += 'export GIT_TEST_ASSUME_DIFFERENT_OWNER=1; '; // irrelevant: not a repo
    const result = await reg('empty-member', dir);
    expect(result).toContain('registered successfully');
    expect(result).toMatch(/VCS provider could not be determined/);
    expect(getAllAgents().find(a => a.friendlyName === 'empty-member')).toBeTruthy();
  });

  it('accepts a normal repo with an origin remote and auto-detects the provider', async () => {
    const dir = makeRepo('normal', 'https://github.com/acme/widgets.git');
    const result = await reg('normal-member', dir);
    expect(result).toContain('registered successfully');
    expect(result).toContain('(auto-detected from origin)');
    expect(getAllAgents().find(a => a.friendlyName === 'normal-member')?.vcsProvider).toBe('github');
  });
});
