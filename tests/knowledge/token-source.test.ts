import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  buildShellInvocation,
  CommandTokenSource,
  StaticTokenSource,
  TOKEN_SOURCE_FAILED,
} from '../../src/services/knowledge/token-source.js';
import {
  bumpCounterJs,
  makeTempDir,
  nodeEvalCommand,
  readCounter,
  unsignedJwt,
} from './token-command-helpers.js';

// No mocks: every CommandTokenSource test runs a real `node -e` command
// through the real platform shell, and proves how often it ran with a counter
// file in a per-test temp dir.

let tmp: string;
let counter: string;

beforeEach(() => {
  tmp = makeTempDir('token-source-');
  counter = path.join(tmp, 'count');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A command that bumps the counter file and prints `token`. */
function printingCommand(token: string, delayMs = 0): string {
  const print = `process.stdout.write(${JSON.stringify(token)})`;
  const then = delayMs > 0 ? `setTimeout(function(){${print}},${delayMs})` : print;
  return nodeEvalCommand(bumpCounterJs(counter, then));
}

async function rejection(p: Promise<unknown>): Promise<NodeJS.ErrnoException> {
  try {
    await p;
  } catch (err) {
    return err as NodeJS.ErrnoException;
  }
  throw new Error('expected the promise to reject, but it resolved');
}

/** Everything written to process.stderr / console while `fn` runs. */
async function captureOutput<T>(fn: () => Promise<T>): Promise<{ result: T; output: string }> {
  const lines: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  const origConsole = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const record = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  (process.stderr as any).write = (chunk: unknown, ...rest: unknown[]) => {
    lines.push(String(chunk));
    return origWrite(chunk as any, ...(rest as any[]));
  };
  console.log = record; console.warn = record; console.error = record; console.info = record;
  try {
    const result = await fn();
    return { result, output: lines.join('\n') };
  } finally {
    (process.stderr as any).write = origWrite;
    Object.assign(console, origConsole);
  }
}

describe('buildShellInvocation', () => {
  it('uses cmd.exe /d /s /c with the quoted command on win32', () => {
    const cmd = 'my-token-cli print-access-token --x "a b"';
    const inv = buildShellInvocation(cmd, 'win32');
    expect(inv.file).toBe('cmd.exe');
    expect(inv.args).toEqual(['/d', '/s', '/c', `"${cmd}"`]);
    expect(inv.windowsVerbatimArguments).toBe(true);
  });

  it('uses /bin/sh -c with the command on linux', () => {
    const cmd = 'my-token-cli print-access-token --x "a b"';
    const inv = buildShellInvocation(cmd, 'linux');
    expect(inv.file).toBe('/bin/sh');
    expect(inv.args).toEqual(['-c', cmd]);
    expect(inv.windowsVerbatimArguments).toBe(false);
  });
});

describe('StaticTokenSource', () => {
  it('returns its token from getToken and refresh, and cannot refresh', async () => {
    const source = new StaticTokenSource('fixed-value');
    expect(source.canRefresh).toBe(false);
    expect(await source.getToken()).toBe('fixed-value');
    expect(await source.refresh()).toBe('fixed-value');
  });
});

describe('CommandTokenSource caching', () => {
  it('returns trimmed stdout as the token and reports canRefresh', async () => {
    const source = new CommandTokenSource({ command: printingCommand('  opaque-1\n') });
    expect(source.canRefresh).toBe(true);
    expect(await source.getToken()).toBe('opaque-1');
  });

  it('re-runs the command when a JWT has fewer than 300 s left', async () => {
    const jwt = unsignedJwt(200);
    const source = new CommandTokenSource({ command: printingCommand(jwt) });
    expect(await source.getToken()).toBe(jwt);
    expect(await source.getToken()).toBe(jwt);
    expect(readCounter(counter)).toBe(2);
  });

  it('does not re-run the command while a JWT has 3600 s left', async () => {
    const jwt = unsignedJwt(3600);
    const source = new CommandTokenSource({ command: printingCommand(jwt), ttlSeconds: 1 });
    expect(await source.getToken()).toBe(jwt);
    // Longer than ttlSeconds: a JWT's exp, not the TTL, decides staleness.
    await new Promise(r => setTimeout(r, 1200));
    expect(await source.getToken()).toBe(jwt);
    expect(readCounter(counter)).toBe(1);
  });

  it('re-runs a non-JWT command only after ttlSeconds', async () => {
    const source = new CommandTokenSource({ command: printingCommand('opaque-token'), ttlSeconds: 1 });
    await source.getToken();
    await source.getToken();
    expect(readCounter(counter)).toBe(1);
    await new Promise(r => setTimeout(r, 1200));
    await source.getToken();
    expect(readCounter(counter)).toBe(2);
  });

  it('refresh() re-runs the command even while the cache is fresh', async () => {
    const source = new CommandTokenSource({ command: printingCommand('opaque-token') });
    await source.getToken();
    await source.refresh();
    expect(readCounter(counter)).toBe(2);
  });
});

describe('CommandTokenSource single-flight', () => {
  it('runs the command exactly once for ten concurrent getToken() calls on an empty cache', async () => {
    const source = new CommandTokenSource({ command: printingCommand('shared-token', 300) });
    const tokens = await Promise.all(Array.from({ length: 10 }, () => source.getToken()));
    expect(tokens).toEqual(Array(10).fill('shared-token'));
    expect(readCounter(counter)).toBe(1);
  });

  it('shares one run between concurrent getToken() and refresh() calls on a stale cache', async () => {
    const source = new CommandTokenSource({ command: printingCommand('shared-token', 300), ttlSeconds: 1 });
    await source.getToken();
    await new Promise(r => setTimeout(r, 1200));
    const calls = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? source.getToken() : source.refresh()));
    await Promise.all(calls);
    expect(readCounter(counter)).toBe(2);
  });
});

describe('CommandTokenSource failures', () => {
  const marker = `SECRETMARKER${crypto.randomBytes(8).toString('hex')}`;
  const emitMarker = `process.stdout.write(${JSON.stringify(marker)});process.stderr.write(${JSON.stringify(marker)});`;

  function expectNoLeak(err: NodeJS.ErrnoException, output: string, command: string): void {
    expect(err.code).toBe(TOKEN_SOURCE_FAILED);
    for (const text of [err.message, String(err.stack), JSON.stringify(err), output]) {
      expect(text).not.toContain(marker);
      expect(text).not.toContain(command);
    }
  }

  it('a non-zero exit rejects naming the exit code', async () => {
    const command = nodeEvalCommand(`${emitMarker}process.exit(3)`);
    const source = new CommandTokenSource({ command });
    const { result: err, output } = await captureOutput(() => rejection(source.getToken()));
    expect(err.message).toContain('exit code 3');
    expectNoLeak(err, output, command);
  });

  it('a command exceeding the timeout rejects naming the timeout', async () => {
    const command = nodeEvalCommand(`${emitMarker}setInterval(function(){},60000)`);
    const source = new CommandTokenSource({ command, timeoutMs: 1000 });
    const { result: err, output } = await captureOutput(() => rejection(source.getToken()));
    expect(err.message).toContain('timed out after 1000ms');
    expectNoLeak(err, output, command);
  });

  it('empty output rejects naming empty output', async () => {
    const command = nodeEvalCommand(`process.stderr.write(${JSON.stringify(marker)});process.stdout.write("  \\n")`);
    const source = new CommandTokenSource({ command });
    const { result: err, output } = await captureOutput(() => rejection(source.getToken()));
    expect(err.message).toContain('empty output');
    expectNoLeak(err, output, command);
  });

  it('a failed run is not cached: the next call runs the command again', async () => {
    const command = nodeEvalCommand(bumpCounterJs(counter, 'process.exit(3)'));
    const source = new CommandTokenSource({ command });
    await rejection(source.getToken());
    await rejection(source.getToken());
    expect(readCounter(counter)).toBe(2);
  });
});

describe('CommandTokenSource timeout kills the process tree', () => {
  it('settles within timeout + 2 s when a grandchild keeps stdout open, and the grandchild is killed', async () => {
    const pidFile = path.join(tmp, 'grandchild.pid');
    // The shell's child spawns a grandchild that inherits stdout and sleeps,
    // records its pid, then exits 0 -- stdout stays open via the grandchild.
    // On Windows an inherited stdout does not keep the parent's pipe open, so
    // that hang cannot occur there; the child stays alive instead, so the
    // timeout still fires and taskkill /T must take down the whole tree.
    // No arrow functions: cmd.exe would read their ">" as a redirect.
    const childEnd = process.platform === 'win32' ? 'setInterval(function(){},60000)' : 'process.exit(0)';
    const js =
      `const fs=require("fs");const cp=require("child_process");` +
      `const g=cp.spawn(process.execPath,["-e","setInterval(function(){},60000)"],{stdio:["ignore","inherit","inherit"]});` +
      `fs.writeFileSync(${JSON.stringify(pidFile)},String(g.pid));${childEnd}`;
    const timeoutMs = 1000;
    const source = new CommandTokenSource({ command: nodeEvalCommand(js), timeoutMs });

    const started = Date.now();
    const err = await rejection(source.getToken());
    const elapsed = Date.now() - started;

    expect(err.code).toBe(TOKEN_SOURCE_FAILED);
    expect(err.message).toContain(`timed out after ${timeoutMs}ms`);
    expect(elapsed).toBeLessThan(timeoutMs + 2000);

    const grandchildPid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(grandchildPid).toBeGreaterThan(0);
    const deadline = Date.now() + 2000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try {
        process.kill(grandchildPid, 0);
        await new Promise(r => setTimeout(r, 100));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });
});

describe('CommandTokenSource options', () => {
  it('rejects an empty command and non-positive ttl/timeout at construction', () => {
    expect(() => new CommandTokenSource({ command: '  ' })).toThrow(/non-empty/);
    expect(() => new CommandTokenSource({ command: 'x', ttlSeconds: 0 })).toThrow(/ttlSeconds/);
    expect(() => new CommandTokenSource({ command: 'x', timeoutMs: -1 })).toThrow(/timeoutMs/);
  });
});
