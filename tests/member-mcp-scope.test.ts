/**
 * apra-fleet-b4g.23.2 -- verification for BOTH halves of the membercfg lane:
 *
 *   - the member-side install resolver (apra-fleet-b4g.23.3,
 *     src/services/member-fleet-install.ts), and
 *   - the composed member config that consumes it (apra-fleet-b4g.23.1,
 *     src/tools/compose-permissions.ts plus the claude/agy providers).
 *
 * Design context these assertions are written against: every member runs its OWN
 * apra-fleet over LOCAL stdio. There is no central KB server, no tunnel, no
 * mirror and no credential, so no assertion here may expect an endpoint URL or a
 * JWT -- several explicitly assert their ABSENCE.
 *
 * The resolver is NOT module-mocked. It is driven to succeed or to fail by what
 * the mocked member shell answers to its probe, which is strictly stronger than
 * stubbing the return value: it exercises the real probe string, the real output
 * parsing and the real path construction, so a regression in any of those is
 * caught here rather than hidden behind a stub.
 *
 * Every write goes to the in-memory member filesystem below. No real member
 * config, no real member machine and no real KB is touched.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent, getAgent } from '../src/services/registry.js';
import { composePermissions } from '../src/tools/compose-permissions.js';
import {
  buildFleetVersionProbe,
  clearMemberFleetInstallCache,
  orchestratorOwnedValues,
  parseFleetVersion,
  resolveMemberFleetInstall,
  MIN_MEMBER_FLEET_VERSION,
} from '../src/services/member-fleet-install.js';
import {
  MEMBER_ALLOWED_TOOLS,
  MEMBER_DENIED_TOOLS,
  MEMBER_MCP_SERVER_NAME,
  renderAgyMemberMcpRules,
  renderClaudeMemberMcpRules,
} from '../src/providers/member-tool-scope.js';
import { AGY_MEMBER_ALLOWED_TOOLS, AGY_ORCHESTRATOR_DENIED_TOOLS } from '../src/providers/agy.js';
import { clearMemberHomeDirCache } from '../src/services/member-home.js';
import type { SSHExecResult } from '../src/types.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({ execCommand: mockExecCommand }),
}));

const MEMBER_HOME = '/home/testuser';
const MEMBER_BIN = `${MEMBER_HOME}/.apra-fleet/bin/apra-fleet`;
/** What the mocked member shell answers for a Windows member's home probe, and
 *  the bin path the resolver must therefore build for it: joined with the
 *  MEMBER's separator and suffixed .exe, never the orchestrator's POSIX shape. */
const MEMBER_HOME_WIN = 'C:\\Users\\testuser';
const MEMBER_BIN_WIN = `${MEMBER_HOME_WIN}\\.apra-fleet\\bin\\apra-fleet.exe`;
const GOOD_VERSION = '9.9.9';

/** The member-side executable path expected for a member on `memberOs`. */
function expectedMemberBin(memberOs: 'linux' | 'macos' | 'windows'): string {
  return memberOs === 'windows' ? MEMBER_BIN_WIN : MEMBER_BIN;
}

/** Decode a `powershell -EncodedCommand <base64>` string back to its script, so
 *  a Windows member's command can be asserted on rather than taken on trust. */
function decodePowerShell(cmd: string): string {
  const m = /powershell -EncodedCommand (\S+)/.exec(cmd);
  if (!m) return cmd;
  return Buffer.from(m[1], 'base64').toString('utf16le');
}

/** What the member's shell should answer for the fleet-install version probe. */
type ProbeOutcome =
  | { kind: 'version'; version: string }
  | { kind: 'no-install' }
  | { kind: 'exec-failed' }
  | { kind: 'shell-error' }
  | { kind: 'throw' };

interface MemberFsOptions {
  seed?: Record<string, string>;
  probe?: ProbeOutcome;
  /** Serve this content on the read-BACK of the named path instead of what was
   *  written, to simulate a write that reported success but did not land. */
  tamperReadBackOf?: string;
}

/**
 * Stateful in-memory member filesystem + shell, modelled on the handler in
 * tests/compose-permissions.test.ts. deliverConfigFile reads every config file
 * back after writing it and fails loudly when the intended content is not there,
 * so a mock that answers every command with empty stdout looks exactly like the
 * silent-no-op bug; this records writes and serves them back.
 */
function makeMemberFs(opts: MemberFsOptions = {}) {
  const files = new Map<string, string>(Object.entries(opts.seed ?? {}));
  const probe = opts.probe ?? { kind: 'no-install' as const };
  const readCounts = new Map<string, number>();
  let probeCalls = 0;

  const handler = async (cmd: string): Promise<SSHExecResult> => {
    const script = decodePowerShell(cmd);

    // --- fleet-install version probe (the resolver's own command) ---
    if (script.includes('.apra-fleet') && script.includes('--version')) {
      probeCalls++;
      if (probe.kind === 'throw') throw new Error('member unreachable (simulated)');
      if (probe.kind === 'shell-error') return { stdout: '', stderr: 'boom', code: 127 };
      if (probe.kind === 'no-install') return { stdout: '__APRA_FLEET_NO_INSTALL__\n', stderr: '', code: 0 };
      if (probe.kind === 'exec-failed') return { stdout: '__APRA_FLEET_EXEC_FAILED__\n', stderr: '', code: 0 };
      // A real member emits a login banner first, then the version block.
      return {
        stdout: `Welcome to member-box\napra-fleet ${probe.version}\n  Mode:   sea\n  Binary: ${MEMBER_BIN}\n`,
        stderr: '',
        code: 0,
      };
    }
    // A local member's probe runs the orchestrator's own entry script instead.
    if (script.includes('--version') && !script.includes('.apra-fleet')) {
      probeCalls++;
      if (probe.kind === 'throw') throw new Error('unreachable (simulated)');
      if (probe.kind === 'no-install') return { stdout: '__APRA_FLEET_NO_INSTALL__\n', stderr: '', code: 0 };
      return { stdout: `apra-fleet ${GOOD_VERSION}\n`, stderr: '', code: 0 };
    }

    // --- member home probe ---
    if (cmd === 'printf \'%s\' "$HOME"') return { stdout: MEMBER_HOME, stderr: '', code: 0 };
    if (script.includes('$env:USERPROFILE')) return { stdout: MEMBER_HOME_WIN, stderr: '', code: 0 };

    // --- writes ---
    let m = cmd.match(/^cat > (.+?) << 'FLEET_PERMS_EOF'\n([\s\S]*)\nFLEET_PERMS_EOF$/);
    if (m) { files.set(m[1], m[2]); return { stdout: '', stderr: '', code: 0 }; }
    m = cmd.match(/\[System\.IO\.File\]::WriteAllText\("(.+?)", '([\s\S]*)', \(New-Object System\.Text\.UTF8Encoding\(\$false\)\)\)/);
    // Keyed WITH the surrounding quotes, exactly as the read branch below keys
    // its lookup: the POSIX read/write commands both embed the quotes in their
    // captured group, the Windows pair does not, so without re-adding them here
    // a Windows member's read-BACK would miss the file it had just written and
    // deliverConfigFile's verification would fail as a phantom silent-no-op.
    if (m) { files.set(`"${m[1]}"`, m[2].replace(/''/g, "'")); return { stdout: '', stderr: '', code: 0 }; }

    // --- reads (merge-read and read-back share the same command) ---
    const serve = (key: string): SSHExecResult => {
      const n = (readCounts.get(key) ?? 0) + 1;
      readCounts.set(key, n);
      // The FIRST read of a path is the merge-read; the SECOND is the read-back
      // verification. Tampering only the read-back is what makes the write look
      // like it reported success without landing.
      if (opts.tamperReadBackOf && key.includes(opts.tamperReadBackOf) && n >= 2) {
        return { stdout: JSON.stringify({ tampered: true }), stderr: '', code: 0 };
      }
      return { stdout: files.get(key) ?? '', stderr: '', code: 0 };
    };
    m = cmd.match(/^cat (.+?) 2>\/dev\/null/);
    if (m) return serve(m[1]);
    m = cmd.match(/Get-Content -Raw "(.+?)"/);
    if (m) return serve(`"${m[1]}"`);

    // --- agy project probe. Two envelopes, per buildAgyNodeCommand: the POSIX
    //     heredoc pipe into node, and (for a Windows member) a base64-wrapped
    //     `$code = @'...'@ | node` script with no EOF marker in it at all.
    //     Recognising only the first makes an agy WINDOWS member fail project
    //     provisioning before compose is ever reached, which is exactly how that
    //     path stayed unexercised. `FLEET_AGY_PROJECT:` is the probe's own reply
    //     marker; the delete script uses FLEET_AGY_PROJECT_DELETE: and must not
    //     be swallowed by this branch. ---
    const isAgyProbe = cmd.includes('FLEET_AGY_PROBE_EOF')
      || (script.includes('node --input-type=commonjs')
          && script.includes('FLEET_AGY_PROJECT:')
          && !script.includes('FLEET_AGY_PROJECT_DELETE:'));
    if (isAgyProbe) {
      return { stdout: 'FLEET_AGY_PROJECT:' + JSON.stringify({ state: 'ok' }), stderr: '', code: 0 };
    }

    // mkdir, detectStacks, workspace trust, everything else
    return { stdout: '', stderr: '', code: 0 };
  };

  return { handler, files, probeCalls: () => probeCalls };
}

function install(opts: MemberFsOptions = {}) {
  const fsMock = makeMemberFs(opts);
  mockExecCommand.mockImplementation(fsMock.handler);
  return fsMock;
}

/**
 * One config write the mocked member shell received, split into its target path
 * and the content it persisted. Understands BOTH member write shapes -- the
 * POSIX heredoc (`cat > "<p>" << 'FLEET_PERMS_EOF'`) and the Windows
 * `[System.IO.File]::WriteAllText("<p>", '<c>', UTF8Encoding($false))` form --
 * and normalises the path separator to `/`, so ONE assertion can be written and
 * then run for a member on any supported OS. Matching a fragment against the raw
 * command instead (what this file used to do) silently never fires for a Windows
 * member, whose paths are backslash-separated: that is how the Windows compose
 * path went unexercised.
 */
function parseConfigWrite(cmd: string): { path: string; content: string } | undefined {
  let m = cmd.match(/^cat > (.+?) << 'FLEET_PERMS_EOF'\n([\s\S]*)\nFLEET_PERMS_EOF$/);
  if (m) return { path: m[1].replace(/\\/g, '/'), content: m[2] };
  m = cmd.match(/\[System\.IO\.File\]::WriteAllText\("(.+?)", '([\s\S]*)', \(New-Object System\.Text\.UTF8Encoding\(\$false\)\)\)/);
  // A PowerShell single-quoted literal escapes one quote as two; undo that so
  // the content compares byte-for-byte with the POSIX branch's.
  if (m) return { path: m[1].replace(/\\/g, '/'), content: m[2].replace(/''/g, "'") };
  return undefined;
}

/** Every config write whose (separator-normalised) path contains `pathFragment`,
 *  oldest first. Pass `''` to get all of them. */
function configWrites(pathFragment: string): Array<{ path: string; content: string }> {
  return mockExecCommand.mock.calls
    .map(c => parseConfigWrite(c[0] as string))
    .filter((w): w is { path: string; content: string } => !!w && w.path.includes(pathFragment));
}

/** Parse the JSON the LAST write to `pathFragment` persisted, on any member OS. */
function writtenJson(pathFragment: string): any {
  const writes = configWrites(pathFragment);
  if (writes.length === 0) return undefined;
  return JSON.parse(writes[writes.length - 1].content);
}

function wroteTo(pathFragment: string): boolean {
  return configWrites(pathFragment).length > 0;
}

/** Everything the run persisted to the member, concatenated -- for the "this
 *  string appears in NO config we wrote" assertions, on a member of any OS. */
function allWrittenContent(): string {
  return configWrites('').map(w => w.content).join('\n');
}

beforeEach(() => {
  backupAndResetRegistry();
  vi.clearAllMocks();
  clearMemberFleetInstallCache();
  clearMemberHomeDirCache();
  // Same reason as tests/compose-permissions.test.ts: force findProfilesDir to
  // fall through to the repo checkout instead of a possibly-stale installed copy.
  vi.spyOn(os, 'homedir').mockReturnValue('/nonexistent-test-home');
});

afterEach(() => {
  restoreRegistry();
  vi.restoreAllMocks();
  clearMemberFleetInstallCache();
  clearMemberHomeDirCache();
});

// ---------------------------------------------------------------------------
// RESOLVER (apra-fleet-b4g.23.3)
// ---------------------------------------------------------------------------

describe('resolveMemberFleetInstall -- descriptor for a member that HAS an install (assertion 1)', () => {
  it('returns a stdio descriptor with NO orchestrator-derived value in it', async () => {
    const member = makeTestAgent({ friendlyName: 'remote-box', os: 'linux' });
    install({ probe: { kind: 'version', version: GOOD_VERSION } });

    const result = await resolveMemberFleetInstall(member);

    expect(result.scoped).toBe(true);
    if (!result.scoped) return;
    // Launches the stdio MCP server, and `run` is passed explicitly so an MCP
    // host never triggers the no-arg default (installation).
    expect(result.descriptor.args).toEqual(['run', '--transport', 'stdio']);
    expect(result.descriptor.args.slice(-3)).toEqual(['run', '--transport', 'stdio']);
    // Resolved against the MEMBER's probed home, not the orchestrator's.
    expect(result.descriptor.command).toBe(MEMBER_BIN);
    expect(result.version).toBe(GOOD_VERSION);
    expect(result.origin).toBe('member-probe');

    // THE assertion that fails if src/cli/install.ts's orchestrator-local
    // mcpConfig is reused: process.execPath, process.argv[1], the orchestrator's
    // BIN_DIR and its os.homedir() may appear nowhere in a remote descriptor.
    const serialized = JSON.stringify(result.descriptor);
    for (const owned of orchestratorOwnedValues()) {
      expect(serialized).not.toContain(owned);
    }
    expect(serialized).not.toContain(process.execPath);
    expect(serialized).not.toContain(String(process.argv[1]));
  });

  it('carries no endpoint URL, port or credential anywhere in the result', async () => {
    const member = makeTestAgent({ friendlyName: 'remote-box', os: 'linux' });
    install({ probe: { kind: 'version', version: GOOD_VERSION } });

    const serialized = JSON.stringify(await resolveMemberFleetInstall(member));
    expect(serialized).not.toMatch(/https?:\/\//);
    expect(serialized.toLowerCase()).not.toContain('bearer');
    expect(serialized.toLowerCase()).not.toContain('authorization');
    expect(serialized).not.toContain('?member=');
  });
});

describe('resolveMemberFleetInstall -- named unscoped reasons, never a throw (assertion 2)', () => {
  const cases: Array<{ name: string; probe: ProbeOutcome; reason: string }> = [
    { name: 'no install at the expected path', probe: { kind: 'no-install' }, reason: 'no-install-found' },
    { name: 'present but not runnable', probe: { kind: 'exec-failed' }, reason: 'install-unusable' },
    { name: 'present but too old', probe: { kind: 'version', version: '0.0.1' }, reason: 'install-unusable' },
    { name: 'member unreachable (probe threw)', probe: { kind: 'throw' }, reason: 'probe-failed' },
    { name: 'member shell failed', probe: { kind: 'shell-error' }, reason: 'probe-failed' },
  ];

  for (const c of cases) {
    it(`${c.name} -> reason "${c.reason}" with an actionable remediation, and does not throw`, async () => {
      const member = makeTestAgent({ friendlyName: 'remote-box', os: 'linux' });
      install({ probe: c.probe });

      // The absence of an install must never abort the caller.
      const result = await resolveMemberFleetInstall(member);

      expect(result.scoped).toBe(false);
      if (result.scoped) return;
      expect(result.reason).toBe(c.reason);
      expect(result.remediation.trim().length).toBeGreaterThan(0);
      // Actionable without tribal knowledge: names the member and something to do.
      expect(result.remediation).toContain('remote-box');
    });
  }

  it('distinguishes all three of no-install-found, install-unusable and probe-failed', async () => {
    const reasons = new Set<string>();
    for (const c of cases) {
      const member = makeTestAgent({ friendlyName: 'remote-box', os: 'linux' });
      install({ probe: c.probe });
      const r = await resolveMemberFleetInstall(member);
      if (!r.scoped) reasons.add(r.reason);
    }
    expect(reasons).toContain('no-install-found');
    expect(reasons).toContain('install-unusable');
    expect(reasons).toContain('probe-failed');
  });

  it('names the minimum version in the too-old remediation so the user knows the target', async () => {
    const member = makeTestAgent({ friendlyName: 'remote-box', os: 'linux' });
    install({ probe: { kind: 'version', version: '0.0.1' } });
    const r = await resolveMemberFleetInstall(member);
    expect(r.scoped).toBe(false);
    if (r.scoped) return;
    expect(r.remediation).toContain(MIN_MEMBER_FLEET_VERSION);
    expect(r.remediation).toContain('apra-fleet install');
  });
});

describe('buildFleetVersionProbe -- member-bound command hygiene (assertion 3)', () => {
  const POSIX_PATH = '/home/bella/.apra-fleet/bin/apra-fleet';
  const WIN_PATH = 'C:\\Users\\bella\\.apra-fleet\\bin\\apra-fleet.exe';

  it('a POSIX member gets a POSIX command with no shell-expansion token', () => {
    const cmd = buildFleetVersionProbe(POSIX_PATH, 'linux', undefined);
    expect(cmd).not.toMatch(/powershell/i);
    expect(cmd).toContain(POSIX_PATH);
    // No $VAR, no ~, no backtick: the path is already fully resolved in JS, so
    // nothing is left for the member's shell to expand.
    expect(cmd).not.toContain('$');
    expect(cmd).not.toContain('~');
    expect(cmd).not.toContain('`');
  });

  it('a PowerShell member gets an EXPLICITLY WRAPPED command, not a POSIX one', () => {
    const cmd = buildFleetVersionProbe(WIN_PATH, 'windows', 'powershell5');
    // Explicitly wrapped per src/os/windows.ts -- base64 -EncodedCommand, never a
    // raw `powershell -c "..."` that an intermediate shell could re-tokenize.
    expect(cmd).toMatch(/^powershell -EncodedCommand /);
    // The emitted string carries no expansion token at all (it is base64).
    expect(cmd).not.toContain('~');
    expect(cmd).not.toContain('`');

    const script = decodePowerShell(cmd);
    expect(script).toContain('Test-Path -LiteralPath');
    expect(script).toContain(WIN_PATH);
    // The SCRIPT must not reach for a member environment variable either.
    expect(script).not.toContain('$env:');
    expect(script).not.toContain('~');
  });

  it('a gitbash Windows member takes the POSIX branch, not the PowerShell one', () => {
    const cmd = buildFleetVersionProbe('/c/Users/bella/.apra-fleet/bin/apra-fleet.exe', 'windows', 'gitbash');
    expect(cmd).not.toMatch(/powershell/i);
    expect(cmd).toContain('/c/Users/bella');
  });

  it('parses the version out of banner-polluted output and rejects noise', () => {
    expect(parseFleetVersion('motd line\napra-fleet 0.4.4\n  Mode: sea\n')).toBe('0.4.4');
    expect(parseFleetVersion('apra-fleet 1.2.3-rc1')).toBe('1.2.3-rc1');
    expect(parseFleetVersion('command not found')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// LIVE PowerShell: the emitted probe's BEHAVIOUR, not merely its shape
// (assertion 3b -- apra-fleet-b4g.23.3 criterion 4 on a Windows member)
//
// The hygiene assertions above pattern-match the emitted PowerShell string. That
// is not enough, and this file learned it the expensive way: the probe once used
// `try { & $p --version } catch { <exec-failed sentinel> }`, which LOOKS correct
// and passed every hygiene assertion, but PowerShell raises no terminating error
// when a NATIVE executable exits non-zero -- so the catch never fired and a
// Windows member with a present-but-broken install was reported as
// probe-failed/unreachable instead of install-unusable. Nothing short of running
// the real interpreter can catch that class of defect.
//
// Same precedent as buildWindowsDeleteFilesScript, which was extracted precisely
// so a live-PowerShell test could execute the REAL emitted script instead of a
// hand-copied lookalike: buildFleetVersionProbe is exported, so execute it.
// ---------------------------------------------------------------------------

/** A real PowerShell interpreter, or null. `pwsh` (PowerShell 7+, which is
 *  cross-platform) is tried FIRST so these assertions also run on Linux/macOS
 *  dev boxes and CI runners rather than only on windows-latest; `powershell`
 *  (5.1) is the Windows-native fallback. That is sound here because the probe
 *  script uses only portable PowerShell -- Test-Path -LiteralPath, the `&` call
 *  operator, $LASTEXITCODE, [Console]::Out.Write -- with no cmd.exe and no
 *  Windows-only construct, and the semantics under test (does a NATIVE non-zero
 *  exit surface at all?) are identical on every platform. */
const psExe: string | null = (() => {
  for (const exe of ['pwsh', 'powershell']) {
    const r = spawnSync(exe, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' });
    if (!r.error && r.status === 0) return exe;
  }
  return null;
})();

/** Run the module's OWN emitted probe command through a real interpreter. Only
 *  the executable NAME is substituted (this box may have `pwsh` rather than
 *  `powershell`); the base64 -EncodedCommand payload is passed through
 *  untouched, and that is asserted, so what executes is byte-for-byte the script
 *  a Windows member would be sent. */
function runEmittedProbe(cmd: string): { code: number; stdout: string; stderr: string } {
  const m = /^powershell -EncodedCommand (\S+)$/.exec(cmd);
  expect(m, 'the probe for a PowerShell member must be an -EncodedCommand string').not.toBeNull();
  const r = spawnSync(psExe!, ['-NoProfile', '-EncodedCommand', m![1]], { encoding: 'utf-8' });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Write a stand-in `apra-fleet` that prints `out` then exits `code`, in the
 *  shape THIS platform can actually execute: a POSIX shell script under pwsh on
 *  Linux/macOS, a .cmd batch file on Windows. Either way PowerShell's `&`
 *  operator invokes it as a NATIVE executable, which is the case that matters --
 *  a native non-zero exit is exactly what raises no terminating error. */
function writeFakeFleetExe(dir: string, base: string, out: string, code: number): string {
  if (process.platform === 'win32') {
    const p = path.join(dir, `${base}.cmd`);
    fs.writeFileSync(p, `@echo off\r\n${out ? `echo ${out}\r\n` : ''}exit /b ${code}\r\n`);
    return p;
  }
  const p = path.join(dir, base);
  fs.writeFileSync(p, `#!/bin/sh\n${out ? `echo "${out}"\n` : ''}exit ${code}\n`, { mode: 0o755 });
  return p;
}

/** Fixture directories the live-PowerShell blocks create. Drained by ONE
 *  afterAll registered at collection time below -- never from inside a running
 *  it() body, where a hook silently fails to attach to the file suite and leaks
 *  every fixture while the suite still reports green (the lesson recorded in
 *  tests/windows-powershell-error-handling.test.ts). */
const liveTempDirs: string[] = [];

describe.runIf(psExe)('buildFleetVersionProbe -- LIVE PowerShell behaviour (assertion 3b)', () => {
  // Fixtures live under os.tmpdir(), NOT the operator's home directory.
  let dir: string;
  let healthy: string;
  let broken: string;
  let absent: string;
  let quoted: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-probe-live-'));
    healthy = writeFakeFleetExe(dir, 'healthy', `apra-fleet ${GOOD_VERSION}`, 0);
    // Prints partial output and THEN fails, which is the realistic corrupt-install
    // shape and the one that used to slip through with no sentinel at all.
    broken = writeFakeFleetExe(dir, 'broken', 'apra-fleet: error while loading shared libraries', 3);
    absent = path.join(dir, 'definitely-not-here', 'apra-fleet.exe');
    const quotedDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-probe-o'live-"));
    quoted = writeFakeFleetExe(quotedDir, 'quoted', `apra-fleet ${GOOD_VERSION}`, 0);
    liveTempDirs.push(dir, quotedDir);
  });

  it('a present executable that exits NON-ZERO yields the exec-failed sentinel, and exit 0', () => {
    const live = runEmittedProbe(buildFleetVersionProbe(broken, 'windows', 'powershell5'));

    // THE regression assertion. Before the $LASTEXITCODE fix this produced the
    // executable's partial stdout with NO sentinel and propagated exit 3, which
    // verifyOnMember reads as probe-failed ("is the member powered on?") for a
    // perfectly reachable machine. Reverting that fix fails this line.
    expect(live.stdout).toContain('__APRA_FLEET_EXEC_FAILED__');
    expect(live.code).toBe(0);
    // The module's documented invariant: the outcome is TAGGED in stdout, so a
    // non-zero exit can mean nothing but "the shell/transport itself failed".
    expect(live.stdout).not.toContain('__APRA_FLEET_NO_INSTALL__');
    expect(parseFleetVersion(live.stdout)).toBeNull();
  });

  it('an ABSENT path yields the no-install sentinel, and exit 0', () => {
    const live = runEmittedProbe(buildFleetVersionProbe(absent, 'windows', 'powershell5'));

    expect(live.stdout).toContain('__APRA_FLEET_NO_INSTALL__');
    expect(live.stdout).not.toContain('__APRA_FLEET_EXEC_FAILED__');
    expect(live.code).toBe(0);
  });

  it('a healthy executable passes its version straight through, and exit 0', () => {
    const live = runEmittedProbe(buildFleetVersionProbe(healthy, 'windows', 'powershell5'));

    // Parsed by the REAL parser, so the PowerShell branch's own output framing
    // (Out-String, CRLF, trailing newline) has to survive it -- a sentinel-only
    // assertion would not notice if it did not.
    expect(parseFleetVersion(live.stdout)).toBe(GOOD_VERSION);
    expect(live.stdout).not.toContain('__APRA_FLEET_');
    expect(live.code).toBe(0);
  });

  it("a path containing a single quote survives the PowerShell escaping intact", () => {
    // escapePowerShellArgInner doubles the quote; if that ever broke, the script
    // would either be a syntax error or probe the wrong path -- both of which
    // look like "no install" to a caller, i.e. a silent misdiagnosis.
    expect(quoted).toContain("o'live");
    const live = runEmittedProbe(buildFleetVersionProbe(quoted, 'windows', 'powershell5'));

    expect(parseFleetVersion(live.stdout)).toBe(GOOD_VERSION);
    expect(live.stdout).not.toContain('__APRA_FLEET_NO_INSTALL__');
    expect(live.code).toBe(0);
  });
});

describe.runIf(psExe)('resolveMemberFleetInstall -- a REAL PowerShell probe result is classified correctly (assertion 2b)', () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-probe-classify-'));
    liveTempDirs.push(dir);
  });

  /** Drive the resolver for a WINDOWS member, answering its probe with a result
   *  a real interpreter actually produced for `exePath`. Nothing here hand-copies
   *  a sentinel string, which is what made the earlier version of this suite
   *  blind: it fed the resolver the POSIX-shaped sentinel that the PowerShell
   *  branch provably never emitted. */
  async function resolveWithLiveProbe(exePath: string) {
    const live = runEmittedProbe(buildFleetVersionProbe(exePath, 'windows', 'powershell5'));
    mockExecCommand.mockImplementation(async (cmd: string) => {
      const script = decodePowerShell(cmd);
      if (script.includes('--version')) {
        return { stdout: live.stdout, stderr: live.stderr, code: live.code };
      }
      if (script.includes('$env:USERPROFILE')) return { stdout: MEMBER_HOME_WIN, stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });
    const member = makeTestAgent({ friendlyName: 'win-box', os: 'windows', shell: 'powershell5' });
    return { live, result: await resolveMemberFleetInstall(member) };
  }

  it('a present-but-broken install is install-unusable, NOT probe-failed or unreachable', async () => {
    const broken = writeFakeFleetExe(dir, 'broken', 'apra-fleet: bad image', 3);
    const { result } = await resolveWithLiveProbe(broken);

    expect(result.scoped).toBe(false);
    if (result.scoped) return;
    // The distinction criterion 4 requires. probe-failed here would send the
    // operator to "check that the member is powered on and reachable" for a
    // machine that is reachable and whose install is the actual problem.
    expect(result.reason).toBe('install-unusable');
    expect(result.reason).not.toBe('probe-failed');
    expect(result.remediation).toContain('win-box');
    expect(result.remediation).toContain('apra-fleet install');
  });

  it('an absent install is no-install-found, distinct from both of the above', async () => {
    const { result } = await resolveWithLiveProbe(path.join(dir, 'nothing-here.exe'));

    expect(result.scoped).toBe(false);
    if (result.scoped) return;
    expect(result.reason).toBe('no-install-found');
  });

  it('a healthy install resolves SCOPED with the version the real probe reported', async () => {
    const healthy = writeFakeFleetExe(dir, 'healthy', `apra-fleet ${GOOD_VERSION}`, 0);
    const { result } = await resolveWithLiveProbe(healthy);

    expect(result.scoped).toBe(true);
    if (!result.scoped) return;
    expect(result.version).toBe(GOOD_VERSION);
    expect(result.descriptor.args).toEqual(['run', '--transport', 'stdio']);
  });

  it('COUNTERFACTUAL: the pre-fix probe SHAPE (partial stdout, no sentinel, non-zero exit) is what collapses the two reasons', async () => {
    // Pins the misdiagnosis the fix removed, so the test above cannot be read as
    // a tautology: this is exactly what the old try/catch branch produced live
    // (measured: exit 3, stdout "partial junk", no sentinel), and the resolver
    // can only call it probe-failed. The live assertions above prove the real
    // interpreter no longer produces this shape for a broken install.
    mockExecCommand.mockImplementation(async (cmd: string) => {
      const script = decodePowerShell(cmd);
      if (script.includes('--version')) {
        return { stdout: 'apra-fleet: error while loading shared libraries\n', stderr: '', code: 3 };
      }
      if (script.includes('$env:USERPROFILE')) return { stdout: MEMBER_HOME_WIN, stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    const member = makeTestAgent({ friendlyName: 'win-box', os: 'windows', shell: 'powershell5' });
    const result = await resolveMemberFleetInstall(member);

    expect(result.scoped).toBe(false);
    if (result.scoped) return;
    expect(result.reason).toBe('probe-failed');
  });
});

// Registered at collection time (module top level, not inside any it() body), so
// it reliably attaches to this file's suite and removes every live-PowerShell
// fixture regardless of which block created it. The suite must leave os.tmpdir()
// exactly as it found it -- "tests pass" is not "tests clean up".
afterAll(() => {
  for (const d of liveTempDirs) fs.rmSync(d, { recursive: true, force: true });
  liveTempDirs.length = 0;
});

describe('resolveMemberFleetInstall -- local vs remote take different paths (assertion 4)', () => {
  it('a local member resolves via its agentType branch, a remote one via the member probe', async () => {
    // Identical host data; ONLY agentType differs.
    const shared = { friendlyName: 'same-host', os: 'linux' as const, workFolder: '/home/testuser/project' };
    const localMember = makeTestAgent({ ...shared, agentType: 'local' });
    const remoteMember = makeTestAgent({ ...shared, agentType: 'remote' });

    install({ probe: { kind: 'version', version: GOOD_VERSION } });
    const localResult = await resolveMemberFleetInstall(localMember);
    const remoteResult = await resolveMemberFleetInstall(remoteMember);

    expect(localResult.scoped).toBe(true);
    expect(remoteResult.scoped).toBe(true);
    if (!localResult.scoped || !remoteResult.scoped) return;

    // Observably different code paths, not an accidental fallthrough.
    expect(localResult.origin).toBe('local-host');
    expect(remoteResult.origin).toBe('member-probe');
    expect(localResult.descriptor.command).not.toBe(remoteResult.descriptor.command);

    // The local member legitimately shares this host, so the orchestrator's own
    // install IS its install. The remote one must NOT be that.
    expect(remoteResult.descriptor.command).toBe(MEMBER_BIN);
    expect(remoteResult.descriptor.command).not.toContain(process.execPath);
  });
});

describe('resolveMemberFleetInstall -- caching discipline (assertion 5)', () => {
  it('caches a SUCCESS so a second call does not re-probe the member', async () => {
    const member = makeTestAgent({ friendlyName: 'remote-box', os: 'linux' });
    const fsMock = install({ probe: { kind: 'version', version: GOOD_VERSION } });

    const first = await resolveMemberFleetInstall(member);
    const afterFirst = fsMock.probeCalls();
    const second = await resolveMemberFleetInstall(member);

    expect(first.scoped).toBe(true);
    expect(second).toEqual(first);
    expect(afterFirst).toBe(1);
    expect(fsMock.probeCalls()).toBe(1);
  });

  it('does NOT cache a failure -- a transient outage re-probes and recovers without a restart', async () => {
    const member = makeTestAgent({ friendlyName: 'remote-box', os: 'linux' });

    // Pass 1: the member is briefly unreachable.
    const failing = install({ probe: { kind: 'throw' } });
    const first = await resolveMemberFleetInstall(member);
    expect(first.scoped).toBe(false);
    expect(failing.probeCalls()).toBeGreaterThanOrEqual(1);

    // Pass 2: same member id, member is back. A cached failure would pin the
    // stale answer until a server restart; it must re-probe instead.
    const healthy = install({ probe: { kind: 'version', version: GOOD_VERSION } });
    clearMemberHomeDirCache(); // the home probe failed too, so it is uncached
    const second = await resolveMemberFleetInstall(member);

    expect(second.scoped).toBe(true);
    expect(healthy.probeCalls()).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// COMPOSED MEMBER CONFIG (apra-fleet-b4g.23.1)
// ---------------------------------------------------------------------------

describe('composePermissions -- ENABLED member-local stdio entry when the install is there (assertion 6)', () => {
  // EVERY supported member OS, which is what both beads say. `windows` was
  // declared in this list but not populated, so the Windows compose path -- a
  // different write command (WriteAllText), a different read-back command and a
  // backslash-joined member bin path -- was never exercised at all.
  const oses: Array<'linux' | 'macos' | 'windows'> = ['linux', 'macos', 'windows'];

  for (const memberOs of oses) {
    it(`claude/${memberOs}: enables an apra-fleet entry built from the resolver's descriptor`, async () => {
      const member = makeTestAgent({ friendlyName: 'claude-doer', llmProvider: 'claude', os: memberOs });
      addAgent(member);
      install({ probe: { kind: 'version', version: GOOD_VERSION } });

      const result = await composePermissions({ member_id: member.id, role: 'doer' });
      expect(result).toContain('Fleet MCP: enabled');

      // The member's OWN write shape was taken, so this case cannot pass
      // vacuously by having a Windows member quietly travel the POSIX branch (or
      // by the assertion helpers reading a path they never actually matched).
      const rawWrites = mockExecCommand.mock.calls
        .map(c => c[0] as string)
        .filter(c => c.includes('cat >') || c.includes('WriteAllText'));
      expect(rawWrites.length).toBeGreaterThan(0);
      for (const w of rawWrites) {
        if (memberOs === 'windows') {
          expect(w).toContain('WriteAllText');
          expect(w).not.toContain('cat >');
        } else {
          expect(w).toContain('cat >');
          expect(w).not.toContain('WriteAllText');
        }
      }

      // The ENABLED entry lives in the project .mcp.json (half of Claude's one
      // authoritative switch); it is NOT a disabled entry.
      const mcpJson = writtenJson('.mcp.json');
      expect(mcpJson.mcpServers[MEMBER_MCP_SERVER_NAME]).toEqual({
        command: expectedMemberBin(memberOs),
        args: ['run', '--transport', 'stdio'],
      });
      expect(mcpJson.mcpServers[MEMBER_MCP_SERVER_NAME].disabled).toBeUndefined();

      // No endpoint URL, host, port or credential anywhere in ANY written config.
      const allWrites = allWrittenContent();
      expect(allWrites).not.toMatch(/https?:\/\//);
      expect(allWrites.toLowerCase()).not.toContain('bearer ');
      expect(allWrites).not.toContain('?member=');
    });
  }

  for (const memberOs of ['linux', 'windows'] as const) {
    it(`agy/${memberOs}: enables the entry in agy's machine-global mcp_config.json`, async () => {
      const member = makeTestAgent({
        friendlyName: 'agy-doer', llmProvider: 'agy', os: memberOs, agyProjectId: 'proj-1',
      });
      addAgent(member);
      install({ probe: { kind: 'version', version: GOOD_VERSION } });

      const result = await composePermissions({ member_id: member.id, role: 'doer' });
      expect(result).toContain('Fleet MCP: enabled');

      const mcpConfig = writtenJson('.gemini/config/mcp_config.json');
      expect(mcpConfig.mcpServers[MEMBER_MCP_SERVER_NAME]).toEqual({
        type: 'stdio',
        command: expectedMemberBin(memberOs),
        args: ['run', '--transport', 'stdio'],
      });
      expect(JSON.stringify(mcpConfig)).not.toMatch(/https?:\/\//);
      expect(JSON.stringify(mcpConfig).toLowerCase()).not.toContain('bearer');
    });
  }

  it('the per-tool rules land for a WINDOWS member too, in both providers', async () => {
    // The rules are rendered from the shared definition, but they still have to
    // survive the Windows write path's PowerShell quoting to reach the member.
    const claudeMember = makeTestAgent({ friendlyName: 'claude-win', llmProvider: 'claude', os: 'windows' });
    addAgent(claudeMember);
    install({ probe: { kind: 'version', version: GOOD_VERSION } });
    await composePermissions({ member_id: claudeMember.id, role: 'doer' });

    const permissions = writtenJson('.claude/settings.local.json').permissions;
    for (const tool of MEMBER_ALLOWED_TOOLS) {
      expect(permissions.allow).toContain(`mcp__apra-fleet__${tool}`);
    }
    expect(permissions.deny).toContain('mcp__apra-fleet__version');
    expect(permissions.deny).toContain('mcp__apra-fleet__kb_setup');

    const agyMember = makeTestAgent({
      friendlyName: 'agy-win', llmProvider: 'agy', os: 'windows', agyProjectId: 'proj-win',
    });
    addAgent(agyMember);
    install({ probe: { kind: 'version', version: GOOD_VERSION } });
    await composePermissions({ member_id: agyMember.id, role: 'doer' });

    const grants = writtenJson('.gemini/config/projects/proj-win.json').permissionGrants.permissionGrants;
    for (const tool of MEMBER_ALLOWED_TOOLS) {
      expect(grants.allow).toContain(`mcp(apra-fleet/${tool})`);
    }
    expect(grants.deny).toContain('mcp(apra-fleet/version)');
    expect(grants.allow).not.toContain('mcp(apra-fleet)');
  });

  it('a WINDOWS member with NO install stays usable and is NAMED, exactly as a POSIX one', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-win', llmProvider: 'claude', os: 'windows' });
    addAgent(member);
    install({ probe: { kind: 'no-install' } });

    const result = await composePermissions({ member_id: member.id, role: 'doer' });

    expect(result).toContain('Permissions composed');
    expect(result).not.toContain('Failed to persist');
    expect(result).toContain('Fleet MCP: NOT scoped (no-install-found)');
    expect(wroteTo('.mcp.json')).toBe(false);
    expect(getAgent(member.id)!.memberMcpScope!.reason).toBe('no-install-found');
  });

  it('uses the descriptor VERBATIM -- the command is never rebuilt from orchestrator state', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-doer', llmProvider: 'claude', os: 'linux' });
    addAgent(member);
    install({ probe: { kind: 'version', version: GOOD_VERSION } });

    await composePermissions({ member_id: member.id, role: 'doer' });

    const entry = writtenJson('.mcp.json').mcpServers[MEMBER_MCP_SERVER_NAME];
    const serialized = JSON.stringify(entry);
    for (const owned of orchestratorOwnedValues()) {
      expect(serialized).not.toContain(owned);
    }
    // And nothing the member's shell would have to expand.
    expect(serialized).not.toContain('$HOME');
    expect(serialized).not.toContain('$env:');
    expect(serialized).not.toContain('~/');
  });
});

describe('composePermissions -- unscoped member stays usable and is NAMED (assertion 7)', () => {
  it('writes no entry, no orchestrator path, does not throw, and records reason + remediation', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-doer', llmProvider: 'claude', os: 'linux' });
    addAgent(member);
    install({ probe: { kind: 'no-install' } });

    // This is the assertion that protects remote-member sprint init: a member
    // with no install must NOT make compose_permissions fail.
    const result = await composePermissions({ member_id: member.id, role: 'doer' });
    expect(result).toContain('Permissions composed');
    expect(result).not.toContain('Failed to persist');
    expect(result).toContain('Fleet MCP: NOT scoped (no-install-found)');
    expect(result).toContain('apra-fleet install');

    // No fleet MCP entry at all -- not an enabled one, not a disabled one.
    expect(wroteTo('.mcp.json')).toBe(false);
    const settings = writtenJson('.claude/settings.local.json');
    expect(settings.mcpServers?.[MEMBER_MCP_SERVER_NAME]).toBeUndefined();

    // And no orchestrator-derived path smuggled in anywhere.
    const allWrites = mockExecCommand.mock.calls.map(c => c[0] as string).filter(c => c.includes('cat >')).join('\n');
    for (const owned of orchestratorOwnedValues()) {
      expect(allWrites).not.toContain(owned);
    }

    // Structured, read-back-able by the preflight and panel lanes.
    const scope = getAgent(member.id)!.memberMcpScope!;
    expect(scope.scoped).toBe(false);
    expect(scope.reason).toBe('no-install-found');
    expect(scope.remediation!.length).toBeGreaterThan(0);
    expect(scope.resolvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('records the scoped outcome structurally too, with the server name and version', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-doer', llmProvider: 'claude', os: 'linux' });
    addAgent(member);
    install({ probe: { kind: 'version', version: GOOD_VERSION } });

    await composePermissions({ member_id: member.id, role: 'doer' });

    const scope = getAgent(member.id)!.memberMcpScope!;
    expect(scope.scoped).toBe(true);
    expect(scope.serverName).toBe(MEMBER_MCP_SERVER_NAME);
    expect(scope.version).toBe(GOOD_VERSION);
    expect(scope.reason).toBeUndefined();
  });
});

describe('composePermissions -- exactly ONE switch for the server (assertion 8)', () => {
  it('the chosen key is present and the RETIRED key is absent from every file written', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-doer', llmProvider: 'claude', os: 'linux' });
    addAgent(member);
    install({ probe: { kind: 'version', version: GOOD_VERSION } });

    await composePermissions({ member_id: member.id, role: 'doer' });

    // Chosen switch: declared in .mcp.json.
    expect(writtenJson('.mcp.json').mcpServers[MEMBER_MCP_SERVER_NAME]).toBeDefined();
    // Retired switch: absent from settings.local.json.
    expect(writtenJson('.claude/settings.local.json').mcpServers?.[MEMBER_MCP_SERVER_NAME]).toBeUndefined();
    // And absent as a *value* anywhere: no file says the server is disabled.
    const allWrites = mockExecCommand.mock.calls.map(c => c[0] as string).filter(c => c.includes('cat >')).join('\n');
    expect(allWrites).not.toContain('"disabled"');
  });

  it('PRUNES a stale retired switch that was already on the member disk', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-doer', llmProvider: 'claude', os: 'linux' });
    addAgent(member);
    // Exactly what an older apra-fleet left behind. A deep merge alone cannot
    // remove it, so without the explicit prune the member reads as both enabled
    // (via .mcp.json) and disabled (here) at once.
    install({
      probe: { kind: 'version', version: GOOD_VERSION },
      seed: {
        '"/home/testuser/project/.claude/settings.local.json"': JSON.stringify({
          permissions: { allow: ['Read'] },
          mcpServers: { 'apra-fleet': { disabled: true } },
        }),
      },
    });

    await composePermissions({ member_id: member.id, role: 'doer' });

    const settings = writtenJson('.claude/settings.local.json');
    expect(settings.mcpServers?.['apra-fleet']).toBeUndefined();
    expect(writtenJson('.mcp.json').mcpServers['apra-fleet']).toBeDefined();
  });

  it('prunes the superseded url+credential agy entry rather than leaving it reachable', async () => {
    const member = makeTestAgent({
      friendlyName: 'agy-doer', llmProvider: 'agy', os: 'linux', agyProjectId: 'proj-1',
    });
    addAgent(member);
    install({
      probe: { kind: 'version', version: GOOD_VERSION },
      seed: {
        '"/home/testuser/.gemini/config/mcp_config.json"': JSON.stringify({
          mcpServers: {
            'apra-fleet-member': {
              type: 'http',
              url: 'http://orchestrator:9999/mcp?member=abc',
              headers: { Authorization: 'Bearer stale-jwt' },
            },
          },
        }),
      },
    });

    await composePermissions({ member_id: member.id, role: 'doer' });

    const cfg = writtenJson('.gemini/config/mcp_config.json');
    expect(cfg.mcpServers['apra-fleet-member']).toBeUndefined();
    expect(cfg.mcpServers['apra-fleet']).toBeDefined();
    expect(JSON.stringify(cfg)).not.toContain('stale-jwt');
  });
});

describe('per-tool rules in each provider\'s own syntax, from ONE definition (assertion 9)', () => {
  it('claude renders mcp__<server>__<tool> for exactly the shared allow set', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-doer', llmProvider: 'claude', os: 'linux' });
    addAgent(member);
    install({ probe: { kind: 'version', version: GOOD_VERSION } });

    await composePermissions({ member_id: member.id, role: 'doer' });
    const permissions = writtenJson('.claude/settings.local.json').permissions;

    // Driven from the single shared definition, so a duplicated second copy of
    // the list cannot satisfy this.
    for (const tool of MEMBER_ALLOWED_TOOLS) {
      expect(permissions.allow).toContain(`mcp__apra-fleet__${tool}`);
    }
    for (const tool of MEMBER_DENIED_TOOLS) {
      expect(permissions.deny).toContain(`mcp__apra-fleet__${tool}`);
    }
    // A blanket kb_* glob would pass a weaker assertion -- these two must NOT be
    // allowed, and there must be no glob at all.
    expect(permissions.allow).not.toContain('mcp__apra-fleet__version');
    expect(permissions.allow).not.toContain('mcp__apra-fleet__kb_setup');
    expect(permissions.allow).not.toContain('mcp__apra-fleet__kb_export');
    expect(permissions.allow.some((r: string) => r.includes('kb_*') || r.includes('code_*'))).toBe(false);
    expect(permissions.deny).toContain('mcp__apra-fleet__version');
    expect(permissions.deny).toContain('mcp__apra-fleet__kb_setup');
  });

  it('agy renders mcp(<server>/<tool>) for the SAME logical set', async () => {
    const member = makeTestAgent({
      friendlyName: 'agy-doer', llmProvider: 'agy', os: 'linux', agyProjectId: 'proj-1',
    });
    addAgent(member);
    install({ probe: { kind: 'version', version: GOOD_VERSION } });

    await composePermissions({ member_id: member.id, role: 'doer' });
    const grants = writtenJson('.gemini/config/projects/proj-1.json').permissionGrants.permissionGrants;

    for (const tool of MEMBER_ALLOWED_TOOLS) {
      expect(grants.allow).toContain(`mcp(apra-fleet/${tool})`);
    }
    for (const tool of MEMBER_DENIED_TOOLS) {
      expect(grants.deny).toContain(`mcp(apra-fleet/${tool})`);
    }
    expect(grants.deny).toContain('mcp(apra-fleet/version)');
    expect(grants.deny).toContain('mcp(apra-fleet/kb_setup)');
    // Never a bare server-level grant, which would widen to every tool.
    expect(grants.allow).not.toContain('mcp(apra-fleet)');
  });

  it('both renderings are the same logical set, so a divergent copy cannot pass', () => {
    const claude = renderClaudeMemberMcpRules();
    const agy = renderAgyMemberMcpRules();

    const claudeAllowTools = claude.allow.map(r => r.replace('mcp__apra-fleet__', ''));
    const agyAllowTools = agy.allow.map(r => r.replace('mcp(apra-fleet/', '').replace(')', ''));
    expect(claudeAllowTools).toEqual([...MEMBER_ALLOWED_TOOLS]);
    expect(agyAllowTools).toEqual([...MEMBER_ALLOWED_TOOLS]);
    expect(claudeAllowTools).toEqual(agyAllowTools);

    // Denies cover the same tool set in both syntaxes.
    const uniq = (xs: string[]) => [...new Set(xs)].sort();
    const claudeDenyTools = uniq(claude.deny.map(r => r.replace(/^mcp__[^_]*(?:-[^_]*)*__/, '')));
    const agyDenyTools = uniq(agy.deny.map(r => r.replace(/^mcp\([^/]+\//, '').replace(')', '')));
    expect(claudeDenyTools).toEqual(uniq([...MEMBER_DENIED_TOOLS]));
    expect(agyDenyTools).toEqual(uniq([...MEMBER_DENIED_TOOLS]));
  });

  it('the promoted lists are the SAME objects agy exports -- not a second copy (assertion 10)', () => {
    // If these ever became separate arrays, the tool-registry coverage tripwire
    // in tests/unit/agy-provider-fixes.test.ts would police only one of them.
    expect(AGY_MEMBER_ALLOWED_TOOLS).toBe(MEMBER_ALLOWED_TOOLS);
    expect(AGY_ORCHESTRATOR_DENIED_TOOLS).toBe(MEMBER_DENIED_TOOLS);
  });

  it('every tool registered in tool-registry.ts is still in exactly one list (assertion 10)', () => {
    // The same invariant tests/unit/agy-provider-fixes.test.ts enforces, re-checked
    // against the PROMOTED definition so the promotion cannot have broken it.
    const registryPath = path.resolve(__dirname, '../src/services/tool-registry.ts');
    const content = fs.readFileSync(registryPath, 'utf8');
    const tools = [...content.matchAll(/server\.tool\s*\(\s*'([^']+)'/g)].map(m => m[1]);
    expect(tools.length).toBeGreaterThan(0);

    const allowed = new Set(MEMBER_ALLOWED_TOOLS);
    const denied = new Set(MEMBER_DENIED_TOOLS);
    const missing = tools.filter(t => !allowed.has(t) && !denied.has(t));
    const both = tools.filter(t => allowed.has(t) && denied.has(t));
    expect(missing).toEqual([]);
    expect(both).toEqual([]);
  });
});

describe('composePermissions -- a post-write mismatch fails LOUD (assertion 11)', () => {
  it('surfaces a blocking failure when the read-back does not match what was intended', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-doer', llmProvider: 'claude', os: 'linux' });
    addAgent(member);
    install({
      probe: { kind: 'version', version: GOOD_VERSION },
      tamperReadBackOf: '.claude/settings.local.json',
    });

    const result = await composePermissions({ member_id: member.id, role: 'doer' });

    // Blocks with a named cause -- never merely logs and reports success.
    expect(result).toContain('Failed to persist');
    expect(result).toContain('read-back verification failed');
    expect(result).not.toContain('Permissions composed');
  });

  it('the unscoped case does NOT trigger that blocking path', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-doer', llmProvider: 'claude', os: 'linux' });
    addAgent(member);
    install({ probe: { kind: 'no-install' } });

    const result = await composePermissions({ member_id: member.id, role: 'doer' });
    expect(result).toContain('Permissions composed');
    expect(result).not.toContain('Failed to persist');
    expect(result).toContain('NOT scoped');
  });
});

describe('composePermissions -- a human-set disable is honoured, not overridden (assertion 12)', () => {
  it('preserves it and reports the member unscoped with that as the named cause', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-doer', llmProvider: 'claude', os: 'linux' });
    addAgent(member);
    // A human explicitly disabled the server for this project in the member's
    // own ~/.claude.json. That value is authoritative.
    install({
      probe: { kind: 'version', version: GOOD_VERSION },
      seed: {
        '"/home/testuser/.claude.json"': JSON.stringify({
          projects: {
            '/home/testuser/project': {
              hasTrustDialogAccepted: true,
              disabledMcpjsonServers: ['apra-fleet'],
            },
          },
        }),
      },
    });

    const result = await composePermissions({ member_id: member.id, role: 'doer' });

    expect(result).toContain('Permissions composed');
    expect(result).toContain('Fleet MCP: NOT scoped (human-disabled)');
    // Their disable is not overridden: no enabled entry is written for it.
    expect(wroteTo('.mcp.json')).toBe(false);

    const scope = getAgent(member.id)!.memberMcpScope!;
    expect(scope.scoped).toBe(false);
    expect(scope.reason).toBe('human-disabled');
    expect(scope.remediation).toContain('disabled');
  });

  it('a human\'s own permissions.deny entries survive -- fleet unions, never replaces', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-doer', llmProvider: 'claude', os: 'linux' });
    addAgent(member);
    install({
      probe: { kind: 'version', version: GOOD_VERSION },
      seed: {
        '"/home/testuser/project/.claude/settings.local.json"': JSON.stringify({
          permissions: { allow: [], deny: ['Bash(rm:*)', 'WebFetch'] },
        }),
      },
    });

    await composePermissions({ member_id: member.id, role: 'doer' });

    const deny = writtenJson('.claude/settings.local.json').permissions.deny;
    expect(deny).toContain('Bash(rm:*)');
    expect(deny).toContain('WebFetch');
    expect(deny).toContain('mcp__apra-fleet__shutdown_server');
  });
});

describe('composePermissions -- idempotency (assertion 13)', () => {
  it('composing twice yields byte-identical config and no second entry', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-doer', llmProvider: 'claude', os: 'linux' });
    addAgent(member);
    install({ probe: { kind: 'version', version: GOOD_VERSION } });

    await composePermissions({ member_id: member.id, role: 'doer' });
    const runOne = mockExecCommand.mock.calls.map(c => c[0] as string).filter(c => c.includes('cat >'));

    mockExecCommand.mockClear();
    await composePermissions({ member_id: member.id, role: 'doer' });
    const runTwo = mockExecCommand.mock.calls.map(c => c[0] as string).filter(c => c.includes('cat >'));

    const byPath = (writes: string[], frag: string) => writes.filter(w => w.includes(frag));

    for (const frag of ['.claude/settings.local.json', '.mcp.json']) {
      const a = byPath(runOne, frag);
      const b = byPath(runTwo, frag);
      expect(b.length).toBe(a.length);
      // Byte-identical: same content, not merely equivalent JSON.
      expect(b[b.length - 1]).toBe(a[a.length - 1]);
    }

    // Exactly ONE server entry, not a second one appended.
    const mcpServers = writtenJson('.mcp.json').mcpServers;
    expect(Object.keys(mcpServers)).toEqual([MEMBER_MCP_SERVER_NAME]);
    // And the allow list did not accumulate duplicates.
    const allow = writtenJson('.claude/settings.local.json').permissions.allow;
    expect(allow.length).toBe(new Set(allow).size);
  });
});

describe('composePermissions -- a provider with no MCP support is NAMED, not silent (assertion 14)', () => {
  for (const provider of ['codex', 'copilot', 'opencode'] as const) {
    it(`${provider}: yields a named unscoped reason and does not abort`, async () => {
      const member = makeTestAgent({ friendlyName: `${provider}-doer`, llmProvider: provider, os: 'linux' });
      addAgent(member);
      install({ probe: { kind: 'version', version: GOOD_VERSION } });

      const result = await composePermissions({ member_id: member.id, role: 'doer' });

      // Not an abort, and not a silently unreachable member.
      expect(result).toContain('Permissions composed');
      expect(result).toContain('Fleet MCP: NOT scoped (provider-unsupported)');
      expect(wroteTo('.mcp.json')).toBe(false);

      const scope = getAgent(member.id)!.memberMcpScope!;
      expect(scope.scoped).toBe(false);
      expect(scope.reason).toBe('provider-unsupported');
      // Actionable: says what to do about it.
      expect(scope.remediation).toContain(provider);
    });
  }
});
