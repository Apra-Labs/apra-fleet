import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';

// apra-fleet-oomh.14 -- regression guard for the single-entry-point invariant
// the sibling impl task (apra-fleet-oomh.9, streak ci-test-entrypoint) relies
// on: root `npm test` (scripts/run-all-tests.mjs) must enumerate ALL THREE
// suites (a vitest run, the @apralabs/apra-fleet-se workspace, and the
// packages/apra-fleet-se/apra-pm prefix path) and must not short-circuit the
// remaining suites when an earlier one fails.
//
// TECHNIQUE (per the bead's gotcha -- do not execute the script for real):
// this test dynamically imports scripts/run-all-tests.mjs itself, with
// node:child_process's spawnSync mocked and process.exit spied on, so the
// script's REAL top-level control flow (the suites loop, the `failed` flag,
// the final process.exit call) runs -- this is not a re-derivation of that
// logic inside the test body. It never actually spawns a subprocess: the
// script's own first suite entry is `npm exec -- vitest run`, and this guard
// lives inside the vitest suite itself -- letting it spawn a real subprocess
// here would recurse into `vitest run` and take minutes or hang. vi.mock
// intercepts spawnSync before the script's own `import { spawnSync } from
// 'node:child_process'` resolves, and vi.resetModules() + a fresh dynamic
// import is required per test because the script runs its suites loop
// unconditionally at import time and Vitest would otherwise cache that first
// run's side effects across tests.
//
// Suite identity (name + argv) is read from the *paired* runtime evidence the
// script itself produces each iteration -- the "> running <name> suite..."
// console.log immediately before that suite's spawnSync call -- and matched
// into a Map keyed by name, not by call position. This means a reordering of
// the suites array (which preserves behaviour) cannot produce a false
// failure here, unlike asserting on raw array/call position or grepping the
// file's source text.

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

const SCRIPT_PATH = '../scripts/run-all-tests.mjs';
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

async function runScript(): Promise<{ exitSpy: ReturnType<typeof vi.spyOn> }> {
  vi.resetModules();
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((() => undefined) as unknown) as (code?: number) => never);
  await import(SCRIPT_PATH);
  return { exitSpy };
}

/** Pairs each "> running <name> suite..." console.log with the spawnSync call
 * emitted in the same loop iteration, so suite identity is resolved from
 * runtime behaviour rather than call position or source text. */
function extractSuiteRuns(logSpy: ReturnType<typeof vi.spyOn>): Map<string, unknown[]> {
  const runningLines = logSpy.mock.calls
    .map((args) => String(args[0]))
    .filter((line) => /running .+ suite\.\.\./.test(line));
  const names = runningLines.map((line) => {
    const m = line.match(/running (.+) suite\.\.\./);
    if (!m) throw new Error(`could not parse suite name from log line: ${line}`);
    return m[1];
  });

  const calls = vi.mocked(spawnSync).mock.calls;
  expect(names).toHaveLength(calls.length);

  const byName = new Map<string, unknown[]>();
  names.forEach((name, i) => {
    const [cmd, argv] = calls[i];
    byName.set(name, [cmd, ...(argv as string[])]);
  });
  return byName;
}

describe('scripts/run-all-tests.mjs suite enumeration and failure semantics', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(spawnSync).mockReset();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('enumerates exactly the vitest, apra-fleet-se, and apra-pm suites with their real argv', async () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>);

    await runScript();

    const byName = extractSuiteRuns(logSpy);
    expect(byName.size).toBe(3);
    expect(byName.get('vitest')).toEqual([npmCmd, 'exec', '--', 'vitest', 'run']);
    expect(byName.get('apra-fleet-se')).toEqual([npmCmd, 'test', '--workspace=@apralabs/apra-fleet-se']);
    expect(byName.get('apra-pm')).toEqual([npmCmd, 'test', '--prefix', 'packages/apra-fleet-se/apra-pm']);
  });

  it('keeps running the remaining suites after an earlier one fails, and exits non-zero overall', async () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 1 } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({ status: 0 } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({ status: 0 } as ReturnType<typeof spawnSync>);

    const { exitSpy } = await runScript();

    // All three suites still ran -- the first failure did not skip the rest.
    expect(vi.mocked(spawnSync).mock.calls).toHaveLength(3);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits zero when every suite passes', async () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>);

    const { exitSpy } = await runScript();

    expect(vi.mocked(spawnSync).mock.calls).toHaveLength(3);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
