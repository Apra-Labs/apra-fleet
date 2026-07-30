import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isBenignPostjectStderrLine,
  filterPostjectStderr,
  runPostjectFiltered,
  reportAndCheckPostjectResult,
} from '../scripts/package-sea.mjs';

// apra-fleet-eft.57.2: postject repeats a KNOWN-BENIGN warning per Linux
// build against Node 22's ELF sections (see package-sea.mjs's
// POSTJECT_BENIGN_STDERR_PATTERNS / apra-fleet-eft.57.1). This must be an
// explicit allowlist of exact benign patterns only -- everything else must
// pass through verbatim, and a nonzero postject exit must still fail the
// build. These tests pin: (1) a non-allowlisted stderr line passes through
// verbatim, (2) a benign allowlisted line is dropped, (3) a nonzero postject
// exit still fails the build.
describe('isBenignPostjectStderrLine / filterPostjectStderr', () => {
  it('recognizes the exact known-benign ELF section warning as benign', () => {
    expect(isBenignPostjectStderrLine("warning: Can't find string offset for section name '.note'")).toBe(true);
    expect(isBenignPostjectStderrLine("warning: Can't find string offset for section name '.note.1'")).toBe(true);
  });

  it('does NOT treat an unrelated stderr line as benign', () => {
    expect(isBenignPostjectStderrLine('Error: something went wrong')).toBe(false);
    expect(isBenignPostjectStderrLine("warning: Can't find string offset for section name '.text'")).toBe(false);
  });

  it('drops only the benign allowlisted line, passing a non-allowlisted line through verbatim', () => {
    const stderrText = [
      "warning: Can't find string offset for section name '.note'",
      'Error: unexpected failure while injecting blob',
      "warning: Can't find string offset for section name '.note.2'",
    ].join('\n');

    const filtered = filterPostjectStderr(stderrText);

    expect(filtered).toBe('Error: unexpected failure while injecting blob');
  });

  it('passes a fully non-allowlisted stderr blob through verbatim, unmodified', () => {
    const stderrText = 'Error: postject could not locate NODE_SEA_BLOB fuse\nAborting.';
    expect(filterPostjectStderr(stderrText)).toBe(stderrText);
  });
});

describe('runPostjectFiltered', () => {
  it('filters benign lines out of the captured stderr while preserving status/error', () => {
    const spawnSyncSpy = vi.fn().mockReturnValue({
      status: 0,
      error: undefined,
      stderr: "warning: Can't find string offset for section name '.note'\n",
    });

    const result = runPostjectFiltered('npx --yes postject foo', {}, { spawnSync: spawnSyncSpy });

    expect(spawnSyncSpy).toHaveBeenCalled();
    expect(result.status).toBe(0);
    expect(result.filteredStderr).toBe('');
  });

  it('preserves a non-allowlisted stderr line verbatim alongside a nonzero exit status', () => {
    const spawnSyncSpy = vi.fn().mockReturnValue({
      status: 1,
      error: undefined,
      stderr: 'Error: postject injection failed\n',
    });

    const result = runPostjectFiltered('npx --yes postject foo', {}, { spawnSync: spawnSyncSpy });

    expect(result.status).toBe(1);
    expect(result.filteredStderr).toBe('Error: postject injection failed');
  });
});

describe('reportAndCheckPostjectResult', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not exit and prints nothing extra when postject succeeds with no residual stderr', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
    const stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    reportAndCheckPostjectResult({ status: 0, error: undefined, filteredStderr: '' });

    expect(exitSpy).not.toHaveBeenCalled();
    expect(stderrWriteSpy).not.toHaveBeenCalled();
  });

  it('writes a non-allowlisted filtered stderr line verbatim even on a successful (zero) exit', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
    const stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    reportAndCheckPostjectResult({ status: 0, error: undefined, filteredStderr: 'Error: something odd but non-fatal' });

    expect(stderrWriteSpy).toHaveBeenCalledWith('Error: something odd but non-fatal\n');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('fails the build (non-zero process.exit) when postject exits nonzero, even with no stderr', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as () => never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => reportAndCheckPostjectResult({ status: 1, error: undefined, filteredStderr: '' })).toThrow('exit:1');

    expect(exitSpy).toHaveBeenCalledWith(1);
    errorSpy.mockRestore();
  });

  it('throws the underlying spawn error (e.g. ENOENT) rather than swallowing it', () => {
    const spawnError = new Error('spawnSync npx ENOENT');

    expect(() => reportAndCheckPostjectResult({ status: null, error: spawnError, filteredStderr: '' })).toThrow('spawnSync npx ENOENT');
  });
});
