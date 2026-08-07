import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { getStrategy } from '../src/services/strategy.js';
import { makeTestLocalAgent } from './test-helpers.js';

// Proves apra-fleet-grq: LocalStrategy.execCommand's stdout handler decodes
// each Buffer chunk through a stateful StringDecoder (src/services/strategy.ts,
// child.stdout.on('data', ...)), carrying a trailing incomplete multi-byte
// UTF-8 sequence across chunks instead of substituting U+FFFD for it. If a
// naive per-chunk `.toString()` were used instead, a multi-byte character
// split across two separate stdout 'data' events would come out corrupted on
// both halves.
//
// The previous version of this test proved the same thing by spawning a REAL
// `node` child process and using a `setTimeout` between two writes to coax
// the OS into delivering them as separate 'data' events. That is exactly the
// kind of split we want to test, but relying on the OS to reproduce it is
// inherently racy and slow: a real process spawn plus a deliberate 50ms delay
// measurably exceeded Windows CI's budget (test timeout) under load, and the
// cross-platform temp-directory cleanup in afterEach() raced Windows' delayed
// release of the just-exited child's file handle (EBUSY on rmdir) -- neither
// of which has anything to do with the UTF-8 decoding logic actually under
// test.
//
// This version mocks `node:child_process`'s `spawn` and drives the exact
// same byte split directly and synchronously: no real process, no real
// filesystem, no timers, no OS-scheduling dependency. It is deterministic by
// construction, so it cannot be flaky, and it still exercises the real
// `LocalStrategy.execCommand` code path end to end (stdout handler, decoder,
// 'close' handler) -- only the child process itself is faked.
const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: mockSpawn };
});

/** Minimal fake ChildProcess: just enough surface for LocalStrategy.execCommand
 *  to drive to a normal 'close' -- stdout/stderr as separate emitters (real
 *  Node behavior), the process itself as the 'close'/'error' emitter, plus
 *  the stdin.end()/kill()/pid fields execCommand touches unconditionally. */
function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { end: () => void };
    pid: number;
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: vi.fn() };
  child.pid = 4242;
  child.kill = vi.fn();
  return child;
}

describe('LocalStrategy stdout UTF-8 chunk-boundary handling (apra-fleet-grq)', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it('does not corrupt a multi-byte UTF-8 character split across two stdout chunks', async () => {
    const fakeChild = makeFakeChild();
    mockSpawn.mockReturnValue(fakeChild);

    const member = makeTestLocalAgent();
    const strategy = getStrategy(member);

    const resultPromise = strategy.execCommand('irrelevant -- spawn is mocked');

    // spawn() runs synchronously inside execCommand's Promise executor, so by
    // this point mockSpawn has already been called and fakeChild's 'data'/
    // 'close' listeners are already attached -- safe to drive them now.
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    // U+1F4CB (clipboard emoji) UTF-8 bytes: F0 9F 93 8B. Split exactly at
    // the byte boundary the original bug required: bytes 0-2 in one chunk,
    // byte 3 (+ trailing ASCII) in the next -- the precise case a per-chunk
    // `.toString()` corrupts and a StringDecoder does not.
    fakeChild.stdout.emit('data', Buffer.from([0xF0, 0x9F, 0x93]));
    fakeChild.stdout.emit('data', Buffer.concat([
      Buffer.from([0x8B]),
      Buffer.from(' Response from fleet-reorg: done'),
    ]));
    fakeChild.emit('close', 0);

    const result = await resultPromise;

    expect(result.code).toBe(0);
    // Would fail if the handler decoded each chunk independently: the split
    // write would come out as U+FFFD U+FFFD (or similar) instead of the
    // intended single U+1F4CB emoji.
    expect(result.stdout).not.toContain('\uFFFD');
    expect(result.stdout).toBe('\u{1F4CB} Response from fleet-reorg: done');
  });
});
