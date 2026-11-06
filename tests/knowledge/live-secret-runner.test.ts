import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  E_LIVE_SECRET,
  LiveSecretError,
  parseLiveOutput,
  runLiveSecret,
} from '../../src/services/live-secret-runner.js';
import {
  afterStdinJs,
  futureIso,
  isPidAlive,
  makeTempDir,
  rejection,
  runLaunch,
  waitForPidGone,
  writeNodeHelper,
} from './token-command-helpers.js';

// Real helper scripts, no mocks: each test writes a node helper that speaks
// (or breaks) the env + stdout JSON contract and runs it through the runner.

const CREDENTIAL = 'kb-runner-test-cred';

const TOKEN_CANARY = 'tok-CANARY-5d1f0b7e';
const STDERR_CANARY = 'stderr-CANARY-a93c2e41';

let tmp: string;
const leftoverPids: number[] = [];

beforeEach(() => {
  tmp = makeTempDir('cred-helper-runner-');
});

afterEach(() => {
  for (const pid of leftoverPids.splice(0)) {
    if (isPidAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** JS that writes STDERR_CANARY to stderr, then runs `thenJs` once stdin is read. */
function helperJs(thenJs: string): string {
  return afterStdinJs(`process.stderr.write(${JSON.stringify(STDERR_CANARY)}+"\\n");${thenJs}`);
}

function printJs(body: unknown): string {
  return `process.stdout.write(${JSON.stringify(JSON.stringify(body))});`;
}

async function failureOf(js: string, extra: { timeoutMs?: number; maxOutputBytes?: number } = {}): Promise<Error & { code?: string }> {
  const launch = writeNodeHelper(tmp, 'helper', js);
  return rejection(runLaunch(CREDENTIAL, launch, extra));
}

function expectSafeFailure(err: Error & { code?: string }, reason: RegExp): void {
  expect(err).toBeInstanceOf(LiveSecretError);
  expect(err.code).toBe(E_LIVE_SECRET);
  expect(err.message).toContain(`'${CREDENTIAL}'`);
  expect(err.message).toMatch(reason);
  for (const text of [err.message, String(err.stack), String(err)]) {
    expect(text).not.toContain(TOKEN_CANARY);
    expect(text).not.toContain(STDERR_CANARY);
  }
}

describe('runLiveSecret success', () => {
  it('returns the token and expires_at the helper prints', async () => {
    const expiresAt = futureIso();
    const launch = writeNodeHelper(tmp, 'ok', helperJs(printJs({ token: TOKEN_CANARY, expires_at: expiresAt })));
    const result = await runLaunch(CREDENTIAL, launch);
    expect(result).toEqual({ token: TOKEN_CANARY, expiresAt });
  });

  it('passes FLEET_CREDENTIAL and the bound env vars, and writes nothing to stdin', async () => {
    const recorded = path.join(tmp, 'seen.json');
    const js = helperJs(
      `fs.writeFileSync(${JSON.stringify(recorded)},JSON.stringify({stdin:input,cred:process.env.FLEET_CREDENTIAL,bound:process.env.MY_BOUND}));` +
      printJs({ token: TOKEN_CANARY, expires_at: futureIso() }),
    );
    const launch = writeNodeHelper(tmp, 'env', js);
    await runLaunch(CREDENTIAL, launch, { env: { MY_BOUND: 'bound-value' } });
    expect(JSON.parse(fs.readFileSync(recorded, 'utf8'))).toEqual({ stdin: '', cred: CREDENTIAL, bound: 'bound-value' });
  });

  it('succeeds for a helper that never reads stdin', async () => {
    const expiresAt = futureIso();
    const launch = writeNodeHelper(tmp, 'nostdin', printJs({ token: TOKEN_CANARY, expires_at: expiresAt }));
    const result = await runLaunch(CREDENTIAL, launch);
    expect(result.token).toBe(TOKEN_CANARY);
  });
});

describe('runLiveSecret failures name the credential and leak nothing', () => {
  it('non-zero exit', async () => {
    const js = helperJs(`${printJs({ token: TOKEN_CANARY, expires_at: futureIso() })}process.exitCode=3;`);
    expectSafeFailure(await failureOf(js), /exit code 3/);
  });

  it('timeout kills the whole tree, including a grandchild holding stdout open', async () => {
    const pidFile = path.join(tmp, 'grandchild.pid');
    // The helper spawns a grandchild that inherits stdout/stderr and sleeps.
    // On POSIX the helper then exits 0, so only the grandchild keeps stdout
    // open; on Windows an inherited stdout does not keep the pipe open, so the
    // helper stays alive and taskkill /T must take the tree down.
    const helperEnd = process.platform === 'win32' ? 'setInterval(function(){},60000);' : 'process.exit(0);';
    const js = helperJs(
      `const cp=require("child_process");` +
      `const g=cp.spawn(process.execPath,["-e","setInterval(function(){},60000)"],{stdio:["ignore","inherit","inherit"]});` +
      `fs.writeFileSync(${JSON.stringify(pidFile)},String(g.pid));` +
      `process.stdout.write(${JSON.stringify(TOKEN_CANARY)});${helperEnd}`,
    );
    const timeoutMs = 1500;
    const started = Date.now();
    const err = await failureOf(js, { timeoutMs });
    const elapsed = Date.now() - started;

    expectSafeFailure(err, new RegExp(`timed out after ${timeoutMs}ms`));
    expect(elapsed).toBeLessThan(timeoutMs + 3000);
    const grandchildPid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(grandchildPid).toBeGreaterThan(0);
    leftoverPids.push(grandchildPid);
    expect(await waitForPidGone(grandchildPid, 3000)).toBe(true);
  });

  it('oversized output', async () => {
    const js = helperJs(
      `process.stdout.write(${JSON.stringify(`{"token":"${TOKEN_CANARY}`)}+"x".repeat(200000)+'","expires_at":"2099-01-01T00:00:00Z"}');`,
    );
    expectSafeFailure(await failureOf(js, { maxOutputBytes: 4096 }), /output exceeded 4096 bytes/);
  });

  it('multi-line token', async () => {
    const js = helperJs(printJs({ token: `${TOKEN_CANARY}\nsecond-line`, expires_at: futureIso() }));
    expectSafeFailure(await failureOf(js), /single line with no whitespace/);
  });

  it('missing token', async () => {
    expectSafeFailure(await failureOf(helperJs(printJs({ expires_at: futureIso() }))), /no token/);
  });

  it('missing expires_at', async () => {
    expectSafeFailure(await failureOf(helperJs(printJs({ token: TOKEN_CANARY }))), /no expires_at/);
  });

  it('unparseable expires_at', async () => {
    const js = helperJs(printJs({ token: TOKEN_CANARY, expires_at: 'tomorrow-ish' }));
    expectSafeFailure(await failureOf(js), /not an ISO 8601 date-time/);
  });

  it('past expires_at', async () => {
    const js = helperJs(printJs({ token: TOKEN_CANARY, expires_at: '2001-01-01T00:00:00Z' }));
    expectSafeFailure(await failureOf(js), /not in the future/);
  });

  it('invalid JSON', async () => {
    const js = helperJs(`process.stdout.write("token=${TOKEN_CANARY} not json");`);
    expectSafeFailure(await failureOf(js), /not valid JSON/);
  });

  it('a program that does not exist', async () => {
    const err = await rejection(runLaunch(CREDENTIAL, { program: path.join(tmp, 'no-such-helper.exe'), args: [] }));
    expectSafeFailure(err, /could not start the script \(ENOENT\)/);
  });
});

describe('parseLiveOutput', () => {
  const now = Date.parse('2030-01-01T00:00:00Z');

  it('accepts an offset zone and surrounding whitespace', () => {
    const out = parseLiveOutput(CREDENTIAL, ' {"token":"abc","expires_at":"2030-01-01T05:30:00+05:00"}\n', now);
    expect(out).toEqual({ token: 'abc', expiresAt: '2030-01-01T05:30:00+05:00' });
  });

  it('rejects an expires_at with no zone (it would be read as local time)', () => {
    expect(() => parseLiveOutput(CREDENTIAL, '{"token":"abc","expires_at":"2030-06-01T00:00:00"}', now))
      .toThrow(/not an ISO 8601 date-time with a time zone/);
  });

  it('rejects a token containing a space, a tab or a CR', () => {
    for (const token of ['a b', 'a\tb', 'a\rb']) {
      expect(() => parseLiveOutput(CREDENTIAL, JSON.stringify({ token, expires_at: '2031-01-01T00:00:00Z' }), now))
        .toThrow(/single line with no whitespace/);
    }
  });

  it('rejects a JSON value that is not an object', () => {
    expect(() => parseLiveOutput(CREDENTIAL, '["abc"]', now)).toThrow(/not a JSON object/);
  });
});

describe('runLiveSecret options', () => {
  it('rejects a non-positive timeout or output cap before spawning', () => {
    const base = { credential: CREDENTIAL, invocation: { file: process.execPath, args: [], windowsVerbatimArguments: false } };
    expect(() => runLiveSecret({ ...base, timeoutMs: 0 })).toThrow(/timeoutMs/);
    expect(() => runLiveSecret({ ...base, maxOutputBytes: -1 })).toThrow(/maxOutputBytes/);
  });
});
