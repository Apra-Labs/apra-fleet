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
// git rev-parse for the exclude file: '' = no repo, so the exclude step is a
// quiet no-op here (tests/code-index-no-repo-writes.test.ts covers it for real).
const mockExecFileSync = vi.hoisted(() => vi.fn(() => ''));
const mockReadFileSync = vi.hoisted(() => vi.fn());
const mockLogWarn = vi.hoisted(() => vi.fn());
const mockLogError = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  spawn: mockSpawn,
  execFileSync: mockExecFileSync,
}));

// Only the config read is faked; the shared analyze runner's own fs use
// (log file, status.json under the sandbox data dir) runs for real.
vi.mock('fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs')>()),
  readFileSync: mockReadFileSync,
}));

const sandbox = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reindex-unit-'));
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'bin', process.platform === 'win32' ? 'npx.cmd' : 'npx'), '');
  return { dir, bin: path.join(dir, 'bin') };
});
vi.mock('../src/paths.js', () => ({ FLEET_DIR: sandbox.dir }));
vi.mock('../src/services/knowledge/project-slug.js', () => ({ resolveProjectSlug: () => 'slug' }));

import { afterAll } from 'vitest';
import { delimiter } from 'node:path';
import { rmSync } from 'node:fs';
const realPath = process.env.PATH;
process.env.PATH = sandbox.bin + delimiter + realPath;
afterAll(() => { process.env.PATH = realPath; rmSync(sandbox.dir, { recursive: true, force: true }); });

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
  pid: number;
  on: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
  listeners: Record<string, Array<(...args: unknown[]) => void>>;
}

function makeFakeChild(): FakeChild {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const child: FakeChild = {
    pid: 99999991,
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

  it('spawns npx gitnexus analyze --index-only (no AGENTS.md/CLAUDE.md/skills writes) when no reindex is running', async () => {
    const fakeChild = makeFakeChild();
    mockSpawn.mockReturnValue(fakeChild);
    const { maybeScheduleReindex } = await import('../src/tools/code-intelligence-reindex.js');

    const started = maybeScheduleReindex('/repo/path');

    expect(started).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = mockSpawn.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(cmd).toBe('npx');
    // On win32 spawn runs through cmd.exe (shell: true), where an unquoted `>=`
    // is a redirection, so the version-range spec is double-quoted there.
    const spec = process.platform === 'win32' ? '"gitnexus@>=1.6.5"' : 'gitnexus@>=1.6.5';
    expect(args).toEqual(['-y', spec, 'analyze', '--index-only']);
    expect(options.cwd).toBe('/repo/path');
    // win32: non-detached so the cmd.exe tree shares one hidden console.
    expect(options.detached).toBe(process.platform !== 'win32');
    expect(options.windowsHide).toBe(true);
    expect(options.stdio).toEqual(['ignore', expect.any(Number), expect.any(Number)]);
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

  it('records status.json and warns with the log tail when the child exits non-zero', async () => {
    const fakeChild = makeFakeChild();
    mockSpawn.mockReturnValue(fakeChild);
    const { maybeScheduleReindex } = await import('../src/tools/code-intelligence-reindex.js');

    maybeScheduleReindex('/repo/path');
    fakeChild.listeners['exit'][0](1);

    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    const [, msg] = mockLogWarn.mock.calls[0] as [string, string];
    expect(msg).toContain('exit 1');
    // An automatic run that failed pauses automatic rebuilds; the one warning says so.
    expect(msg).toContain('automatic rebuilds paused until code_reindex or a server restart');
    const { readFileSync: realRead } = await vi.importActual<typeof import('fs')>('fs');
    const status = JSON.parse(realRead(`${sandbox.dir}/code-index/slug/status.json`, 'utf8'));
    expect(status).toMatchObject({ phase: 'done', result: 'failed', exitCode: 1 });
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
