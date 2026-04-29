import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';

describe('log-helpers', () => {
  const testDataDir = process.env.APRA_FLEET_DATA_DIR!;
  const logsDir = path.join(testDataDir, 'logs');

  let capturedLines: string[];

  beforeEach(() => {
    vi.resetModules();
    capturedLines = [];

    if (fs.existsSync(logsDir)) {
      fs.rmSync(logsDir, { recursive: true });
    }

    vi.spyOn(fs, 'createWriteStream').mockImplementation(() => {
      const stream = new Writable({
        write(chunk, _encoding, callback) {
          capturedLines.push(chunk.toString());
          callback();
        },
      }) as unknown as fs.WriteStream;
      return stream;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function parsedLines(): Record<string, unknown>[] {
    return capturedLines
      .flatMap((chunk) => chunk.split('\n').filter(Boolean))
      .map((l) => JSON.parse(l));
  }

  it('creates APRA_FLEET_DATA_DIR/logs/ directory on first logLine call', async () => {
    const { logLine } = await import('../src/utils/log-helpers.js');
    expect(fs.existsSync(logsDir)).toBe(false);
    logLine('test', 'hello');
    expect(fs.existsSync(logsDir)).toBe(true);
  });

  it('writes valid JSONL to fleet-<pid>.log', async () => {
    const { logLine } = await import('../src/utils/log-helpers.js');
    logLine('mytag', 'hello world');

    const lines = parsedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'info', tag: 'mytag', msg: 'hello world' });
    expect(lines[0]).not.toHaveProperty('pid');
    expect(typeof lines[0].ts).toBe('string');
    expect((lines[0].ts as string)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('field order: ts, level, tag, msg (no mid/mem/pid when omitted)', async () => {
    const { logLine } = await import('../src/utils/log-helpers.js');
    logLine('tag', 'msg');

    const lines = parsedLines();
    expect(lines).toHaveLength(1);
    expect(Object.keys(lines[0])).toEqual(['ts', 'level', 'tag', 'msg']);
  });

  it('includes mid between tag and msg when member provided; omits when not', async () => {
    const { logLine } = await import('../src/utils/log-helpers.js');
    logLine('tag', 'with member', { id: 'member-uuid-123', friendlyName: '' });
    logLine('tag', 'without member');

    const lines = parsedLines();
    expect(lines).toHaveLength(2);

    expect(Object.keys(lines[0])).toEqual(['ts', 'level', 'tag', 'mid', 'msg']);
    expect(lines[0].mid).toBe('member-uuid-123');

    expect(Object.keys(lines[1])).toEqual(['ts', 'level', 'tag', 'msg']);
    expect(lines[1]).not.toHaveProperty('mid');
  });

  it('includes mem field when member has a friendlyName', async () => {
    const { logLine } = await import('../src/utils/log-helpers.js');
    logLine('tag', 'with name', { id: 'member-uuid-123', friendlyName: 'MyMember' });

    const lines = parsedLines();
    expect(lines).toHaveLength(1);
    expect(Object.keys(lines[0])).toEqual(['ts', 'level', 'tag', 'mid', 'mem', 'msg']);
    expect(lines[0].mid).toBe('member-uuid-123');
    expect(lines[0].mem).toBe('MyMember');
  });

  it('applies maskSecrets() — {{secure.MY_KEY}} is written as [REDACTED]', async () => {
    const { logLine } = await import('../src/utils/log-helpers.js');
    logLine('tag', 'use {{secure.MY_KEY}} here');

    const lines = parsedLines();
    expect(lines[0].msg).toBe('use [REDACTED] here');
  });

  it('still calls console.error on each logLine call', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { logLine } = await import('../src/utils/log-helpers.js');

    logLine('mytag', 'test message');

    expect(consoleSpy).toHaveBeenCalledOnce();
    const output: string = consoleSpy.mock.calls[0][0];
    expect(output).toContain('mytag');
    expect(output).toContain('test message');
  });
});
