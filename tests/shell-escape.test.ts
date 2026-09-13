import { describe, it, expect } from 'vitest';
import {
  escapeShellArg,
  escapeShellArgInner,
  escapePowerShellArg,
  escapePowerShellArgInner,
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

describe('escapePowerShellArg', () => {
  it('wraps in single quotes and doubles embedded single quotes', () => {
    expect(escapePowerShellArg('hello')).toBe("'hello'");
    expect(escapePowerShellArg("it's")).toBe("'it''s'");
    expect(escapePowerShellArg("a'b'c")).toBe("'a''b''c'");
  });
});

// apra-fleet-3swo.7.16 criterion 2 (anti-drift invariant): escapeShellArg and
// escapePowerShellArg must be DEFINED IN TERMS OF their respective *Inner
// helpers, not merely happen to agree with them today. Asserting the
// invariant here -- rather than trusting a read of the source -- is what
// stops a future edit to one of the four functions from silently
// desynchronizing the wrapping form from the interior-only form that
// vcs-credential-exec.ts's inline placeholder mode relies on.
describe('escapeShellArgInner / escapePowerShellArgInner anti-drift invariant', () => {
  const samples = [
    'hello',
    "it's",
    "a'b'c",
    '',
    "'",
    "''",
    "'''",
    'say "hi"',
    '$(whoami)',
    '`rm -rf /`',
    "a'b\"c$d`e!f",
    "multi\nline'value",
  ];

  it('escapeShellArg(s) === "\'" + escapeShellArgInner(s) + "\'" for every sample', () => {
    for (const s of samples) {
      expect(escapeShellArg(s)).toBe("'" + escapeShellArgInner(s) + "'");
    }
  });

  it('escapePowerShellArg(s) === "\'" + escapePowerShellArgInner(s) + "\'" for every sample', () => {
    for (const s of samples) {
      expect(escapePowerShellArg(s)).toBe("'" + escapePowerShellArgInner(s) + "'");
    }
  });

  it('escapeShellArgInner escapes a single quote as \'\\\'\' with no surrounding quotes', () => {
    expect(escapeShellArgInner("it's")).toBe("it'\\''s");
    expect(escapeShellArgInner("'")).toBe("'\\''");
  });

  it('escapePowerShellArgInner escapes a single quote by doubling it, with no surrounding quotes', () => {
    expect(escapePowerShellArgInner("it's")).toBe("it''s");
    expect(escapePowerShellArgInner("'")).toBe("''");
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
  it('escapes all regex metacharacters individually', () => {
    // Each of these characters MUST be escaped with a backslash
    const chars = '.*+?^${}()|[]\\'.split('');
    for (const char of chars) {
      const escaped = escapeGrepPattern(char);
      expect(escaped).toBe('\\' + char);
    }
  });

  it('escapes a complex regex string correctly', () => {
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
