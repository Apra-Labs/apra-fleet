import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  E_LIVE_SECRET,
  LiveSecretError,
  buildProgramInvocation,
} from '../../src/services/live-secret-runner.js';
import { getActiveLogFile } from '../../src/utils/log-helpers.js';
import {
  afterStdinJs,
  isPidAlive,
  makeTempDir,
  rejection,
  runLaunch,
  waitForPidGone,
  writeNodeHelper,
} from './token-command-helpers.js';

// End to end from the public runner entry point, no mocks. The helper is an
// az-shaped wrapper script: invoked like `az account get-access-token
// --resource <url> ...`, it records FLEET_CREDENTIAL and its argv, and prints
// {token, expires_at} built from its own arguments. A
// trailing `--simulate <failure>` makes it break the protocol one way at a time.

const CREDENTIAL = 'kb-e2e-az-cred';

const TOKEN_CANARY = 'tok-E2E-CANARY-0c4b7d19';
const STDERR_CANARY = 'stderr-E2E-CANARY-6e2a90f3';
const AZ_ARGS = [
  'account', 'get-access-token',
  '--resource', 'https://kb.example.test',
  '--tenant', 'tenant with spaces and "double quotes" and \'single\'',
];

let tmp: string;
const leftoverPids: number[] = [];

/** Everything written to this process's stderr while the suite runs. */
const stderrChunks: string[] = [];
const originalStderrWrite = process.stderr.write;

beforeAll(() => {
  const passthrough = originalStderrWrite.bind(process.stderr);
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    stderrChunks.push(String(chunk));
    return (passthrough as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
});

afterAll(() => {
  process.stderr.write = originalStderrWrite;
});

beforeEach(() => {
  tmp = makeTempDir('cred-helper-e2e-');
});

afterEach(() => {
  for (const pid of leftoverPids.splice(0)) {
    if (isPidAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** The az-shaped wrapper. Records {stdin, credential, argv, ppid, parentExe} to `recordPath`. */
function azWrapperJs(recordPath: string, grandchildPidPath: string): string {
  const simulate = `
    const argv = process.argv.slice(2);
    const at = argv.indexOf("--simulate");
    const mode = at >= 0 ? argv[at + 1] : "none";
    let parentExe = null;
    try { parentExe = fs.readlinkSync("/proc/" + process.ppid + "/exe"); } catch (e) { parentExe = null; }
    fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ stdin: input, credential: process.env.FLEET_CREDENTIAL, argv: argv, ppid: process.ppid, parentExe: parentExe }));
    process.stderr.write(${JSON.stringify(STDERR_CANARY)} + "\\n");
    const future = new Date(Date.now() + 3600000).toISOString();
    const own = "aztok-" + Buffer.from(JSON.stringify(argv)).toString("base64url");
    function print(obj) { process.stdout.write(JSON.stringify(obj)); }
    if (mode === "none") { print({ token: own, expires_at: future }); }
    else if (mode === "exit") { print({ token: ${JSON.stringify(TOKEN_CANARY)}, expires_at: future }); process.exitCode = 2; }
    else if (mode === "hang") {
      const cp = require("child_process");
      const g = cp.spawn(process.execPath, ["-e", "setInterval(function(){},60000)"], { stdio: ["ignore", "inherit", "inherit"] });
      fs.writeFileSync(${JSON.stringify(grandchildPidPath)}, String(g.pid));
      process.stdout.write(${JSON.stringify(TOKEN_CANARY)});
      if (process.platform === "win32") setInterval(function(){}, 60000); else process.exit(0);
    }
    else if (mode === "huge") { process.stdout.write('{"token":"' + ${JSON.stringify(TOKEN_CANARY)} + "x".repeat(300000) + '"}'); }
    else if (mode === "multiline") { print({ token: ${JSON.stringify(TOKEN_CANARY)} + "\\nline-two", expires_at: future }); }
    else if (mode === "past") { print({ token: ${JSON.stringify(TOKEN_CANARY)}, expires_at: "2000-01-01T00:00:00Z" }); }
    else if (mode === "notjson") { process.stdout.write("accessToken: " + ${JSON.stringify(TOKEN_CANARY)}); }
  `;
  return afterStdinJs(simulate);
}

interface Recorded { stdin: string; credential: string; argv: string[]; ppid: number; parentExe: string | null }

function setUpWrapper(extraArgs: string[]) {
  const record = path.join(tmp, 'record.json');
  const grandchildPidPath = path.join(tmp, 'grandchild.pid');
  const launch = writeNodeHelper(tmp, 'az', azWrapperJs(record, grandchildPidPath), extraArgs);
  const readRecord = (): Recorded => JSON.parse(fs.readFileSync(record, 'utf8'));
  return { launch, readRecord, grandchildPidPath };
}

function fleetLogText(): string {
  const logFile = getActiveLogFile();
  return logFile && fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
}

describe('live secret runner end to end (az-shaped wrapper)', () => {
  it('success: returns the token and expires_at, sets FLEET_CREDENTIAL, closes stdin, passes argv untouched', async () => {
    const { launch, readRecord } = setUpWrapper(AZ_ARGS);
    const before = Date.now();

    const result = await runLaunch(CREDENTIAL, launch);

    const seen = readRecord();
    expect(seen.stdin).toBe('');
    expect(seen.credential).toBe(CREDENTIAL);
    expect(seen.argv).toEqual(AZ_ARGS);
    expect(result.token).toBe(`aztok-${Buffer.from(JSON.stringify(AZ_ARGS)).toString('base64url')}`);
    expect(Date.parse(result.expiresAt)).toBeGreaterThan(before);
  });

  it.skipIf(process.platform !== 'linux')(
    'Linux: a POSIX script is spawned directly -- no shell and no cmd.exe between the runner and the helper (Linux only: reads /proc)',
    async () => {
      const { launch, readRecord } = setUpWrapper(AZ_ARGS);
      const invocation = buildProgramInvocation(launch.program, launch.args, process.platform);
      expect(invocation.file).toBe(launch.program);
      expect(invocation.args).toEqual(launch.args);
      expect(invocation.windowsVerbatimArguments).toBe(false);

      await runLaunch(CREDENTIAL, launch);

      const seen = readRecord();
      expect(seen.ppid).toBe(process.pid);
      expect(seen.parentExe).toBe(fs.readlinkSync('/proc/self/exe'));
      expect(seen.parentExe).not.toMatch(/(^|\/)(sh|bash|dash|cmd\.exe)$/);
    },
  );

  const FAILURES: Array<{ mode: string; reason: RegExp; extra?: { timeoutMs?: number; maxOutputBytes?: number } }> = [
    { mode: 'exit', reason: /exit code 2/ },
    { mode: 'hang', reason: /timed out after 1500ms/, extra: { timeoutMs: 1500 } },
    { mode: 'huge', reason: /output exceeded \d+ bytes/ },
    { mode: 'multiline', reason: /single line with no whitespace/ },
    { mode: 'past', reason: /expires_at is not in the future/ },
    { mode: 'notjson', reason: /output is not valid JSON/ },
  ];

  for (const { mode, reason, extra } of FAILURES) {
    it(`failure '${mode}': typed error naming the credential, no canary anywhere`, async () => {
      const { launch, readRecord, grandchildPidPath } = setUpWrapper([...AZ_ARGS, '--simulate', mode]);
      const stderrMark = stderrChunks.length;
      const logBefore = fleetLogText().length;

      const err = await rejection(runLaunch(CREDENTIAL, launch, extra));

      expect(readRecord().argv).toContain(mode); // the wrapper really ran this mode
      expect(err).toBeInstanceOf(LiveSecretError);
      expect(err.code).toBe(E_LIVE_SECRET);
      expect(err.message).toContain(`'${CREDENTIAL}'`);
      expect(err.message).toMatch(reason);
      const surfaces = [
        err.message, String(err.stack), String(err),
        stderrChunks.slice(stderrMark).join(''),
        fleetLogText().slice(logBefore),
      ];
      for (const text of surfaces) {
        expect(text).not.toContain(TOKEN_CANARY);
        expect(text).not.toContain(STDERR_CANARY);
      }

      if (mode === 'hang') {
        // The runner has returned: the grandchild it never knew about must be gone.
        const grandchildPid = Number(fs.readFileSync(grandchildPidPath, 'utf8'));
        expect(grandchildPid).toBeGreaterThan(0);
        leftoverPids.push(grandchildPid);
        expect(await waitForPidGone(grandchildPid, 3000)).toBe(true);
      }
    });
  }
});
