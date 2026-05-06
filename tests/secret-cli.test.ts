/**
 * T5: Unit tests for secret CLI — arg parsing, error messages, output formatting.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Hoisted mocks (must be defined before vi.mock calls)
// ---------------------------------------------------------------------------

const {
  mockNetConnect,
  mockReadlineCreateInterface,
  mockSecureInput,
  mockCredentialList,
  mockCredentialDelete,
  mockCredentialSet,
  mockCredentialUpdate,
} = vi.hoisted(() => ({
  mockNetConnect: vi.fn(),
  mockReadlineCreateInterface: vi.fn(),
  mockSecureInput: vi.fn(),
  mockCredentialList: vi.fn(),
  mockCredentialDelete: vi.fn(),
  mockCredentialSet: vi.fn(),
  mockCredentialUpdate: vi.fn(),
}));

vi.mock('node:net', () => ({
  default: { connect: mockNetConnect },
}));

vi.mock('node:readline', () => ({
  default: { createInterface: mockReadlineCreateInterface },
}));

vi.mock('../src/utils/secure-input.js', () => ({
  secureInput: mockSecureInput,
}));

vi.mock('../src/services/auth-socket.js', () => ({
  getSocketPath: vi.fn().mockReturnValue('/tmp/apra-fleet-test.sock'),
}));

vi.mock('../src/services/credential-store.js', () => ({
  credentialList: mockCredentialList,
  credentialDelete: mockCredentialDelete,
  credentialSet: mockCredentialSet,
  credentialUpdate: mockCredentialUpdate,
}));

import { runSecret } from '../src/cli/secret.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

class ExitError extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`);
    this.name = 'ExitError';
  }
}

function makeErrorSocket(): any {
  const emitter = new EventEmitter() as any;
  emitter.write = vi.fn();
  emitter.end = vi.fn();
  process.nextTick(() => emitter.emit('error', new Error('ENOENT')));
  return emitter;
}

function makeSuccessSocket(response: object): any {
  const emitter = new EventEmitter() as any;
  emitter.end = vi.fn();
  emitter.write = vi.fn(() => {
    process.nextTick(() => {
      emitter.emit('data', Buffer.from(JSON.stringify(response) + '\n'));
    });
  });
  return emitter;
}

let exitSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
    throw new ExitError(code ?? 0);
  });
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  mockCredentialList.mockReturnValue([]);
  mockCredentialDelete.mockReturnValue(true);
  mockCredentialSet.mockReturnValue({ name: 'x', scope: 'session', network_policy: 'deny', created_at: '', allowedMembers: '*' });
  mockCredentialUpdate.mockReturnValue({ members: '*', network_policy: 'allow' });
  mockSecureInput.mockResolvedValue('my-secret-value');
});

afterEach(() => {
  exitSpy.mockRestore();
  logSpy.mockRestore();
  errSpy.mockRestore();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// No-arg / help
// ---------------------------------------------------------------------------

describe('runSecret: no args', () => {
  it('prints usage and exits 1 when called with no args', async () => {
    await expect(runSecret([])).rejects.toThrow(ExitError);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits 0 for --help', async () => {
    await expect(runSecret(['--help'])).rejects.toThrow(ExitError);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

// ---------------------------------------------------------------------------
// Name validation (NAME_REGEX = /^[a-zA-Z0-9_]{1,64}$/)
// ---------------------------------------------------------------------------

describe('runSecret: name validation via --delete', () => {
  it('accepts lowercase letters', async () => {
    await runSecret(['--delete', 'valid_name']);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('accepts uppercase letters and digits', async () => {
    await runSecret(['--delete', 'ABC123']);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('accepts exactly 64-character name', async () => {
    const name = 'a'.repeat(64);
    await runSecret(['--delete', name]);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('rejects name with hyphen', async () => {
    await expect(runSecret(['--delete', 'bad-name'])).rejects.toThrow(ExitError);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const msg = errSpy.mock.calls.flat().join('\n');
    expect(msg).toContain('Invalid credential name');
  });

  it('rejects name with space', async () => {
    await expect(runSecret(['--delete', 'bad name'])).rejects.toThrow(ExitError);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('rejects name longer than 64 characters', async () => {
    const name = 'a'.repeat(65);
    await expect(runSecret(['--delete', name])).rejects.toThrow(ExitError);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const msg = errSpy.mock.calls.flat().join('\n');
    expect(msg).toContain('[a-zA-Z0-9_]{1,64}');
  });
});

// ---------------------------------------------------------------------------
// --list
// ---------------------------------------------------------------------------

describe('runSecret --list', () => {
  it('prints "No secrets stored." when list is empty', async () => {
    mockCredentialList.mockReturnValue([]);
    await runSecret(['--list']);
    expect(logSpy).toHaveBeenCalledWith('No secrets stored.');
  });

  it('prints a table with NAME/SCOPE/POLICY/MEMBERS/EXPIRES headers', async () => {
    mockCredentialList.mockReturnValue([
      {
        name: 'my_token',
        scope: 'persistent',
        network_policy: 'allow',
        created_at: '2026-01-01T00:00:00.000Z',
        allowedMembers: '*',
        expiresAt: undefined,
      },
    ]);
    await runSecret(['--list']);

    const output = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('NAME');
    expect(output).toContain('SCOPE');
    expect(output).toContain('POLICY');
    expect(output).toContain('MEMBERS');
    expect(output).toContain('EXPIRES');
    expect(output).toContain('my_token');
    expect(output).toContain('persistent');
    expect(output).toContain('allow');
    expect(output).toContain('*');
    // Secret value must NOT appear
    expect(output).not.toContain('secret');
  });

  it('shows "—" for missing expiresAt', async () => {
    mockCredentialList.mockReturnValue([
      { name: 'tok', scope: 'session', network_policy: 'confirm', created_at: '', allowedMembers: '*' },
    ]);
    await runSecret(['--list']);
    const output = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('—');
  });
});

// ---------------------------------------------------------------------------
// --set
// ---------------------------------------------------------------------------

describe('runSecret --set', () => {
  it('exits 1 when name argument is missing', async () => {
    await expect(runSecret(['--set'])).rejects.toThrow(ExitError);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const msg = errSpy.mock.calls.flat().join('\n');
    expect(msg).toContain('Usage');
  });

  it('exits 1 for invalid name', async () => {
    await expect(runSecret(['--set', 'bad-name!'])).rejects.toThrow(ExitError);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const msg = errSpy.mock.calls.flat().join('\n');
    expect(msg).toContain('Invalid credential name');
  });

  it('exits 1 when secureInput returns empty string', async () => {
    mockSecureInput.mockResolvedValue('');
    await expect(runSecret(['--set', 'valid_name'])).rejects.toThrow(ExitError);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const msg = errSpy.mock.calls.flat().join('\n');
    expect(msg).toContain('Empty value');
  });

  it('exits 1 when secureInput is cancelled', async () => {
    mockSecureInput.mockRejectedValue(new Error('cancelled'));
    await expect(runSecret(['--set', 'valid_name'])).rejects.toThrow(ExitError);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const msg = errSpy.mock.calls.flat().join('\n');
    expect(msg).toContain('Cancelled');
  });

  it('exits 1 when no server and no --persist', async () => {
    mockNetConnect.mockImplementation(() => makeErrorSocket());
    await expect(runSecret(['--set', 'my_secret'])).rejects.toThrow(ExitError);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const msg = errSpy.mock.calls.flat().join('\n');
    expect(msg).toContain('No pending request');
    expect(msg).toContain('--persist');
  });

  it('stores credential when no server but --persist is given', async () => {
    mockNetConnect.mockImplementation(() => makeErrorSocket());
    await runSecret(['--set', 'my_secret', '--persist']);
    expect(mockCredentialSet).toHaveBeenCalledWith('my_secret', 'my-secret-value', true, 'deny');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('delivers via OOB when server is listening', async () => {
    mockNetConnect.mockImplementation((_path: string, connectCb?: () => void) => {
      const socket = makeSuccessSocket({ ok: true });
      if (connectCb) process.nextTick(connectCb);
      return socket;
    });
    await runSecret(['--set', 'my_secret']);
    expect(exitSpy).not.toHaveBeenCalled();
    const msg = errSpy.mock.calls.flat().join('\n');
    expect(msg).toContain('delivered');
  });
});

// ---------------------------------------------------------------------------
// --delete
// ---------------------------------------------------------------------------

describe('runSecret --delete', () => {
  it('exits 1 when no name and no --all', async () => {
    await expect(runSecret(['--delete'])).rejects.toThrow(ExitError);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const msg = errSpy.mock.calls.flat().join('\n');
    expect(msg).toContain('Usage');
  });

  it('exits 1 when name is invalid', async () => {
    await expect(runSecret(['--delete', 'bad-name'])).rejects.toThrow(ExitError);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits 1 when credential not found', async () => {
    mockCredentialDelete.mockReturnValue(false);
    await expect(runSecret(['--delete', 'missing_cred'])).rejects.toThrow(ExitError);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const msg = errSpy.mock.calls.flat().join('\n');
    expect(msg).toContain('not found');
  });

  it('prints success when credential is deleted', async () => {
    mockCredentialDelete.mockReturnValue(true);
    await runSecret(['--delete', 'my_token']);
    expect(exitSpy).not.toHaveBeenCalled();
    const msg = logSpy.mock.calls.flat().join('\n');
    expect(msg).toContain('deleted');
    expect(msg).toContain('my_token');
  });

  it('--delete --all: cancels when answer is not "yes"', async () => {
    mockReadlineCreateInterface.mockReturnValue({
      question: vi.fn((_prompt: string, cb: (ans: string) => void) => cb('no')),
      close: vi.fn(),
    });
    await runSecret(['--delete', '--all']);
    expect(mockCredentialDelete).not.toHaveBeenCalled();
    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Cancelled');
  });

  it('--delete --all: deletes all after "yes" confirmation', async () => {
    mockReadlineCreateInterface.mockReturnValue({
      question: vi.fn((_prompt: string, cb: (ans: string) => void) => cb('yes')),
      close: vi.fn(),
    });
    mockCredentialList.mockReturnValue([
      { name: 'tok1', scope: 'session', network_policy: 'allow', created_at: '', allowedMembers: '*' },
      { name: 'tok2', scope: 'persistent', network_policy: 'deny', created_at: '', allowedMembers: '*' },
    ]);
    await runSecret(['--delete', '--all']);
    expect(mockCredentialDelete).toHaveBeenCalledWith('tok1');
    expect(mockCredentialDelete).toHaveBeenCalledWith('tok2');
    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Deleted 2');
  });
});

// ---------------------------------------------------------------------------
// --update
// ---------------------------------------------------------------------------

describe('runSecret --update', () => {
  it('exits 1 when name is missing', async () => {
    await expect(runSecret(['--update'])).rejects.toThrow(ExitError);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits 1 for invalid name', async () => {
    await expect(runSecret(['--update', 'bad-name'])).rejects.toThrow(ExitError);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits 1 when no update flags are provided (zero-flag no-op)', async () => {
    await expect(runSecret(['--update', 'my_token'])).rejects.toThrow(ExitError);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const msg = errSpy.mock.calls.flat().join('\n');
    expect(msg).toContain('No fields to update');
    // Must not call credentialUpdate with empty patch
    expect(mockCredentialUpdate).not.toHaveBeenCalled();
  });

  it('exits 1 when credential not found', async () => {
    mockCredentialUpdate.mockReturnValue(null);
    await expect(runSecret(['--update', 'missing_cred', '--allow'])).rejects.toThrow(ExitError);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const msg = errSpy.mock.calls.flat().join('\n');
    expect(msg).toContain('not found');
  });

  it('updates with --allow flag', async () => {
    await runSecret(['--update', 'my_token', '--allow']);
    expect(mockCredentialUpdate).toHaveBeenCalledWith('my_token', expect.objectContaining({ network_policy: 'allow' }));
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('updates with --deny flag', async () => {
    await runSecret(['--update', 'my_token', '--deny']);
    expect(mockCredentialUpdate).toHaveBeenCalledWith('my_token', expect.objectContaining({ network_policy: 'deny' }));
  });

  it('updates with --members flag', async () => {
    await runSecret(['--update', 'my_token', '--members', 'alice,bob']);
    expect(mockCredentialUpdate).toHaveBeenCalledWith('my_token', expect.objectContaining({ members: 'alice,bob' }));
  });

  it('updates with --ttl flag', async () => {
    await runSecret(['--update', 'my_token', '--ttl', '3600']);
    const call = mockCredentialUpdate.mock.calls[0];
    expect(call[0]).toBe('my_token');
    expect(typeof call[1].expiresAt).toBe('number');
    expect(call[1].expiresAt).toBeGreaterThan(Date.now() + 3000 * 1000);
  });

  it('exits 1 when --ttl value is not a positive number', async () => {
    await expect(runSecret(['--update', 'my_token', '--ttl', 'abc'])).rejects.toThrow(ExitError);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const msg = errSpy.mock.calls.flat().join('\n');
    expect(msg).toContain('Invalid TTL');
  });
});
