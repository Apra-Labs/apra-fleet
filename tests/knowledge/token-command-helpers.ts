import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Shared by the credential helper runner tests: write real node helper
// scripts (no mocks), launch them as program + argv, and watch the processes
// they leave behind. Carried over from the TokenSource tests (commit
// 0f7e129a) and adapted from shell command lines to program + argv.

export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export interface HelperLaunch {
  program: string;
  args: string[];
}

/**
 * Write `js` as a helper script in `dir` and return how to launch it with
 * `extraArgs`. On POSIX the script is itself the program (shebang to this
 * test's node, chmod 0755), spawned directly like any POSIX helper. On
 * Windows it is node.exe with the script as its first argument (a .exe,
 * spawned directly too).
 */
export function writeNodeHelper(dir: string, name: string, js: string, extraArgs: string[] = []): HelperLaunch {
  const script = path.join(dir, `${name}.js`);
  if (process.platform === 'win32') {
    fs.writeFileSync(script, js);
    return { program: process.execPath, args: [script, ...extraArgs] };
  }
  if (/\s/.test(process.execPath)) {
    throw new Error(`writeNodeHelper: a shebang cannot carry a node path with whitespace: ${process.execPath}`);
  }
  fs.writeFileSync(script, `#!${process.execPath}\n${js}`, { mode: 0o755 });
  return { program: script, args: [...extraArgs] };
}

/**
 * JS that reads all of stdin, then runs `thenJs` with the text in the
 * variable `input`.
 */
export function afterStdinJs(thenJs: string): string {
  return (
    `const fs=require("fs");let input="";process.stdin.setEncoding("utf8");` +
    `process.stdin.on("data",function(c){input+=c});` +
    `process.stdin.on("end",function(){${thenJs}});`
  );
}

/** An expires_at one hour from now. */
export function futureIso(): string {
  return new Date(Date.now() + 3_600_000).toISOString();
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** True once `pid` is gone, polling every 100 ms for up to `withinMs`. */
export async function waitForPidGone(pid: number, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return !isPidAlive(pid);
}

/** Await a promise that must reject and return its error. */
export async function rejection(promise: Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await promise;
  } catch (err) {
    return err as Error & { code?: string };
  }
  throw new Error('expected the promise to reject, but it resolved');
}
