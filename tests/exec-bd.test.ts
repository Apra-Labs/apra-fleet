import { describe, it, expect } from 'vitest';
import { execBdSync } from '../scripts/lib/exec-bd.mjs';

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
