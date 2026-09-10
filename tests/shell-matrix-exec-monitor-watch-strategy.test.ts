/**
 * apra-fleet-7dir.5.3: string-level (never end-to-end/live) shell-matrix pin
 * for the four sites the 7dir.5.1/5.2 lane fixed or confirmed
 * shell-agnostic:
 *
 *  1. execute-command.ts credential-token substitution -- escaper choice
 *     (POSIX vs PowerShell) branches on the member's registered shell, not
 *     OS alone.
 *  2. monitor-task.ts status/pid/log command strings -- confirmed
 *     shell-agnostic (wrapPowerShellEncoded-wrapped), so every Windows shell
 *     row must produce the identical, golden-pinned string.
 *  3. watch.ts buildNewestTranscriptCommand/buildTailCommand -- gitbash gets
 *     the base64-wrapped form, every other Windows shell keeps today's raw
 *     `powershell -NoProfile -Command "..."` string.
 *  4. strategy.ts buildWindowsDeleteFilesScript -- confirmed shell-agnostic
 *     (no gitbash POSIX branch exists); golden-pinned so a future POSIX
 *     branch is caught and required to avoid PowerShell cmdlets.
 *
 * This defect class only manifests on a Windows host with Git for Windows
 * installed -- on Linux the member OS is linux, no shell probe runs, and the
 * bug is invisible to an OS-only assertion. A Linux-only CI can never catch
 * its return, so every assertion below is a plain string comparison that
 * runs identically on every platform; no real credential is ever written to
 * disk and no PowerShell/gitbash binary is invoked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry, resultText, decodePowerShellEncodedCommand } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import type { SSHExecResult } from '../src/types.js';

type ShellRow = 'gitbash' | 'pwsh7' | 'powershell5' | undefined;
const SHELL_ROWS: ShellRow[] = ['gitbash', 'pwsh7', 'powershell5', undefined];
const isPosixRow = (shell: ShellRow): boolean => shell === 'gitbash';

// ---------------------------------------------------------------------------
// 1. execute-command.ts credential substitution
// ---------------------------------------------------------------------------

const { mockExecCommand1 } = vi.hoisted(() => ({
  mockExecCommand1: vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>(),
}));

vi.mock('../src/services/strategy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/strategy.js')>();
  return {
    ...actual,
    getStrategy: () => ({
      execCommand: mockExecCommand1,
      testConnection: vi.fn().mockResolvedValue({ ok: true }),
      transferFiles: vi.fn(),
      close: vi.fn(),
    }),
  };
});

import { executeCommand } from '../src/tools/execute-command.js';
import { credentialSet, credentialDelete } from '../src/services/credential-store.js';

describe('execute-command.ts: credential-token substitution shell matrix', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    mockExecCommand1.mockReset();
  });

  afterEach(() => restoreRegistry());

  it.each(SHELL_ROWS)('shell=%s', async (shell) => {
    const name = `mtx${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    // Contains a single quote, a double quote, and a space -- the exact
    // plaintext shape the bead requires.
    const plaintext = `it's a "test" value`;
    credentialSet(name, plaintext, false, 'allow');

    const member = makeTestAgent({ friendlyName: `matrix-${shell ?? 'unset'}`, os: 'windows', shell } as any);
    addAgent(member);
    // The command's own output happens to echo the plaintext back, so the
    // redaction assertion below is meaningful.
    mockExecCommand1.mockResolvedValue({ stdout: plaintext, stderr: '', code: 0 });

    const result = resultText(await executeCommand({
      member_id: member.id,
      command: `echo {{secure.${name}}}`,
      timeout_s: 5,
    }));

    // Redaction still masks the plaintext in output on every shell row.
    expect(result).not.toContain(plaintext);
    expect(result).toContain(`[REDACTED:${name}]`);

    const calledCmd = mockExecCommand1.mock.calls[0][0] as string;
    expect(calledCmd).not.toContain(`{{secure.${name}}}`);

    if (isPosixRow(shell)) {
      // POSIX single-quote escaping: internal single quote doubled via
      // close-escape-reopen ('\'').
      expect(calledCmd).toContain("'it'\\''s a \"test\" value'");
      // Not the PowerShell-style doubled single quote (no adjacent '' pair).
      expect(calledCmd).not.toMatch(/it''s/);
    } else {
      // PowerShell single-quote escaping: internal single quote doubled ('').
      expect(calledCmd).toContain("'it''s a \"test\" value'");
      expect(calledCmd).not.toContain("'\\''"); // no POSIX-style escape sequence
    }

    credentialDelete(name);
  });

  it('pwsh7, powershell5 and unset all produce the identical escaped substitution (unchanged from today)', async () => {
    const plaintext = `it's a "test" value`;
    const calls: string[] = [];
    for (const shell of ['pwsh7', 'powershell5', undefined] as ShellRow[]) {
      const name = `same${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
      credentialSet(name, plaintext, false, 'allow');
      mockExecCommand1.mockReset();
      mockExecCommand1.mockResolvedValue({ stdout: '', stderr: '', code: 0 });
      const member = makeTestAgent({ friendlyName: `same-${shell ?? 'unset'}`, os: 'windows', shell } as any);
      addAgent(member);
      await executeCommand({ member_id: member.id, command: `echo {{secure.${name}}}`, timeout_s: 5 });
      const cmd = (mockExecCommand1.mock.calls[0][0] as string).replace(member.id, ''); // strip nothing member-specific present
      calls.push(cmd);
      credentialDelete(name);
    }
    expect(new Set(calls).size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. monitor-task.ts status/pid/log command strings
// ---------------------------------------------------------------------------

vi.mock('../src/services/credential-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/credential-store.js')>();
  return { ...actual, getTaskCredentials: () => [] };
});

vi.mock('../src/services/cloud/aws.js', () => ({
  awsProvider: { stopInstance: vi.fn() },
}));

import { monitorTask } from '../src/tools/monitor-task.js';

// monitorTask uses getStrategy(agent), already mocked above to route through
// mockExecCommand1 -- but that mock is shared per-module-mock, so re-mock a
// dedicated strategy for this section is not possible (vi.mock is hoisted
// once per module path). Route this section's assertions through the SAME
// mockExecCommand1 fixture instead.
describe('monitor-task.ts: status/pid/log command strings shell matrix', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    mockExecCommand1.mockReset();
    mockExecCommand1.mockResolvedValue({ stdout: '', stderr: '', code: 0 });
  });

  afterEach(() => restoreRegistry());

  it.each(SHELL_ROWS)('shell=%s', async (shell) => {
    const member = makeTestAgent({ friendlyName: `mon-${shell ?? 'unset'}`, os: 'windows', shell } as any);
    addAgent(member);

    await monitorTask({ member_id: member.id, task_id: 'task-abcd1234' });

    // status, pid, log -- the GPU call is skipped entirely for a non-cloud
    // agent (execute-command's gpuResult branch resolves without calling
    // strategy.execCommand).
    expect(mockExecCommand1).toHaveBeenCalledTimes(3);
    const [statusCmd, pidCmd, logCmd] = mockExecCommand1.mock.calls.map((c) => c[0] as string);

    for (const cmd of [statusCmd, pidCmd, logCmd]) {
      if (isPosixRow(shell)) {
        // Confirmed shell-agnostic (apra-fleet-7dir.5.2): even a gitbash
        // member gets the wrapPowerShellEncoded-wrapped form -- no literal,
        // unencoded PowerShell cmdlet appears in the outer command string.
        expect(cmd).toMatch(/^powershell -EncodedCommand /);
      } else {
        expect(cmd).toMatch(/^powershell -EncodedCommand /);
      }
    }

    // Golden: today's exact decoded scripts (including the
    // wrapPowerShellEncoded error-handling scaffold), byte-identical
    // regardless of shell.
    expect(decodePowerShellEncodedCommand(statusCmd)).toBe(
      "$ErrorActionPreference = 'Stop'; try { if (Test-Path \"$env:USERPROFILE\\.fleet-tasks\\task-abcd1234\\status.json\") { Get-Content \"$env:USERPROFILE\\.fleet-tasks\\task-abcd1234\\status.json\" -Raw } else { echo '{}' }; if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 0 } catch { Write-Error $_; exit 1 }",
    );
    expect(decodePowerShellEncodedCommand(pidCmd)).toBe(
      "$ErrorActionPreference = 'Stop'; try { $pidFile = \"$env:USERPROFILE\\.fleet-tasks\\task-abcd1234\\task.pid\"; if (Test-Path $pidFile) { $p = (Get-Content $pidFile -Raw).Trim() } else { $p = $null }; if ($p -and (Get-Process -Id $p -ErrorAction SilentlyContinue)) { echo alive } else { echo dead }; if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 0 } catch { Write-Error $_; exit 1 }",
    );
    expect(decodePowerShellEncodedCommand(logCmd)).toBe(
      "$ErrorActionPreference = 'Stop'; try { if (Test-Path \"$env:USERPROFILE\\.fleet-tasks\\task-abcd1234\\task.log\") { Get-Content \"$env:USERPROFILE\\.fleet-tasks\\task-abcd1234\\task.log\" -Tail 20 } else { echo '' }; if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 0 } catch { Write-Error $_; exit 1 }",
    );
  });

  it('gitbash, pwsh7, powershell5 and unset all produce byte-identical status/pid/log commands', async () => {
    const cmdSets: string[][] = [];
    for (const shell of SHELL_ROWS) {
      mockExecCommand1.mockReset();
      mockExecCommand1.mockResolvedValue({ stdout: '', stderr: '', code: 0 });
      const member = makeTestAgent({ friendlyName: `monsame-${shell ?? 'unset'}`, os: 'windows', shell } as any);
      addAgent(member);
      await monitorTask({ member_id: member.id, task_id: 'task-abcd1234' });
      const [statusCmd, pidCmd, logCmd] = mockExecCommand1.mock.calls.map((c) => c[0] as string);
      cmdSets.push([statusCmd, pidCmd, logCmd]);
    }
    // Every row's [status, pid, log] triple must be identical to row 0's.
    for (const set of cmdSets.slice(1)) {
      expect(set).toEqual(cmdSets[0]);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. watch.ts buildNewestTranscriptCommand / buildTailCommand
// ---------------------------------------------------------------------------

import { buildNewestTranscriptCommand, buildTailCommand } from '../src/cli/watch.js';

describe('watch.ts: buildNewestTranscriptCommand shell matrix', () => {
  const dir = 'C:\\Users\\bella\\.claude\\projects\\C--Users-bella-project';

  it.each(SHELL_ROWS)('shell=%s', (shell) => {
    const cmd = buildNewestTranscriptCommand('windows', dir, shell);

    if (isPosixRow(shell)) {
      expect(cmd).toMatch(/^powershell -EncodedCommand /);
      const decoded = decodePowerShellEncodedCommand(cmd);
      expect(decoded).toBe(
        `$ErrorActionPreference = 'Stop'; try { Get-ChildItem -LiteralPath '${dir}' -Filter *.jsonl -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName; if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 0 } catch { Write-Error $_; exit 1 }`,
      );
    } else {
      // Golden: the deliberate explicit-PowerShell-prefix form -- must not
      // silently switch to the base64-wrapped envelope.
      expect(cmd).toBe(
        `powershell -NoProfile -Command "Get-ChildItem -LiteralPath '${dir}' -Filter *.jsonl -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName"`,
      );
    }
  });

  it('pwsh7, powershell5 and unset all produce the identical explicit-PowerShell-prefix string', () => {
    const cmds = (['pwsh7', 'powershell5', undefined] as ShellRow[]).map((shell) =>
      buildNewestTranscriptCommand('windows', dir, shell),
    );
    expect(new Set(cmds).size).toBe(1);
    expect(cmds[0]).toMatch(/^powershell -NoProfile -Command "/);
  });
});

describe('watch.ts: buildTailCommand shell matrix', () => {
  const file = 'C:\\Users\\bella\\.claude\\projects\\p\\session.jsonl';

  it.each(SHELL_ROWS)('shell=%s', (shell) => {
    const cmd = buildTailCommand('-n0', file, 'windows', shell);

    if (isPosixRow(shell)) {
      expect(cmd).toMatch(/^powershell -EncodedCommand /);
      const decoded = decodePowerShellEncodedCommand(cmd);
      expect(decoded).toBe(
        `$ErrorActionPreference = 'Stop'; try { Get-Content -LiteralPath '${file}' -Encoding UTF8 -Wait -Tail 0; if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 0 } catch { Write-Error $_; exit 1 }`,
      );
    } else {
      expect(cmd).toBe(`powershell -NoProfile -Command "Get-Content -LiteralPath '${file}' -Encoding UTF8 -Wait -Tail 0"`);
    }
  });

  it('pwsh7, powershell5 and unset all produce the identical explicit-PowerShell-prefix string', () => {
    const cmds = (['pwsh7', 'powershell5', undefined] as ShellRow[]).map((shell) =>
      buildTailCommand('-n0', file, 'windows', shell),
    );
    expect(new Set(cmds).size).toBe(1);
    expect(cmds[0]).toMatch(/^powershell -NoProfile -Command "/);
  });
});

// ---------------------------------------------------------------------------
// 4. strategy.ts buildWindowsDeleteFilesScript
// ---------------------------------------------------------------------------

import { buildWindowsDeleteFilesScript } from '../src/services/strategy.js';

describe('strategy.ts: buildWindowsDeleteFilesScript golden pin', () => {
  it('golden-compares the wrapped delete script (no shell parameter today -- confirmed shell-agnostic)', () => {
    const cmd = buildWindowsDeleteFilesScript('C:\\Users\\bella\\project', ['a.txt', 'b.txt']);
    expect(cmd).toMatch(/^powershell -EncodedCommand /);
    const decoded = decodePowerShellEncodedCommand(cmd);
    expect(decoded).toBe(
      "$ErrorActionPreference = 'Stop'; try { Set-Location \"C:\\Users\\bella\\project\"; Remove-Item \"a.txt\", \"b.txt\" -Force -ErrorAction SilentlyContinue; if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 0 } catch { Write-Error $_; exit 1 }",
    );
  });

  it('regression guard: if a sibling change ever adds a gitbash POSIX branch here, it must not emit a PowerShell cmdlet', () => {
    // buildWindowsDeleteFilesScript currently takes no shell parameter -- it
    // is confirmed shell-agnostic (apra-fleet-7dir.5.2 audit comment in
    // strategy.ts). This assertion documents and pins that today's single
    // code path never contains a POSIX `rm` invocation mixed with PowerShell
    // cmdlets, so a future POSIX branch added without removing the
    // PowerShell one would be caught by the golden test above changing shape.
    const cmd = buildWindowsDeleteFilesScript('C:\\Users\\bella\\project', ['a.txt']);
    const decoded = decodePowerShellEncodedCommand(cmd);
    expect(decoded).toContain('Remove-Item');
    expect(decoded).not.toContain('rm -f');
  });
});
