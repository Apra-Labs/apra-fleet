/**
 * Regression coverage for apra-fleet-7dir.4: a local member whose registered
 * shell is Git-for-Windows bash (`shell: 'gitbash'`) must have both its
 * timeout/abort process-tree kill and its clean-env dispatch actually work
 * through LocalStrategy.execCommand -- not just produce a command string
 * that looks right.
 *
 * Both bugs shared one root cause: LocalStrategy.execCommand's killTree
 * (src/services/strategy.ts) and LinuxCommands.getCleanEnv (src/os/linux.ts,
 * inherited by WindowsGitBashCommands) called execSync with no `shell`
 * option, so on Windows execSync fell back to cmd.exe -- which cannot
 * parse either the gitbash-flavoured kill string (`taskkill //F //T //PID
 * <n> >/dev/null 2>&1; true`) or the `env -i ... bash -l -c 'env -0'` probe.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getStrategy } from '../src/services/strategy.js';
import { makeTestLocalAgent } from './test-helpers.js';
import { resolveGitBashPath } from '../src/os/windows-gitbash.js';
import { GIT_BASH_MACHINE_CANDIDATES, GIT_BASH_USER_SUFFIX, gitBashUserCandidate } from '../src/os/git-bash-candidates.js';
import { buildGitBashDiscoveryCommand } from '../src/services/shell-probe.js';
import { decodePowerShellEncodedCommand } from './test-helpers.js';

describe.skipIf(process.platform !== 'win32')('LocalStrategy + gitbash shell (apra-fleet-7dir.4)', () => {
  let tmpDir: string;
  let heartbeatPath: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `fleet-test-7dir4-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    heartbeatPath = path.join(tmpDir, 'heartbeat.txt');
  });

  afterEach(async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise(r => setTimeout(r, 300));
      }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 10000);

  it('actually kills the bash.exe wrapper (via the gitbash killPid string) after an inactivity timeout', async () => {
    const member = makeTestLocalAgent({ workFolder: tmpDir, shell: 'gitbash' });
    const strategy = getStrategy(member);

    const hbPath = heartbeatPath.replace(/\\/g, '/');
    // The wrapper bash.exe process (matches child.pid) itself heartbeats
    // forever, so it is straightforward to tell "still alive" (file keeps
    // growing) from "killed" (file stops growing) without depending on how
    // MSYS forks background jobs into the Windows process tree -- that is a
    // separate concern from this bug, which is specifically that killTree's
    // execSync call used to run under cmd.exe (default, no `shell` option)
    // and could not parse the gitbash-flavoured kill string at all, so
    // taskkill never even ran.
    const cmd = `while true; do date +%s%N >> '${hbPath}'; sleep 0.1; done`;

    const start = Date.now();
    await expect(strategy.execCommand(cmd, 800)).rejects.toThrow(/timed out/);
    expect(Date.now() - start).toBeLessThan(5000);

    await new Promise(r => setTimeout(r, 1000));
    const sizeAfterKill = fs.existsSync(heartbeatPath) ? fs.statSync(heartbeatPath).size : 0;
    await new Promise(r => setTimeout(r, 800));
    const sizeLater = fs.existsSync(heartbeatPath) ? fs.statSync(heartbeatPath).size : 0;

    expect(sizeLater).toBe(sizeAfterKill);
  }, 15000);

  it('strips the fleet server env (e.g. CLAUDE_SOURCE_METADATA) from a gitbash local dispatch instead of inheriting it wholesale', async () => {
    process.env.CLAUDE_SOURCE_METADATA = 'test-leak-marker';
    try {
      const member = makeTestLocalAgent({ workFolder: tmpDir, shell: 'gitbash' });
      const strategy = getStrategy(member);
      const result = await strategy.execCommand('echo "[$CLAUDE_SOURCE_METADATA]"');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('[]');
      expect(result.stdout).not.toContain('test-leak-marker');
    } finally {
      delete process.env.CLAUDE_SOURCE_METADATA;
    }
  }, 15000);
});

/**
 * apra-fleet-7dir.7: resolveGitBashPath's candidate list must be the SAME
 * list the registration probe (buildGitBashDiscoveryCommand) uses, must
 * include the user-scope LOCALAPPDATA install location, and must never
 * silently fall back to the bare string 'bash.exe' when no known candidate
 * exists on disk -- that string is exactly what Windows' own WSL launcher
 * (System32\bash.exe) can shadow on PATH.
 *
 * Deliberately NOT gated by describe.skipIf(win32): resolveGitBashPath takes
 * injectable deps (env/exists/probeUname) precisely so this logic is
 * testable on any host with no real Git-for-Windows install and no real
 * bash.exe on PATH.
 */
describe('resolveGitBashPath candidate list (apra-fleet-7dir.7)', () => {
  it('shares one candidate list with the registration probe -- no second literal list', () => {
    // The probe's discovery script embeds every GIT_BASH_MACHINE_CANDIDATES
    // entry verbatim; if windows-gitbash.ts ever hand-rolled its own literal
    // list again, only THIS assertion (not a grep) would catch a diverging
    // entry, since grep can't tell "same list" from "two lists that happen to
    // overlap". A literal-string check per entry is the strongest test-level
    // proxy for "one shared list, two consumers" without inspecting imports.
    const script = decodePowerShellEncodedCommand(buildGitBashDiscoveryCommand());
    for (const candidate of GIT_BASH_MACHINE_CANDIDATES) {
      expect(script).toContain(candidate);
    }
    expect(script).toContain('LOCALAPPDATA');
    // apra-fleet-7dir.14: the user-scope suffix itself must come from the
    // shared GIT_BASH_USER_SUFFIX export, not a second hand-rolled literal --
    // checking for the literal string 'LOCALAPPDATA' alone can't catch that
    // divergence since the env var name never changes even if the suffix does.
    expect(script).toContain(GIT_BASH_USER_SUFFIX);
  });

  it('the shared list includes the user-scope LOCALAPPDATA Programs\\Git\\bin\\bash.exe path', () => {
    const userCandidate = gitBashUserCandidate('C:\\Users\\bella\\AppData\\Local');
    expect(userCandidate).toBe('C:\\Users\\bella\\AppData\\Local\\Programs\\Git\\bin\\bash.exe');
  });

  it('with only the user-scope LOCALAPPDATA candidate present, resolution returns that absolute path -- never the bare string bash.exe', () => {
    const localAppData = 'C:\\Users\\bella\\AppData\\Local';
    const userCandidate = gitBashUserCandidate(localAppData)!;
    const result = resolveGitBashPath({
      env: { LOCALAPPDATA: localAppData },
      exists: (p) => p === userCandidate,
      probeUname: () => { throw new Error('must not be reached: a candidate was found on disk'); },
    });
    expect(result).toBe(userCandidate);
    expect(result).not.toBe('bash.exe');
  });

  it('with no candidate present and a real MSYS bash.exe on PATH, resolution verifies the uname and returns bash.exe', () => {
    const result = resolveGitBashPath({
      env: {},
      exists: () => false,
      probeUname: () => 'MINGW64_NT-10.0-19045\n',
    });
    expect(result).toBe('bash.exe');
  });

  it('with no candidate present and PATH bash.exe proving to be the WSL launcher (uname reports Linux), resolution throws naming the candidates tried -- it never silently returns bash.exe', () => {
    expect(() =>
      resolveGitBashPath({
        env: { LOCALAPPDATA: 'C:\\Users\\bella\\AppData\\Local' },
        exists: () => false,
        probeUname: () => 'Linux\n',
      }),
    ).toThrow(/No Git-for-Windows bash\.exe found/);

    try {
      resolveGitBashPath({
        env: { LOCALAPPDATA: 'C:\\Users\\bella\\AppData\\Local' },
        exists: () => false,
        probeUname: () => 'Linux\n',
      });
    } catch (err: any) {
      // Names every candidate it tried, including the machine-wide ones and
      // the user-scope LOCALAPPDATA one.
      for (const candidate of GIT_BASH_MACHINE_CANDIDATES) {
        expect(err.message).toContain(candidate);
      }
      expect(err.message).toContain('Programs\\Git\\bin\\bash.exe');
    }
  });

  it('with no candidate present and no bash.exe resolvable on PATH at all, resolution throws naming the candidates tried', () => {
    expect(() =>
      resolveGitBashPath({
        env: {},
        exists: () => false,
        probeUname: () => undefined,
      }),
    ).toThrow(/No Git-for-Windows bash\.exe found/);
  });

  it('reverting the fix (bare OS-PATH fallback with no MSYS verification) would return the ambiguous bare string -- this pins the fix', () => {
    // Simulates the pre-fix behavior this bead replaces: "last resort: let
    // the OS resolve it from PATH" with no uname check at all. If
    // resolveGitBashPath were reverted to that shape, this assertion (which
    // demands a thrown error naming candidates instead of a bare 'bash.exe')
    // would fail.
    let threw = false;
    try {
      resolveGitBashPath({ env: {}, exists: () => false, probeUname: () => 'Linux\n' });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
