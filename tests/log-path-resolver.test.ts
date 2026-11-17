import { describe, it, expect } from 'vitest';
import {
  encodeClaudeProjectDir,
  resolveSessionLogDir,
  resolveSessionLogPath,
} from '../src/services/stall/log-path-resolver.js';
import { join } from 'path';

describe('encodeClaudeProjectDir', () => {
  it('replaces every non-alphanumeric char with a dash (Claude Code rule)', () => {
    // Observed on disk: underscores, slashes AND dots all become '-'.
    expect(encodeClaudeProjectDir('/home/ecs_user/vbv_nyk/apra-edge-vision'))
      .toBe('-home-ecs-user-vbv-nyk-apra-edge-vision');
  });

  it('preserves existing dashes and letter case', () => {
    expect(encodeClaudeProjectDir('/home/ecs-user/repos/ApraPipes'))
      .toBe('-home-ecs-user-repos-ApraPipes');
  });

  // GitHub #562 review: names over 200 chars are cut and suffixed with
  // base36(|hash(cwd)|) by the claude CLI. Expected values computed with the
  // CLI bundle's own QZ/Vx functions (claude 2.1.287), copied verbatim.
  const SEG = 'very-long-directory-name-segment/';
  const WSEG = 'very_long_directory_name_segment\\';
  it('over-200 POSIX name matches the CLI (200-char cut + base36 hash)', () => {
    const cwd = '/home/fleet/' + SEG.repeat(7) + 'repo';
    expect(encodeClaudeProjectDir(cwd, false)).toBe(
      '-home-fleet-very-long-directory-name-segment-very-long-directory-name-segment-very-long-directory-name-segment-very-long-directory-name-segment-very-long-directory-name-segment-very-long-directory-nam-5y80us',
    );
  });

  it('over-200 Windows name hashes the backslash cwd form, even when stored with forward slashes', () => {
    const cwd = 'C:\\Users\\fleet\\' + WSEG.repeat(7) + 'repo';
    const expected = 'C--Users-fleet-very-long-directory-name-segment-very-long-directory-name-segment-very-long-directory-name-segment-very-long-directory-name-segment-very-long-directory-name-segment-very-long-directory--knqmjg';
    expect(encodeClaudeProjectDir(cwd, true)).toBe(expected);
    expect(encodeClaudeProjectDir(cwd.replace(/\\/g, '/'), true)).toBe(expected);
    expect(encodeClaudeProjectDir(cwd + '\\', true)).toBe(expected);
  });

  it('strips trailing separators like the CLI cwd (C:/repo/ -> C--repo, /a/b/ -> -a-b)', () => {
    expect(encodeClaudeProjectDir('C:/repo/', true)).toBe('C--repo');
    expect(encodeClaudeProjectDir('C:\\repo\\\\', true)).toBe('C--repo');
    expect(encodeClaudeProjectDir('/home/u/repo/', false)).toBe('-home-u-repo');
    expect(encodeClaudeProjectDir('/', false)).toBe('-');
    expect(encodeClaudeProjectDir('C:\\', true)).toBe('C--');
  });

  it('regression: does not leave underscores un-encoded', () => {
    // The old regex /[\/\\:]/ kept underscores, so watch/stall looked in the
    // wrong dir for any path containing '_'. Guard against that returning.
    const dir = resolveSessionLogDir('claude', '/home/ecs_user/vbv_nyk/app');
    expect(dir).toContain('-home-ecs-user-vbv-nyk-app');
    expect(dir).not.toContain('ecs_user');
  });
});

describe('resolveSessionLogPath', () => {
  it('resolves Claude log path with project path encoding', () => {
    const result = resolveSessionLogPath(
      'claude',
      'session-123-abc',
      '/home/user/project',
      '/home/user'
    );
    // Project path /home/user/project should be encoded with dashes: -home-user-project
    const expected = join('/home/user', '.claude', 'projects', '-home-user-project', 'session-123-abc.jsonl');
    expect(result).toBe(expected);
  });

  it('resolves Claude log path with Windows path', () => {
    const result = resolveSessionLogPath(
      'claude',
      'session-456-def',
      'C:\\Users\\test\\workspace',
      'C:\\Users\\test'
    );
    // Windows path should be encoded with dashes: C--Users-test-workspace
    const expected = join('C:\\Users\\test', '.claude', 'projects', 'C--Users-test-workspace', 'session-456-def.jsonl');
    expect(result).toBe(expected);
  });

  it('uses default homedir if homeDir not provided', () => {
    // This test verifies the function uses homedir() when homeDir is omitted
    // Without mocking homedir, we just verify it doesn't throw
    expect(() => {
      resolveSessionLogPath('claude', 'session-test', '/tmp/project');
    }).not.toThrow();
  });

  it('resolves AGY log path with session brain directory structure', () => {
    const result = resolveSessionLogPath(
      'agy',
      'session-agy-123',
      '/tmp/project',
      '/home/user'
    );
    const expected = join('/home/user', '.gemini', 'antigravity-cli', 'brain', 'session-agy-123', '.system_generated', 'logs', 'transcript.jsonl');
    expect(result).toBe(expected);
  });

  it('resolves AGY log directory', () => {
    const dir = resolveSessionLogDir('agy', '/tmp/project', '/home/user');
    const expected = join('/home/user', '.gemini', 'antigravity-cli', 'brain');
    expect(dir).toBe(expected);
  });

  it('throws error for unknown provider', () => {
    expect(() => {
      resolveSessionLogPath(
        'unknown' as any,
        'session-123',
        '/tmp/project',
        '/home/user'
      );
    }).toThrow('Unknown LLM provider');
  });
});
