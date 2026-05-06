import { describe, it, expect } from 'vitest';
import { resolveSessionLogDir, resolveSessionLogPath } from './log-path-resolver.js';

describe('log-path-resolver', () => {
  describe('resolveSessionLogDir', () => {
    it('Claude Windows: encodes path separators and colons with dashes', () => {
      const result = resolveSessionLogDir('claude', 'C:\\Users\\test\\project');
      expect(result).toContain('.claude');
      expect(result).toContain('C---Users-test-project');
    });

    it('Claude macOS: encodes path separators and colons with dashes', () => {
      const result = resolveSessionLogDir('claude', '/Users/test/project');
      expect(result).toContain('.claude');
      expect(result).toContain('Users-test-project');
    });

    it('Gemini: includes /chats/ subdirectory', () => {
      const result = resolveSessionLogDir('gemini', '/home/user/project');
      expect(result).toContain('.gemini');
      expect(result).toContain('project');
      expect(result).toContain('chats');
      expect(result?.endsWith('chats')).toBe(true);
    });

    it('Gemini: uses project basename', () => {
      const result = resolveSessionLogDir('gemini', '/path/to/my-project');
      expect(result).toContain('my-project');
    });

    it('returns null for unknown provider', () => {
      const result = resolveSessionLogDir('unknown' as any, '/some/path');
      expect(result).toBeNull();
    });

    it('uses custom homeDir when provided', () => {
      const result = resolveSessionLogDir('claude', 'C:\\work\\project', '/custom/home');
      expect(result).toContain('/custom/home');
    });
  });

  describe('resolveSessionLogPath', () => {
    it('Claude: constructs correct path with dash-encoded project path', () => {
      const result = resolveSessionLogPath('claude', 'session123', 'C:\\Users\\test\\project');
      expect(result).toContain('.claude');
      expect(result).toContain('C---Users-test-project');
      expect(result).toContain('session123.jsonl');
    });

    it('Claude macOS: encodes slashes with dashes', () => {
      const result = resolveSessionLogPath('claude', 'session456', '/Users/test/project');
      expect(result).toContain('.claude');
      expect(result).toContain('Users-test-project');
      expect(result).toContain('session456.jsonl');
    });

    it('Gemini: includes /chats/ subdirectory in path', () => {
      const result = resolveSessionLogPath('gemini', 'session789', '/home/user/my-project');
      expect(result).toContain('.gemini');
      expect(result).toContain('my-project');
      expect(result).toContain('chats');
      expect(result).toContain('session789.jsonl');
      // Verify chats appears before session ID
      const chatsIndex = result.indexOf('chats');
      const sessionIndex = result.indexOf('session789');
      expect(chatsIndex).toBeLessThan(sessionIndex);
    });

    it('Gemini: uses project basename when extracting from path', () => {
      const result = resolveSessionLogPath('gemini', 'sess_id', '/path/to/my-app');
      expect(result).toContain('my-app');
      expect(result).toContain('chats');
    });

    it('throws for unknown provider', () => {
      expect(() => {
        resolveSessionLogPath('unknown' as any, 'id', '/path');
      }).toThrow('Unknown LLM provider');
    });

    it('uses custom homeDir when provided', () => {
      const result = resolveSessionLogPath('claude', 'sess123', '/work', '/custom/home');
      expect(result).toContain('/custom/home');
      expect(result).toContain('.claude');
    });
  });
});
