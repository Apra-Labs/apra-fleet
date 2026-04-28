import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('log-helpers', () => {
  const testDataDir = process.env.APRA_FLEET_DATA_DIR!;
  const logsDir = path.join(testDataDir, 'logs');

  let mockInfo: ReturnType<typeof vi.fn>;
  let mockWarn: ReturnType<typeof vi.fn>;
  let mockError: ReturnType<typeof vi.fn>;
  let mockTransportFn: ReturnType<typeof vi.fn>;
  let mockPinoFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();

    mockInfo = vi.fn();
    mockWarn = vi.fn();
    mockError = vi.fn();
    mockTransportFn = vi.fn().mockReturnValue({});

    const mockLogger = { info: mockInfo, warn: mockWarn, error: mockError };
    mockPinoFn = vi.fn().mockReturnValue(mockLogger);
    (mockPinoFn as any).transport = mockTransportFn;

    vi.doMock('pino', () => ({ default: mockPinoFn }));

    if (fs.existsSync(logsDir)) {
      fs.rmSync(logsDir, { recursive: true });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('pino');
  });

  it('creates APRA_FLEET_DATA_DIR/logs/ directory on first logLine call', async () => {
    const { logLine } = await import('../src/utils/log-helpers.js');
    expect(fs.existsSync(logsDir)).toBe(false);
    logLine('test', 'hello');
    expect(fs.existsSync(logsDir)).toBe(true);
  });

  it('configures pino with fleet-<pid>.log file path and correct transport options', async () => {
    const { logLine } = await import('../src/utils/log-helpers.js');
    logLine('test', 'hello');

    expect(mockTransportFn).toHaveBeenCalledWith(
      expect.objectContaining({
        target: 'pino-roll',
        options: expect.objectContaining({
          file: expect.stringContaining(`fleet-${process.pid}.log`),
        }),
      }),
    );
    expect(mockPinoFn).toHaveBeenCalledWith(
      expect.objectContaining({
        timestamp: expect.any(Function),
        formatters: expect.objectContaining({
          level: expect.any(Function),
          bindings: expect.any(Function),
        }),
      }),
      expect.anything(),
    );
  });

  it('writes with tag and msg fields; level/pid formatters produce correct shape', async () => {
    const { logLine } = await import('../src/utils/log-helpers.js');
    logLine('mytag', 'hello world');

    expect(mockInfo).toHaveBeenCalledOnce();
    const [fields, msg] = mockInfo.mock.calls[0];
    expect(fields).toMatchObject({ tag: 'mytag' });
    expect(msg).toBe('hello world');

    // Verify formatters produce expected field shapes
    const [[pinoOpts]] = mockPinoFn.mock.calls;
    expect(pinoOpts.formatters.level('info')).toEqual({ level: 'info' });
    expect(pinoOpts.formatters.bindings({ pid: 42, hostname: 'host' })).toEqual({ pid: 42 });
    // timestamp should return ISO 8601 string in pino inline-field format
    const ts = pinoOpts.timestamp();
    expect(ts).toMatch(/^,"ts":"\d{4}-\d{2}-\d{2}T/);
  });

  it('populates member_id when memberId provided; excludes it when omitted', async () => {
    const { logLine } = await import('../src/utils/log-helpers.js');

    logLine('tag', 'with member', 'member-uuid-123');
    expect(mockInfo).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ member_id: 'member-uuid-123' }),
      'with member',
    );

    logLine('tag', 'without member');
    expect(mockInfo.mock.calls[1][0]).not.toHaveProperty('member_id');
  });

  it('applies maskSecrets() — {{secure.MY_KEY}} is written as [REDACTED]', async () => {
    const { logLine } = await import('../src/utils/log-helpers.js');
    logLine('tag', 'use {{secure.MY_KEY}} here');

    const [, msg] = mockInfo.mock.calls[0];
    expect(msg).toBe('use [REDACTED] here');
  });

  it('verifies pino-roll rotation config: 10m size cap, 3 rotated files', async () => {
    const { logLine } = await import('../src/utils/log-helpers.js');
    logLine('tag', 'init');

    const transportArgs = mockTransportFn.mock.calls[0][0];
    expect(transportArgs.target).toBe('pino-roll');
    expect(transportArgs.options.size).toBe('10m');
    expect(transportArgs.options.limit).toEqual({ count: 3 });
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
