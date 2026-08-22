/**
 * Regression test for apra-fleet-7dir.6: pin the gitbash branch of
 * src/tools/compose-permissions.ts deliverConfigFile (plus the Claude
 * settings read-back used by reactive grant mode), which was uncovered
 * before this bead -- a grep for "gitbash" across tests/ found only
 * os-shell-selection, register-member-shell-probe, windows-shell-probe,
 * strategy-gitbash-local-exec and member-detail-repo-remote-url, none of
 * which exercise compose-permissions.
 *
 * This is what reddened the tree the round before: the shell probe records
 * shell='gitbash' for any Windows member with Git for Windows installed, so
 * compose_permissions' deliverConfigFile (and the Claude merge pre-read at
 * compose-permissions.ts:536-538) must emit POSIX command strings for that
 * member, not PowerShell -- and the bug only manifests on a Windows host
 * with Git for Windows, which a Linux-only CI can never catch. So this suite
 * pins the generated command STRINGS (same technique as
 * "deliverConfigFile -- Windows BOM-free write (T4)" in
 * compose-permissions.test.ts) rather than driving a real shell, so it runs
 * -- and can fail -- on any host, including a non-Windows CI runner with no
 * real shell installed at all.
 *
 * Chose a new file over extending compose-permissions.test.ts: that file's
 * existing "T4" Windows-write describe block only ever registers
 * os:'windows' with no shell (implicitly the powershell5/pwsh7/unset case);
 * adding the gitbash split and the three-way golden compare there would
 * bury this bead's narrow regression inside an already-large file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { composePermissions } from '../src/tools/compose-permissions.js';
import type { SSHExecResult } from '../src/types.js';
import type { MemberShell } from '../src/os/os-commands.js';

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
  }),
}));

/**
 * Stateful in-memory filesystem mock for strategy.execCommand, mirroring the
 * one in compose-permissions.test.ts (same command shapes: POSIX heredoc
 * write / `cat` read, Windows WriteAllText / Get-Content -Raw read) so a
 * write that actually happened verifies as landed on the matching read-back,
 * instead of every command looking like the k4sc silent-no-op failure.
 */
function makeFsHandler(): (cmd: string, timeout?: number) => Promise<SSHExecResult> {
  const files = new Map<string, string>();
  return async (cmd: string): Promise<SSHExecResult> => {
    // POSIX write (heredoc)
    let m = cmd.match(/^cat > (.+?) << 'FLEET_PERMS_EOF'\n([\s\S]*)\nFLEET_PERMS_EOF$/);
    if (m) { files.set(m[1], m[2]); return { stdout: '', stderr: '', code: 0 }; }
    // Windows write (WriteAllText); PowerShell single-quote escaping doubles quotes
    m = cmd.match(/\[System\.IO\.File\]::WriteAllText\("(.+?)", '([\s\S]*)', \(New-Object System\.Text\.UTF8Encoding\(\$false\)\)\)/);
    if (m) { files.set(m[1], m[2].replace(/''/g, "'")); return { stdout: '', stderr: '', code: 0 }; }
    // POSIX read (cat <path> 2>/dev/null ...) -- merge-read (line 536-538) and
    // deliverConfigFile's own merge-read/read-back all share this shape.
    m = cmd.match(/^cat (.+?) 2>\/dev\/null/);
    if (m) { return { stdout: files.get(m[1]) ?? '', stderr: '', code: 0 }; }
    // Windows read (Get-Content -Raw "<path>" ...)
    m = cmd.match(/Get-Content -Raw "(.+?)"/);
    if (m) { return { stdout: files.get(m[1]) ?? '', stderr: '', code: 0 }; }
    // mkdir/New-Item, detectStacks (ls), workspace-trust writes/reads, everything else
    return { stdout: '', stderr: '', code: 0 };
  };
}

/** Command strings touching the settings.local.json config file this suite pins. */
function settingsCommands(): string[] {
  return mockExecCommand.mock.calls
    .map(c => c[0] as string)
    .filter(cmd => cmd.includes('settings.local.json'));
}

const POWERSHELL_CMDLET_PATTERN = /New-Item|Get-Content|WriteAllText|Set-Content|-ErrorAction/;

beforeEach(() => {
  backupAndResetRegistry();
  vi.clearAllMocks();
  mockExecCommand.mockImplementation(makeFsHandler());
  // findProfilesDir() prefers an installed ~/.claude/skills/fleet/profiles over the
  // repo's own skills/fleet/profiles (same reasoning as compose-permissions.test.ts).
  vi.spyOn(os, 'homedir').mockReturnValue('/nonexistent-test-home');
});

afterEach(() => {
  restoreRegistry();
  vi.restoreAllMocks();
});

describe('compose-permissions -- gitbash branch of config delivery (apra-fleet-7dir.6)', () => {
  it('windows member with shell=gitbash gets POSIX command strings against a forward-slash drive path, never a PowerShell cmdlet', async () => {
    const member = makeTestAgent({
      friendlyName: 'gitbash-member',
      llmProvider: 'claude',
      os: 'windows',
      shell: 'gitbash',
      workFolder: 'C:\\Users\\gitbash-member\\project',
    });
    addAgent(member);

    const result = await composePermissions({
      member_id: member.id,
      role: 'doer',
      grant: ['Bash(docker:*)'],
    });

    expect(result).toContain('Granted');

    const cmds = settingsCommands();
    expect(cmds.length).toBeGreaterThan(0);

    for (const cmd of cmds) {
      expect(cmd).not.toMatch(POWERSHELL_CMDLET_PATTERN);
      // MSYS/gitbash cannot parse a backslash path inside double quotes -- no
      // command touching the config file may contain one.
      expect(cmd).not.toContain('\\');
    }

    // POSIX write is the heredoc form against the forward-slash drive path.
    const writeCmd = cmds.find(cmd => cmd.includes('cat >'));
    expect(writeCmd).toBeDefined();
    expect(writeCmd).toContain('C:/Users/gitbash-member/project/.claude/settings.local.json');
    expect(writeCmd).toContain('FLEET_PERMS_EOF');

    // POSIX reads (merge-read at compose-permissions.ts:536-538, plus
    // deliverConfigFile's own merge-read and read-back) use `cat ... 2>/dev/null`.
    const readCmds = cmds.filter(cmd => cmd.startsWith('cat ') && cmd.includes('2>/dev/null'));
    expect(readCmds.length).toBeGreaterThan(0);
    for (const cmd of readCmds) {
      expect(cmd).toContain('C:/Users/gitbash-member/project/.claude/settings.local.json');
    }

    // mkdir uses the POSIX form, not New-Item.
    const mkdirCmds = mockExecCommand.mock.calls
      .map(c => c[0] as string)
      .filter(cmd => cmd.includes('.claude"') && (cmd.startsWith('mkdir') || cmd.startsWith('New-Item')));
    expect(mkdirCmds.length).toBeGreaterThan(0);
    for (const cmd of mkdirCmds) {
      expect(cmd).toMatch(/^mkdir -p /);
    }
  });

  it('windows members with shell powershell5, pwsh7 or unset all get byte-identical PowerShell command strings (golden compare)', async () => {
    const shells: Array<MemberShell | undefined> = ['powershell5', 'pwsh7', undefined];
    const perShellCmds: string[][] = [];

    for (const shell of shells) {
      backupAndResetRegistry();
      mockExecCommand.mockClear();
      mockExecCommand.mockImplementation(makeFsHandler());

      const member = makeTestAgent({
        friendlyName: 'win-member',
        llmProvider: 'claude',
        os: 'windows',
        shell,
        workFolder: 'C:\\Users\\win-member\\project',
      });
      addAgent(member);

      const result = await composePermissions({
        member_id: member.id,
        role: 'doer',
        grant: ['Bash(docker:*)'],
      });
      expect(result).toContain('Granted');

      perShellCmds.push(settingsCommands());
    }

    expect(perShellCmds[0].length).toBeGreaterThan(0);
    // pwsh7 and unset must be byte-identical to powershell5 -- any drift here
    // means the PowerShell branch changed for a shell that isn't gitbash,
    // which this bead's acceptance criteria says must not happen.
    expect(perShellCmds[1]).toEqual(perShellCmds[0]);
    expect(perShellCmds[2]).toEqual(perShellCmds[0]);

    for (const cmd of perShellCmds[0]) {
      expect(cmd).not.toContain('cat >');
      expect(cmd).not.toContain('mkdir -p');
    }
    const writeCmd = perShellCmds[0].find(cmd => cmd.includes('WriteAllText'));
    expect(writeCmd).toBeDefined();
    expect(writeCmd).toContain('UTF8Encoding($false)');
    const readCmds = perShellCmds[0].filter(cmd => cmd.includes('Get-Content -Raw'));
    expect(readCmds.length).toBeGreaterThan(0);
    for (const cmd of readCmds) {
      expect(cmd).toContain('-ErrorAction SilentlyContinue');
    }
  });
});
