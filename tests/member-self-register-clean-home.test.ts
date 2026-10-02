/**
 * A clean remote member self-registers on its own install (bug: member-mode
 * install lacked the fleet permission profiles, so the self-registration
 * failed with "member not provisioned ... No complete profiles directory").
 *
 * Which parts are REAL and which are simulated:
 *  - REAL: the `apra-fleet register-member` CLI entry (runRegisterMember) and
 *    the shared registerMember handler, run with the exact argv that
 *    buildSelfRegisterCommand (src/services/member-fleet-install.ts) sends to
 *    the member, against a fresh temporary HOME and APRA_FLEET_DATA_DIR (no
 *    ~/.claude/skills, no ~/.apra-fleet).
 *  - REAL: the compose_permissions profile lookup (findProfilesDir), run
 *    against that fresh HOME.
 *  - SIMULATED: the install half. A real `install --member` needs a
 *    single-executable binary and a service manager, so it cannot run
 *    hermetically here; tests/install-member.test.ts covers it with mocked fs
 *    and asserts it writes no skills. Its RESULT is modelled here: a fresh HOME
 *    with no skill profiles, and a profile lookup whose start directory has no
 *    skills/ tree (an installed binary's directory has none -- in this repo the
 *    walk-up from __dirname would otherwise find skills/fleet/profiles and mask
 *    the bug). composePermissions is wrapped only to pin that start directory;
 *    the real lookup and the real composePermissions still run.
 *
 * Everything is created under one mkdtemp sandbox, removed in afterEach.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTestAgent } from './test-helpers.js';
import { buildSelfRegisterCommand, memberBinPath } from '../src/services/member-fleet-install.js';

const MEMBER_ID = '5f0c2a3e-8d41-4b6a-9c3e-2b7d1e4f6a80';

const compose = vi.hoisted(() => ({ calls: 0 }));

vi.mock('../src/tools/compose-permissions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tools/compose-permissions.js')>();
  return {
    ...actual,
    composePermissions: async (input: Parameters<typeof actual.composePermissions>[0]) => {
      compose.calls++;
      // An installed member binary has no skills/ tree next to it: look up the
      // profiles from the (fresh) HOME, exactly as the member's install would.
      actual.findProfilesDir(os.homedir(), os.homedir());
      return actual.composePermissions(input);
    },
  };
});

let sandbox: string;
let home: string;
let work: string;
const saved: Record<string, string | undefined> = {};

/** The argv the member's shell receives: parse the POSIX single-quoted command. */
function selfRegisterArgv(): string[] {
  const agent = makeTestAgent({ id: MEMBER_ID, friendlyName: 'bella', workFolder: work, llmProvider: 'claude', os: 'linux' });
  const cmd = buildSelfRegisterCommand(memberBinPath(home, 'linux', 'bash' as never), agent, 'linux', 'bash' as never);
  const tokens = [...cmd.matchAll(/'((?:[^']|'\\'')*)'/g)].map(m => m[1].replace(/'\\''/g, "'"));
  // The command targets a LINUX member, so the binary path is POSIX-joined
  // (forward slashes) even when this test runs on a Windows host.
  expect(tokens[0]).toBe(path.posix.join(home, '.apra-fleet', 'bin', 'apra-fleet'));
  expect(tokens[1]).toBe('register-member');
  return tokens.slice(2);
}

function stderrText(): string {
  return vi.mocked(console.error).mock.calls.flat().map(String).join('\n');
}

beforeEach(async () => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'member-self-reg-'));
  home = path.join(sandbox, 'home');
  work = path.join(sandbox, 'work');
  fs.mkdirSync(home);
  fs.mkdirSync(work);
  for (const k of ['APRA_FLEET_DATA_DIR', 'HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR']) saved[k] = process.env[k];
  process.env.APRA_FLEET_DATA_DIR = path.join(home, '.apra-fleet', 'data');
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  compose.calls = 0;
  vi.resetModules();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('member self-registration on a clean member install', () => {
  it('the exact self-registration command exits 0 in a fresh HOME with no skill profiles', async () => {
    expect(fs.existsSync(path.join(home, '.claude', 'skills'))).toBe(false);
    const { runRegisterMember } = await import('../src/cli/register-member.js');
    await runRegisterMember(selfRegisterArgv());
    expect(stderrText()).not.toMatch(/No complete profiles directory|member not provisioned/);
    expect(process.exitCode).toBeUndefined();
    const registry = JSON.parse(fs.readFileSync(path.join(home, '.apra-fleet', 'data', 'registry.json'), 'utf8'));
    expect(registry.agents.map((a: { id: string }) => a.id)).toEqual([MEMBER_ID]);
  });

  it('the member-side self-registration does not run compose_permissions (the orchestrator composes)', async () => {
    const { runRegisterMember } = await import('../src/cli/register-member.js');
    await runRegisterMember(selfRegisterArgv());
    expect(compose.calls).toBe(0);
  });

  it('a manual shell registration (no --id) still composes, so it still needs the profiles', async () => {
    const { runRegisterMember } = await import('../src/cli/register-member.js');
    await runRegisterMember(['--type', 'local', '--name', 'manual', '--path', work, '--llm', 'claude']);
    expect(compose.calls).toBe(1);
    expect(process.exitCode).toBe(1);
    expect(stderrText()).toMatch(/^ERROR: member not provisioned .*No complete profiles directory/m);
  });
});
