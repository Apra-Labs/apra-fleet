import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { BaseSequencer } from 'vitest/node';

// apra-fleet-3604.2 -- guards the sharded root vitest run in
// scripts/run-all-tests.mjs (apra-fleet-3604.1): shard enumeration, the
// APRA_TEST_VITEST_SHARDS override and its loud validation, failure
// isolation across shards, and the >70%-of-budget headroom WARNING.
//
// TECHNIQUE: same as tests/run-all-tests-suite-enumeration.test.ts -- the
// REAL script is dynamically imported with node:child_process mocked, so its
// own top-level suites loop runs but no subprocess (and certainly no nested
// vitest/npm run) is ever spawned. The headroom case drives elapsed time with
// fake timers (Date + setTimeout) instead of a real sleeping stub, so it is
// deterministic on slow CI runners. The one real subprocess below (invalid
// shard count) is `node scripts/run-all-tests.mjs` itself, which throws
// before spawning any suite.

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

interface MockChildProcess extends EventEmitter {
  pid: number;
  kill: ReturnType<typeof vi.fn>;
}

/** A fake child that exits with `exitCode` -- immediately (next microtask),
 * or after `delayMs` of (possibly fake) timer time. */
function createMockChildProcess(exitCode = 0, delayMs?: number): MockChildProcess {
  const child = Object.assign(new EventEmitter(), { pid: 12345, kill: vi.fn() });
  if (delayMs === undefined) queueMicrotask(() => child.emit('exit', exitCode));
  else setTimeout(() => child.emit('exit', exitCode), delayMs);
  return child;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const SCRIPT_PATH = '../scripts/run-all-tests.mjs';
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

async function runScript(): Promise<{ exitSpy: ReturnType<typeof vi.spyOn> }> {
  vi.resetModules();
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((() => undefined) as unknown) as (code?: number) => never);
  await import(SCRIPT_PATH);
  return { exitSpy };
}

/** Every line written via console.log/console.error, in call order. */
function allOutput(logSpy: ReturnType<typeof vi.spyOn>, errSpy: ReturnType<typeof vi.spyOn>): string {
  return [...logSpy.mock.calls, ...errSpy.mock.calls].map((args) => String(args[0])).join('\n');
}

/** Ordered [suite name, argv] pairs, each "> running <name> suite..." log
 * line paired with the spawn call made in the same loop iteration. */
function suiteRuns(logSpy: ReturnType<typeof vi.spyOn>): Array<[string, string[]]> {
  const names = logSpy.mock.calls
    .map((args) => String(args[0]))
    .map((line) => line.match(/running (.+) suite\.\.\./)?.[1])
    .filter((name): name is string => Boolean(name));
  const calls = vi.mocked(spawn).mock.calls;
  expect(names).toHaveLength(calls.length);
  return names.map((name, i) => [name, [calls[i][0] as string, ...(calls[i][1] as string[])]]);
}

describe('scripts/run-all-tests.mjs sharded root vitest run', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  // Each import of the script registers process 'exit'/SIGINT/SIGTERM
  // listeners; remove the ones a test added so they neither pile up across
  // imports nor outlive this file inside the vitest worker.
  const trackedEvents = ['exit', 'SIGINT', 'SIGTERM'] as const;
  const emitter = process as unknown as EventEmitter;
  let listenersBefore: Map<string, Function[]>;

  beforeEach(() => {
    listenersBefore = new Map(trackedEvents.map((event) => [event, emitter.listeners(event)]));
    vi.stubEnv('APRA_TEST_VITEST_SHARDS', undefined);
    vi.stubEnv('APRA_TEST_SUITES_JSON', undefined);
    vi.stubEnv('APRA_TEST_TIMEOUT_MS', undefined);
    vi.mocked(spawn).mockReset();
    vi.mocked(spawnSync).mockReset();
    vi.mocked(spawn).mockImplementation(() => createMockChildProcess(0));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const event of trackedEvents) {
      const before = listenersBefore.get(event) ?? [];
      for (const listener of emitter.listeners(event)) {
        if (!before.includes(listener)) emitter.removeListener(event, listener as (...args: unknown[]) => void);
      }
    }
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('spawns exactly 3 vitest shard suites by default, each preceded by its own running-suite log line', async () => {
    await runScript();

    const shards = suiteRuns(logSpy).filter(([name]) => name.startsWith('vitest'));
    expect(shards.map(([name]) => name)).toEqual(['vitest-shard-1-of-3', 'vitest-shard-2-of-3', 'vitest-shard-3-of-3']);
    shards.forEach(([, argv], i) => {
      expect(argv).toEqual([npmCmd, 'exec', '--', 'vitest', 'run', `--shard=${i + 1}/3`]);
    });
  });

  it('APRA_TEST_VITEST_SHARDS=2 gives exactly 2 shards', async () => {
    vi.stubEnv('APRA_TEST_VITEST_SHARDS', '2');
    await runScript();

    const shards = suiteRuns(logSpy).filter(([name]) => name.startsWith('vitest'));
    expect(shards).toEqual([
      ['vitest-shard-1-of-2', [npmCmd, 'exec', '--', 'vitest', 'run', '--shard=1/2']],
      ['vitest-shard-2-of-2', [npmCmd, 'exec', '--', 'vitest', 'run', '--shard=2/2']],
    ]);
  });

  it('APRA_TEST_VITEST_SHARDS=1 reproduces the legacy single vitest suite argv with no --shard', async () => {
    vi.stubEnv('APRA_TEST_VITEST_SHARDS', '1');
    await runScript();

    const runs = suiteRuns(logSpy);
    const vitestRuns = runs.filter(([name]) => name.startsWith('vitest'));
    expect(vitestRuns).toEqual([['vitest', [npmCmd, 'exec', '--', 'vitest', 'run']]]);
    expect(runs.flatMap(([, argv]) => argv).some((arg) => arg.startsWith('--shard'))).toBe(false);
  });

  it.each(['0', '-1', 'abc', '1.5', '2x'])('APRA_TEST_VITEST_SHARDS=%s fails loudly naming the variable and spawns nothing', async (value) => {
    vi.stubEnv('APRA_TEST_VITEST_SHARDS', value);
    await expect(runScript()).rejects.toThrow(/APRA_TEST_VITEST_SHARDS must be a positive integer/);
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  it('an invalid APRA_TEST_VITEST_SHARDS makes the real runner process exit non-zero naming the variable', async () => {
    // Real child_process (the module is mocked for this file). The runner
    // throws while building its suite list, before any suite is spawned.
    const real = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const result = real.spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'run-all-tests.mjs')], {
      cwd: repoRoot,
      // APRA_TEST_TIMEOUT_MS=1 is a safety net only: should validation ever
      // regress, any real suite it starts is killed by the runner's own bound
      // within ~2s instead of recursing into a full test run.
      env: { ...process.env, APRA_TEST_VITEST_SHARDS: '0', APRA_TEST_SUITES_JSON: '', APRA_TEST_TIMEOUT_MS: '1' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
    expect(result.stderr).toContain('APRA_TEST_VITEST_SHARDS');
    expect(result.stdout).not.toMatch(/running .+ suite/);
  });

  it('APRA_TEST_SUITES_JSON still bypasses the default list, including shard validation', async () => {
    vi.stubEnv('APRA_TEST_VITEST_SHARDS', 'abc');
    vi.stubEnv('APRA_TEST_SUITES_JSON', JSON.stringify([{ name: 'stub', cmd: 'node', args: ['-v'] }]));
    await runScript();

    expect(suiteRuns(logSpy)).toEqual([['stub', ['node', '-v']]]);
  });

  it('a failing shard does not skip later suites; the run exits 1 and SUMMARY names the failed shard', async () => {
    // Fail the second vitest shard only (suite order: contract:check, then shards).
    let call = 0;
    vi.mocked(spawn).mockImplementation(() => {
      call += 1;
      return createMockChildProcess(call === 3 ? 1 : 0);
    });

    const { exitSpy } = await runScript();

    const names = suiteRuns(logSpy).map(([name]) => name);
    expect(names[2]).toBe('vitest-shard-2-of-3');
    expect(names).toEqual([
      'contract:check',
      'vitest-shard-1-of-3',
      'vitest-shard-2-of-3',
      'vitest-shard-3-of-3',
      'apra-fleet-client',
      'apra-fleet-workflow',
      'apra-fleet-se',
      'apra-pm',
    ]);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const summary = allOutput(logSpy, errSpy).split('\n').find((line) => line.startsWith('SUMMARY:'));
    expect(summary).toBeDefined();
    expect(summary).toMatch(/vitest-shard-2-of-3=FAILED\(/);
    expect(summary).toMatch(/vitest-shard-1-of-3=ok\(/);
    expect(summary).toMatch(/vitest-shard-3-of-3=ok\(/);
    expect(summary).toMatch(/apra-pm=ok\(/);
    expect(summary).toMatch(/-- FAILED$/);
  });

  it('a suite that finishes above 70% of its budget gets a WARNING line and its elapsed time in SUMMARY; a fast suite does not', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.stubEnv('APRA_TEST_TIMEOUT_MS', '10000');
    vi.stubEnv('APRA_TEST_SUITES_JSON', JSON.stringify([
      { name: 'slow-stub', cmd: 'node', args: ['slow.mjs'] },
      { name: 'fast-stub', cmd: 'node', args: ['fast.mjs'] },
    ]));
    vi.mocked(spawn)
      .mockImplementationOnce(() => createMockChildProcess(0, 8_000)) // 80% of budget
      .mockImplementation(() => createMockChildProcess(0, 1_000)); // 10% of budget

    // The script's import (module load) is real async I/O, so keep stepping
    // fake time until its top-level suites loop has actually finished.
    let settled = false;
    const done = runScript().finally(() => { settled = true; });
    for (let i = 0; i < 400 && !settled; i++) {
      await vi.advanceTimersByTimeAsync(250);
      await new Promise((resolve) => setImmediate(resolve));
    }
    const { exitSpy } = await done;

    expect(exitSpy).toHaveBeenCalledWith(0);
    const lines = allOutput(logSpy, errSpy).split('\n');
    const warnings = lines.filter((line) => /WARNING/.test(line));
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.every((line) => line.includes('slow-stub'))).toBe(true);
    expect(warnings.some((line) => line.includes('fast-stub'))).toBe(false);
    expect(warnings[0]).toContain('80%');
    const summary = lines.find((line) => line.startsWith('SUMMARY:'));
    expect(summary).toBe('SUMMARY: slow-stub=ok(8s/10s) fast-stub=ok(1s/10s) -- ok');
  });

  it('a run where every suite is fast produces no WARNING line', async () => {
    vi.stubEnv('APRA_TEST_SUITES_JSON', JSON.stringify([{ name: 'fast-stub', cmd: 'node', args: ['fast.mjs'] }]));
    await runScript();
    expect(allOutput(logSpy, errSpy)).not.toMatch(/WARNING/);
  });
});

describe('vitest --shard partition of this repo\'s real test files', () => {
  // `vitest list --shard` does NOT apply sharding in the pinned vitest 4.1
  // (it lists every file for every shard -- verified by hand), and a nested
  // vitest run is off-limits here, so the partition is computed with
  // vitest's own BaseSequencer.shard() -- the exact method `vitest run
  // --shard` calls in its pool (createPool -> executeTests) -- over the same
  // spec files both configured projects collect.
  function collectSpecFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string, pattern: RegExp) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules') walk(full, pattern);
        } else if (pattern.test(entry.name)) out.push(full);
      }
    };
    walk(path.join(repoRoot, 'tests'), /\.test\.ts$/);
    walk(path.join(repoRoot, 'packages', 'apra-fleet-shell-ui', 'test'), /\.test\.tsx?$/);
    return out;
  }

  it.each([2, 3, 4])('--shard=i/%i shards are disjoint and their union is the unsharded file set', async (count) => {
    const files = collectSpecFiles();
    expect(files.length).toBeGreaterThan(count);
    const specs = files.map((moduleId) => ({ moduleId }));
    const shardSets: string[][] = [];
    for (let index = 1; index <= count; index++) {
      const ctx = { config: { root: repoRoot, shard: { index, count } } };
      const sequencer = new BaseSequencer(ctx as never);
      const picked = (await sequencer.shard(specs as never)) as unknown as Array<{ moduleId: string }>;
      shardSets.push(picked.map((spec) => spec.moduleId));
    }
    const union = shardSets.flat();
    expect(new Set(union).size).toBe(union.length); // disjoint
    expect([...union].sort()).toEqual([...files].sort()); // complete
    for (const set of shardSets) expect(set.length).toBeGreaterThan(0);
  });
});
