import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventEmitter } from 'node:events';

// --- Mock blindfold ---
vi.mock('blindfold', async () => {
  const actual = await vi.importActual<typeof import('blindfold')>('blindfold');
  return {
    ...actual,
    getSocketPath: () => '/tmp/test-fleet.sock',
  };
});

// --- Mock node:readline ---
const mockQuestion = vi.fn<(prompt: string, cb: (answer: string) => void) => void>();
const mockRlClose = vi.fn();
const mockRlOn = vi.fn<(event: string, cb: (...args: any[]) => void) => any>();

vi.mock('node:readline', () => ({
  default: {
    createInterface: () => ({
      question: mockQuestion,
      close: mockRlClose,
      on: mockRlOn,
    }),
  },
}));

// --- Mock node:net ---
let capturedSocketPath = '';
let capturedWritten = '';
const mockNetWrite = vi.fn<(data: string) => void>();
const mockNetEnd = vi.fn();
const mockClientOn = vi.fn<(event: string, cb: (...args: any[]) => void) => any>();
let connectCallback: (() => void) | null = null;
let dataCallback: ((chunk: Buffer) => void) | null = null;

vi.mock('node:net', () => ({
  default: {
    connect: (sockPath: string, cb: () => void) => {
      capturedSocketPath = sockPath;
      connectCallback = cb;
      return {
        write: (data: string) => {
          mockNetWrite(data);
          capturedWritten = data;
        },
        end: mockNetEnd,
        on: (event: string, cb: (...args: any[]) => void) => {
          mockClientOn(event, cb);
          if (event === 'data') dataCallback = cb as (chunk: Buffer) => void;
        },
      };
    },
  },
}));

describe('auth --confirm (egress confirmation)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedSocketPath = '';
    capturedWritten = '';
    connectCallback = null;
    dataCallback = null;

    // readline: question immediately calls cb with 'yes', then fires close
    mockQuestion.mockImplementation((_prompt, cb) => {
      cb('yes');
    });
    mockRlOn.mockImplementation((event, cb) => {
      if (event === 'close') {
        // do not auto-fire; the question handler resolves first
      }
      return {};
    });
  });

  it('connects to socket and sends correct JSON when user types yes', async () => {
    const { runAuth } = await import('../src/cli/auth.js');

    const p = runAuth(['--confirm', 'TEST_CRED']);

    // Simulate the socket connecting and returning ok
    await vi.waitFor(() => connectCallback !== null);
    connectCallback!();

    await vi.waitFor(() => dataCallback !== null);
    const okResponse = Buffer.from(JSON.stringify({ ok: true }) + '\n');
    dataCallback!(okResponse);

    await p;

    expect(capturedSocketPath).toBe('/tmp/test-fleet.sock');
    const sent = JSON.parse(capturedWritten.trim());
    expect(sent).toMatchObject({
      type: 'auth',
      member_name: 'TEST_CRED',
      password: 'yes',
    });
  });

  it('rejects an invalid credential name before opening the socket', async () => {
    const { runAuth } = await import('../src/cli/auth.js');

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => { throw new Error('process.exit'); });

    await expect(runAuth(['--confirm', 'bad name!'])).rejects.toThrow('process.exit');
    expect(capturedSocketPath).toBe('');
    exitSpy.mockRestore();
  });
});
