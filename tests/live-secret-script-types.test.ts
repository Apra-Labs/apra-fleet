/**
 * `secret --live` grammar and script types through the real CLI (node
 * dist/index.js, needs a build), plus the launch rules for every OS with the
 * platform as a parameter. Each script is real and reports what it received; the
 * tool it stands for is a fake, and no credential is real.
 *
 * The rules for another OS's launch are unit-tested here on every host. The real
 * runs of .sh with and without the execute bit, .ps1 under pwsh and the POSIX
 * refusals happen only on the matching CI runner.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildProgramInvocation,
  LiveLauncherError,
  resolvePosixPwsh,
  type ScriptLaunchers,
} from '../src/services/live-secret-runner.js';
import { isWslLauncherBash, resolveGitBashExecutable } from '../src/os/windows-executable.js';
import { inlineScriptChanged } from '../src/cli/inline-quote-check.js';
import { inlineQuoteFailure } from '../src/cli/secret.js';

const WIN = process.platform === 'win32';
const CLI = path.resolve(__dirname, '..', 'dist', 'index.js');
const TOKEN = 'tok-TYPES-CANARY-5d1c';
const BOUND = 'bound-TYPES-CANARY-9e2f';

let sandbox: string;
let dataDir: string;
let report: string;
let reporter: string;

function cli(args: string[], input?: string) {
  return spawnSync(process.execPath, [CLI, 'secret', ...args], {
    env: { ...process.env, APRA_FLEET_DATA_DIR: dataDir },
    input: input ?? '',
    encoding: 'utf-8',
    timeout: 90_000,
  });
}

function records(): Record<string, any> {
  const file = path.join(dataDir, 'credentials.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')).credentials : {};
}

function reported(): { argv: string[]; credential: string; bound: string } {
  return JSON.parse(fs.readFileSync(report, 'utf-8'));
}

function setBound(): void {
  expect(cli(['--set', 'R', '--persist', '-y'], `${BOUND}\n`).status).toBe(0);
}

function writeScript(name: string, content: string, mode = 0o644): string {
  const dir = path.join(sandbox, 'dir with spaces');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, { mode });
  return file;
}

function expectRegisteredAndReported(name: string, r: ReturnType<typeof cli>, argv: string[]): void {
  expect(r.stderr).toBe('');
  expect(r.status).toBe(0);
  expect(r.stdout).toMatch(/^OK: expires /);
  expect(r.stdout + r.stderr).not.toContain(BOUND);
  expect(reported()).toEqual({ argv, credential: name, bound: BOUND });
  expect(records()[name].kind).toBe('live');
  expect(JSON.stringify(records()[name])).not.toContain(BOUND);
}

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-live-types-'));
  dataDir = path.join(sandbox, 'data');
  fs.mkdirSync(dataDir);
  report = path.join(sandbox, 'report.json');
  // Every script type below calls this, the same way, so each reports the args it got.
  reporter = path.join(sandbox, 'report.js');
  fs.writeFileSync(reporter, `
    require('fs').writeFileSync(${JSON.stringify(report)}, JSON.stringify({ argv: process.argv.slice(2), credential: process.env.FLEET_CREDENTIAL, bound: process.env.BOUND }));
    process.stdout.write(JSON.stringify({ token: ${JSON.stringify(TOKEN)}, expires_at: new Date(Date.now() + 3600000).toISOString() }));
  `);
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('secret --live grammar, through the real CLI', () => {
  let script: string;
  const nodeRun = () => [process.execPath, reporter];

  beforeEach(() => {
    script = reporter;
    setBound();
  });

  it('without --, the first non-option is the program: what npm\'s PowerShell shim leaves of the documented form', () => {
    const r = cli(['--live', 'noseparator', '--env', 'BOUND={{secret.R}}', ...nodeRun(), 'a']);
    expectRegisteredAndReported('noseparator', r, ['a']);
    expect(records().noseparator.program).toBe(process.execPath);
  });

  it('args starting with - and the script\'s own -- go to the script untouched', () => {
    const args = ['-x', '--inline', '--env', 'y', '--', '--help', '-h'];
    const r = cli(['--live', 'dashargs', '--env', 'BOUND={{secret.R}}', ...nodeRun(), ...args]);
    expectRegisteredAndReported('dashargs', r, args);
  });

  it('-- still works before the script path', () => {
    const r = cli(['--live', 'withseparator', '--env', 'BOUND={{secret.R}}', '--', ...nodeRun(), '--', 'a']);
    expectRegisteredAndReported('withseparator', r, ['--', 'a']);
  });

  it('a script whose name starts with -: ./ works without --, and -- finds it only on PATH, as the docs say', () => {
    const dashed = path.join(sandbox, '-dashed.js');
    fs.copyFileSync(script, dashed);
    const name = WIN ? '-dashed.cmd' : '-dashed.sh';
    const body = WIN
      ? `@"${process.execPath}" "${reporter}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${reporter}" "$@"\n`;
    fs.writeFileSync(path.join(sandbox, name), body, { mode: 0o755 });
    const opts = { env: { ...process.env, APRA_FLEET_DATA_DIR: dataDir }, cwd: sandbox, encoding: 'utf-8' as const, input: '', timeout: 90_000 };
    const live = (...rest: string[]) => spawnSync(process.execPath, [CLI, 'secret', '--live', 'dashpath', '--env', 'BOUND={{secret.R}}', ...rest], opts);
    // Bare and with no --: an unknown option.
    const bare = live(name);
    expect(bare.status).toBe(1);
    expect(bare.stderr).toContain('Usage');
    // After --, a bare name is looked up on PATH only, so one in this folder is not found.
    const notOnPath = live('--', name);
    expect(notOnPath.status).toBe(1);
    expect(notOnPath.stderr).toContain('program-not-found');
    expect(records().dashpath).toBeUndefined();
    const dotSlash = live(`./${name}`);
    expect(dotSlash.stderr).toBe('');
    expect(dotSlash.status).toBe(0);
    // Real paths: on macOS the temp folder is a symlink, and a child's cwd is already resolved.
    expect(fs.realpathSync(records().dashpath.program)).toBe(fs.realpathSync(path.join(sandbox, name)));
    expect(path.isAbsolute(records().dashpath.program)).toBe(true);
    const onPath = spawnSync(process.execPath, [CLI, 'secret', '--live', 'dashonpath', '--env', 'BOUND={{secret.R}}', '--', name], {
      ...opts, cwd: dataDir, env: { ...opts.env, PATH: `${sandbox}${path.delimiter}${process.env.PATH}` },
    });
    expect(onPath.stderr).toBe('');
    expect(onPath.status).toBe(0);
    expect(fs.realpathSync(records().dashonpath.program)).toBe(fs.realpathSync(path.join(sandbox, name)));
  });

  it('an unknown option before the script path is an error, and saves nothing', () => {
    const r = cli(['--live', 'badopt', '--nope', ...nodeRun()]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Usage');
    expect(records().badopt).toBeUndefined();
    expect(fs.existsSync(report)).toBe(false);
  });

  it('--env cannot swallow the script path', () => {
    const r = cli(['--live', 'swallow', '--env', script]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Usage');
    expect(records().swallow).toBeUndefined();
    const notPlaceholder = cli(['--live', 'swallow', '--env', 'X=plain', ...nodeRun()]);
    expect(notPlaceholder.status).toBe(1);
    expect(notPlaceholder.stderr).toContain('bad-env');
    expect(records().swallow).toBeUndefined();
    expect(fs.existsSync(report)).toBe(false);
  });

  it('a split --inline is refused with the double-quote advice, runs nothing and saves nothing', () => {
    // What Windows PowerShell 5.1 hands over for: --inline 'node -e "x y"'
    const r = cli(['--live', 'split', '--inline', 'node', '-e', 'x', 'y']);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/^FAILED: inline-extra-args: /);
    expect(r.stderr).toContain('double quotes');
    expect(r.stderr).toContain('Windows PowerShell 5.1');
    expect(r.stderr).toContain('script file');
    expect(r.stderr).not.toContain('node -e');
    expect(records().split).toBeUndefined();
  });

  // Raw command lines recorded from Windows PowerShell 5.1 running node with --inline '<script>'.
  it.each([
    ['$x = "abc"; Write-Output $x', '"node.exe" i.js --inline "$x = "abc"; Write-Output $x"', '$x = abc; Write-Output $x', true],
    ["x=\"a\"", '"node.exe" i.js --inline x="a"', 'x=a', true],
    ["$t = (az --query ''{t:a}'')", `"node.exe" i.js --inline "$t = (az --query '{t:a}')"`, "$t = (az --query '{t:a}')", false],
    ['say \\"hi\\"', '"node.exe" i.js --inline "say \\"hi\\""', 'say "hi"', false],
    ['abc', '"node.exe" i.js --inline abc', 'abc', false],
  ])('the raw command line shows whether the shell changed %s', (_typed, raw, argv, changed) => {
    expect(inlineScriptChanged(raw, argv)).toBe(changed);
    const failure = inlineQuoteFailure(argv, raw);
    if (changed) expect(failure).toMatch(/^FAILED: inline-quotes-changed: /);
    else expect(failure).toBeNull();
  });

  it('a raw command line that cannot be read or does not hold the script is refused, not trusted', () => {
    expect(inlineQuoteFailure('abc', null)).toMatch(/^FAILED: inline-unverified: /);
    expect(inlineQuoteFailure('abc', '"node.exe" i.js --inline other')).toMatch(/^FAILED: inline-unverified: /);
  });

  it.runIf(WIN)('Windows PowerShell 5.1: an inline script whose double quotes it removed is refused and saves nothing; doubled single quotes register', () => {
    const ok = writeScript('ok.js', `process.stdout.write(JSON.stringify({token:${JSON.stringify(TOKEN)},expires_at:new Date(Date.now()+3600000).toISOString()}))`);
    const ps1 = path.join(sandbox, 'register.ps1');
    const node = process.execPath.replace(/'/g, "''");
    const cliPath = CLI.replace(/'/g, "''");
    const okPath = ok.replace(/'/g, "''");
    fs.writeFileSync(ps1, [
      `& '${node}' '${cliPath}' secret --live changed --inline '$x = "abc"; node ''${okPath}'''`,
      `& '${node}' '${cliPath}' secret --live kept --inline 'node ''${okPath}'''`,
    ].join('\r\n'));
    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], {
      env: { ...process.env, APRA_FLEET_DATA_DIR: dataDir }, encoding: 'utf-8', timeout: 90_000,
    });
    expect(r.stderr).toMatch(/^FAILED: inline-quotes-changed: /m);
    expect(r.stderr).not.toContain('abc');
    expect(r.stdout).toMatch(/^OK: expires /m);
    expect(records().changed).toBeUndefined();
    expect(records().kept).toBeDefined();
  }, 90_000);

  it('--inline cannot be combined with a script path, with or without --', () => {
    for (const rest of [[script], ['--', script]]) {
      const r = cli(['--live', 'both', '--inline', 'echo hi', ...rest]);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/^FAILED: inline-extra-args: /);
      expect(records().both).toBeUndefined();
    }
  });
});

describe('script types this OS can run, through the real CLI, from a path with spaces', () => {
  beforeEach(() => setBound());

  /** Args every launch must pass unchanged. A bare -- is left out here: see the .ps1 case. */
  const ARGS = ['a b', '-x', '*', 'C:\\dir\\f', '/usr/bin', 'q"uote', '%PATH%', '$HOME'];
  const register = (name: string, file: string, args: string[] = ARGS) =>
    cli(['--live', name, '--env', 'BOUND={{secret.R}}', file, ...args]);

  const insidePowerShell = () => {
    const seen = path.join(sandbox, 'seen-ps.txt');
    const file = writeScript('inside.ps1', `@($args) + $env:FLEET_CREDENTIAL + $env:BOUND | Set-Content -Path $env:SEEN_FILE -Encoding Ascii\n@{ token = '${TOKEN}'; expires_at = '2100-01-01T00:00:00Z' } | ConvertTo-Json -Compress\n`);
    const args = [...ARGS, '--', 'after', 'tail\\'];
    const r = spawnSync(process.execPath, [CLI, 'secret', '--live', 'insideps', '--env', 'BOUND={{secret.R}}', file, ...args], {
      env: { ...process.env, APRA_FLEET_DATA_DIR: dataDir, SEEN_FILE: seen },
      encoding: 'utf-8', input: '', timeout: 90_000,
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(fs.readFileSync(seen, 'utf-8').split(/\r?\n/).slice(0, -1)).toEqual([...args, 'insideps', BOUND]);
  };

  describe.skipIf(!WIN)('Windows', () => {
    it('.ps1 through powershell.exe', () => {
      const file = writeScript('mint.ps1', `& "${process.execPath}" "${reporter}" @args\n`);
      // PowerShell re-quotes for node with its own rules, so a " does not survive that hop.
      const args = ARGS.filter((a) => !a.includes('"'));
      expectRegisteredAndReported('ps', register('ps', file, args), args);
    }, 90_000);

    for (const name of ['mint.py', 'mint.txt', 'mint']) {
      it(`${name} is refused with the types Windows runs, and saves nothing`, () => {
        const r = register(name.replace('.', '_'), writeScript(name, 'x\n'));
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/^FAILED: script-type-unsupported: .*\.ps1, \.sh, \.bat, \.cmd, \.exe or \.com/);
        expect(records()[name.replace('.', '_')]).toBeUndefined();
      });
    }

    it('.ps1 sees its args unchanged inside PowerShell itself, including a bare -- and a quote', () => insidePowerShell(), 90_000);

    for (const ext of ['bat', 'cmd']) {
      it(`.${ext} through cmd.exe`, () => {
        const file = writeScript(`mint.${ext}`, `@"${process.execPath}" "${reporter}" %*\r\n`);
        expectRegisteredAndReported(ext, register(ext, file), ARGS);
      }, 90_000);
    }

    // Seen inside bash itself: a native program it calls gets its args rewritten by MSYS, which is not this launch.
    const insideBash = (extraEnv: Record<string, string> = {}) => {
      const seen = path.join(sandbox, 'seen.txt');
      const file = writeScript('inside.sh', `#!/bin/bash
printf '%s\\n' "$@" "$FLEET_CREDENTIAL" "$BOUND" > "$SEEN_FILE"
printf '{"token":"${TOKEN}","expires_at":"2100-01-01T00:00:00Z"}'
`);
      const args = [...ARGS, '--', 'tail\\', '', '?', 'a"b"c'];
      const r = spawnSync(process.execPath, [CLI, 'secret', '--live', 'inside', '--env', 'BOUND={{secret.R}}', file, ...args], {
        env: { ...process.env, ...extraEnv, APRA_FLEET_DATA_DIR: dataDir, SEEN_FILE: seen },
        encoding: 'utf-8', input: '', timeout: 90_000,
      });
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(fs.readFileSync(seen, 'utf-8').split('\n').slice(0, -1)).toEqual([...args, 'inside', BOUND]);
      expect(records().inside.kind).toBe('live');
    };

    it('.sh through Git for Windows\' bash: args and env reach it unchanged', () => insideBash(), 90_000);

    it('.sh gets its args unchanged when the user\'s MSYS says noglob', () => insideBash({ MSYS: 'winsymlinks:nativestrict noglob' }), 90_000);
  });

  describe.skipIf(WIN)('Linux and macOS', () => {
    // A function: `reporter` is set per test, after this describe body has run.
    const shBody = () => `exec "${process.execPath}" "${reporter}" "$@"\n`;

    it('.sh with the execute bit runs directly, and its shebang decides', () => {
      // awk, not node: under the test sandbox's NODE_OPTIONS=--import, node runs its
      // entry through the ESM loader, which refuses a .sh file. As shell this is a syntax error.
      const seen = path.join(sandbox, 'seen-awk.txt');
      const file = writeScript('shebang.sh', `#!/usr/bin/awk -f
BEGIN {
  print ENVIRON["FLEET_CREDENTIAL"] > ${JSON.stringify(seen)}
  print ENVIRON["BOUND"] > ${JSON.stringify(seen)}
  print ARGV[1] > ${JSON.stringify(seen)}
  printf "{\\"token\\":\\"${TOKEN}\\",\\"expires_at\\":\\"2100-01-01T00:00:00Z\\"}"
}
`, 0o755);
      const r = register('shebang', file, ['a b']);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(fs.readFileSync(seen, 'utf-8').split('\n').slice(0, 3)).toEqual(['shebang', BOUND, 'a b']);
    });

    it('.sh without the execute bit runs through /bin/sh', () => {
      const file = writeScript('noexec.sh', shBody(), 0o644);
      expectRegisteredAndReported('noexec', register('noexec', file), ARGS);
    });

    it('a file of no known type without the execute bit is refused with the reason, not EACCES', () => {
      const file = writeScript('noexec', shBody(), 0o644);
      const r = register('noexecplain', file);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/^FAILED: script-not-executable: .*chmod \+x/);
      expect(records().noexecplain).toBeUndefined();
    });

    for (const ext of ['bat', 'cmd']) {
      it(`.${ext} is refused, saying it runs only on Windows`, () => {
        const r = register(ext, writeScript(`mint.${ext}`, '@echo off\r\n'));
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/^FAILED: script-type-unsupported: .*only on Windows/);
        expect(records()[ext]).toBeUndefined();
      });
    }

    const hasPwsh = !WIN && resolvePosixPwsh() !== null;

    // Seen inside pwsh itself: on Linux and macOS pwsh expands a * it passes on to a native program, which is not this launch.
    it.skipIf(!hasPwsh)('.ps1 through pwsh: args and env reach it unchanged', () => insidePowerShell(), 90_000);

    it.skipIf(hasPwsh)('.ps1 with no pwsh is refused, saying pwsh is needed', () => {
      const r = register('nopwsh', writeScript('mint.ps1', 'exit 0\n'));
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/^FAILED: launcher-not-found: .*pwsh/);
      expect(records().nopwsh).toBeUndefined();
    });
  });
});

describe('launch rules per OS, on any host', () => {
  const tools = (tool: string) => `C:\\Windows\\System32\\${tool}.exe`;
  const launchers = (over: Partial<ScriptLaunchers> = {}): ScriptLaunchers => ({
    gitBash: () => 'C:\\Git\\bin\\bash.exe',
    pwsh: () => '/usr/bin/pwsh',
    lacksExecuteBit: () => false,
    ...over,
  });
  const refusal = (fn: () => unknown): LiveLauncherError => {
    try { fn(); } catch (err) { return err as LiveLauncherError; }
    throw new Error('expected a refusal');
  };

  it('Windows .sh: the resolved Git Bash, with a command line quoted the way MSYS reads it', () => {
    const inv = buildProgramInvocation('C:\\a b\\m.sh', ['x y', '*', 'q"t'], 'win32', tools, launchers());
    expect(inv).toMatchObject({
      file: 'C:\\Git\\bin\\bash.exe',
      argv0: '"C:\\Git\\bin\\bash.exe"',
      args: ['"C:\\\\a b\\\\m.sh" "x y" "*" "q""t"'],
      windowsVerbatimArguments: true,
    });
  });

  it('Windows .sh with no Git Bash is refused, naming the requirement', () => {
    const err = refusal(() => buildProgramInvocation('C:\\m.sh', [], 'win32', tools, launchers({ gitBash: () => null })));
    expect(err).toBeInstanceOf(LiveLauncherError);
    expect(err.reasonCode).toBe('launcher-not-found');
    expect(err.message).toContain('Git for Windows');
  });

  it('Windows runs .exe and .com directly, and refuses anything else, naming the types', () => {
    expect(buildProgramInvocation('C:\\m.exe', ['a'], 'win32', tools, launchers())).toMatchObject({ file: 'C:\\m.exe', args: ['a'] });
    expect(buildProgramInvocation('C:\\m.COM', [], 'win32', tools, launchers()).file).toBe('C:\\m.COM');
    for (const file of ['C:\\m.py', 'C:\\m.txt', 'C:\\m']) {
      const err = refusal(() => buildProgramInvocation(file, [], 'win32', tools, launchers()));
      expect(err.reasonCode).toBe('script-type-unsupported');
      expect(err.message).toContain('.ps1, .sh, .bat, .cmd, .exe or .com');
    }
  });

  it('Windows .ps1 stays powershell.exe -File, .cmd and .bat stay cmd.exe, and neither looks for Git Bash', () => {
    const none = launchers({ gitBash: () => { throw new Error('not needed'); } });
    expect(buildProgramInvocation('C:\\m.ps1', ['a'], 'win32', tools, none).file).toBe(tools('powershell'));
    expect(buildProgramInvocation('C:\\m.ps1', ['a'], 'win32', tools, none).args.slice(-3)).toEqual(['-File', 'C:\\m.ps1', 'a']);
    expect(buildProgramInvocation('C:\\m.BAT', [], 'win32', tools, none).file).toBe(tools('cmd'));
  });

  for (const platform of ['linux', 'darwin'] as const) {
    it(`${platform} .sh: direct with the execute bit, /bin/sh without`, () => {
      expect(buildProgramInvocation('/a b/m.sh', ['x'], platform, tools, launchers())).toMatchObject({ file: '/a b/m.sh', args: ['x'] });
      expect(buildProgramInvocation('/a b/m.sh', ['x'], platform, tools, launchers({ lacksExecuteBit: () => true })))
        .toMatchObject({ file: '/bin/sh', args: ['/a b/m.sh', 'x'] });
    });

    it(`${platform} other file without the execute bit is refused`, () => {
      expect(refusal(() => buildProgramInvocation('/m', [], platform, tools, launchers({ lacksExecuteBit: () => true }))).reasonCode).toBe('script-not-executable');
    });

    it(`${platform} .ps1: pwsh -File, or a refusal naming it`, () => {
      expect(buildProgramInvocation('/a b/m.ps1', ['x'], platform, tools, launchers())).toMatchObject({ file: '/usr/bin/pwsh', args: ['-NoProfile', '-NonInteractive', '-File', '/a b/m.ps1', 'x'] });
      const err = refusal(() => buildProgramInvocation('/m.ps1', [], platform, tools, launchers({ pwsh: () => null })));
      expect(err.reasonCode).toBe('launcher-not-found');
      expect(err.message).toContain('pwsh');
    });

    it(`${platform} .bat and .cmd are refused`, () => {
      for (const file of ['/m.bat', '/m.CMD']) {
        expect(refusal(() => buildProgramInvocation(file, [], platform, tools, launchers())).reasonCode).toBe('script-type-unsupported');
      }
    });
  }
});

describe('the Git Bash lookup skips the WSL launcher', () => {
  const WSL = 'C:\\Windows\\System32\\bash.exe';

  it('recognises the launcher, whatever the case or the alias folder', () => {
    for (const p of [WSL, 'c:\\windows\\SYSTEM32\\BASH.EXE', 'C:\\Windows\\Sysnative\\bash.exe', 'C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe']) {
      expect(isWslLauncherBash(p)).toBe(true);
    }
    expect(isWslLauncherBash('C:\\Program Files\\Git\\bin\\bash.exe')).toBe(false);
  });

  it('a PATH with only the launcher finds nothing', () => {
    expect(resolveGitBashExecutable({ candidates: [], pathValue: 'C:\\Windows\\System32', isFile: (p) => p === WSL })).toBeNull();
  });

  it('a Git Bash after the launcher on PATH is found', () => {
    const bash = 'D:\\tools\\msys\\bash.exe';
    expect(resolveGitBashExecutable({ candidates: [], pathValue: `C:\\Windows\\System32;D:\\tools\\msys`, isFile: (p) => p === WSL || p === bash })).toBe(bash);
  });

  it('a well-known location wins over PATH, and a candidate that is the launcher is skipped', () => {
    const known = 'C:\\Program Files\\Git\\bin\\bash.exe';
    expect(resolveGitBashExecutable({ candidates: [WSL, known], pathValue: 'D:\\x', isFile: () => true })).toBe(known);
  });

  it('finds the bash of a custom install beside the git on PATH, and never returns a relative path', () => {
    const git = 'E:\\Git\\cmd\\git.exe';
    const bash = 'E:\\Git\\bin\\bash.exe';
    expect(resolveGitBashExecutable({ candidates: [], pathValue: '.;E:\\Git\\cmd', isFile: (p) => p === git || p === bash })).toBe(bash);
    expect(resolveGitBashExecutable({ candidates: [], pathValue: '.;relative\\bin', isFile: () => true })).toBeNull();
  });
});
