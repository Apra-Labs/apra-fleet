import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { registerMember } from '../src/tools/register-member.js';
import { encryptPassword, credentialResolve, credentialDelete } from 'blindfold';
import type { SSHExecResult } from '../src/types.js';

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();
const mockTestConnection = vi.fn();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: mockTestConnection,
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
}));

const mockCollectOobPassword = vi.fn<(name: string, tool: string, opts?: any) => Promise<{ password?: string; fallback?: string; persist?: boolean }>>();
const mockCollectOobApiKey = vi.fn<(name: string, tool: string, opts?: any) => Promise<{ password?: string; fallback?: string; persist?: boolean }>>();

vi.mock('blindfold', async () => {
  const actual = await vi.importActual<typeof import('blindfold')>('blindfold');
  return {
    ...actual,
    collectOobPassword: (name: string, tool: string, opts?: any) => mockCollectOobPassword(name, tool, opts),
    collectOobApiKey: (name: string, tool: string, opts?: any) => mockCollectOobApiKey(name, tool, opts),
  };
});

// ---------------------------------------------------------------------------
// Test 3: Anonymous OOB use-and-throw
// ---------------------------------------------------------------------------

describe('register_member: anonymous OOB password (Test 3)', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: 'Linux', stderr: '', code: 0 });
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('calls collectOobPassword when auth_type=password and no password provided', async () => {
    const encPw = encryptPassword('test-pw');
    mockCollectOobPassword.mockResolvedValueOnce({ password: encPw });

    const result = await registerMember({
      friendly_name: 'oob-test',
      member_type: 'remote',
      host: '192.168.1.102',
      username: 'akhil',
      work_folder: '~/git/test',
      auth_type: 'password',
    });

    expect(result).toContain('✅ Member registered successfully');
    expect(mockCollectOobPassword).toHaveBeenCalledOnce();
  });

  it('passes username@host in the OOB prompt', async () => {
    const encPw = encryptPassword('test-pw');
    mockCollectOobPassword.mockResolvedValueOnce({ password: encPw });

    await registerMember({
      friendly_name: 'prompt-test',
      member_type: 'remote',
      host: '192.168.1.102',
      username: 'akhil',
      work_folder: '~/git/test2',
      auth_type: 'password',
    });

    const opts = mockCollectOobPassword.mock.calls[0][2];
    expect(opts).toBeDefined();
    expect(opts.prompt).toContain('akhil@192.168.1.102');
  });

  it('returns fallback when OOB terminal is unavailable', async () => {
    mockCollectOobPassword.mockResolvedValueOnce({ fallback: 'No terminal available' });

    const result = await registerMember({
      friendly_name: 'fallback-test',
      member_type: 'remote',
      host: '192.168.1.102',
      username: 'akhil',
      work_folder: '~/git/test3',
      auth_type: 'password',
    });

    expect(result).toContain('No terminal available');
    expect(result).not.toContain('✅');
  });

  it('does NOT call collectOobPassword when password is provided inline', async () => {
    const result = await registerMember({
      friendly_name: 'inline-pw',
      member_type: 'remote',
      host: '192.168.1.102',
      username: 'akhil',
      work_folder: '~/git/test4',
      auth_type: 'password',
      password: 'my-password',
    });

    expect(result).toContain('✅ Member registered successfully');
    expect(mockCollectOobPassword).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test 4: Named credential auto-create via OOB
// ---------------------------------------------------------------------------

describe('register_member: named credential auto-create (Test 4)', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: 'Linux', stderr: '', code: 0 });
    // Clean up any stale credentials from prior runs
    credentialDelete('MyLinPass');
    credentialDelete('PersistCred');
    credentialDelete('SessionCred');
    credentialDelete('FailCred');
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('opens OOB when {{secure.NAME}} credential does not exist', async () => {
    const encPw = encryptPassword('collected-value');
    mockCollectOobApiKey.mockResolvedValueOnce({ password: encPw, persist: false });

    const result = await registerMember({
      friendly_name: 'auto-create-test',
      member_type: 'remote',
      host: '192.168.1.102',
      username: 'akhil',
      work_folder: '~/git/test5',
      auth_type: 'password',
      password: '{{secure.MyLinPass}}',
    });

    expect(result).toContain('✅ Member registered successfully');
    expect(mockCollectOobApiKey).toHaveBeenCalledOnce();
    expect(mockCollectOobApiKey).toHaveBeenCalledWith(
      'MyLinPass',
      'register_member',
      expect.objectContaining({ askPersist: true }),
    );
  });

  it('stores credential as persistent when user confirms', async () => {
    const encPw = encryptPassword('persist-value');
    mockCollectOobApiKey.mockResolvedValueOnce({ password: encPw, persist: true });

    const result = await registerMember({
      friendly_name: 'persist-test',
      member_type: 'remote',
      host: '192.168.1.102',
      username: 'akhil',
      work_folder: '~/git/test6',
      auth_type: 'password',
      password: '{{secure.PersistCred}}',
    });

    expect(result).toContain('✅ Member registered successfully');
    const stored = credentialResolve('PersistCred');
    expect(stored).not.toBeNull();
    expect(stored).toHaveProperty('plaintext', 'persist-value');
    expect(stored).toHaveProperty('meta');
    expect((stored as any).meta.scope).toBe('persistent');
  });

  it('stores credential as session-only when user declines persist', async () => {
    const encPw = encryptPassword('session-value');
    mockCollectOobApiKey.mockResolvedValueOnce({ password: encPw, persist: false });

    const result = await registerMember({
      friendly_name: 'session-test',
      member_type: 'remote',
      host: '192.168.1.102',
      username: 'akhil',
      work_folder: '~/git/test7',
      auth_type: 'password',
      password: '{{secure.SessionCred}}',
    });

    expect(result).toContain('✅ Member registered successfully');
    const stored = credentialResolve('SessionCred');
    expect(stored).not.toBeNull();
    expect(stored).toHaveProperty('plaintext', 'session-value');
    expect((stored as any).meta.scope).toBe('session');
  });

  it('returns error when OOB collection fails for missing credential', async () => {
    mockCollectOobApiKey.mockResolvedValueOnce({ fallback: 'Terminal unavailable' });

    const result = await registerMember({
      friendly_name: 'oob-fail-test',
      member_type: 'remote',
      host: '192.168.1.102',
      username: 'akhil',
      work_folder: '~/git/test8',
      auth_type: 'password',
      password: '{{secure.FailCred}}',
    });

    expect(result).toContain('Terminal unavailable');
    expect(result).not.toContain('✅');
  });
});
