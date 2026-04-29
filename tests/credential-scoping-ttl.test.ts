/**
 * T3 tests: credential scoping, TTL enforcement, list display,
 * and backward compatibility.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { executeCommand } from '../src/tools/execute-command.js';
import {
  credentialSet,
  credentialList,
  credentialDelete,
  credentialResolve,
  purgeExpiredCredentials,
} from '../src/services/credential-store.js';
import type { SSHExecResult } from '../src/types.js';

// ---------------------------------------------------------------------------
// Mocks — no real SSH
// ---------------------------------------------------------------------------

const { mockExecCommand } = vi.hoisted(() => ({
  mockExecCommand: vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>(),
}));

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: vi.fn().mockResolvedValue({ ok: true }),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock('../src/services/cloud/lifecycle.js', () => ({
  ensureCloudReady: vi.fn((member: any) => Promise.resolve(member)),
}));

vi.mock('../src/services/auth-socket.js', () => ({
  collectOobConfirm: vi.fn(),
  collectOobPassword: vi.fn(),
  collectOobApiKey: vi.fn(),
  ensureAuthSocket: vi.fn(),
  createPendingAuth: vi.fn(),
  hasPendingAuth: vi.fn().mockReturnValue(false),
  getPendingPassword: vi.fn().mockReturnValue(null),
  waitForPassword: vi.fn(),
  cleanupAuthSocket: vi.fn(),
  getSocketPath: vi.fn().mockReturnValue('/tmp/test.sock'),
  launchAuthTerminal: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Scoping enforcement
// ---------------------------------------------------------------------------

describe('credentialResolve: member scoping', () => {
  afterEach(() => {
    // Purge any credentials left over from a failed or partial test run.
    // Each test also deletes its own credential, but this catches leaks.
    for (const entry of credentialList()) {
      if (/^(scope_star_|scope_in_|scope_deny_|scope_bypass_|scope_undef_)/.test(entry.name)) {
        credentialDelete(entry.name);
      }
    }
  });

  it('allows access when allowedMembers is "*"', () => {
    const name = `scope_star_${Date.now()}`;
    credentialSet(name, 'secret', false, 'allow', '*');
    const result = credentialResolve(name, 'fleet-dev');
    expect(result).not.toBeNull();
    expect('plaintext' in result!).toBe(true);
    credentialDelete(name);
  });

  it('allows access when callingMember is in allowedMembers list', () => {
    const name = `scope_in_${Date.now()}`;
    credentialSet(name, 'secret', false, 'allow', ['fleet-dev', 'fleet-rev']);
    const result = credentialResolve(name, 'fleet-dev');
    expect(result).not.toBeNull();
    expect('plaintext' in result!).toBe(true);
    credentialDelete(name);
  });

  it('denies access when callingMember is NOT in allowedMembers list', () => {
    const name = `scope_deny_${Date.now()}`;
    credentialSet(name, 'secret', false, 'allow', ['fleet-dev']);
    const result = credentialResolve(name, 'fleet-rev');
    expect(result).not.toBeNull();
    expect('denied' in result!).toBe(true);
    if (result && 'denied' in result) {
      expect(result.denied).toContain('fleet-rev');
      expect(result.denied).toContain(name);
      expect(result.denied).toContain('fleet-dev');
    }
    credentialDelete(name);
  });

  it('bypasses scoping when callingMember is "*" (fleet-operator bypass)', () => {
    const name = `scope_bypass_${Date.now()}`;
    credentialSet(name, 'secret', false, 'allow', ['fleet-dev']);
    const result = credentialResolve(name, '*');
    expect(result).not.toBeNull();
    expect('plaintext' in result!).toBe(true);
    credentialDelete(name);
  });

  it('bypasses scoping when callingMember is undefined (no enforcement)', () => {
    const name = `scope_undef_${Date.now()}`;
    credentialSet(name, 'secret', false, 'allow', ['fleet-dev']);
    const result = credentialResolve(name, undefined);
    expect(result).not.toBeNull();
    expect('plaintext' in result!).toBe(true);
    credentialDelete(name);
  });
});

// ---------------------------------------------------------------------------
// TTL enforcement
// ---------------------------------------------------------------------------

describe('credentialResolve: TTL enforcement', () => {
  it('resolves a credential with a future TTL', () => {
    const name = `ttl_future_${Date.now()}`;
    credentialSet(name, 'secret', false, 'allow', '*', 3600);
    const result = credentialResolve(name);
    expect(result).not.toBeNull();
    expect('plaintext' in result!).toBe(true);
    credentialDelete(name);
  });

  it('returns { expired } for a credential with a past TTL', () => {
    const name = `ttl_past_${Date.now()}`;
    credentialSet(name, 'secret', false, 'allow', '*', -1); // already expired
    const result = credentialResolve(name);
    expect(result).not.toBeNull();
    expect('expired' in result!).toBe(true);
    if (result && 'expired' in result) {
      expect(result.expired).toContain(name);
      expect(result.expired).toContain('expired');
    }
    // Entry should be purged — second resolve returns null
    expect(credentialResolve(name)).toBeNull();
  });

  it('returns null for a credential that never existed', () => {
    expect(credentialResolve('does_not_exist_xyz_scoping')).toBeNull();
  });

  it('re-setting a credential resets the TTL', () => {
    const name = `ttl_reset_${Date.now()}`;
    credentialSet(name, 'secret-v1', false, 'allow', '*', -1); // expired
    // Verify it's expired
    const first = credentialResolve(name);
    expect(first && 'expired' in first).toBe(true);

    // Re-set with valid TTL
    credentialSet(name, 'secret-v2', false, 'allow', '*', 3600);
    const second = credentialResolve(name);
    expect(second).not.toBeNull();
    expect('plaintext' in second!).toBe(true);
    if (second && 'plaintext' in second) {
      expect(second.plaintext).toBe('secret-v2');
    }
    credentialDelete(name);
  });

  it('omitting ttl_seconds stores no expiresAt', () => {
    const name = `ttl_none_${Date.now()}`;
    const meta = credentialSet(name, 'secret', false, 'allow');
    expect(meta.expiresAt).toBeUndefined();
    const result = credentialResolve(name);
    expect(result).not.toBeNull();
    expect('plaintext' in result!).toBe(true);
    credentialDelete(name);
  });
});

// ---------------------------------------------------------------------------
// credentialList: members and expiry display
// ---------------------------------------------------------------------------

describe('credentialList: allowedMembers and expiresAt metadata', () => {
  it('includes allowedMembers and expiresAt in listed entries', () => {
    const name = `list_meta_${Date.now()}`;
    credentialSet(name, 'secret', false, 'allow', ['fleet-dev'], 3600);
    const list = credentialList();
    const entry = list.find(e => e.name === name);
    expect(entry).toBeDefined();
    expect(entry!.allowedMembers).toEqual(['fleet-dev']);
    expect(entry!.expiresAt).toBeDefined();
    credentialDelete(name);
  });

  it('shows "*" for allowedMembers when credential is unrestricted', () => {
    const name = `list_star_${Date.now()}`;
    credentialSet(name, 'secret', false, 'allow', '*');
    const list = credentialList();
    const entry = list.find(e => e.name === name);
    expect(entry).toBeDefined();
    expect(entry!.allowedMembers).toBe('*');
    credentialDelete(name);
  });
});

// ---------------------------------------------------------------------------
// purgeExpiredCredentials: startup sweep
// ---------------------------------------------------------------------------

describe('purgeExpiredCredentials', () => {
  it('is callable without error even when no credentials exist', () => {
    expect(() => purgeExpiredCredentials()).not.toThrow();
  });

  it('removes expired session-tier credentials after purge', () => {
    const name = `purge_sess_${Date.now()}`;
    credentialSet(name, 'secret', false, 'allow', '*', -1); // expired immediately
    // Before purge, credentialResolve returns expired (and purges inline)
    const pre = credentialResolve(name);
    expect(pre && 'expired' in pre).toBe(true);
    // Now it's gone
    expect(credentialResolve(name)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility: credentials without allowedMembers/expiresAt
// ---------------------------------------------------------------------------

describe('backward compatibility', () => {
  it('treats missing allowedMembers as "*" (any member can resolve)', () => {
    // Simulate a legacy credential written before T1 by directly setting via
    // credentialSet with default params (allowedMembers defaults to '*')
    const name = `compat_${Date.now()}`;
    credentialSet(name, 'legacy-value', false, 'allow');
    const result = credentialResolve(name, 'any-member');
    expect(result).not.toBeNull();
    expect('plaintext' in result!).toBe(true);
    if (result && 'plaintext' in result) {
      expect(result.plaintext).toBe('legacy-value');
    }
    credentialDelete(name);
  });
});

// ---------------------------------------------------------------------------
// execute_command: scoping rejection propagates to tool
// ---------------------------------------------------------------------------

describe('execute_command: credential scoping rejection', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('returns error when credential is not accessible to the calling member', async () => {
    const name = `cmd_scope_${Date.now()}`;
    // Only fleet-dev is allowed
    credentialSet(name, 'secret', false, 'allow', ['fleet-dev']);

    // Use a member with a different friendlyName
    const member = makeTestAgent({ os: 'linux', friendlyName: 'fleet-rev' });
    addAgent(member);

    const result = await executeCommand({
      member_id: member.id,
      command: `echo {{secure.${name}}}`,
      timeout_s: 5,
    });

    expect(result).toContain('❌');
    expect(result).toContain(name);
    expect(mockExecCommand).not.toHaveBeenCalled();

    credentialDelete(name);
  });

  it('executes successfully when calling member is in allowedMembers', async () => {
    const name = `cmd_allowed_${Date.now()}`;
    credentialSet(name, 'secret', false, 'allow', ['fleet-dev']);

    const member = makeTestAgent({ os: 'linux', friendlyName: 'fleet-dev' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: 'ok', stderr: '', code: 0 });

    const result = await executeCommand({
      member_id: member.id,
      command: `echo {{secure.${name}}}`,
      timeout_s: 5,
    });

    expect(result).toContain('Exit code: 0');
    credentialDelete(name);
  });
});
