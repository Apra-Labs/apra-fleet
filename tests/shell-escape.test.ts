import { describe, it, expect } from 'vitest';
import {
  escapeShellArg,
  escapeDoubleQuoted,
  escapeWindowsArg,
  escapeGrepPattern,
  sanitizeSessionId,
} from '../src/utils/shell-escape.js';

describe('escapeShellArg', () => {
  it('wraps simple string in single quotes', () => {
    expect(escapeShellArg('hello')).toBe("'hello'");
  });

  it('escapes embedded single quotes', () => {
    expect(escapeShellArg("it's")).toBe("'it'\\''s'");
  });

  it('handles empty string', () => {
    expect(escapeShellArg('')).toBe("''");
  });

  it('handles multiple single quotes', () => {
    expect(escapeShellArg("a'b'c")).toBe("'a'\\''b'\\''c'");
  });

  it('leaves double quotes and other chars untouched', () => {
    expect(escapeShellArg('say "hi"')).toBe("'say \"hi\"'");
  });

  it('neutralizes command substitution attempts', () => {
    const malicious = '$(whoami)';
    const escaped = escapeShellArg(malicious);
    expect(escaped).toBe("'$(whoami)'");
    // Inside single quotes, $(...) is literal
  });

  it('neutralizes backtick injection', () => {
    expect(escapeShellArg('`rm -rf /`')).toBe("'`rm -rf /`'");
  });
});

describe('escapeDoubleQuoted', () => {
  it('escapes backslashes', () => {
    expect(escapeDoubleQuoted('a\\b')).toBe('a\\\\b');
  });

  it('escapes double quotes', () => {
    expect(escapeDoubleQuoted('say "hi"')).toBe('say \\"hi\\"');
  });

  it('escapes dollar signs', () => {
    expect(escapeDoubleQuoted('$HOME')).toBe('\\$HOME');
  });

  it('escapes backticks', () => {
    expect(escapeDoubleQuoted('`whoami`')).toBe('\\`whoami\\`');
  });

  it('escapes exclamation marks', () => {
    expect(escapeDoubleQuoted('hello!')).toBe('hello\\!');
  });

  it('handles combined injection attempt', () => {
    const malicious = '"; rm -rf / #';
    const escaped = escapeDoubleQuoted(malicious);
    expect(escaped).toBe('\\"; rm -rf / #');
    // The leading " is escaped to \", so inside double quotes it's a literal quote, not a quote-closer
    expect(escaped.startsWith('\\"')).toBe(true);
  });

  it('handles command substitution in double quotes', () => {
    const malicious = '$(cat /etc/passwd)';
    const escaped = escapeDoubleQuoted(malicious);
    expect(escaped).toBe('\\$(cat /etc/passwd)');
  });

  it('handles empty string', () => {
    expect(escapeDoubleQuoted('')).toBe('');
  });

  it('handles safe strings without modification', () => {
    expect(escapeDoubleQuoted('hello world')).toBe('hello world');
  });
});

describe('escapeWindowsArg', () => {
  it('escapes double quotes by doubling them', () => {
    expect(escapeWindowsArg('say "hi"')).toBe('say ""hi""');
  });

  it('escapes ampersand', () => {
    expect(escapeWindowsArg('a & b')).toBe('a ^& b');
  });

  it('escapes pipe', () => {
    expect(escapeWindowsArg('a | b')).toBe('a ^| b');
  });

  it('escapes caret', () => {
    expect(escapeWindowsArg('a^b')).toBe('a^^b');
  });

  it('escapes angle brackets', () => {
    expect(escapeWindowsArg('a<b>c')).toBe('a^<b^>c');
  });

  it('handles combined Windows injection attempt', () => {
    const malicious = '"&whoami&"';
    const escaped = escapeWindowsArg(malicious);
    expect(escaped).toBe('""^&whoami^&""');
  });

  it('handles empty string', () => {
    expect(escapeWindowsArg('')).toBe('');
  });
});

describe('escapeGrepPattern', () => {
  it('escapes regex metacharacters', () => {
    expect(escapeGrepPattern('file.txt')).toBe('file\\.txt');
  });

  it('escapes dots, stars, plus, question marks', () => {
    expect(escapeGrepPattern('a.*b+c?d')).toBe('a\\.\\*b\\+c\\?d');
  });

  it('escapes brackets and braces', () => {
    expect(escapeGrepPattern('[test]{1}')).toBe('\\[test\\]\\{1\\}');
  });

  it('escapes parentheses and pipe', () => {
    expect(escapeGrepPattern('(a|b)')).toBe('\\(a\\|b\\)');
  });

  it('escapes dollar and caret', () => {
    expect(escapeGrepPattern('^start$end')).toBe('\\^start\\$end');
  });

  it('handles normal path-like strings', () => {
    expect(escapeGrepPattern('/home/user/project')).toBe('/home/user/project');
  });

  it('handles empty string', () => {
    expect(escapeGrepPattern('')).toBe('');
  });

  it('handles Windows paths', () => {
    expect(escapeGrepPattern('C:\\Users\\dev')).toBe('C:\\\\Users\\\\dev');
  });
});

describe('sanitizeSessionId', () => {
  it('accepts valid alphanumeric session IDs', () => {
    expect(sanitizeSessionId('abc-123-def')).toBe('abc-123-def');
  });

  it('accepts underscores and dashes', () => {
    expect(sanitizeSessionId('session_abc-123')).toBe('session_abc-123');
  });

  it('accepts purely numeric IDs', () => {
    expect(sanitizeSessionId('12345')).toBe('12345');
  });

  it('rejects IDs with spaces', () => {
    expect(() => sanitizeSessionId('abc 123')).toThrow('Invalid session ID');
  });

  it('rejects IDs with shell metacharacters', () => {
    expect(() => sanitizeSessionId('abc;whoami')).toThrow('Invalid session ID');
    expect(() => sanitizeSessionId('abc$(cmd)')).toThrow('Invalid session ID');
    expect(() => sanitizeSessionId('abc`cmd`')).toThrow('Invalid session ID');
    expect(() => sanitizeSessionId('abc"def')).toThrow('Invalid session ID');
    expect(() => sanitizeSessionId("abc'def")).toThrow('Invalid session ID');
  });

  it('rejects IDs with path separators', () => {
    expect(() => sanitizeSessionId('abc/def')).toThrow('Invalid session ID');
    expect(() => sanitizeSessionId('abc\\def')).toThrow('Invalid session ID');
  });

  it('rejects empty string', () => {
    expect(() => sanitizeSessionId('')).toThrow('Invalid session ID');
  });
});
