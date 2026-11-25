/**
 * compose_permissions grant mode for a claude member must keep the base role
 * profile when settings.local.json is missing or unparseable (re-seed, named
 * in the response), and stay a plain additive merge for a valid file.
 * Drives the real LocalStrategy against scratch dirs (same technique and
 * workspace-trust stub as compose-permissions-persist.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  // The home is a real scratch dir (no installed skills dir in it) because
  // compose now writes the member's per-folder apra-fleet MCP entry into the
  // local member's ~/.claude.json, resolved in JavaScript from os.homedir() --
  // so the real ~/.claude.json is never touched.
  const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-k4sc-home-'));
  scratchDirs.push(scratchHome);
  vi.spyOn(os, 'homedir').mockReturnValue(scratchHome);
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

const baseDev: string[] = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'fleet', 'profiles', 'base-dev.json'), 'utf-8'),
).permissions.allow;

describe.skipIf(process.platform === 'win32')('composePermissions grant mode -- base profile seeding', () => {
  async function grant(settings: string | null) {
    const workFolder = makeScratchWorkFolder();
    if (settings !== null) {
      fs.mkdirSync(path.join(workFolder, '.claude'), { recursive: true });
      fs.writeFileSync(settingsPath(workFolder), settings);
    }
    const member = makeTestAgent({ friendlyName: 'seed-grant', agentType: 'local', llmProvider: 'claude', os: HOST_OS, workFolder });
    addAgent(member);
    const result = await composePermissions({ member_id: member.id, role: 'doer', grant: ['Bash(zzcustom:*)'] });
    const allow: string[] = JSON.parse(fs.readFileSync(settingsPath(workFolder), 'utf-8')).permissions.allow;
    return { result, allow };
  }

  it('missing file: writes the base role profile plus the grant and names the re-seed cause', async () => {
    const { result, allow } = await grant(null);
    expect(allow).toContain('Bash(zzcustom:*)');
    expect(allow).toEqual(expect.arrayContaining(baseDev.slice(0, 5)));
    expect(result).toContain('Base profile re-seeded');
    expect(result).toContain('cause: missing');
  });

  it('unparseable file: writes the base role profile plus the grant and names the re-seed cause', async () => {
    const { result, allow } = await grant('this is { not json');
    expect(allow).toContain('Bash(zzcustom:*)');
    expect(allow).toEqual(expect.arrayContaining(baseDev.slice(0, 5)));
    expect(result).toContain('Base profile re-seeded');
    expect(result).toContain('cause: unparseable');
  });

  it('valid file with a custom allow list: keeps existing rules, appends the grant, no re-seed', async () => {
    const { result, allow } = await grant(JSON.stringify({ permissions: { allow: ['Bash(custom-existing:*)'] } }));
    expect(allow).toEqual(expect.arrayContaining(['Bash(custom-existing:*)', 'Bash(zzcustom:*)']));
    expect(allow).not.toContain('Bash(git:*)');
    expect(result).not.toContain('re-seeded');
  });
});
