import { describe, it, expect } from 'vitest';
import { execBdSync, execBdAsync } from '../scripts/lib/exec-bd.mjs';

// Tests for apra-fleet-2cc.1: scripts/lib/exec-bd.mjs -- the single shared
// cross-platform 'bd' invocation helper used by scripts/sandbox-seed-beads.mjs
// and scripts/check-sandbox-sync-remote.mjs.
//
// Root cause it fixes: on Windows the globally-installed `bd` resolves to
// npm's extensionless POSIX shim; `execFileSync('bd', ...)` without
// `{ shell: true }` throws `spawnSync bd ENOENT` because Windows'
// CreateProcess cannot exec a shebang script directly. This helper always
// forces `shell: true`, which lets the platform shell (cmd.exe on Windows,
// /bin/sh elsewhere) do PATHEXT/shim resolution exactly like an interactive
// `bd ...` invocation would.

describe('execBdSync', () => {
  it('invokes the injected execFileSync as "bd" with the given args and shell: true forced on', () => {
    const calls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
    const fakeExecFileSync = (cmd: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({ cmd, args, opts });
      return 'fake-output';
    };

    const result = execBdSync(['dolt', 'remote', 'list', '--json'], { cwd: '/some/repo', encoding: 'utf-8' }, fakeExecFileSync as never);

    expect(result).toBe('fake-output');
    expect(calls.length).toBe(1);
    expect(calls[0].cmd).toBe('bd');
    expect(calls[0].args).toEqual(['dolt', 'remote', 'list', '--json']);
    expect(calls[0].opts.cwd).toBe('/some/repo');
    expect(calls[0].opts.encoding).toBe('utf-8');
    expect(calls[0].opts.shell).toBe(true);
  });

  it('forces shell: true even if a caller-supplied options object tries to set shell: false', () => {
    const calls: Array<{ opts: Record<string, unknown> }> = [];
    const fakeExecFileSync = (_cmd: string, _args: string[], opts: Record<string, unknown>) => {
      calls.push({ opts });
      return '';
    };

    execBdSync(['--version'], { shell: false } as never, fakeExecFileSync as never);

    expect(calls[0].opts.shell).toBe(true);
  });

  it('throws a TypeError when args is not an array (defensive: never silently stringify/concatenate)', () => {
    expect(() => execBdSync('not-an-array' as never)).toThrow(TypeError);
  });

  it('defaults to the real node:child_process execFileSync when no implementation is injected, and can run a real "bd --version"', () => {
    // This is the acceptance-criterion path: a real execFileSync('bd', ...)
    // equivalent, but routed through this helper's shell: true, must succeed
    // on this platform (Windows via cmd.exe resolving the bd.cmd shim; POSIX
    // via /bin/sh resolving the real bd binary/symlink either way).
    const out = execBdSync(['--version'], { encoding: 'utf-8' });
    expect(String(out)).toMatch(/bd version/);
  });
});

// Tests for apra-fleet-xuo.2: execBdAsync, the async counterpart used by
// packages/apra-fleet-se/src/supervisor/backlog.mjs's fetchAllBeadsRaw() and
// scope-overlap.mjs's bdListChildren(), which previously each hand-rolled
// their own execFileAsync('bd', [...], { shell: true }) call.
//
// Like execBdSync, this still forces shell: true -- as of the Node
// CVE-2024-27980 fix, execFile/spawn refuse to invoke a .bat/.cmd file
// directly at all without it (spawn EINVAL), so there is no shell-free way to
// resolve the npm-installed bd.cmd shim on Windows. What execBdAsync adds is
// assertSafeArgs(): every arg must match an allowlist charset (letters,
// digits, '.', '_', '-') BEFORE the shell ever sees it, closing the
// metacharacter-injection risk shell: true carries (verified empirically:
// cmd.exe treats unescaped &, ;, $(), and () in an array arg as separate
// shell tokens even though Node passes args as an array) at the helper level
// rather than depending on every call site remembering to validate its own
// caller-controlled values.
describe('execBdAsync', () => {
  it('invokes the injected execFileAsync as "bd" with the given args and shell: true forced on', async () => {
    const calls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
    const fakeExecFileAsync = async (cmd: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({ cmd, args, opts });
      return { stdout: 'fake-output', stderr: '' };
    };

    const result = await execBdAsync(['list', '--parent', 'apra-fleet-xuo', '--json', '--limit', '0'], { cwd: '/some/repo', encoding: 'utf-8' }, fakeExecFileAsync as never);

    expect(result.stdout).toBe('fake-output');
    expect(calls.length).toBe(1);
    expect(calls[0].cmd).toBe('bd');
    expect(calls[0].args).toEqual(['list', '--parent', 'apra-fleet-xuo', '--json', '--limit', '0']);
    expect(calls[0].opts.cwd).toBe('/some/repo');
    expect(calls[0].opts.encoding).toBe('utf-8');
    expect(calls[0].opts.shell).toBe(true);
  });

  it('forces shell: true even if a caller-supplied options object tries to set shell: false', async () => {
    const calls: Array<{ opts: Record<string, unknown> }> = [];
    const fakeExecFileAsync = async (_cmd: string, _args: string[], opts: Record<string, unknown>) => {
      calls.push({ opts });
      return { stdout: '', stderr: '' };
    };

    await execBdAsync(['--version'], { shell: false } as never, fakeExecFileAsync as never);

    expect(calls[0].opts.shell).toBe(true);
  });

  it('throws a TypeError when args is not an array (defensive: never silently stringify/concatenate)', () => {
    expect(() => execBdAsync('not-an-array' as never)).toThrow(TypeError);
  });

  it('throws when an arg contains a shell metacharacter, before the shell ever sees it', () => {
    const fakeExecFileAsync = async () => ({ stdout: '', stderr: '' });
    for (const unsafe of ['a; rm -rf /', 'a & b', '$(touch pwned)', '`touch pwned`', 'a|b', 'a<b', 'a>b', 'a(b)']) {
      expect(() => execBdAsync(['list', '--parent', unsafe], {}, fakeExecFileAsync as never)).toThrow(TypeError);
    }
  });

  it('allows the charset bd invocations legitimately need (letters, digits, dot, underscore, dash)', async () => {
    const fakeExecFileAsync = async () => ({ stdout: 'ok', stderr: '' });
    const result = await execBdAsync(['list', '--parent', 'apra-fleet-xuo.2_v1', '--json', '--limit', '0'], {}, fakeExecFileAsync as never);
    expect(result.stdout).toBe('ok');
  });

  it('defaults to the real node:child_process execFile when no implementation is injected, and can run a real "bd --version"', async () => {
    const out = await execBdAsync(['--version'], { encoding: 'utf-8' });
    expect(String(out.stdout)).toMatch(/bd version/);
  });
});
