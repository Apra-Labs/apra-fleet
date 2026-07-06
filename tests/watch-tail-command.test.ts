import { describe, it, expect } from 'vitest';
import { buildTailCommand } from '../src/cli/watch.js';

// The remote transcript filename fed to `tail` comes from `ls -t` on the
// member's own disk -- untrusted input. These tests lock in that
// buildTailCommand shell-escapes it, so a hostile filename cannot break out of
// the argument and inject a second command over the SSH channel.
describe('buildTailCommand (remote transcript tail)', () => {
  it('wraps a normal filename in single quotes', () => {
    expect(buildTailCommand('-n0', '/home/u/.claude/projects/p/sess.jsonl')).toBe(
      "tail -n0 -F '/home/u/.claude/projects/p/sess.jsonl'",
    );
  });

  it('passes the caller-controlled start flag through verbatim', () => {
    expect(buildTailCommand('-n +1', '/a/b.jsonl')).toBe("tail -n +1 -F '/a/b.jsonl'");
  });

  it('neutralizes a command-injection filename (semicolon + rm -rf)', () => {
    const evil = '/a/b.jsonl; rm -rf /';
    const cmd = buildTailCommand('-n0', evil);
    // The whole payload stays inside one single-quoted argument, so the `;` and
    // `rm -rf /` are literal text handed to `tail`, not a second command.
    expect(cmd).toBe("tail -n0 -F '/a/b.jsonl; rm -rf /'");
  });

  it('neutralizes a stray single quote (quote-break attempt)', () => {
    const evil = "/a/b'.jsonl; touch pwned; '";
    const cmd = buildTailCommand('-n0', evil);
    // Embedded quote is escaped as '\'' so the argument never terminates early.
    expect(cmd).toBe("tail -n0 -F '/a/b'\\''.jsonl; touch pwned; '\\'''");
  });

  it('neutralizes command substitution and backticks', () => {
    expect(buildTailCommand('-n0', '/a/$(whoami).jsonl')).toBe("tail -n0 -F '/a/$(whoami).jsonl'");
    expect(buildTailCommand('-n0', '/a/`id`.jsonl')).toBe("tail -n0 -F '/a/`id`.jsonl'");
  });
});
