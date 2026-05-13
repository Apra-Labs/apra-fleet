import { describe, it, expect } from 'vitest';
import {
  escapeShellArg,
  escapeDoubleQuoted,
  escapeWindowsArg,
  escapePowerShellArg,
  escapeBatchMetachars,
  escapeGrepPattern,
  sanitizeSessionId,
} from '../src/shell-escape.js';

describe('escapeShellArg', () => {
  it('wraps in single quotes', () => {
    expect(escapeShellArg('hello')).toBe("'hello'");
  });

  it('escapes embedded single quotes', () => {
    expect(escapeShellArg("it's")).toBe("'it'\\''s'");
  });

  it('handles empty string', () => {
    expect(escapeShellArg('')).toBe("''");
  });
});

describe('escapeDoubleQuoted', () => {
  it('escapes dollar signs', () => {
    expect(escapeDoubleQuoted('$HOME')).toBe('\\$HOME');
  });

  it('escapes backticks', () => {
    expect(escapeDoubleQuoted('`cmd`')).toBe('\\`cmd\\`');
  });

  it('escapes backslashes and double quotes', () => {
    expect(escapeDoubleQuoted('a\\b"c')).toBe('a\\\\b\\"c');
  });

  it('escapes exclamation marks', () => {
    expect(escapeDoubleQuoted('hello!')).toBe('hello\\!');
  });
});

describe('escapeWindowsArg', () => {
  it('doubles double quotes', () => {
    expect(escapeWindowsArg('"hello"')).toBe('""hello""');
  });

  it('escapes cmd metacharacters', () => {
    expect(escapeWindowsArg('a&b|c')).toBe('a^&b^|c');
  });
});

describe('escapePowerShellArg', () => {
  it('wraps in single quotes', () => {
    expect(escapePowerShellArg('hello')).toBe("'hello'");
  });

  it('doubles internal single quotes', () => {
    expect(escapePowerShellArg("it's")).toBe("'it''s'");
  });
});

describe('escapeBatchMetachars', () => {
  it('escapes batch metacharacters', () => {
    expect(escapeBatchMetachars('a&b|c>d<e^f%g')).toBe('a^&b^|c^>d^<e^^f^%g');
  });
});

describe('escapeGrepPattern', () => {
  it('escapes regex metacharacters', () => {
    expect(escapeGrepPattern('a.b*c+d?e')).toBe('a\\.b\\*c\\+d\\?e');
  });
});

describe('sanitizeSessionId', () => {
  it('allows valid session IDs', () => {
    expect(sanitizeSessionId('abc-123_def')).toBe('abc-123_def');
  });

  it('rejects invalid characters', () => {
    expect(() => sanitizeSessionId('abc def')).toThrow('Invalid session ID');
    expect(() => sanitizeSessionId('abc;rm -rf')).toThrow('Invalid session ID');
    expect(() => sanitizeSessionId('../etc/passwd')).toThrow('Invalid session ID');
  });
});
