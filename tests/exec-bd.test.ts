import { describe, it, expect } from 'vitest';
import {
  execBdSync,
  execBdAsync,
  resolveWindowsBdScript,
  warnIfLargeBdOutput,
  BD_MAX_BUFFER_BYTES,
  BD_LARGE_OUTPUT_WARN_BYTES,
} from '../scripts/lib/exec-bd.mjs';

// Tests for apra-fleet-2cc.1: scripts/lib/exec-bd.mjs -- the single shared
// cross-platform 'bd' invocation helper used by scripts/sandbox-seed-beads.mjs
// and scripts/check-sandbox-sync-remote.mjs.
//
// Root cause it fixes: on Windows the globally-installed `bd` resolves to
// npm's extensionless POSIX shim; `execFileSync('bd', ...)` without
// `{ shell: true }` throws `spawnSync bd ENOENT` because Windows'
// CreateProcess cannot exec a shebang script directly.
//
// 2026-07-30 review fix: `execBdSync` no longer routes through
// `{ shell: true }` on win32. Instead it resolves the real `.../bin/bd.js`
// script the npm `bd.cmd` shim wraps (`resolveWindowsBdScript()`) and
// invokes THAT directly via a plain, shell-less
// `execFileSync(process.execPath, [scriptPath, ...args])` -- closing the
// shell-metacharacter-injection surface `{ shell: true }` carried (verified
// empirically: Node does not safely quote array args for cmd.exe) for
// scripts/sandbox-seed-beads.mjs's caller-controlled `--prefix` and
// `pathToFileURL(...)`-derived `--remote` values. `execBdSync` only falls
// back to the pre-fix `{ shell: true }` invocation when that resolution
// fails (or on non-Windows, where a real `bd` binary/symlink already execs
// fine shell-less either way).

describe('resolveWindowsBdScript', () => {
  it('extracts the wrapped bin/bd.js path from a real npm-shim-shaped bd.cmd, when node.exe is bundled', () => {
    const shimContent = [
      '@ECHO off',
      'GOTO start',
      ':find_dp0',
      'SET dp0=%~dp0',
      'EXIT /b',
      ':start',
      'SETLOCAL',
      'CALL :find_dp0',
      '',
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ') ELSE (',
      '  SET "_prog=node"',
      '  SET PATHEXT=%PATHEXT:;.JS;=;%',
      ')',
      '',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@beads\\bd\\bin\\bd.js" %*',
      '',
    ].join('\r\n');

    const scriptPath = resolveWindowsBdScript({
      env: { PATH: 'C:\\Users\\fake\\AppData\\Roaming\\npm' },
      platform: 'win32',
      existsFn: (p: string) => p === 'C:\\Users\\fake\\AppData\\Roaming\\npm\\bd.cmd',
      readFileFn: () => shimContent,
    });

    expect(scriptPath).toBe('C:\\Users\\fake\\AppData\\Roaming\\npm\\node_modules\\@beads\\bd\\bin\\bd.js');
  });

  it('searches every PATH entry and returns null when bd.cmd is on none of them', () => {
    const scriptPath = resolveWindowsBdScript({
      env: { PATH: 'C:\\a;C:\\b;C:\\c' },
      platform: 'win32',
      existsFn: () => false,
      readFileFn: () => { throw new Error('should never be called'); },
    });
    expect(scriptPath).toBeNull();
  });

  it('returns null when bd.cmd exists but does not match the expected npm-shim shape', () => {
    const scriptPath = resolveWindowsBdScript({
      env: { PATH: 'C:\\a' },
      platform: 'win32',
      existsFn: (p: string) => p === 'C:\\a\\bd.cmd',
      readFileFn: () => '@ECHO off\r\necho not an npm shim\r\n',
    });
    expect(scriptPath).toBeNull();
  });

  it('always returns null on a non-win32 platform, regardless of what PATH/fs would otherwise resolve', () => {
    const scriptPath = resolveWindowsBdScript({
      env: { PATH: '/usr/local/bin' },
      platform: 'linux',
      existsFn: () => true,
      readFileFn: () => 'irrelevant',
    });
    expect(scriptPath).toBeNull();
  });
});

describe('execBdSync', () => {
  it('on the win32 safe path: invokes the resolved bin/bd.js script directly via process.execPath, with shell: false, and no shell-metacharacter arg is ever reinterpreted', () => {
    const calls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
    const fakeExecFileSync = (cmd: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({ cmd, args, opts });
      return 'fake-output';
    };
    const fakeResolveWindowsBd = () => 'C:\\fake\\npm\\node_modules\\@beads\\bd\\bin\\bd.js';

    // An arg containing a shell metacharacter -- if this ever reached a real
    // shell, '&' would start a second command. Proving it is passed through
    // as one opaque argv element (not string-concatenated into a command
    // line) is the direct regression test for the reviewed vulnerability.
    const injectionAttempt = 'a & echo INJECTED';
    const result = execBdSync(
      ['list', '--parent', injectionAttempt, '--json'],
      { cwd: '/some/repo', encoding: 'utf-8' },
      fakeExecFileSync as never,
      fakeResolveWindowsBd,
    );

    expect(result).toBe('fake-output');
    expect(calls.length).toBe(1);
    expect(calls[0].cmd).toBe(process.execPath);
    expect(calls[0].args).toEqual(['C:\\fake\\npm\\node_modules\\@beads\\bd\\bin\\bd.js', 'list', '--parent', injectionAttempt, '--json']);
    expect(calls[0].opts.cwd).toBe('/some/repo');
    expect(calls[0].opts.encoding).toBe('utf-8');
    expect(calls[0].opts.shell).toBe(false);
  });

  it('never lets a caller-supplied options object force shell: true back on when the win32 safe path is used', () => {
    const calls: Array<{ opts: Record<string, unknown> }> = [];
    const fakeExecFileSync = (_cmd: string, _args: string[], opts: Record<string, unknown>) => {
      calls.push({ opts });
      return '';
    };
    execBdSync(['--version'], { shell: true } as never, fakeExecFileSync as never, () => 'C:\\fake\\bd.js');
    expect(calls[0].opts.shell).toBe(false);
  });

  it('falls back to invoking "bd" directly (shell-less on POSIX, shell: true on win32) when bd.cmd cannot be resolved', () => {
    const calls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
    const fakeExecFileSync = (cmd: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({ cmd, args, opts });
      return 'fake-output';
    };

    const result = execBdSync(['dolt', 'remote', 'list', '--json'], { cwd: '/some/repo', encoding: 'utf-8' }, fakeExecFileSync as never, () => null);

    expect(result).toBe('fake-output');
    expect(calls.length).toBe(1);
    expect(calls[0].cmd).toBe('bd');
    expect(calls[0].args).toEqual(['dolt', 'remote', 'list', '--json']);
    expect(calls[0].opts.cwd).toBe('/some/repo');
    expect(calls[0].opts.encoding).toBe('utf-8');
    expect(calls[0].opts.shell).toBe(process.platform === 'win32');
  });

  it('throws a TypeError when args is not an array (defensive: never silently stringify/concatenate)', () => {
    expect(() => execBdSync('not-an-array' as never)).toThrow(TypeError);
  });

  it('defaults to the real node:child_process execFileSync and the real resolveWindowsBdScript when no implementation is injected, and can run a real "bd --version"', () => {
    // This is the acceptance-criterion path: a real execFileSync('bd', ...)
    // equivalent must succeed on this platform (Windows via the resolved
    // bin/bd.js script, shell-less; POSIX via the real bd binary/symlink,
    // also shell-less).
    const out = execBdSync(['--version'], { encoding: 'utf-8' });
    expect(String(out)).toMatch(/bd version/);
  });

  it('a real "bd list" invocation with a shell-metacharacter-laden --parent value does not leak a second command onto stdout/stderr (real end-to-end injection regression check)', () => {
    // Uses a bogus but harmless issue id (bd will just report zero/blocked
    // results, or nothing at all, for a nonexistent parent) -- what this
    // asserts is the ABSENCE of the injected echo's output, proving no shell
    // ever interpreted the '&'.
    let out = '';
    try {
      out = String(execBdSync(['list', '--parent', 'a & echo INJECTED-BY-TEST', '--json', '--limit', '0'], { encoding: 'utf-8' }));
    } catch (err) {
      // bd itself rejecting the bogus id is also an acceptable outcome here
      // -- what matters is that no shell ever ran the injected echo.
      out = err instanceof Error ? String((err as { stdout?: unknown }).stdout ?? err.message) : String(err);
    }
    expect(out).not.toMatch(/INJECTED-BY-TEST/);
    // Real `bd` subprocess spawn on a shared CI runner has been observed to
    // exceed vitest's default 5000ms under load (GitHub Actions build-and-test,
    // 2026-08-12) -- this is a real subprocess call, not a mock, so give it
    // headroom rather than tightening timing assumptions on a shared runner.
  }, 20000);
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

// ---------------------------------------------------------------------------
// maxBuffer (dolt sync budget review round 2, item 1)
// ---------------------------------------------------------------------------
//
// Node's execFile/execFileSync default maxBuffer is 1MiB, and overflowing it
// KILLS the child (ERR_CHILD_PROCESS_STDIO_MAXBUFFER) rather than truncating.
// Measured on the apra-fleet tracker: `bd list --all --limit 0 --json` emitted
// ~2.96MB at 766 issues -- every POST /api/sprints launch-overlap guard call
// (and every dashboard progress tick) failed. The ceiling is therefore set
// centrally here, so no call site can inherit the 1MiB default by omission.
describe('exec-bd maxBuffer', () => {
  it('exposes a 64MB ceiling and an 8MB warn threshold', () => {
    expect(BD_MAX_BUFFER_BYTES).toBe(64 * 1024 * 1024);
    expect(BD_LARGE_OUTPUT_WARN_BYTES).toBe(8 * 1024 * 1024);
    expect(BD_MAX_BUFFER_BYTES).toBeGreaterThan(BD_LARGE_OUTPUT_WARN_BYTES);
  });

  it('execBdAsync passes the 64MB maxBuffer even when the caller supplies no options', async () => {
    const calls: Array<{ opts: Record<string, unknown> }> = [];
    const fakeExecFileAsync = async (_cmd: string, _args: string[], opts: Record<string, unknown>) => {
      calls.push({ opts });
      return { stdout: '', stderr: '' };
    };
    await execBdAsync(['list', '--all', '--limit', '0', '--json'], {}, fakeExecFileAsync as never);
    expect(calls[0].opts.maxBuffer).toBe(BD_MAX_BUFFER_BYTES);
  });

  it('execBdAsync lets an explicit caller maxBuffer win, but never silently falls back to Node 1MiB', async () => {
    const calls: Array<{ opts: Record<string, unknown> }> = [];
    const fakeExecFileAsync = async (_cmd: string, _args: string[], opts: Record<string, unknown>) => {
      calls.push({ opts });
      return { stdout: '', stderr: '' };
    };
    await execBdAsync(['--version'], { maxBuffer: 123 } as never, fakeExecFileAsync as never);
    expect(calls[0].opts.maxBuffer).toBe(123);
    await execBdAsync(['--version'], { cwd: '/x' } as never, fakeExecFileAsync as never);
    expect(calls[1].opts.maxBuffer).toBe(BD_MAX_BUFFER_BYTES);
  });

  it('execBdSync passes the 64MB maxBuffer on BOTH the win32 script path and the fallback path', () => {
    const calls: Array<{ opts: Record<string, unknown> }> = [];
    const fakeExecFileSync = (_cmd: string, _args: string[], opts: Record<string, unknown>) => {
      calls.push({ opts });
      return '';
    };
    execBdSync(['--version'], {}, fakeExecFileSync as never, () => 'C:\\fake\\bd.js');
    expect(calls[0].opts.maxBuffer).toBe(BD_MAX_BUFFER_BYTES);
    execBdSync(['--version'], {}, fakeExecFileSync as never, () => null);
    expect(calls[1].opts.maxBuffer).toBe(BD_MAX_BUFFER_BYTES);
    execBdSync(['--version'], { maxBuffer: 7 } as never, fakeExecFileSync as never, () => null);
    expect(calls[2].opts.maxBuffer).toBe(7);
  });

  it('an output over the 1MiB Node default is returned intact instead of killing the child', async () => {
    // The exact size class that crashed the launch guard in production.
    const big = 'x'.repeat(3 * 1024 * 1024);
    const fakeExecFileAsync = async () => ({ stdout: big, stderr: '' });
    const res = await execBdAsync(['list', '--all', '--limit', '0', '--json'], {}, fakeExecFileAsync as never);
    expect(String(res.stdout).length).toBe(3 * 1024 * 1024);
  });

  it('warns once an output crosses the 8MB threshold, and stays silent below it', async () => {
    const warnings: string[] = [];
    const warn = (msg: string) => { warnings.push(msg); };
    const small = async () => ({ stdout: 'x'.repeat(1024), stderr: '' });
    await execBdAsync(['list', '--json'], {}, small as never, warn as never);
    expect(warnings.length).toBe(0);

    const huge = async () => ({ stdout: 'x'.repeat(BD_LARGE_OUTPUT_WARN_BYTES + 1), stderr: '' });
    await execBdAsync(['list', '--all', '--limit', '0', '--json'], {}, huge as never, warn as never);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/bd list --all --limit 0 --json/);
    expect(warnings[0]).toMatch(/8\.0MB/);
  });

  it('warnIfLargeBdOutput measures Buffers and strings alike, and never throws on a broken logger', () => {
    expect(warnIfLargeBdOutput(['list'], null)).toBe(0);
    expect(warnIfLargeBdOutput(['list'], 'abc')).toBe(3);
    expect(warnIfLargeBdOutput(['list'], Buffer.alloc(10))).toBe(10);
    const broken = () => { throw new Error('logger exploded'); };
    expect(() => warnIfLargeBdOutput(['list'], Buffer.alloc(BD_LARGE_OUTPUT_WARN_BYTES + 1), broken)).not.toThrow();
  });
});
