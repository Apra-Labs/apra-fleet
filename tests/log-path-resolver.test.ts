import { describe, it, expect } from 'vitest';
import { resolveSessionLogPath } from '../src/services/stall/log-path-resolver.js';
import { join } from 'path';

describe('resolveSessionLogPath', () => {
  it('resolves Claude log path with project path encoding', () => {
    const result = resolveSessionLogPath(
      'claude',
      'session-123-abc',
      '/home/user/project',
      '/home/user'
    );
    // Project path /home/user/project should be encoded: /home/user%2Fproject
    const expected = join('/home/user', '.claude', 'projects', '%2Fhome%2Fuser%2Fproject', 'session-123-abc.jsonl');
    expect(result).toBe(expected);
  });

  it('resolves Claude log path with Windows path', () => {
    const result = resolveSessionLogPath(
      'claude',
      'session-456-def',
      'C:\\Users\\test\\workspace',
      'C:\\Users\\test'
    );
    // Windows path should be encoded: C:%5CUsers%5Ctest%5Cworkspace
    const expected = join('C:\\Users\\test', '.claude', 'projects', 'C:%5CUsers%5Ctest%5Cworkspace', 'session-456-def.jsonl');
    expect(result).toBe(expected);
  });

  it('resolves Gemini log path with project name extraction', () => {
    const result = resolveSessionLogPath(
      'gemini',
      'session-789-ghi',
      '/home/user/my-project',
      '/home/user'
    );
    // Gemini uses last path component as project name
    const expected = join('/home/user', '.gemini', 'tmp', 'my-project', 'session-789-ghi.jsonl');
    expect(result).toBe(expected);
  });

  it('resolves Gemini log path with Windows path', () => {
    const result = resolveSessionLogPath(
      'gemini',
      'session-xyz-123',
      'C:\\Users\\test\\workspace',
      'C:\\Users\\test'
    );
    // Extract project name from last path component
    const expected = join('C:\\Users\\test', '.gemini', 'tmp', 'workspace', 'session-xyz-123.jsonl');
    expect(result).toBe(expected);
  });

  it('uses default homedir if homeDir not provided', () => {
    // This test verifies the function uses homedir() when homeDir is omitted
    // Without mocking homedir, we just verify it doesn't throw
    expect(() => {
      resolveSessionLogPath('claude', 'session-test', '/tmp/project');
    }).not.toThrow();
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
