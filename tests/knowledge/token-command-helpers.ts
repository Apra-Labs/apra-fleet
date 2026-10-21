import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Shared by the TokenSource and HttpKbProvider token-source tests: build real
// `node -e` shell commands (no mocks) and read the counter files they bump.

/**
 * A shell command line that runs `js` with this test's own node binary via
 * `node -e`. Quoted for /bin/sh (single quotes) or cmd.exe (double quotes)
 * on the host the test runs on.
 */
export function nodeEvalCommand(js: string): string {
  if (process.platform === 'win32') {
    return `"${process.execPath}" -e "${js.replace(/"/g, '\\"')}"`;
  }
  if (js.includes("'")) throw new Error(`nodeEvalCommand: js must not contain a single quote: ${js}`);
  return `'${process.execPath}' -e '${js}'`;
}

/**
 * JS that increments the number in `counterPath` and then runs `thenJs`, with
 * the new count available as the variable `n`.
 */
export function bumpCounterJs(counterPath: string, thenJs: string): string {
  return (
    `const fs=require("fs");const p=${JSON.stringify(counterPath)};` +
    `let n=0;try{n=Number(fs.readFileSync(p,"utf8"))}catch(e){}` +
    `n=n+1;fs.writeFileSync(p,String(n));${thenJs}`
  );
}

/** How many times the command bumping `counterPath` has run (0 if never). */
export function readCounter(counterPath: string): number {
  return fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) : 0;
}

/** An unsigned JWT (alg none, empty signature) whose exp is `secondsFromNow` away. */
export function unsignedJwt(secondsFromNow: number): string {
  const encode = (obj: object) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + secondsFromNow;
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: 'test', exp })}.`;
}

export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
