import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// recordUsage() is fire-and-forget: it kicks off an async fs.appendFile chain
// and returns immediately without a promise the caller can await. Tests use
// vi.waitFor() to poll for the expected mock call instead of awaiting
// recordUsage() itself. The module holds no in-memory state (every call
// re-reads/re-writes the filesystem), so a plain vi.mock('fs/promises', ...)
// with static imports is sufficient -- KB constraint 1 (vi.resetModules +
// dynamic import) does not apply here.
// ---------------------------------------------------------------------------
const mockAppendFile = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockMkdir = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockRename = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockStat = vi.hoisted(() => vi.fn());

vi.mock('fs/promises', () => ({
  appendFile: mockAppendFile,
  mkdir: mockMkdir,
  rename: mockRename,
  stat: mockStat,
}));

import { recordUsage, USAGE_LOG_PATH, ROTATED_USAGE_LOG_PATH, MAX_USAGE_LOG_BYTES } from '../src/tools/code-intelligence-telemetry.js';

describe('recordUsage()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAppendFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    // Default: no existing usage.jsonl -- ENOENT means "nothing to rotate".
    mockStat.mockRejectedValue(Object.assign(new Error('no such file'), { code: 'ENOENT' }));
  });

  it('never returns a promise -- the call is synchronous and fire-and-forget', () => {
    const result = recordUsage('code_graph', 'handleIPChange', null);
    expect(result).toBeUndefined();
  });

  it('appends one JSON line with the exact keys, an ISO timestamp, and repo null when absent', async () => {
    recordUsage('code_graph', 'handleIPChange', null);

    await vi.waitFor(() => expect(mockAppendFile).toHaveBeenCalledTimes(1));

    const [path, data, encoding] = mockAppendFile.mock.calls[0] as [string, string, string];
    expect(path).toBe(USAGE_LOG_PATH);
    expect(encoding).toBe('utf8');
    expect(data.endsWith('\n')).toBe(true);

    const record = JSON.parse(data.trimEnd());
    expect(Object.keys(record).sort()).toEqual(['repo', 'target', 'tool', 'ts']);
    expect(record.tool).toBe('code_graph');
    expect(record.target).toBe('handleIPChange');
    expect(record.repo).toBeNull();
    expect(() => new Date(record.ts).toISOString()).not.toThrow();
    expect(new Date(record.ts).toISOString()).toBe(record.ts);
  });

  it('records the repo path when provided', async () => {
    recordUsage('code_impact', 'someTarget', '/repo/path');

    await vi.waitFor(() => expect(mockAppendFile).toHaveBeenCalledTimes(1));

    const record = JSON.parse((mockAppendFile.mock.calls[0][1] as string).trimEnd());
    expect(record.repo).toBe('/repo/path');
  });

  it('creates the parent directory before appending', async () => {
    recordUsage('code_query', 'q', null);

    await vi.waitFor(() => expect(mockMkdir).toHaveBeenCalledTimes(1));
    expect(mockMkdir.mock.calls[0][1]).toEqual({ recursive: true });
  });

  it('does not rotate when the existing file is under the size threshold', async () => {
    mockStat.mockResolvedValue({ size: MAX_USAGE_LOG_BYTES - 1 });

    recordUsage('code_context', 'x', null);

    await vi.waitFor(() => expect(mockAppendFile).toHaveBeenCalledTimes(1));
    expect(mockRename).not.toHaveBeenCalled();
  });

  it('rotates usage.jsonl to usage.jsonl.1 (overwrite semantics) when it exceeds 5 MB, then appends fresh', async () => {
    mockStat.mockResolvedValue({ size: MAX_USAGE_LOG_BYTES + 1 });

    recordUsage('code_context', 'x', null);

    await vi.waitFor(() => expect(mockRename).toHaveBeenCalledTimes(1));
    expect(mockRename).toHaveBeenCalledWith(USAGE_LOG_PATH, ROTATED_USAGE_LOG_PATH);

    await vi.waitFor(() => expect(mockAppendFile).toHaveBeenCalledTimes(1));
    expect(mockAppendFile).toHaveBeenCalledWith(USAGE_LOG_PATH, expect.any(String), 'utf8');
  });

  it('does not rotate at exactly the threshold size (only when strictly greater than 5 MB)', async () => {
    mockStat.mockResolvedValue({ size: MAX_USAGE_LOG_BYTES });

    recordUsage('code_context', 'x', null);

    await vi.waitFor(() => expect(mockAppendFile).toHaveBeenCalledTimes(1));
    expect(mockRename).not.toHaveBeenCalled();
  });

  it('never throws when mkdir fails -- the failure never surfaces to the caller', async () => {
    mockMkdir.mockRejectedValue(new Error('EACCES'));

    expect(() => recordUsage('code_graph', 'x', null)).not.toThrow();
    // Give the swallowed rejection a chance to settle before the test ends.
    await vi.waitFor(() => expect(mockMkdir).toHaveBeenCalledTimes(1));
  });

  it('never throws when stat rejects with something other than ENOENT', async () => {
    mockStat.mockRejectedValue(new Error('EPERM'));

    expect(() => recordUsage('code_graph', 'x', null)).not.toThrow();
    await vi.waitFor(() => expect(mockAppendFile).toHaveBeenCalledTimes(1));
  });

  it('never throws when rename fails during rotation', async () => {
    mockStat.mockResolvedValue({ size: MAX_USAGE_LOG_BYTES + 1 });
    mockRename.mockRejectedValue(new Error('EBUSY'));

    expect(() => recordUsage('code_graph', 'x', null)).not.toThrow();
    await vi.waitFor(() => expect(mockRename).toHaveBeenCalledTimes(1));
    // Even though rotation failed, recordUsage still attempts the append --
    // and even if that also failed, it must never surface to the caller.
    await vi.waitFor(() => expect(mockAppendFile).toHaveBeenCalledTimes(1));
  });

  it('never throws when appendFile itself rejects', async () => {
    mockAppendFile.mockRejectedValue(new Error('ENOSPC'));

    expect(() => recordUsage('code_graph', 'x', null)).not.toThrow();
    await vi.waitFor(() => expect(mockAppendFile).toHaveBeenCalledTimes(1));
  });
});
