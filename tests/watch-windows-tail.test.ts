import { describe, it, expect } from 'vitest';
import { buildTailCommand, buildNewestTranscriptCommand, splitTranscriptChunk } from '../src/cli/watch.js';

// Item 5: the defect-class assertion used throughout this file. It must reject
// expansion-pasted POSIX-style paths ($HOME/x, ~/x) -- which PowerShell cannot
// parse (apra-fleet-ot2z) -- while ACCEPTING legitimate PowerShell forms that
// merely happen to contain the substrings "$HOME" or "~" as part of a proper
// PowerShell expression ($env:USERPROFILE, `Join-Path $HOME 'x'`, in-script
// $vars like $dir). The distinguishing feature is a bare `$HOME/` or `~/`
// path-style expansion, not mere presence of those characters.
function hasBareHomeExpansion(cmd: string): boolean {
  return /\$HOME\//.test(cmd) || /(^|[\s"'])~\//.test(cmd);
}

describe('defect-class assertion: hasBareHomeExpansion', () => {
  it('rejects a bare $HOME/... expansion-pasted path (failing example)', () => {
    expect(hasBareHomeExpansion('ls -t "$HOME/.claude/projects/x"/*.jsonl')).toBe(true);
  });

  it('rejects a bare ~/... expansion-pasted path (failing example)', () => {
    expect(hasBareHomeExpansion('cat ~/.claude/projects/x/file.jsonl')).toBe(true);
  });

  it('accepts $env:USERPROFILE-based PowerShell forms (passing example)', () => {
    expect(hasBareHomeExpansion('Get-Content -LiteralPath $env:USERPROFILE\\.claude\\projects\\x')).toBe(false);
  });

  it('accepts Join-Path $HOME \'x\' (passing example, not a bare slash expansion)', () => {
    expect(hasBareHomeExpansion("Get-ChildItem -LiteralPath (Join-Path $HOME 'x')")).toBe(false);
  });

  it('accepts an in-script PowerShell variable reference', () => {
    expect(hasBareHomeExpansion('Get-Content -LiteralPath $dir -Wait')).toBe(false);
  });
});

describe('buildTailCommand', () => {
  it('windows: uses the PowerShell follow form, no tail/-F/bare $HOME or ~, and escapes an untrusted filename', () => {
    const file = "C:\\Users\\bob\\.claude\\projects\\x\\file with space's.jsonl";
    const cmd = buildTailCommand('-n0', file, 'windows');

    expect(cmd).not.toMatch(/\btail\b/);
    expect(cmd).not.toContain('-F ');
    expect(hasBareHomeExpansion(cmd)).toBe(false);
    expect(cmd).toContain('Get-Content');
    expect(cmd).toContain('-Wait');
    // Untrusted file argument escaped with the Windows (PowerShell single-quote) escaper:
    // internal single quote doubled.
    expect(cmd).toContain("file with space''s.jsonl");
    expect(cmd).not.toContain("file with space's.jsonl'");
  });

  it('windows: "-n +1" (from top) omits -Tail 0; anything else (e.g. "-n0") adds -Tail 0', () => {
    const file = 'C:\\Users\\bob\\.claude\\projects\\x\\file.jsonl';
    const fromTop = buildTailCommand('-n +1', file, 'windows');
    const fromEnd = buildTailCommand('-n0', file, 'windows');
    expect(fromTop).not.toContain('-Tail 0');
    expect(fromEnd).toContain('-Tail 0');
  });

  it('linux: byte-identical to the pre-fix POSIX string', () => {
    const cmd = buildTailCommand('-n0', "file with space's.jsonl", 'linux');
    expect(cmd).toBe(`tail -n0 -F 'file with space'\\''s.jsonl'`);
  });

  it('darwin/default: same POSIX string when targetOs is omitted', () => {
    const cmd = buildTailCommand('-n +1', 'plain.jsonl');
    expect(cmd).toBe(`tail -n +1 -F 'plain.jsonl'`);
  });
});

describe('buildNewestTranscriptCommand (the ensureRemoteTail listing command)', () => {
  it('windows: no ls/head/2>/dev/null/bare $HOME, and the dir is a concrete resolved path', () => {
    // Mirrors ensureRemoteTail's own dir construction for a windows agent:
    // homeDir is resolved in JS (getMemberPathContext), never a shell variable.
    const homeDir = 'C:\\Users\\bob';
    const enc = 'C--Users-bob-projects-foo';
    const dir = `${homeDir.replace(/[\\/]+$/, '')}\\.claude\\projects\\${enc}`;
    const cmd = buildNewestTranscriptCommand('windows', dir);

    expect(cmd).not.toMatch(/\bls\b/);
    expect(cmd).not.toMatch(/\bhead\b/);
    expect(cmd).not.toContain('2>/dev/null');
    expect(hasBareHomeExpansion(cmd)).toBe(false);
    // The concrete resolved path appears verbatim (quote-doubling escaped).
    expect(cmd).toContain('C:\\Users\\bob\\.claude\\projects\\C--Users-bob-projects-foo');
    expect(cmd).toContain('Get-ChildItem');
  });

  it('linux: unchanged -- still uses $HOME/... and ls -t | head -1', () => {
    const dir = '$HOME/.claude/projects/foo';
    const cmd = buildNewestTranscriptCommand('linux', dir);
    expect(cmd).toBe(`ls -t "$HOME/.claude/projects/foo"/*.jsonl 2>/dev/null | head -1`);
  });
});

describe('CRLF tolerance in the remote-tail stream parser (splitTranscriptChunk)', () => {
  it('a PowerShell-produced \\r\\n chunk parses identically to the \\n equivalent', () => {
    const crlfChunk = 'line one\r\nline two\r\nline thr';
    const lfChunk = 'line one\nline two\nline thr';

    const crlfResult = splitTranscriptChunk('', crlfChunk);
    const lfResult = splitTranscriptChunk('', lfChunk);

    expect(crlfResult.lines).toEqual(lfResult.lines);
    expect(crlfResult.lines).toEqual(['line one', 'line two']);
    expect(crlfResult.leftover).toBe('line thr');
    expect(lfResult.leftover).toBe('line thr');
  });

  it('a chunk boundary that splits exactly on the CR of a \\r\\n pair is carried into leftover and rejoins on the next chunk', () => {
    const first = splitTranscriptChunk('', 'complete line\r');
    expect(first.lines).toEqual([]);
    expect(first.leftover).toBe('complete line\r');

    const second = splitTranscriptChunk(first.leftover, '\nnext line\r\n');
    expect(second.lines).toEqual(['complete line', 'next line']);
    expect(second.leftover).toBe('');
  });
});
