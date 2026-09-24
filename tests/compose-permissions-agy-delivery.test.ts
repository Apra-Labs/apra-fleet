/**
 * Regression test for the AGY permission-delivery defect that made every
 * fleet-sprint dispatch to an agy member die with
 *   "a tool required the \"command\" permission that headless mode cannot
 *    prompt for, so it was auto-denied"
 *
 * Three independent faults had to line up for that failure, and this suite
 * pins all three against a REAL, unmocked LocalStrategy (same technique and
 * rationale as tests/compose-permissions-persist.test.ts -- the earlier
 * agy-integration tests asserted only on the composed OBJECT, which is exactly
 * why a config that never reached AGY still "looked right"):
 *
 *   1. WRONG PATH  -- the config was written to <workFolder>/.gemini/... but
 *      AGY reads permissions only from the machine-global
 *      ~/.gemini/antigravity-cli/settings.json.
 *   2. WRONG SHAPE -- the allow list held {action,target} OBJECTS; AGY's
 *      settings parser accepts only `action(target)` STRINGS and silently
 *      ignores anything else.
 *   3. INVALID ACTIONS -- 'custom'/'invoke_subagent'/'send_message' are not in
 *      AGY's permission vocabulary and must never be written into a file the
 *      human user's own Antigravity install also reads.
 *
 * os.homedir() is pointed at a scratch dir throughout, so the "machine-global"
 * write lands in the temp dir rather than the real developer's ~/.gemini.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupAndResetRegistry, restoreRegistry, makeTestAgent } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { composePermissions } from '../src/tools/compose-permissions.js';

const HOST_OS: 'windows' | 'macos' | 'linux' =
  process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';

// AGY's own validation regex, verbatim from the agy CLI binary (1.2.8). Any
// permissions.allow entry that fails it is rejected by AGY.
const AGY_RULE_RE = /^(command|read_file|write_file|read_url|mcp|execute_url|unsandboxed)\s*\(.*\)$/;

const scratchDirs: string[] = [];

function makeScratch(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

function agySettingsPath(homeDir: string): string {
  return path.join(homeDir, '.gemini', 'antigravity-cli', 'settings.json');
}

function agyProjectPath(homeDir: string, memberId: string): string {
  return path.join(homeDir, '.gemini', 'config', 'projects', `fleet-${memberId}.json`);
}

let fakeHome: string;

beforeEach(() => {
  backupAndResetRegistry();
  // Created BEFORE os.homedir is mocked -- mkdtemp itself resolves via tmpdir,
  // not homedir, but the ordering keeps the fake home stable for the whole test.
  fakeHome = makeScratch('fleet-agy-home-');
  // Doubles as findProfilesDir()'s isolation (no installed ~/.claude/skills
  // under a fresh temp dir, so profile resolution falls through to the repo
  // checkout) AND as the member home getMemberHomeDir returns for a LOCAL
  // member -- which is what the home-anchored "~/" config path resolves against.
  vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
});

afterEach(() => {
  restoreRegistry();
  vi.restoreAllMocks();
  for (const dir of scratchDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === 'win32')('composePermissions -- AGY native delivery', () => {
  async function composeForAgyDoer(): Promise<{ workFolder: string; member: any; result: string }> {
    const workFolder = makeScratch('fleet-agy-work-');
    const member = makeTestAgent({
      friendlyName: 'agy-delivery',
      agentType: 'local',
      llmProvider: 'agy',
      os: HOST_OS,
      workFolder,
    });
    addAgent(member);
    const result = await composePermissions({ member_id: member.id, role: 'doer' });
    return { workFolder, member, result };
  }

  it('writes the doer profile to the HOME-anchored project config, never under the work folder', async () => {
    const { workFolder, member, result } = await composeForAgyDoer();

    expect(result).not.toContain('Failed to persist');
    // The project config file AGY reads for this workspace.
    expect(fs.existsSync(agyProjectPath(fakeHome, member.id))).toBe(true);
    // The workspace is trusted in settings.json.
    expect(fs.existsSync(agySettingsPath(fakeHome))).toBe(true);
    const settings = JSON.parse(fs.readFileSync(agySettingsPath(fakeHome), 'utf-8'));
    expect(settings.trustedWorkspaces).toContain(workFolder);
    // The file AGY never reads -- writing it was the original defect.
    expect(fs.existsSync(path.join(workFolder, '.gemini'))).toBe(false);
  });

  it('persists the allow list as AGY-parseable strings carrying the role profile', async () => {
    const { member } = await composeForAgyDoer();
    const onDisk = JSON.parse(fs.readFileSync(agyProjectPath(fakeHome, member.id), 'utf-8'));

    expect(Array.isArray(onDisk.permissionGrants.allow)).toBe(true);
    expect(onDisk.permissionGrants.allow.length).toBeGreaterThan(0);
    for (const entry of onDisk.permissionGrants.allow) {
      expect(typeof entry).toBe('string');
      expect(entry).toMatch(AGY_RULE_RE);
    }
    // The doer profile's core commands must survive the Claude -> AGY mapping:
    // a sprint member that cannot run git or bd cannot do anything at all.
    expect(onDisk.permissionGrants.allow).toContain('command(git)');
    expect(onDisk.permissionGrants.allow).toContain('command(bd)');
    expect(onDisk.permissionGrants.allow).toContain('read_file(*)');
    expect(onDisk.permissionGrants.allow).toContain('write_file(*)');
    // Not a single {action,target} object survived serialization.
    expect(onDisk.permissionGrants.allow.some((e: unknown) => typeof e === 'object')).toBe(false);
  });

  it('never writes an action outside AGY\'s vocabulary, including the mcp__ tokens the doer profile carries', async () => {
    const { member } = await composeForAgyDoer();
    const onDisk = JSON.parse(fs.readFileSync(agyProjectPath(fakeHome, member.id), 'utf-8'));
    for (const entry of onDisk.permissionGrants.allow as string[]) {
      expect(entry.startsWith('custom(')).toBe(false);
      expect(entry.startsWith('invoke_subagent(')).toBe(false);
      expect(entry.startsWith('send_message(')).toBe(false);
      // The per-tool MCP grants must NOT be collapsed into a server-level rule
      // (that would hand out remove_member/shutdown_server too).
      expect(entry.startsWith('mcp(apra-fleet)')).toBe(false);
    }
    // ...but they must still be DELIVERED, per tool. The deployer's Step 0
    // kb_session_prime is auto-denied in headless mode without this, which
    // takes down the whole Deploy phase.
    const allow = onDisk.permissionGrants.allow as string[];
    expect(allow).toContain('mcp(apra-fleet/kb_session_prime)');
    expect(allow.some(e => e.startsWith('mcp(apra-fleet/kb_query'))).toBe(true);
  });

  it('preserves unrelated keys already in the user\'s machine-global settings.json', async () => {
    // AGY's settings.json is shared with the human user's own install -- a
    // compose must not blow away their model choice or MCP servers.
    const settingsFile = agySettingsPath(fakeHome);
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify({
      defaultModel: 'gemini-3.5-flash',
      mcpServers: { 'some-user-server': { command: 'user-thing' } },
    }, null, 2));

    const { workFolder, member } = await composeForAgyDoer();

    const onDisk = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    expect(onDisk.defaultModel).toBe('gemini-3.5-flash');
    expect(onDisk.mcpServers['some-user-server']).toEqual({ command: 'user-thing' });
    expect(onDisk.trustedWorkspaces).toContain(workFolder);

    const projectConfig = JSON.parse(fs.readFileSync(agyProjectPath(fakeHome, member.id), 'utf-8'));
    expect(projectConfig.permissionGrants.allow).toContain('command(git)');
  });

  it('adds a mid-sprint grant in AGY syntax', async () => {
    const workFolder = makeScratch('fleet-agy-work-');
    const member = makeTestAgent({
      friendlyName: 'agy-grant',
      agentType: 'local',
      llmProvider: 'agy',
      os: HOST_OS,
      workFolder,
    });
    addAgent(member);

    const result = await composePermissions({
      member_id: member.id,
      role: 'doer',
      grant: ['Bash(docker:*)'],
    });
    expect(result).not.toContain('Failed to persist');

    const onDisk = JSON.parse(fs.readFileSync(agyProjectPath(fakeHome, member.id), 'utf-8'));
    expect(onDisk.permissionGrants.allow).toContain('command(docker)');
  });
});
