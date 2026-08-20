import { describe, it, expect, afterAll } from 'vitest';
import { execSync, spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { wrapPowerShellEncoded, WindowsCommands } from '../src/os/windows.js';
import { buildWindowsDeleteFilesScript } from '../src/services/strategy.js';

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

// Fixtures created by makeTempDir() while a test is actually running (i.e.
// from inside an it() body) are collected here instead of registering their
// own afterAll() at call time. Calling afterAll() from within a running
// it() body registers a runtime hook that never gets attached to the file
// suite -- measured live: a full suite run left 16 of 16 fixtures on disk
// (a delta of +16 wpse-* dirs under the operator's real home directory)
// despite the suite reporting fully green. A single top-level afterAll,
// registered at collection time below, drains this array instead so every
// fixture is actually removed regardless of which hook (it body vs.
// top-level describe) created it.
const tempDirsToClean: string[] = [];

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
 *  Cleanup is NOT registered here via afterAll() -- this is routinely called
 *  from inside a running it() body, and afterAll() called at that point
 *  never attaches to the file suite (see tempDirsToClean above). Instead the
 *  created path is pushed onto the module-level tempDirsToClean array, which
 *  a single afterAll registered at collection time (below) drains. */
export function makeTempDir(prefix: string): { dir: string; relDir: string } {
  const dir = mkdtempSync(join(homedir(), prefix));
  const relDir = relative(homedir(), dir);
  tempDirsToClean.push(dir);
  return { dir, relDir };
}

// Registered at collection time (this call is at module top level, not
// inside any it() body), so it reliably attaches to this file's suite and
// runs once after all tests here have finished, removing every fixture any
// makeTempDir() call pushed onto tempDirsToClean -- regardless of whether
// that call happened during collection or while a test was running.
afterAll(() => {
  for (const dir of tempDirsToClean) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
    // apra-fleet-ot2z.16 fixed a Hashtable-metadata-pollution bug where the
    // script's $current sentinel started as an empty Hashtable `@{}` (never
    // reassigned when the target file was missing), and `.psobject.properties`
    // on an empty Hashtable enumerated the .NET Hashtable class's OWN members
    // (Count, Keys, Values, ...) instead of an empty property set -- so the
    // written file used to be a superset of the requested object, not a
    // deep-equal match. $current now starts as $null, so the written file
    // contains only the caller's own keys; assert containment (rather than a
    // full deep-equal against the whole file) because the regression this
    // test guards against is a silent non-write, not exact file shape.
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

  it('nested object merge: exit 0, and the pre-existing and new nested keys are both present (apra-fleet-ot2z.17)', () => {
    const { dir } = makeTempDir('wpse-merge-nested-');
    const target = join(dir, 'merge.json');
    const original = JSON.stringify({ a: { x: 1 } });
    writeFileSync(target, original);
    const result = runPs(cmds.deepMergeJson(target, { a: { y: 2 } }));
    expect(result.code).toBe(0);
    const onDisk = readFileSync(target, 'utf-8');
    const parsed = JSON.parse(onDisk);
    // apra-fleet-ot2z.17 fixed Merge-Objects: the recursive branch used to
    // call $target.Contains($key) directly on $target[$key], but once that
    // value had been assigned from $current's nested property it was a
    // PSCustomObject (not a Hashtable) -- PSCustomObject has no .Contains
    // method, so the recursive call always threw and the whole write was
    // aborted (exit 1), even though it failed closed (original bytes
    // untouched). Merge-Objects now converts a PSCustomObject target value to
    // a Hashtable via ConvertTo-HashtableDeep before recursing into it, so a
    // nested-key merge now succeeds and produces the true merged result.
    expect(parsed.a).toEqual({ x: 1, y: 2 });
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

// -----------------------------------------------------------------------
// apra-fleet-ot2z.15.4: hashFilesRecursive
// -----------------------------------------------------------------------

describe.runIf(hasPowerShell)('Live PowerShell: hashFilesRecursive (apra-fleet-ot2z.15.4)', () => {
  const cmds = new WindowsCommands();

  it('a populated tree with a nested subdirectory: exit 0, one SHA-256 line per file with forward slashes, hashes match Node', () => {
    const { dir, relDir } = makeTempDir('wpse-hash-pop-');
    writeFileSync(join(dir, 'a.txt'), 'hello');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'b.txt'), 'world');

    const result = runPs(cmds.hashFilesRecursive(relDir));
    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
    expect(lines.length).toBe(2);
    for (const line of lines) {
      expect(line).toMatch(/^[0-9a-f]{64}  \.\/.+$/);
      expect(line).not.toContain('\\');
    }
    const aLine = lines.find(l => l.endsWith('./a.txt'));
    expect(aLine).toBeDefined();
    const expectedHash = createHash('sha256').update('hello').digest('hex');
    expect(aLine!.split('  ')[0]).toBe(expectedHash);
    const subLine = lines.find(l => l.includes('sub/b.txt'));
    expect(subLine).toBeDefined();
  }, 20000);

  it('a directory that does not exist under $HOME: exit 0 with empty stdout (deliberate Test-Path tolerance, not a bug)', () => {
    const result = runPs(cmds.hashFilesRecursive(`this-dir-does-not-exist-xyz-${Date.now()}`));
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('');
  }, 20000);

  it('a directory containing a locked file: exit code and stdout agree -- never a silent success pretending the locked file hashed fine', async () => {
    const { dir, relDir } = makeTempDir('wpse-hash-locked-');
    writeFileSync(join(dir, 'ok.txt'), 'fine');
    const lockedPath = join(dir, 'locked.txt');
    writeFileSync(lockedPath, 'locked-content');

    // Hold an exclusive read lock (FileShare.None) on lockedPath from a
    // background PowerShell process, simulating a file mid-write by another
    // process. Inlined via -Command rather than a checked-in .ps1 file,
    // since this task may only touch this one test file.
    const holdScript = `$fs = [System.IO.File]::Open('${lockedPath.replace(/'/g, "''")}', 'Open', 'Read', 'None'); Start-Sleep -Seconds 6; $fs.Close()`;
    const holder = spawn('powershell', ['-Command', holdScript], { stdio: 'ignore' });
    // Resolves once the holder process has actually exited (not merely been
    // signaled), so its exclusive file handle on lockedPath is guaranteed
    // released before teardown's rmSync runs. holder.kill() alone does not
    // wait for OS-level handle release -- rmSync({force:true}) does NOT
    // swallow EBUSY, so racing it against a still-closing handle can leave
    // the fixture directory behind and fail the suite's own cleanup step.
    const holderExited = new Promise<void>((resolve) => {
      holder.once('exit', () => resolve());
      holder.once('error', () => resolve());
    });
    try {
      execSync('powershell -Command "Start-Sleep -Milliseconds 2000"'); // let the holder acquire the lock
      const result = runPs(cmds.hashFilesRecursive(relDir));
      if (result.code === 0) {
        // Silent-success is only acceptable if the locked file's hash is
        // genuinely present -- never a "success" that just skipped it.
        expect(result.stdout).toContain('./ok.txt');
        expect(result.stdout).toContain('./locked.txt');
      } else {
        expect(result.stderr.length).toBeGreaterThan(0);
      }
    } finally {
      holder.kill();
      await holderExited;
    }
  }, 20000);
});

// -----------------------------------------------------------------------
// apra-fleet-ot2z.15.5: strategy.ts RemoteStrategy.deleteFiles
// -----------------------------------------------------------------------

describe.runIf(hasPowerShell)('Live PowerShell: strategy.ts deleteFiles (apra-fleet-ot2z.15.5)', () => {
  it('two existing files: exit 0 and both are gone from disk', () => {
    const { dir } = makeTempDir('wpse-del-two-');
    const f1 = join(dir, 'a.txt');
    const f2 = join(dir, 'b.txt');
    writeFileSync(f1, 'x');
    writeFileSync(f2, 'y');
    const result = runPs(buildWindowsDeleteFilesScript(dir, ['a.txt', 'b.txt']));
    expect(result.code).toBe(0);
    expect(existsSync(f1)).toBe(false);
    expect(existsSync(f2)).toBe(false);
  }, 20000);

  it('one existing plus one already-missing file: exit 0 (SilentlyContinue tolerance) and the existing file is actually deleted', () => {
    const { dir } = makeTempDir('wpse-del-mixed-');
    const existing = join(dir, 'present.txt');
    writeFileSync(existing, 'x');
    const result = runPs(buildWindowsDeleteFilesScript(dir, ['present.txt', 'missing.txt']));
    expect(result.code).toBe(0);
    expect(existsSync(existing)).toBe(false);
  }, 20000);

  it('all paths missing: exit 0, no throw', () => {
    const { dir } = makeTempDir('wpse-del-allmissing-');
    const result = runPs(buildWindowsDeleteFilesScript(dir, ['gone1.txt', 'gone2.txt']));
    expect(result.code).toBe(0);
  }, 20000);

  it('a read-only file: exit code and on-disk presence agree -- Remove-Item -Force removes read-only files, so a silent no-op must not pass unnoticed', () => {
    const { dir } = makeTempDir('wpse-del-ro-');
    const target = join(dir, 'ro.txt');
    writeFileSync(target, 'x');
    makeReadOnly(target);
    const result = runPs(buildWindowsDeleteFilesScript(dir, ['ro.txt']));
    const survived = existsSync(target);
    if (survived) clearReadOnly(target); // ensure cleanup can always remove the fixture
    if (result.code === 0) {
      // -Force overrides the read-only attribute -- assert deletion
      // explicitly rather than only trusting exit 0.
      expect(survived).toBe(false);
    } else {
      expect(survived).toBe(true);
    }
  }, 20000);
});
