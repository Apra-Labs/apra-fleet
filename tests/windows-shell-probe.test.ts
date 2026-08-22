/**
 * Pins the Windows shell probe (apra-fleet-7dir.1.3): registration must record
 * the SPECIFIC shell a Windows member has (gitbash / pwsh7 / powershell5),
 * proven by a real smoke command whose exit code AND stdout are both checked.
 *
 * All cases drive the probe through an injected fake exec -- no subprocesses,
 * no temp dirs, no OS dependence -- so the WSL-bash trap and the
 * "exit 0 with useless stdout" trap can both be exercised on any platform.
 *
 * The fake stdout strings below are REAL outputs captured on a Windows 10 box:
 *   Git bash    "C:\Program Files\Git\bin\bash.exe" -lc 'uname -s' -> MINGW64_NT-10.0-19045 (exit 0)
 *   System32    "C:\Windows\System32\bash.exe"      -lc 'uname -s' -> Linux                (exit 0)
 *   PowerShell 5.1 encoded probe                                   -> PSMAJOR:5            (exit 0)
 */
import { describe, it, expect } from 'vitest';
import {
  probeWindowsShell,
  shouldProbeShell,
  isWslLauncherPath,
  parseGitBashCandidates,
  isProvenGitBash,
  isProvenPwsh7,
  isProvenPowerShell5,
  buildGitBashProbeCommand,
  buildGitBashDiscoveryCommand,
  buildPwsh7ProbeCommand,
  buildPowerShell5ProbeCommand,
  SHELL_PROBE_TIMEOUT_MS,
  type ProbeExecResult,
} from '../src/services/shell-probe.js';

const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const WSL_BASH = 'C:\\Windows\\System32\\bash.exe';
const STORE_BASH = 'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe';

function ok(stdout: string): ProbeExecResult { return { stdout, stderr: '', code: 0 }; }
function fail(stderr = 'not recognized'): ProbeExecResult { return { stdout: '', stderr, code: 1 }; }

function decode(command: string): string {
  const m = /-EncodedCommand\s+(\S+)/.exec(command);
  if (!m) throw new Error(`not an encoded command: ${command}`);
  return Buffer.from(m[1], 'base64').toString('utf16le');
}

/** Build a fake exec from a world description, recording every command sent. */
function fakeExec(world: {
  bashPaths?: string[];
  unameFor?: Record<string, ProbeExecResult>;
  pwsh?: ProbeExecResult;
  ps5?: ProbeExecResult;
  discovery?: ProbeExecResult;
  throwOnAll?: boolean;
}) {
  const calls: { command: string; timeoutMs: number }[] = [];
  const exec = async (command: string, timeoutMs: number): Promise<ProbeExecResult> => {
    calls.push({ command, timeoutMs });
    if (world.throwOnAll) throw new Error('connection reset');
    const script = decode(command);
    if (script.includes('BASHCAND:')) {
      return world.discovery
        ?? ok((world.bashPaths ?? []).map(p => `BASHCAND:${p}`).join('\r\n') + '\r\n');
    }
    if (script.includes("-lc 'uname -s'")) {
      const which = Object.keys(world.unameFor ?? {}).find(p => script.includes(p));
      return which ? world.unameFor![which] : fail();
    }
    if (script.includes('& pwsh ')) return world.pwsh ?? fail();
    if (script.includes('& powershell ')) return world.ps5 ?? fail();
    return fail();
  };
  return { exec, calls };
}

describe('shouldProbeShell (AC6 non-windows, AC7 operator override)', () => {
  it('probes only for windows members with no operator-supplied shell', () => {
    expect(shouldProbeShell('windows', undefined)).toBe(true);
  });

  it('never probes for linux or macos members, with or without a shell value', () => {
    for (const os of ['linux', 'macos'] as const) {
      expect(shouldProbeShell(os, undefined)).toBe(false);
      expect(shouldProbeShell(os, 'gitbash')).toBe(false);
    }
    expect(shouldProbeShell(undefined, undefined)).toBe(false);
  });

  it('never probes when the operator supplied a shell explicitly', () => {
    for (const shell of ['gitbash', 'pwsh7', 'powershell5'] as const) {
      expect(shouldProbeShell('windows', shell)).toBe(false);
    }
  });
});

describe('probe command construction', () => {
  it('invokes the bash binary with the call operator, not as a bare quoted string', () => {
    const script = decode(buildGitBashProbeCommand(GIT_BASH));
    // Without `&` PowerShell would merely echo the path, exit 0, and look green.
    expect(script).toContain(`& '${GIT_BASH}' -lc 'uname -s'`);
  });

  it('quotes a path containing a single quote safely', () => {
    const script = decode(buildGitBashProbeCommand("C:\\dev's tools\\Git\\bin\\bash.exe"));
    expect(script).toContain(`& 'C:\\dev''s tools\\Git\\bin\\bash.exe' -lc 'uname -s'`);
  });

  it('asks the version probes for a prefixed marker, so echoed-back input cannot pass', () => {
    expect(decode(decode(buildPwsh7ProbeCommand()))).toContain("PSEDITION:' + $PSVersionTable.PSEdition");
    expect(decode(decode(buildPowerShell5ProbeCommand()))).toContain("PSMAJOR:' + $PSVersionTable.PSVersion.Major");
  });

  it('discovers well-known Git install paths plus PATH entries, filtered by Test-Path', () => {
    const script = decode(buildGitBashDiscoveryCommand());
    expect(script).toContain('C:\\Program Files\\Git\\bin\\bash.exe');
    expect(script).toContain('Programs\\Git\\bin\\bash.exe');
    expect(script).toContain('Get-Command bash.exe -All');
    expect(script).toContain('Test-Path -LiteralPath');
  });
});

describe('WSL bash disambiguation (AC4)', () => {
  it('classifies System32 / Sysnative / WindowsApps bash.exe as the WSL launcher', () => {
    expect(isWslLauncherPath(WSL_BASH)).toBe(true);
    expect(isWslLauncherPath('C:/Windows/Sysnative/bash.exe')).toBe(true);
    expect(isWslLauncherPath(STORE_BASH)).toBe(true);
    expect(isWslLauncherPath(GIT_BASH)).toBe(false);
  });

  it('drops WSL launchers and duplicates from discovery output', () => {
    const parsed = parseGitBashCandidates(
      [`BASHCAND:${GIT_BASH}`, `BASHCAND:${WSL_BASH}`, `BASHCAND:${STORE_BASH}`,
        `BASHCAND:${GIT_BASH.toUpperCase()}`, 'noise line', ''].join('\r\n'),
    );
    expect(parsed).toEqual([GIT_BASH]);
  });

  it('ignores discovery lines lacking the marker prefix (echo-back guard)', () => {
    expect(parseGitBashCandidates(`${GIT_BASH}\r\nsome echoed command text`)).toEqual([]);
  });

  it('never registers gitbash when the only bash.exe is the System32 WSL launcher', async () => {
    // Belt: the path filter drops it. Braces: even if it were probed, uname
    // says "Linux" (real captured output) and the stdout check rejects it.
    const { exec } = fakeExec({
      bashPaths: [WSL_BASH],
      unameFor: { 'System32': ok('Linux\n') },
      ps5: ok('PSMAJOR:5\r\n'),
    });
    expect(await probeWindowsShell(exec)).toEqual({ shell: 'powershell5' });
  });

  it('rejects a bash whose uname says Linux even when it is offered as a Git path', async () => {
    const disguised = 'C:\\Program Files\\Git\\bin\\bash.exe';
    const { exec } = fakeExec({
      bashPaths: [disguised],
      unameFor: { 'Git\\bin': ok('Linux\n') },
      ps5: ok('PSMAJOR:5\r\n'),
    });
    expect(await probeWindowsShell(exec)).toEqual({ shell: 'powershell5' });
  });
});

describe('stdout is checked, not just the exit code (AC5)', () => {
  it('rejects every candidate that exits 0 with empty or unexpected stdout', async () => {
    const { exec } = fakeExec({
      bashPaths: [GIT_BASH],
      unameFor: { 'Git\\bin': ok('') },              // exit 0, says nothing
      pwsh: ok('some unrelated banner\r\n'),          // exit 0, no PSEDITION marker
      ps5: ok('\r\n'),                                // exit 0, no PSMAJOR marker
    });
    const result = await probeWindowsShell(exec);
    expect(result.shell).toBe('powershell5');
    expect(result.warning).toMatch(/Could not verify/);
  });

  it('predicate level: exit 0 alone never proves a shell', () => {
    expect(isProvenGitBash(ok(''))).toBe(false);
    expect(isProvenGitBash({ stdout: 'MINGW64_NT-10.0-19045', stderr: '', code: 1 })).toBe(false);
    expect(isProvenGitBash(ok('MINGW64_NT-10.0-19045\n'))).toBe(true);
    expect(isProvenPwsh7(ok('Desktop\r\n'))).toBe(false);
    expect(isProvenPwsh7(ok('PSEDITION:Core\r\n'))).toBe(true);
    expect(isProvenPowerShell5(ok('PSMAJOR:7\r\n'))).toBe(false);
    expect(isProvenPowerShell5(ok('PSMAJOR:5\r\n'))).toBe(true);
  });
});

describe('probe ordering and outcomes (AC1-AC3, AC8)', () => {
  it('records gitbash when Git-for-Windows is installed, without probing PowerShell', async () => {
    const { exec, calls } = fakeExec({
      bashPaths: [GIT_BASH],
      unameFor: { 'Git\\bin': ok('MINGW64_NT-10.0-19045\n') },
      pwsh: ok('PSEDITION:Core\r\n'),
      ps5: ok('PSMAJOR:5\r\n'),
    });
    expect(await probeWindowsShell(exec)).toEqual({ shell: 'gitbash' });
    expect(calls.some(c => decode(c.command).includes('& pwsh '))).toBe(false);
    expect(calls.every(c => c.timeoutMs === SHELL_PROBE_TIMEOUT_MS)).toBe(true);
  });

  it('records pwsh7 when only PowerShell 7 is present', async () => {
    const { exec, calls } = fakeExec({ bashPaths: [], pwsh: ok('PSEDITION:Core\r\n'), ps5: ok('PSMAJOR:5\r\n') });
    expect(await probeWindowsShell(exec)).toEqual({ shell: 'pwsh7' });
    expect(calls.some(c => decode(c.command).includes('& powershell '))).toBe(false);
  });

  it('records powershell5 when neither Git bash nor PowerShell 7 is present', async () => {
    const { exec } = fakeExec({ bashPaths: [], pwsh: fail("'pwsh' is not recognized"), ps5: ok('PSMAJOR:5\r\n') });
    expect(await probeWindowsShell(exec)).toEqual({ shell: 'powershell5' });
  });

  it('degrades to powershell5 with a warning instead of throwing when every probe fails', async () => {
    const { exec } = fakeExec({ throwOnAll: true });
    const result = await probeWindowsShell(exec);
    expect(result.shell).toBe('powershell5');
    expect(result.warning).toBeTruthy();
  });

  it('tolerates a failed discovery round trip and falls through to PowerShell', async () => {
    const { exec } = fakeExec({ discovery: fail('access denied'), pwsh: ok('PSEDITION:Core\r\n') });
    expect(await probeWindowsShell(exec)).toEqual({ shell: 'pwsh7' });
  });

  it('emits no bead id in the operator-facing warning', async () => {
    const { exec } = fakeExec({ throwOnAll: true });
    const { warning } = await probeWindowsShell(exec);
    expect(warning).not.toMatch(/apra-fleet-[a-z0-9]/i);
  });
});
