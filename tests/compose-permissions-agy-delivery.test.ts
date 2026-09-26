/**
 * compose_permissions for AGY members against a REAL, unmocked LocalStrategy
 * (same technique as tests/compose-permissions-persist.test.ts -- asserting on
 * the composed object alone is how a config that never reached AGY once
 * "looked right").
 *
 * AGY enforces a project's permissionGrants only for a run that passes
 * `--project <id>` (docs/compose-permissions-design.md section 8). So:
 *   - grants go into ~/.gemini/config/projects/<agyProjectId>.json and nowhere
 *     else (never the work folder, never default-cli-project.json or another
 *     project's file, never the global settings.json);
 *   - the id/name/projectResources agy wrote are kept, only the nested
 *     permissionGrants.permissionGrants.{allow,deny} is written (replaced by a
 *     proactive compose, unioned by a reactive grant);
 *   - allow entries are AGY `action(target)` STRINGS in AGY's vocabulary;
 *   - a member without a project gets one first (upgrade path).
 *
 * os.homedir() is pointed at a scratch dir throughout, and `agy` is replaced
 * by tests/fixtures/fake-agy.cjs, so nothing touches the real ~/.gemini.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupAndResetRegistry, restoreRegistry, makeTestAgent } from './test-helpers.js';
import { addAgent, getAgent } from '../src/services/registry.js';
import { composePermissions } from '../src/tools/compose-permissions.js';
import { setAgyCommandForTests } from '../src/services/agy-project.js';

const HOST_OS: 'windows' | 'macos' | 'linux' =
  process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';

// AGY's own validation regex, verbatim from the agy CLI binary (1.2.8). Any
// permissions.allow entry that fails it is rejected by AGY.
const AGY_RULE_RE = /^(command|read_file|write_file|read_url|mcp|execute_url|unsandboxed)\s*\(.*\)$/;

const PID = '1afd6dbb-498f-4918-a9d9-6da64b75a204';
const OWNER_PID = 'e6d3551b-02a1-455d-8578-2f9424b4d71e';

const scratchDirs: string[] = [];
function makeScratch(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

let fakeHome: string;
const projectsDir = () => path.join(fakeHome, '.gemini', 'config', 'projects');
const projectFile = (id: string) => path.join(projectsDir(), `${id}.json`);

/** Seed the files agy itself would have: the default project, an unrelated
 *  user project, and (optionally) the member's own project as --new-project
 *  created it. Returns the unrelated files' bytes for byte-identity checks. */
function seedProjects(workFolder: string, withMemberProject = true): Record<string, string> {
  fs.mkdirSync(projectsDir(), { recursive: true });
  const others: Record<string, string> = {
    'default-cli-project.json': JSON.stringify({ id: 'default-cli-project', name: 'CLI Project', projectResources: {}, permissionGrants: { permissionGrants: { allow: [] } } }, null, 2),
    [`${OWNER_PID}.json`]: JSON.stringify({ id: OWNER_PID, name: 'apra-fleet-agy', projectResources: { resources: [{ folderUri: 'file://' + workFolder.split(path.sep).join('/') }] }, permissionGrants: { permissionGrants: { allow: ['command(*)'] } } }, null, 2),
  };
  for (const [f, body] of Object.entries(others)) fs.writeFileSync(path.join(projectsDir(), f), body);
  if (withMemberProject) {
    fs.writeFileSync(projectFile(PID), JSON.stringify({
      id: PID,
      name: path.basename(workFolder),
      projectResources: { resources: [{ folderUri: 'file://' + workFolder.split(path.sep).join('/') }] },
    }, null, 2));
  }
  return others;
}

function expectOthersUntouched(others: Record<string, string>): void {
  for (const [f, body] of Object.entries(others)) {
    expect(fs.readFileSync(path.join(projectsDir(), f), 'utf-8')).toBe(body);
  }
}

beforeEach(() => {
  backupAndResetRegistry();
  fakeHome = makeScratch('fleet-agy-home-');
  // Doubles as findProfilesDir()'s isolation and as the member home a LOCAL
  // member's "~/" config path resolves against.
  vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  setAgyCommandForTests({ file: process.execPath, args: [path.resolve(__dirname, 'fixtures', 'fake-agy.cjs'), '--fake-home', fakeHome] });
});

afterEach(() => {
  restoreRegistry();
  vi.restoreAllMocks();
  setAgyCommandForTests(undefined);
  for (const dir of scratchDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {}
  }
});

function addAgyMember(workFolder: string, extra: Record<string, unknown> = {}) {
  const member = makeTestAgent({
    friendlyName: 'agy-delivery',
    agentType: 'local',
    llmProvider: 'agy',
    os: HOST_OS,
    workFolder,
    ...extra,
  });
  addAgent(member);
  return member;
}

describe('composePermissions -- AGY project-bound delivery', { timeout: 60000 }, () => {
  it('writes grants only into <agyProjectId>.json, keeping agy\'s own id/name/projectResources', async () => {
    const workFolder = makeScratch('fleet-agy-work-');
    const others = seedProjects(workFolder);
    const before = JSON.parse(fs.readFileSync(projectFile(PID), 'utf-8'));
    const member = addAgyMember(workFolder, { agyProjectId: PID });

    const result = await composePermissions({ member_id: member.id, role: 'reviewer' });
    expect(result).not.toContain('Failed');

    const onDisk = JSON.parse(fs.readFileSync(projectFile(PID), 'utf-8'));
    expect(onDisk.id).toBe(before.id);
    expect(onDisk.name).toBe(before.name);
    expect(onDisk.projectResources).toEqual(before.projectResources);
    expect(Object.keys(onDisk.permissionGrants)).toEqual(['permissionGrants']);
    expect(onDisk.permissionGrants.permissionGrants.allow).toContain('read_file(*)');
    expect(onDisk.permissionGrants.permissionGrants.deny).toContain('mcp(apra-fleet/remove_member)');

    // Nothing else changed or appeared.
    expectOthersUntouched(others);
    expect(fs.readdirSync(projectsDir()).sort()).toEqual(['default-cli-project.json', `${OWNER_PID}.json`, `${PID}.json`].sort());
    expect(fs.existsSync(path.join(fakeHome, '.gemini', 'antigravity-cli', 'settings.json'))).toBe(false);
    expect(fs.existsSync(path.join(workFolder, '.gemini'))).toBe(false);
  });

  it('persists the doer allow list as AGY-parseable strings in AGY\'s vocabulary', async () => {
    const workFolder = makeScratch('fleet-agy-work-');
    seedProjects(workFolder);
    const member = addAgyMember(workFolder, { agyProjectId: PID });
    await composePermissions({ member_id: member.id, role: 'doer' });

    const allowList = JSON.parse(fs.readFileSync(projectFile(PID), 'utf-8')).permissionGrants.permissionGrants.allow as string[];
    expect(allowList.length).toBeGreaterThan(0);
    for (const entry of allowList) {
      expect(typeof entry).toBe('string');
      expect(entry).toMatch(AGY_RULE_RE);
      expect(entry.startsWith('custom(')).toBe(false);
      expect(entry.startsWith('invoke_subagent(')).toBe(false);
      expect(entry.startsWith('send_message(')).toBe(false);
      // never a server-level MCP grant (that would hand out remove_member etc.)
      expect(entry.startsWith('mcp(apra-fleet)')).toBe(false);
    }
    expect(allowList).toContain('command(git)');
    expect(allowList).toContain('command(bd)');
    expect(allowList).toContain('write_file(*)');
    expect(allowList).toContain('mcp(apra-fleet/kb_session_prime)');
  });

  it('adds a mid-sprint grant in AGY syntax to the same file', async () => {
    const workFolder = makeScratch('fleet-agy-work-');
    const others = seedProjects(workFolder);
    const member = addAgyMember(workFolder, { agyProjectId: PID });
    const result = await composePermissions({ member_id: member.id, role: 'doer', grant: ['Bash(docker:*)'] });
    expect(result).not.toContain('Failed');
    expect(JSON.parse(fs.readFileSync(projectFile(PID), 'utf-8')).permissionGrants.permissionGrants.allow).toContain('command(docker)');
    expectOthersUntouched(others);
  });

  it('a grant MERGES into the composed allow list: after = before + granted, nothing lost', async () => {
    const workFolder = makeScratch('fleet-agy-work-');
    seedProjects(workFolder);
    const member = addAgyMember(workFolder, { agyProjectId: PID });
    await composePermissions({ member_id: member.id, role: 'reviewer' });
    const read = () => JSON.parse(fs.readFileSync(projectFile(PID), 'utf-8')).permissionGrants.permissionGrants;
    const before = read();
    expect(before.allow.length).toBeGreaterThan(10);

    const result = await composePermissions({ member_id: member.id, role: 'reviewer', grant: ['Bash(docker:*)'] });
    expect(result).not.toContain('Failed');
    const after = read();
    const granted = HOST_OS === 'windows'
      ? ['command(docker)', 'command(regex:docker .*)', 'command(docker-compose)', 'command(regex:docker-compose .*)', 'command(docker buildx)', 'command(regex:docker buildx .*)']
      : ['command(docker)', 'command(docker-compose)', 'command(docker buildx)'];
    expect(after.allow).toEqual([...before.allow, ...granted]);
    expect(after.deny).toEqual(before.deny);
    expect(Object.keys(after)).not.toContain('ask');
  });

  it('a proactive compose still REPLACES the allow list (it is the authoritative full set)', async () => {
    const workFolder = makeScratch('fleet-agy-work-');
    seedProjects(workFolder);
    const member = addAgyMember(workFolder, { agyProjectId: PID });
    await composePermissions({ member_id: member.id, role: 'doer' });
    await composePermissions({ member_id: member.id, role: 'reviewer' });
    const allow = JSON.parse(fs.readFileSync(projectFile(PID), 'utf-8')).permissionGrants.permissionGrants.allow as string[];
    expect(allow).not.toContain('write_file(*)');
  });

  it('drops an inexpressible path glob and names it in the compose_permissions result; writes no ask list', async () => {
    const workFolder = makeScratch('fleet-agy-work-');
    seedProjects(workFolder);
    const member = addAgyMember(workFolder, { agyProjectId: PID });
    const result = await composePermissions({ member_id: member.id, role: 'reviewer' });
    expect(result).toContain('Warnings:');
    expect(result).toContain('agy: dropped "Write(feedback-*.md)"');
    expect(result).toContain('agy: dropped "Edit(feedback-*.md)"');
    const grants = JSON.parse(fs.readFileSync(projectFile(PID), 'utf-8')).permissionGrants.permissionGrants;
    expect(Object.keys(grants).sort()).toEqual(['allow', 'deny']);
    const paths = (grants.allow as string[]).filter(r => /^(read_file|write_file)\(/.test(r));
    for (const rule of paths) {
      if (rule.includes('*')) expect(['read_file(*)', 'write_file(*)']).toContain(rule);
    }
  });

  it('upgrade path: a member registered without a project gets one, stored in the registry, then its grants', async () => {
    const workFolder = makeScratch('fleet-agy-work-');
    const others = seedProjects(workFolder, false);
    const member = addAgyMember(workFolder);
    expect(member.agyProjectId).toBeUndefined();

    const result = await composePermissions({ member_id: member.id, role: 'reviewer' });
    expect(result).toContain('AGY project:');
    expect(result).toContain('created: no project id');

    const id = getAgent(member.id)?.agyProjectId;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const onDisk = JSON.parse(fs.readFileSync(projectFile(id!), 'utf-8'));
    expect(onDisk.id).toBe(id);
    expect(onDisk.permissionGrants.permissionGrants.allow).toContain('read_file(*)');
    expectOthersUntouched(others);
  });

  it('re-provisions when the recorded project file was deleted', async () => {
    const workFolder = makeScratch('fleet-agy-work-');
    seedProjects(workFolder, false);
    const member = addAgyMember(workFolder, { agyProjectId: PID });

    const result = await composePermissions({ member_id: member.id, role: 'doer' });
    expect(result).toContain('created: missing');
    const id = getAgent(member.id)?.agyProjectId;
    expect(id).not.toBe(PID);
    expect(fs.existsSync(projectFile(PID))).toBe(false);
    expect(fs.existsSync(projectFile(id!))).toBe(true);
  });
});
