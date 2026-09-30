/**
 * Project-level role-agent shadow check (src/services/agent-shadow.ts):
 * pure command building / parsing / classification, plus the member-facing
 * check against a mocked strategy (quarantine vs tracked report).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SSHExecResult } from '../src/types.js';
import { makeTestAgent } from './test-helpers.js';

const mockExec = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();
vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({ execCommand: mockExec, testConnection: vi.fn(), transferFiles: vi.fn(), close: vi.fn() }),
}));
vi.mock('../src/services/member-home.js', () => ({
  getMemberHomeDir: vi.fn(async () => '/home/testuser'),
}));
vi.mock('../src/services/agent-provisioner.js', () => ({
  remoteAgentsDir: (p: string) => (p === 'codex' || p === 'none' ? null : '.claude/agents'),
  loadCanonicalAgentSet: () => [
    { relPath: 'doer.md', content: '---\nname: doer\ndescription: x\n---\nbody', sha256: 'a' },
    { relPath: 'planner.md', content: '---\nname: planner\n---\n', sha256: 'b' },
    { relPath: '_shared/GRAPH-SEMANTICS.md', content: '# not a role', sha256: 'c' },
    { relPath: 'schemas/doer-input.json', content: '{}', sha256: 'd' },
  ],
}));

import {
  buildShadowProbeCommand,
  buildQuarantineCommand,
  parseShadowProbeOutput,
  classifyShadows,
  managedRolesFrom,
  frontmatterName,
  checkProjectAgentShadows,
  ensureNoProjectAgentShadows,
  invalidateProjectAgentShadowCache,
  shadowCheckCache,
} from '../src/services/agent-shadow.js';

function decodePs(cmd: string): string {
  const m = /-EncodedCommand (\S+)/.exec(cmd);
  expect(m).not.toBeNull();
  return Buffer.from(m![1], 'base64').toString('utf16le');
}

const ok = (stdout: string): SSHExecResult => ({ stdout, stderr: '', code: 0 });

describe('agent-shadow pure helpers', () => {
  it('builds a POSIX probe with single-quoted, injection-safe paths', () => {
    const cmd = buildShadowProbeCommand(true, "/w/it's/.claude/agents", "/w/it's");
    expect(cmd).toContain("d='/w/it'\\''s/.claude/agents'");
    expect(cmd).toContain("w='/w/it'\\''s'");
    expect(cmd).toContain("find -P \"$d\" -type f -name '*.md'");
    expect(cmd).toContain('ls-files --error-unmatch');
    expect(cmd).toContain('FLEETSHADOW_DONE');
    expect(cmd).not.toContain('powershell');
  });

  it('builds a PowerShell probe delivered via -EncodedCommand with literal-quoted paths', () => {
    const cmd = buildShadowProbeCommand(false, "C:\\w\\it's\\.claude\\agents", "C:\\w\\it's");
    expect(cmd.startsWith('powershell -EncodedCommand ')).toBe(true);
    const ps = decodePs(cmd);
    expect(ps).toContain("$d = 'C:\\w\\it''s\\.claude\\agents'");
    expect(ps).toContain("$w = 'C:\\w\\it''s'");
    expect(ps).toContain('$c.Attributes -band [IO.FileAttributes]::ReparsePoint)) { $stack.Push($c.FullName) }');
    expect(ps).not.toContain('-Recurse');
    expect(ps).toContain("$ErrorActionPreference = 'Continue'");
    expect(ps).toContain('FLEETSHADOW_DONE');
  });

  it('builds quarantine commands per shell, preserving relative subpaths', () => {
    const posix = buildQuarantineCommand(true, false, '/w/.claude/agents', '/w/.claude/agents-shadowed-by-fleet', '/w/.claude/agents-shadowed-by-fleet/T', ['doer.md', 'sub/x.md']);
    expect(posix).toContain("mv -f -- '/w/.claude/agents/doer.md' '/w/.claude/agents-shadowed-by-fleet/T/doer.md'");
    expect(posix).toContain("mkdir -p '/w/.claude/agents-shadowed-by-fleet/T/sub'");
    expect(posix).toContain("> '/w/.claude/agents-shadowed-by-fleet/.gitignore'");
    const ps = decodePs(buildQuarantineCommand(false, true, 'C:\\w\\.claude\\agents', 'C:\\w\\.claude\\agents-shadowed-by-fleet', 'C:\\w\\.claude\\agents-shadowed-by-fleet\\T', ['sub/x.md']));
    expect(ps).toContain("Move-Item -LiteralPath 'C:\\w\\.claude\\agents\\sub\\x.md' -Destination 'C:\\w\\.claude\\agents-shadowed-by-fleet\\T\\sub\\x.md'");
  });

  it('parses probe output (CRLF tolerant) and rejects incomplete or unsafe output', () => {
    const out = 'banner\r\nFLEETSHADOW_GIT\trepo\r\nFLEETSHADOW\tU\tdoer.md\tdoer\r\nFLEETSHADOW\tT\tsub/r.md\t"planner"\r\nFLEETSHADOW\tU\t../evil.md\tx\r\nFLEETSHADOW_DONE\r\n';
    const p = parseShadowProbeOutput(out)!;
    expect(p.gitState).toBe('repo');
    expect(p.entries).toEqual([
      { relPath: 'doer.md', tracked: false, name: 'doer' },
      { relPath: 'sub/r.md', tracked: true, name: 'planner' },
    ]);
    expect(parseShadowProbeOutput('FLEETSHADOW_GIT\trepo\n')).toBeNull();
    expect(parseShadowProbeOutput('{"result":"ok"}')).toBeNull();
  });

  it('basename matches but frontmatter name differs -> not a shadow (the CLI keys agents by name:)', () => {
    const roles = managedRolesFrom([{ relPath: 'reviewer.md', content: '---\nname: reviewer\n---\n' }]);
    const cls = classifyShadows({
      gitState: 'repo', links: [],
      entries: [{ relPath: 'reviewer.md', tracked: false, name: 'code-reviewer' }],
    }, roles);
    expect(cls.untracked).toEqual([]);
    expect(cls.tracked).toEqual([]);
  });

  it('classifies by name (basename only when no name:); ignores non-colliding files; tracked vs untracked', () => {
    const roles = managedRolesFrom([
      { relPath: 'doer.md', content: '---\nname: doer\n---\n' },
      { relPath: 'planner.md', content: '---\nname: planner\n---\n' },
      { relPath: '_shared/GRAPH-SEMANTICS.md', content: '' },
    ]);
    expect(roles.basenames.has('graph-semantics.md')).toBe(false);
    const cls = classifyShadows({
      gitState: 'repo', links: [],
      entries: [
        { relPath: 'Doer.md', tracked: false, name: '' },           // no name: -> basename fallback (case-insensitive)
        { relPath: 'my-builder.md', tracked: true, name: 'planner' }, // frontmatter-name match, tracked
        { relPath: 'custom.md', tracked: false, name: 'custom' },   // non-colliding
      ],
    }, roles);
    expect(cls.untracked.map(e => e.relPath)).toEqual(['Doer.md']);
    expect(cls.tracked.map(e => e.relPath)).toEqual(['my-builder.md']);
  });

  it('treats an unknown git state as tracked (never moves what it cannot prove untracked)', () => {
    const roles = managedRolesFrom([{ relPath: 'doer.md', content: '---\nname: doer\n---\n' }]);
    const cls = classifyShadows({ gitState: 'unknown', links: [], entries: [{ relPath: 'doer.md', tracked: false, name: 'doer' }] }, roles);
    expect(cls.untracked).toEqual([]);
    expect(cls.tracked).toHaveLength(1);
  });

  it('probe: git state is norepo only on an explicit not-a-repo answer, else ancestor .git walk -> unknown', () => {
    const sh = buildShadowProbeCommand(true, '/w/.claude/agents', '/w');
    expect(sh).toContain('g=unknown');
    expect(sh).toContain("grep -qi 'not a git repository'; then g=norepo");
    expect(sh).toContain('while :; do if [ -e "$p/.git" ]; then found=1');
    expect(sh).not.toMatch(/^g=norepo$/m);
    const ps = decodePs(buildShadowProbeCommand(false, 'C:\\w\\.claude\\agents', 'C:\\w'));
    expect(ps).toContain("$g = 'unknown'");
    expect(ps).toContain("elseif ($o -match 'not a git repository') { $g = 'norepo' }");
    expect(ps).toContain('Split-Path -Parent $p');
  });

  it('probe: checks each agents-dir component for a symlink/junction before listing', () => {
    const sh = buildShadowProbeCommand(true, '/w/.claude/agents', '/w', ['/w/.claude', '/w/.claude/agents']);
    expect(sh).toContain("if [ -L '/w/.claude' ]; then lnk=1");
    expect(sh).toContain("if [ -L '/w/.claude/agents' ]; then lnk=1");
    expect(sh).toContain('if [ "$lnk" = 0 ] && [ -d "$d" ]');
    const ps = decodePs(buildShadowProbeCommand(false, 'C:\\w\\.claude\\agents', 'C:\\w', ['C:\\w\\.claude', 'C:\\w\\.claude\\agents']));
    expect(ps).toContain("Get-Item -LiteralPath 'C:\\w\\.claude' -Force");
    expect(ps).toContain('[IO.FileAttributes]::ReparsePoint');
    expect(ps).toContain('if (-not $lnk -and (Test-Path -LiteralPath $d -PathType Container))');
    expect(parseShadowProbeOutput('FLEETSHADOW_GIT\trepo\nFLEETSHADOW_LINK\t/w/.claude/agents\nFLEETSHADOW_DONE\n')!.links).toEqual(['/w/.claude/agents']);
  });

  it('probe: name: is read only inside the leading frontmatter block', () => {
    const sh = buildShadowProbeCommand(true, '/w/.claude/agents', '/w');
    expect(sh).toContain('NR==1{if ($0 !~ /^---[ \\t\\r]*$/) exit; next} /^---[ \\t\\r]*$/{exit}');
    const ps = decodePs(buildShadowProbeCommand(false, 'C:\\w\\.claude\\agents', 'C:\\w'));
    expect(ps).toContain("$ls[0] -match '^---\\s*$'");
    expect(ps).toContain("if ($ls[$k] -match '^---\\s*$') { break }");
  });

  it('quarantine: failed moves are reported per file (Stop + verify on PowerShell, verify on POSIX)', () => {
    const ps = decodePs(buildQuarantineCommand(false, true, 'C:\\w\\a', 'C:\\w\\q', 'C:\\w\\q\\T', ['doer.md']));
    expect(ps).toContain("$ErrorActionPreference = 'Stop'");
    expect(ps).toContain('Move-Item -LiteralPath \'C:\\w\\a\\doer.md\' -Destination \'C:\\w\\q\\T\\doer.md\' -Force -ErrorAction Stop');
    expect(ps).toContain("throw 'move not verified'");
    expect(ps).toContain("catch { [Console]::Out.Write('FLEETMOVEFAIL'");
    const sh = buildQuarantineCommand(true, false, '/w/a', '/w/q', '/w/q/T', ['doer.md']);
    expect(sh).toContain("[ ! -e '/w/a/doer.md' ] && [ -e '/w/q/T/doer.md' ]; then printf 'FLEETMOVED");
    expect(sh).toContain("else printf 'FLEETMOVEFAIL\\t%s\\n' 'doer.md'");
  });

  it('reads frontmatter name', () => {
    expect(frontmatterName('---\r\nname: "doer"\r\n---\r\n')).toBe('doer');
    expect(frontmatterName('# no frontmatter\nname: x')).toBe('');
  });
});

describe('checkProjectAgentShadows (mocked strategy)', () => {
  beforeEach(() => {
    mockExec.mockReset();
    shadowCheckCache.clear();
  });

  const member = () => makeTestAgent({ friendlyName: 'm1', os: 'linux', workFolder: '/home/testuser/project' });

  it('quarantines a stale untracked project-level doer.md', async () => {
    mockExec
      .mockResolvedValueOnce(ok('FLEETSHADOW_GIT\trepo\nFLEETSHADOW\tU\tdoer.md\tdoer\nFLEETSHADOW\tU\tcustom.md\tcustom\nFLEETSHADOW_DONE\n'))
      .mockResolvedValueOnce(ok('FLEETMOVED\tdoer.md\nFLEETQUARANTINE_DONE\n'));
    const r = await checkProjectAgentShadows(member(), new Date('2026-09-30T10:00:00.000Z'));
    expect(r.status).toBe('shadowed');
    expect(r.quarantined).toEqual(['doer.md']);
    expect(r.tracked).toEqual([]);
    expect(r.quarantineDir).toBe('/home/testuser/project/.claude/agents-shadowed-by-fleet/2026-09-30T10-00-00-000Z');
    expect(r.persistentWarning).toBeUndefined();
    expect(r.warning).toContain('Quarantined 1');
    const qcmd = mockExec.mock.calls[1][0];
    expect(qcmd).toContain("mv -f -- '/home/testuser/project/.claude/agents/doer.md'");
    expect(qcmd).not.toContain('custom.md');
  });

  it('reports a tracked shadow loudly and never touches it', async () => {
    mockExec.mockResolvedValueOnce(ok('FLEETSHADOW_GIT\trepo\nFLEETSHADOW\tT\tdoer.md\tdoer\nFLEETSHADOW_DONE\n'));
    const r = await checkProjectAgentShadows(member());
    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(r.tracked).toEqual(['doer.md']);
    expect(r.persistentWarning).toContain('tracked in git');
    expect(r.persistentWarning).toContain('renaming the file does not help');
    expect(r.persistentWarning).toContain('doer.md');
  });

  it('a failed quarantine move lands in notMoved with a persistent warning and is not cached', async () => {
    const probe = ok('FLEETSHADOW_GIT\trepo\nFLEETSHADOW\tU\tdoer.md\tdoer\nFLEETSHADOW_DONE\n');
    const qfail = ok('FLEETMOVEFAIL\tdoer.md\nFLEETQUARANTINE_DONE\n');
    mockExec.mockResolvedValueOnce(probe).mockResolvedValueOnce(qfail).mockResolvedValueOnce(probe).mockResolvedValueOnce(qfail);
    const m = member();
    const w1 = await ensureNoProjectAgentShadows(m);
    expect(w1).toContain('Could not quarantine');
    expect(shadowCheckCache.size).toBe(0);
    const r = await checkProjectAgentShadows(m);
    expect(r.quarantined).toEqual([]);
    expect(r.notMoved).toEqual(['doer.md']);
    expect(r.persistentWarning).toContain('doer.md');
  });

  it('skips (with a warning, no quarantine) when the agents dir is a symlink/junction', async () => {
    mockExec.mockResolvedValueOnce(ok('FLEETSHADOW_GIT\trepo\nFLEETSHADOW_LINK\t/home/testuser/project/.claude/agents\nFLEETSHADOW_DONE\n'));
    const r = await checkProjectAgentShadows(member());
    expect(r.status).toBe('skipped');
    expect(r.warning).toContain('symlink/junction');
    expect(mockExec).toHaveBeenCalledTimes(1);
    const probeCmd = mockExec.mock.calls[0][0];
    expect(probeCmd).toContain("if [ -L '/home/testuser/project/.claude' ]");
    expect(probeCmd).toContain("if [ -L '/home/testuser/project/.claude/agents' ]");
  });

  it('unknown member home: shadows are reported, never moved, and the result is not cached', async () => {
    const mh = await import('../src/services/member-home.js');
    vi.mocked(mh.getMemberHomeDir).mockResolvedValueOnce(null);
    mockExec.mockResolvedValueOnce(ok('FLEETSHADOW_GIT\trepo\nFLEETSHADOW\tU\tdoer.md\tdoer\nFLEETSHADOW_DONE\n'));
    const w = await ensureNoProjectAgentShadows(member());
    expect(w).toContain('not quarantined (member home dir could not be verified)');
    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(shadowCheckCache.size).toBe(0);
  });

  it('surfaces a probe failure as a warning and does not cache it', async () => {
    mockExec.mockResolvedValue({ stdout: '', stderr: 'boom', code: 2 });
    const w = await ensureNoProjectAgentShadows(member());
    expect(w).toContain('Could not check');
    expect(shadowCheckCache.size).toBe(0);
  });

  it('caches per member+workFolder, re-emits tracked warnings, and invalidates', async () => {
    const m = member();
    mockExec.mockResolvedValue(ok('FLEETSHADOW_GIT\trepo\nFLEETSHADOW\tT\tdoer.md\tdoer\nFLEETSHADOW_DONE\n'));
    const w1 = await ensureNoProjectAgentShadows(m);
    const w2 = await ensureNoProjectAgentShadows(m);
    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(w2).toBe(w1);
    invalidateProjectAgentShadowCache(m.id);
    await ensureNoProjectAgentShadows(m);
    expect(mockExec).toHaveBeenCalledTimes(2);
  });

  it('skips providers with no managed role set without a round trip', async () => {
    const r = await checkProjectAgentShadows(makeTestAgent({ llmProvider: 'codex' as any }));
    expect(r.status).toBe('skipped');
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('skips when the work folder is the member home (project dir == managed user dir)', async () => {
    const r = await checkProjectAgentShadows(makeTestAgent({ os: 'linux', workFolder: '/home/testuser' }));
    expect(r.status).toBe('skipped');
    expect(mockExec).not.toHaveBeenCalled();
  });
});
