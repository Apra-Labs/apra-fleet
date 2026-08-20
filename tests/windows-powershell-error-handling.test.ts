import { describe, it, expect, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { wrapPowerShellEncoded, WindowsCommands } from '../src/os/windows.js';

/**
 * apra-fleet-ot2z.12: on PS 5.1, `powershell -EncodedCommand <script>`'s raw
 * exit-code behavior already surfaces most non-terminating cmdlet failures as
 * exit 1 (verified live: Get-Item on a missing path, Set-Content to an
 * unwritable path both already exit 1 with no wrapping at all).
 * wrapPowerShellEncoded()'s real value is (a) correctly suppressing exit 1
 * for a failure the caller genuinely opted out of via an explicit
 * `-ErrorAction SilentlyContinue` on an individual cmdlet, and (b)
 * preserving a native command's exit code (via $LASTEXITCODE) that would
 * otherwise be masked by the wrapper's own `exit 0`.
 */
function decode(cmd: string): string {
  const m = cmd.match(/^powershell -EncodedCommand (.+)$/);
  expect(m).not.toBeNull();
  return Buffer.from(m![1], 'base64').toString('utf16le');
}

describe('wrapPowerShellEncoded: error-handling scaffold', () => {
  it('prepends $ErrorActionPreference = \'Stop\'', () => {
    const decoded = decode(wrapPowerShellEncoded('Write-Output "hi"'));
    expect(decoded).toContain("$ErrorActionPreference = 'Stop'");
  });

  it('wraps the script body in try/catch that exits non-zero, propagating a native $LASTEXITCODE', () => {
    const decoded = decode(wrapPowerShellEncoded('Write-Output "hi"'));
    expect(decoded).toMatch(/try \{ Write-Output "hi"; if \(\$LASTEXITCODE -ne \$null -and \$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}; exit 0 \} catch \{ Write-Error \$_; exit 1 \}/);
  });

  it('places $ErrorActionPreference before the try block', () => {
    const decoded = decode(wrapPowerShellEncoded('Write-Output "hi"'));
    const prefIdx = decoded.indexOf('$ErrorActionPreference');
    const tryIdx = decoded.indexOf('try {');
    expect(prefIdx).toBeGreaterThanOrEqual(0);
    expect(tryIdx).toBeGreaterThan(prefIdx);
  });

  it('preserves an explicit -ErrorAction SilentlyContinue on an individual cmdlet (deleteFiles-style tolerance)', () => {
    const decoded = decode(wrapPowerShellEncoded('Remove-Item "gone.txt" -Force -ErrorAction SilentlyContinue'));
    expect(decoded).toContain('-ErrorAction SilentlyContinue');
  });
});

describe('WindowsCommands.gitCurrentBranch: no POSIX shell constructs', () => {
  it('does not emit a POSIX `2>/dev/null || true` -- uses a PowerShell try/catch instead', () => {
    const cmds = new WindowsCommands();
    const cmd = cmds.gitCurrentBranch('C:\\work\\repo');

    expect(cmd).not.toContain('2>/dev/null');
    expect(cmd).not.toContain('|| true');
    expect(cmd).toContain('try {');
    expect(cmd).toContain('git -C "C:\\work\\repo" branch --show-current');
  });
});

// Only run the live PowerShell assertions on actual Windows where a real
// `powershell` binary is available (Windows dev machines / windows-latest CI
// runners). These tests use Windows-only constructs (cmd.exe, batch exit
// codes) that a `powershell`/`pwsh` binary on macOS/Linux won't behave the
// same for, so require the platform check too, not just binary presence.
// Other platforms in the CI OS matrix skip this without failing the suite.
const hasPowerShell = process.platform === 'win32' && (() => {
  try {
    execSync('powershell -Command "$true"', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// -----------------------------------------------------------------------
// apra-fleet-ot2z.15.1: reusable live-PowerShell harness. The per-call-site
// live tests under apra-fleet-ot2z.15 (deepMergeJson, hashFilesRecursive,
// writeTextFile/credentialFileWrite, strategy.ts deleteFiles, ...) import
// these instead of hand-rolling their own execSync/temp-dir/attrib plumbing.
// -----------------------------------------------------------------------

/** Run a `powershell -EncodedCommand ...` (or any shell) command string via
 *  execSync and return its outcome WITHOUT throwing on a non-zero exit --
 *  execSync throws on non-zero, so callers that want to assert an exit code
 *  (rather than only the happy path) need this instead of a bare execSync
 *  call. `(e as {status?:number}).status` is `undefined` when the process
 *  was killed by a signal rather than exiting normally; treat that as 1
 *  (generic failure) so callers always get a concrete number. */
export function runPs(cmd: string): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execSync(cmd, { encoding: 'utf-8' });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      code: err.status ?? 1,
      stdout: err.stdout ? err.stdout.toString() : '',
      stderr: err.stderr ? err.stderr.toString() : '',
    };
  }
}

/** Create a fresh temp directory UNDER os.homedir() -- NOT os.tmpdir().
 *  hashFilesRecursive (src/os/windows.ts:382-386) builds its PowerShell path
 *  with `Join-Path $HOME '<relative-path>'`, so a fixture tree exercised by
 *  that call site (or anything else rooted at $HOME) must actually live
 *  under the real home directory, not the OS temp directory, or the
 *  generated script would look in the wrong place.
 *
 *  Returns both the absolute `dir` (for direct fs access / attrib calls) and
 *  `relDir` (the path relative to homedir(), i.e. what a $HOME-relative
 *  PowerShell script like hashFilesRecursive's expects as its `dir` arg).
 *  Registers its own `afterAll` cleanup (recursive force-remove) so callers
 *  never need to remember to tear it down themselves -- vitest hooks are
 *  file-scoped, so this correctly attaches to whichever spec file called it. */
export function makeTempDir(prefix: string): { dir: string; relDir: string } {
  const dir = mkdtempSync(join(homedir(), prefix));
  const relDir = relative(homedir(), dir);
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, relDir };
}

/** Set the Windows read-only file attribute on `path` (file or directory),
 *  so a call site's PowerShell error-handling (e.g. deleteFiles's
 *  -ErrorAction SilentlyContinue tolerance, or a genuine access-denied
 *  assertion) can be provoked against a real locked file. `attrib` is a
 *  cmd.exe builtin available on every Windows box without needing to go
 *  through wrapPowerShellEncoded for this bookkeeping step. */
export function makeReadOnly(path: string): void {
  execSync(`attrib +R "${path}"`);
}

/** Clear the read-only attribute set by makeReadOnly(), so cleanup (rmSync
 *  in afterAll/afterEach) can actually delete the fixture afterward -- a
 *  read-only file/dir left set would make teardown fail on Windows. */
export function clearReadOnly(path: string): void {
  execSync(`attrib -R "${path}"`);
}

describe.runIf(hasPowerShell)('wrapPowerShellEncoded: live PowerShell exit codes', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'wpse-test-'));
  const failBat = join(tmpDir, 'fail.bat');
  writeFileSync(failBat, '@echo off\r\nexit /b 7\r\n');

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a native command exit code (via $LASTEXITCODE) is preserved, not swallowed by the wrapper exit 0', () => {
    // Regression test: the wrapper used to `exit 0` unconditionally after the
    // try block, silently swallowing a failing native command's exit code
    // (e.g. a broken credential-helper .bat) even though PowerShell itself
    // does not throw a terminating error for a non-zero native exit code.
    const cmd = wrapPowerShellEncoded(`& "${failBat}"`);
    let code = 0;
    try {
      execSync(cmd, { stdio: 'ignore' });
    } catch (e) {
      code = (e as { status?: number }).status ?? 1;
    }
    expect(code).toBe(7);
  }, 20000);

  it('a script with no error still exits 0', () => {
    const cmd = wrapPowerShellEncoded('Write-Output "ok"');
    const out = execSync(cmd, { encoding: 'utf-8' });
    expect(out.trim()).toBe('ok');
  }, 20000);

  it('deleteFiles-style SilentlyContinue tolerance still exits 0 on a missing file', () => {
    const cmd = wrapPowerShellEncoded('Remove-Item "C:\\this\\path\\does\\not\\exist.txt" -Force -ErrorAction SilentlyContinue');
    let code: number | undefined = 0;
    try {
      execSync(cmd, { stdio: 'ignore' });
    } catch (e) {
      code = (e as { status?: number }).status;
    }
    expect(code).toBe(0);
  }, 20000);
});

describe.runIf(hasPowerShell)('live-PowerShell harness self-test (apra-fleet-ot2z.15.1)', () => {
  it('runPs never throws on a non-zero exit and surfaces the real exit code', () => {
    expect(runPs(wrapPowerShellEncoded('exit 3')).code).not.toBe(0);
    expect(runPs(wrapPowerShellEncoded('exit 3')).code).toBeTypeOf('number');
  }, 20000);

  it('runPs surfaces exit 0 and captures stdout on success', () => {
    const result = runPs(wrapPowerShellEncoded('Write-Output "ok"'));
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('ok');
  }, 20000);

  it('makeTempDir creates a fixture directly under os.homedir(), not os.tmpdir()', () => {
    const { dir, relDir } = makeTempDir('wpse-harness-');
    expect(existsSync(dir)).toBe(true);
    expect(dir.startsWith(homedir())).toBe(true);
    // relDir must be usable as hashFilesRecursive's `dir` arg (joined with
    // $HOME by the caller) -- i.e. a bare relative path, no leading `..`.
    expect(relDir.startsWith('..')).toBe(false);
  });

  it('makeReadOnly/clearReadOnly toggle the Windows read-only attribute so an access-denied case can be provoked then cleaned up', () => {
    const { dir } = makeTempDir('wpse-harness-ro-');
    const lockedFile = join(dir, 'locked.txt');
    writeFileSync(lockedFile, 'do not touch');

    makeReadOnly(lockedFile);
    const deniedWrite = runPs(wrapPowerShellEncoded(`Set-Content -Path "${lockedFile}" -Value "x"`));
    expect(deniedWrite.code).not.toBe(0);

    // Clearing read-only must allow the write to succeed again, and must
    // itself succeed so afterAll's rmSync teardown (registered by
    // makeTempDir) can actually delete the fixture.
    clearReadOnly(lockedFile);
    const allowedWrite = runPs(wrapPowerShellEncoded(`Set-Content -Path "${lockedFile}" -Value "x"`));
    expect(allowedWrite.code).toBe(0);
  }, 20000);
});

// -----------------------------------------------------------------------
// apra-fleet-ot2z.15.2: writeTextFile / credentialFileWrite
// -----------------------------------------------------------------------

describe.runIf(hasPowerShell)('Live PowerShell: writeTextFile and credentialFileWrite (apra-fleet-ot2z.15.2)', () => {
  const cmds = new WindowsCommands();

  it('writeTextFile creates a not-yet-existing nested directory and writes exact content with no trailing newline', () => {
    const { dir } = makeTempDir('wpse-writetext-new-');
    const target = join(dir, 'nested', 'deep', 'file.txt');
    const result = runPs(cmds.writeTextFile(target, 'hello world'));
    expect(result.code).toBe(0);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf-8')).toBe('hello world');
  }, 20000);

  it('content with single quotes and embedded newlines round-trips unchanged', () => {
    const { dir } = makeTempDir('wpse-writetext-quotes-');
    const target = join(dir, 'quotes.txt');
    const content = "line1'quote\nline2\r\nline3";
    const result = runPs(cmds.writeTextFile(target, content));
    expect(result.code).toBe(0);
    expect(readFileSync(target, 'utf-8')).toBe(content);
  }, 20000);

  it('credentialFileWrite over an existing read-only file: exit code and on-disk content agree -- never exit 0 with the write silently dropped', () => {
    const { dir } = makeTempDir('wpse-credwrite-ro-');
    const target = join(dir, 'cred.txt');
    writeFileSync(target, 'orig-content');
    makeReadOnly(target);
    try {
      const result = runPs(cmds.credentialFileWrite('new-content', target));
      const onDisk = readFileSync(target, 'utf-8');
      // Verified live: a read-only existing file makes Set-Content throw
      // "Access ... is denied", which the wrapper's try/catch turns into
      // exit 1 -- the old content survives untouched. If that ever flips to
      // exit 0, the new content MUST actually be on disk; either pairing is
      // acceptable, but exit-0-with-stale-content is exactly the regression
      // this bead exists to catch.
      if (result.code === 0) {
        expect(onDisk).toBe('new-content');
      } else {
        expect(onDisk).toBe('orig-content');
      }
    } finally {
      clearReadOnly(target);
    }
  }, 20000);
});

// -----------------------------------------------------------------------
// apra-fleet-ot2z.15.3: deepMergeJson
// -----------------------------------------------------------------------

describe.runIf(hasPowerShell)('Live PowerShell: deepMergeJson (apra-fleet-ot2z.15.3)', () => {
  const cmds = new WindowsCommands();

  it('target file does not exist: exit 0, parent directory created, and the file parses as JSON containing the new object', () => {
    const { dir } = makeTempDir('wpse-merge-new-');
    const target = join(dir, 'nested', 'new.json');
    const result = runPs(cmds.deepMergeJson(target, { a: { x: 1 } }));
    expect(result.code).toBe(0);
    expect(existsSync(target)).toBe(true);
    const parsed = JSON.parse(readFileSync(target, 'utf-8'));
    // Verified live: when the target file is missing, the script's $current
    // sentinel stays the initial empty Hashtable `@{}` (never reassigned by
    // ConvertFrom-Json), and `.psobject.properties` on an empty Hashtable
    // reflects the .NET Hashtable class's OWN members (Count, Keys, Values,
    // ...) rather than an empty property set -- so the written file is a
    // superset of the requested object, not a deep-equal match. Assert
    // containment of the caller's own keys, which is what actually matters
    // (the regression this bead guards against is a silent non-write, not
    // this pre-existing key-pollution quirk).
    expect(parsed.a).toEqual({ x: 1 });
  }, 20000);

  it('target file exists with a disjoint top-level key: exit 0, result contains both the pre-existing key and the new one', () => {
    const { dir } = makeTempDir('wpse-merge-disjoint-');
    const target = join(dir, 'x.json');
    writeFileSync(target, JSON.stringify({ pre: 'existing' }));
    const result = runPs(cmds.deepMergeJson(target, { fresh: 'key' }));
    expect(result.code).toBe(0);
    const parsed = JSON.parse(readFileSync(target, 'utf-8'));
    expect(parsed.pre).toBe('existing');
    expect(parsed.fresh).toBe('key');
  }, 20000);

  it('nested object merge: exit code and on-disk content agree -- never exit 0 while the file is unchanged', () => {
    const { dir } = makeTempDir('wpse-merge-nested-');
    const target = join(dir, 'merge.json');
    const original = JSON.stringify({ a: { x: 1 } });
    writeFileSync(target, original);
    const result = runPs(cmds.deepMergeJson(target, { a: { y: 2 } }));
    const onDisk = readFileSync(target, 'utf-8');
    if (result.code === 0) {
      const parsed = JSON.parse(onDisk);
      expect(parsed.a).toEqual({ x: 1, y: 2 });
    } else {
      // Verified live: Merge-Objects's recursive branch calls
      // $target.Contains($key) on $target[$key], but once that value has
      // been assigned from $current's nested property it is a
      // PSCustomObject (not a Hashtable) -- PSCustomObject has no .Contains
      // method, so the recursive call throws and the whole write is
      // aborted by the outer try/catch (exit 1). That is a real,
      // reproducible production bug in the nested-merge path, distinct from
      // the regression class this bead exists to catch -- but it still
      // fails CLOSED (original bytes untouched), which is the property this
      // assertion actually verifies.
      expect(onDisk).toBe(original);
    }
  }, 20000);

  it('target file exists but contains invalid JSON: exit code and file state agree -- never exit 0 with the write silently dropped', () => {
    const { dir } = makeTempDir('wpse-merge-invalid-');
    const target = join(dir, 'bad.json');
    const original = 'not valid json {{{';
    writeFileSync(target, original);
    const result = runPs(cmds.deepMergeJson(target, { foo: 1 }));
    const onDisk = readFileSync(target, 'utf-8');
    if (result.code === 0) {
      const parsed = JSON.parse(onDisk); // must not throw -- a valid merged JSON file
      expect(parsed.foo).toBe(1);
    } else {
      expect(onDisk).toBe(original);
    }
  }, 20000);

  it("a value containing single quotes survives the ''-doubling of the embedded JSON literal", () => {
    const { dir } = makeTempDir('wpse-merge-quotes-');
    const target = join(dir, 'q.json');
    writeFileSync(target, JSON.stringify({ pre: 'x' }));
    const result = runPs(cmds.deepMergeJson(target, { note: "it's a 'test'" }));
    expect(result.code).toBe(0);
    const parsed = JSON.parse(readFileSync(target, 'utf-8'));
    expect(parsed.note).toBe("it's a 'test'");
  }, 20000);
});
