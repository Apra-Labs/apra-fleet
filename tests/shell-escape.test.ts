import { describe, it, expect } from 'vitest';
import {
  escapeShellArg,
  escapeDoubleQuoted,
  escapeWindowsArg,
  escapeGrepPattern,
  sanitizeSessionId,
} from '../src/utils/shell-escape.js';

describe('escapeShellArg', () => {
  it('wraps in single quotes and escapes embedded single quotes', () => {
    expect(escapeShellArg('hello')).toBe("'hello'");
    expect(escapeShellArg("it's")).toBe("'it'\\''s'");
    expect(escapeShellArg("a'b'c")).toBe("'a'\\''b'\\''c'");
    expect(escapeShellArg('say "hi"')).toBe("'say \"hi\"'");
  });

  it('neutralizes command injection attempts', () => {
    expect(escapeShellArg('$(whoami)')).toBe("'$(whoami)'");
    expect(escapeShellArg('`rm -rf /`')).toBe("'`rm -rf /`'");
  });
});

describe('escapeDoubleQuoted', () => {
  it('escapes all double-quote-special characters', () => {
    const input = 'a\\b"c$d`e!f';
    const escaped = escapeDoubleQuoted(input);
    expect(escaped).toBe('a\\\\b\\"c\\$d\\`e\\!f');
  });

  it('neutralizes injection attempts', () => {
    const injection = '"; rm -rf / #';
    const escaped = escapeDoubleQuoted(injection);
    expect(escaped.startsWith('\\"')).toBe(true);

    const cmdSub = '$(cat /etc/passwd)';
    expect(escapeDoubleQuoted(cmdSub)).toBe('\\$(cat /etc/passwd)');
  });

  it('leaves safe strings unchanged', () => {
    expect(escapeDoubleQuoted('hello world')).toBe('hello world');
  });
});

describe('escapeWindowsArg', () => {
  it('escapes all cmd.exe metacharacters', () => {
    const input = 'a"b&c|d^e<f>g';
    expect(escapeWindowsArg(input)).toBe('a""b^&c^|d^^e^<f^>g');
  });

  it('neutralizes Windows injection attempts', () => {
    expect(escapeWindowsArg('"&whoami&"')).toBe('""^&whoami^&""');
  });
});

describe('escapeGrepPattern', () => {
  it('escapes all regex metacharacters', () => {
    const input = 'a.*b+c?d^e$f{g}h(i|j)k[l]m\\n';
    const escaped = escapeGrepPattern(input);
    expect(escaped).toBe('a\\.\\*b\\+c\\?d\\^e\\$f\\{g\\}h\\(i\\|j\\)k\\[l\\]m\\\\n');
  });

  it('leaves path-like strings unchanged', () => {
    expect(escapeGrepPattern('/home/user/project')).toBe('/home/user/project');
  });

  it('escapes Windows backslash paths', () => {
    expect(escapeGrepPattern('C:\\Users\\dev')).toBe('C:\\\\Users\\\\dev');
  });
});

describe('sanitizeSessionId', () => {
  it('accepts valid session IDs', () => {
    expect(sanitizeSessionId('abc-123-def')).toBe('abc-123-def');
    expect(sanitizeSessionId('session_abc-123')).toBe('session_abc-123');
    expect(sanitizeSessionId('12345')).toBe('12345');
  });

  it('rejects IDs with dangerous characters', () => {
    expect(() => sanitizeSessionId('abc;whoami')).toThrow('Invalid session ID');
    expect(() => sanitizeSessionId('abc$(cmd)')).toThrow('Invalid session ID');
    expect(() => sanitizeSessionId('abc`cmd`')).toThrow('Invalid session ID');
    expect(() => sanitizeSessionId('abc"def')).toThrow('Invalid session ID');
    expect(() => sanitizeSessionId("abc'def")).toThrow('Invalid session ID');
    expect(() => sanitizeSessionId('abc/def')).toThrow('Invalid session ID');
    expect(() => sanitizeSessionId('abc\\def')).toThrow('Invalid session ID');
  });

  it('rejects empty string', () => {
    expect(() => sanitizeSessionId('')).toThrow('Invalid session ID');
  });
});
