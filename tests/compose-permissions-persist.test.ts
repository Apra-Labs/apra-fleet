/**
 * Regression test for apra-fleet-k4sc: a compose_permissions grant must actually
 * change the on-disk settings.local.json, and a write that fails must surface as
 * a compose_permissions failure -- never a false success.
 *
 * WHY A SEPARATE FILE FROM tests/compose-permissions.test.ts: that file mocks
 * getStrategy/execCommand entirely and only asserts on the generated command
 * STRING -- that is exactly why the k4sc bug shipped unnoticed (a write that
 * never landed anywhere still "looked right" as a string). This test drives the
 * REAL, unmocked LocalStrategy (src/services/strategy.ts exports LocalStrategy
 * via getStrategy() for agentType='local') so the generated write command
 * actually executes via child_process against a scratch temp dir, and every
 * assertion reads the resulting file back off disk with node:fs -- never from
 * composePermissions' return string.
 *
 * Platform coverage note: this suite runs on POSIX (darwin/linux) and therefore
 * only exercises deliverConfigFile's POSIX write path
 * (`cat > <path> << 'FLEET_PERMS_EOF'`) for real. The Windows write path
 * (`[System.IO.File]::WriteAllText(...)` in src/tools/compose-permissions.ts) is
 * inspected-but-not-executed here -- it is covered only by the mocked-execCommand
 * assertions in tests/compose-permissions.test.ts ("Windows BOM-free write
 * (T4)"), which check the generated command *string* but never actually run
 * PowerShell. There is currently no test in this repo that executes the Windows
 * write path end-to-end against a real filesystem; that gap is inherited from
 * apra-fleet-k4sc's own notes and is not fixed by this task.
 *
 * Workspace-trust safety note: composePermissions() also calls
 * ClaudeProvider.ensureWorkspaceTrusted() on every run (apra-fleet-eft.40.2).
 * With a REAL LocalStrategy that call reads/writes the actual machine's
 * `$HOME/.claude.json` via a real shell ($HOME resolves to the real user's home
 * directory, not the scratch workFolder) -- unrelated to what this test verifies
 * and unsafe to exercise for real inside a test run. It is stubbed out via
 * vi.spyOn on ClaudeProvider.prototype (a provider module, NOT
 * src/services/strategy.js) so the settings.local.json delivery under test still
 * goes through the real, unmocked LocalStrategy end to end.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupAndResetRegistry, restoreRegistry, makeTestAgent } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { composePermissions } from '../src/tools/compose-permissions.js';
import { ClaudeProvider } from '../src/providers/claude.js';

const HOST_OS: 'windows' | 'macos' | 'linux' =
  process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';

const scratchDirs: string[] = [];

function makeScratchWorkFolder(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-k4sc-persist-'));
  scratchDirs.push(dir);
  return dir;
}

function settingsPath(workFolder: string): string {
  return path.join(workFolder, '.claude', 'settings.local.json');
}

beforeEach(() => {
  backupAndResetRegistry();
  // findProfilesDir() prefers an installed ~/.claude/skills/fleet/profiles over the
  // repo's own skills/fleet/profiles -- on a dev machine with apra-fleet installed,
  // that installed copy can be stale and silently produce wrong results. Point
  // homedir at a path that can't have an installed skills dir, forcing resolution
  // to fall through to the repo checkout (same technique as
  // tests/compose-permissions.test.ts).
  vi.spyOn(os, 'homedir').mockReturnValue('/nonexistent-test-home');
  // See file header "Workspace-trust safety note": never let this test touch the
  // real machine's $HOME/.claude.json.
  vi.spyOn(ClaudeProvider.prototype, 'ensureWorkspaceTrusted').mockResolvedValue({
    seeded: false,
    detail: 'stubbed for compose-permissions-persist.test.ts (see file header)',
  });
});

afterEach(() => {
  restoreRegistry();
  vi.restoreAllMocks();
  for (const dir of scratchDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// See file header "Platform coverage note": this suite only exercises
// deliverConfigFile's POSIX write path. compose-permissions.ts's merge-read
// (`cat .claude/settings.local.json ...`) is a POSIX-only shell command with
// no Windows branch, so routing HOST_OS==='windows' through the real
// LocalStrategy here would run that command under powershell.exe and fail
// on a pre-existing src bug unrelated to this suite's regression coverage.
describe.skipIf(process.platform === 'win32')(
  'composePermissions -- real LocalStrategy persistence (apra-fleet-k4sc regression)',
  () => {
  it('fresh grant persists to settings.local.json on disk (real write, real read-back)', async () => {
    const workFolder = makeScratchWorkFolder();
    const member = makeTestAgent({
      friendlyName: 'k4sc-fresh-grant',
      agentType: 'local',
      llmProvider: 'claude',
      os: HOST_OS,
      workFolder,
    });
    addAgent(member);

    const result = await composePermissions({
      member_id: member.id,
      role: 'doer',
      grant: ['Bash(docker:*)'],
    });

    expect(result).toContain('Granted');
    expect(result).not.toContain('Failed to persist');

    // Assert against the FILE ON DISK, not the return string.
    const onDisk = JSON.parse(fs.readFileSync(settingsPath(workFolder), 'utf-8'));
    expect(onDisk.permissions.allow).toContain('Bash(docker:*)');
  });

  it('merges a grant onto an existing settings.local.json, preserving the pre-existing JWT mcpServers entry', async () => {
    const workFolder = makeScratchWorkFolder();
    const claudeDir = path.join(workFolder, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    // Simulate the file exactly as register_member leaves it: a JWT-bearing
    // mcpServers entry plus a prior allow list.
    const preexisting = {
      mcpServers: {
        'apra-fleet-member': {
          type: 'http',
          url: 'http://localhost:1234/mcp?member=abc-123',
          headers: { Authorization: 'Bearer super-secret-jwt' },
        },
      },
      permissions: { allow: ['Read', 'Bash(git:*)'] },
    };
    fs.writeFileSync(path.join(claudeDir, 'settings.local.json'), JSON.stringify(preexisting, null, 2));

    const member = makeTestAgent({
      friendlyName: 'k4sc-merge-grant',
      agentType: 'local',
      llmProvider: 'claude',
      os: HOST_OS,
      workFolder,
    });
    addAgent(member);

    const result = await composePermissions({
      member_id: member.id,
      role: 'doer',
      grant: ['Bash(docker:*)'],
    });

    expect(result).toContain('Granted');

    const onDisk = JSON.parse(fs.readFileSync(settingsPath(workFolder), 'utf-8'));
    // The JWT entry register_member wrote must survive the merge.
    expect(onDisk.mcpServers['apra-fleet-member']).toEqual(preexisting.mcpServers['apra-fleet-member']);
    // Prior allow entries survive...
    expect(onDisk.permissions.allow).toEqual(expect.arrayContaining(['Read', 'Bash(git:*)']));
    // ...and the new grant (plus its co-occurrence expansion) is added.
    expect(onDisk.permissions.allow).toEqual(expect.arrayContaining(['Bash(docker:*)', 'Bash(docker-compose:*)']));
  });

  it('surfaces failure (never a false success) when the write cannot land, and leaves no false-success state on disk', async () => {
    const workFolder = makeScratchWorkFolder();
    // Force deliverConfigFile's `mkdir -p .claude` to fail for real: pre-create a
    // plain FILE at the exact path compose_permissions needs as a directory, so
    // `mkdir -p .claude` exits nonzero ("File exists").
    const blockerPath = path.join(workFolder, '.claude');
    fs.writeFileSync(blockerPath, 'not a directory');

    const member = makeTestAgent({
      friendlyName: 'k4sc-failure-grant',
      agentType: 'local',
      llmProvider: 'claude',
      os: HOST_OS,
      workFolder,
    });
    addAgent(member);

    const result = await composePermissions({
      member_id: member.id,
      role: 'doer',
      grant: ['Bash(docker:*)'],
    });

    // Must be an explicit failure -- never a success string.
    expect(result).toContain('Failed to persist');
    expect(result).not.toContain('Granted');
    expect(result).not.toContain('composed');

    // No false-success state: the blocker path is still exactly the plain file
    // it was -- never silently replaced by a directory or a settings file.
    expect(fs.statSync(blockerPath).isFile()).toBe(true);
    expect(fs.readFileSync(blockerPath, 'utf-8')).toBe('not a directory');
  });
  }
);
