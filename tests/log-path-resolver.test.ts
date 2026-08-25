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
