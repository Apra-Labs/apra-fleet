import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock references so they are available inside vi.mock factories, which
// are hoisted to the top of the file before any import statements. This
// module (src/tools/code-intelligence-reindex.ts) holds module-level state
// (the repo -> { runningChild, lastFinishedAt } Map), so KB constraint 1
// applies: vi.resetModules() + a dynamic import at the start of each test
// gives a fresh module instance while the hoisted mock references stay
// stable across resets.
// ---------------------------------------------------------------------------
const mockSpawn = vi.hoisted(() => vi.fn());
const mockReadFileSync = vi.hoisted(() => vi.fn());
const mockLogWarn = vi.hoisted(() => vi.fn());
const mockLogError = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  spawn: mockSpawn,
}));

vi.mock('fs', () => ({
  readFileSync: mockReadFileSync,
}));

vi.mock('../src/utils/log-helpers.js', () => ({
  logWarn: mockLogWarn,
  logError: mockLogError,
}));

function configAbsent(): void {
  mockReadFileSync.mockImplementation(() => {
    throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
  });
}

interface FakeChild {
  stderr: { on: ReturnType<typeof vi.fn> };
  on: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
  listeners: Record<string, Array<(...args: unknown[]) => void>>;
}

function makeFakeChild(): FakeChild {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const child: FakeChild = {
    stderr: { on: vi.fn() },
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(cb);
      return child;
    }),
    unref: vi.fn(),
    listeners,
  };
  return child;
}

// ---------------------------------------------------------------------------
// shouldStartReindex() -- pure decision function, no timers/IO.
// ---------------------------------------------------------------------------
describe('shouldStartReindex()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns false when a reindex is already running', async () => {
    const { shouldStartReindex } = await import('../src/tools/code-intelligence-reindex.js');
    expect(shouldStartReindex({ running: true }, Date.now(), 120000)).toBe(false);
  });

  it('returns false within the cooldown window', async () => {
    const { shouldStartReindex } = await import('../src/tools/code-intelligence-reindex.js');
    const now = 1_000_000;
    expect(shouldStartReindex({ running: false, lastFinishedAt: now - 1000 }, now, 120000)).toBe(false);
  });

  it('returns true once the cooldown has passed', async () => {
    const { shouldStartReindex } = await import('../src/tools/code-intelligence-reindex.js');
    const now = 1_000_000;
    expect(shouldStartReindex({ running: false, lastFinishedAt: now - 200000 }, now, 120000)).toBe(true);
  });

  it('returns true when the entry is undefined', async () => {
    const { shouldStartReindex } = await import('../src/tools/code-intelligence-reindex.js');
    expect(shouldStartReindex(undefined, Date.now(), 120000)).toBe(true);
  });

  it('honors a custom cooldownMs', async () => {
    const { shouldStartReindex } = await import('../src/tools/code-intelligence-reindex.js');
    const now = 1_000_000;
    expect(shouldStartReindex({ running: false, lastFinishedAt: now - 5000 }, now, 1000)).toBe(true);
    expect(shouldStartReindex({ running: false, lastFinishedAt: now - 5000 }, now, 10000)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// maybeScheduleReindex() -- spawn, single-flight, config, logging.
// ---------------------------------------------------------------------------
describe('maybeScheduleReindex()', () => {
  beforeEach(() => {
    vi.resetModules();
    mockSpawn.mockReset();
    mockReadFileSync.mockReset();
    mockLogWarn.mockReset();
    mockLogError.mockReset();
    configAbsent();
  });

  it('spawns npx gitnexus analyze with the expected args when no reindex is running', async () => {
    const fakeChild = makeFakeChild();
    mockSpawn.mockReturnValue(fakeChild);
    const { maybeScheduleReindex } = await import('../src/tools/code-intelligence-reindex.js');

    const started = maybeScheduleReindex('/repo/path');

    expect(started).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = mockSpawn.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(cmd).toBe('npx');
    expect(args).toEqual(['gitnexus', 'analyze']);
    expect(options.cwd).toBe('/repo/path');
    expect(options.detached).toBe(true);
    expect(options.stdio).toEqual(['ignore', 'ignore', 'pipe']);
    expect(options.shell).toBe(process.platform === 'win32');
    expect(fakeChild.unref).toHaveBeenCalledTimes(1);
  });

  it('single-flight: a second call while the first is still running does not spawn again', async () => {
    const fakeChild = makeFakeChild();
    mockSpawn.mockReturnValue(fakeChild);
    const { maybeScheduleReindex } = await import('../src/tools/code-intelligence-reindex.js');

    const first = maybeScheduleReindex('/repo/path');
    const second = maybeScheduleReindex('/repo/path');

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('enabled:false in config.json is a no-op', async () => {
    mockReadFileSync.mockReset();
    mockReadFileSync.mockReturnValue(JSON.stringify({ autoReindex: { enabled: false } }));
    const { maybeScheduleReindex } = await import('../src/tools/code-intelligence-reindex.js');

    const started = maybeScheduleReindex('/repo/path');

    expect(started).toBe(false);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('honors a custom cooldownMs from config when deciding to skip', async () => {
    // Prime the module with a finished run, then set a config cooldown longer
    // than the elapsed time so a second call is skipped even though no child
    // is currently running.
    mockReadFileSync.mockReset();
    mockReadFileSync.mockReturnValueOnce(JSON.stringify({ autoReindex: { cooldownMs: 999999999 } }));
    const fakeChild = makeFakeChild();
    mockSpawn.mockReturnValue(fakeChild);
    const { maybeScheduleReindex } = await import('../src/tools/code-intelligence-reindex.js');

    const first = maybeScheduleReindex('/repo/path');
    expect(first).toBe(true);
    // Simulate the child finishing so runningChild is cleared but
    // lastFinishedAt is set -- the long custom cooldown should still block.
    fakeChild.listeners['exit'][0](0);

    mockReadFileSync.mockReturnValue(JSON.stringify({ autoReindex: { cooldownMs: 999999999 } }));
    const second = maybeScheduleReindex('/repo/path');
    expect(second).toBe(false);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('logs via logError when the child exits non-zero, including a stderr tail', async () => {
    const fakeChild = makeFakeChild();
    mockSpawn.mockReturnValue(fakeChild);
    const { maybeScheduleReindex } = await import('../src/tools/code-intelligence-reindex.js');

    maybeScheduleReindex('/repo/path');

    const dataCall = fakeChild.stderr.on.mock.calls.find((c) => c[0] === 'data');
    expect(dataCall).toBeDefined();
    (dataCall as [string, (chunk: Buffer) => void])[1](Buffer.from('boom'));

    fakeChild.listeners['exit'][0](1);

    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    const [, msg] = mockLogWarn.mock.calls[0] as [string, string];
    expect(msg).toContain('boom');
  });

  it('never throws when spawn itself throws', async () => {
    mockSpawn.mockImplementation(() => {
      throw new Error('spawn EMFILE');
    });
    const { maybeScheduleReindex } = await import('../src/tools/code-intelligence-reindex.js');

    expect(() => maybeScheduleReindex('/repo/path')).not.toThrow();
    expect(maybeScheduleReindex('/repo/path')).toBe(false);
    expect(mockLogError).toHaveBeenCalled();
  });
});
