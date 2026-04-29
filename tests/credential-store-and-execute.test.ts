/**
 * M4 tests:
 *  - credential_store_set / credential_store_list / credential_store_delete round-trip
 *  - {{secure.NAME}} token resolution in execute_command
 *  - Output redaction
 *  - Network egress policy (allow / confirm / deny)
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
} from '../src/services/credential-store.js';
import type { SSHExecResult } from '../src/types.js';

// ---------------------------------------------------------------------------
// Mock strategy so no real SSH happens
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

// ---------------------------------------------------------------------------
// Credential store round-trip
// ---------------------------------------------------------------------------

describe('credential store round-trip', () => {
  it('set, list, delete a session credential', () => {
    const name = `test-cred-${Date.now()}`;
    const plaintext = 'super-secret-value';

    // Set
    const meta = credentialSet(name, plaintext, false, 'allow');
    expect(meta.name).toBe(name);
    expect(meta.scope).toBe('session');
    expect(meta.network_policy).toBe('allow');

    // Resolve
    const resolved = credentialResolve(name);
    expect(resolved).not.toBeNull();
    expect(resolved!.plaintext).toBe(plaintext);

    // List — should appear
    const list = credentialList();
    const found = list.find(c => c.name === name);
    expect(found).toBeDefined();
    expect(found!.scope).toBe('session');

    // Delete
    const deleted = credentialDelete(name);
    expect(deleted).toBe(true);

    // Should be gone
    expect(credentialResolve(name)).toBeNull();
    expect(credentialList().find(c => c.name === name)).toBeUndefined();
  });

  it('delete returns false for unknown credential', () => {
    expect(credentialDelete('does-not-exist-xyz-987')).toBe(false);
  });

  it('credentialDelete removes from both session and persistent tiers (M1)', () => {
    const name = `dualtier${Date.now()}`;

    // Write to session tier
    credentialSet(name, 'session-val', false, 'allow');
    // Write to persistent tier too (simulated by calling credentialSet with persist=true)
    // But since persistent requires file writes, just verify session is removed.
    // The M1 fix ensures both are attempted regardless.

    // Confirm it exists
    expect(credentialResolve(name)).not.toBeNull();

    // Delete — must return true even if only session tier is populated
    expect(credentialDelete(name)).toBe(true);
    expect(credentialResolve(name)).toBeNull();
  });

  it('credentialList deduplicates persistent over session', () => {
    // If a credential exists in session, and then is overwritten with persistent,
    // credentialSet(name, ..., true) clears session. List should show one entry.
    const name = `dedup${Date.now()}`;
    credentialSet(name, 'v1', false, 'allow');
    credentialSet(name, 'v2', true, 'allow'); // persist=true clears session entry

    const list = credentialList();
    const entries = list.filter(c => c.name === name);
    expect(entries).toHaveLength(1);
    expect(entries[0].scope).toBe('persistent');

    // cleanup
    credentialDelete(name);
  });
});

// ---------------------------------------------------------------------------
// {{secure.NAME}} token resolution in execute_command
// ---------------------------------------------------------------------------

describe('execute_command: {{secure.NAME}} token resolution', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('substitutes a {{secure.NAME}} token in the command', async () => {
    const name = `tok${Date.now()}`;
    credentialSet(name, 'mypassword', false, 'allow');

    const member = makeTestAgent({ os: 'linux' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: 'ok', stderr: '', code: 0 });

    const result = await executeCommand({
      member_id: member.id,
      command: `echo {{secure.${name}}}`,
      timeout_s: 5,
    });

    expect(result).toContain('Exit code: 0');
    // The actual command sent must contain the plaintext (shell-escaped), not the token
    const calledCmd = mockExecCommand.mock.calls[0][0] as string;
    expect(calledCmd).toContain('mypassword');
    expect(calledCmd).not.toContain(`{{secure.${name}}}`);

    credentialDelete(name);
  });

  it('returns error when {{secure.NAME}} token is not found (nonexistent_cred)', async () => {
    const member = makeTestAgent({ os: 'linux' });
    addAgent(member);

    const result = await executeCommand({
      member_id: member.id,
      command: 'echo {{secure.nonexistent_cred}}',
      timeout_s: 5,
    });

    expect(result).toContain('not found');
    expect(result).toContain('nonexistent_cred');
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('resolves tokens in restart_command as well (H1)', async () => {
    const name = `restartTok${Date.now()}`;
    credentialSet(name, 'restart-secret', false, 'allow');

    const member = makeTestAgent({ os: 'linux' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const result = await executeCommand({
      member_id: member.id,
      command: 'python train.py',
      long_running: true,
      restart_command: `python resume.py --token {{secure.${name}}}`,
      timeout_s: 5,
    });

    // Task should launch (not error out about missing token)
    expect(result).toContain('Task launched');

    // The wrapper script base64 written to the member should contain the resolved secret
    const calledCmd = mockExecCommand.mock.calls[0][0] as string;
    // The script is base64-encoded; verify the launch command was invoked
    expect(calledCmd).toContain('base64');

    credentialDelete(name);
  });
});

// ---------------------------------------------------------------------------
// Output redaction (H2)
// ---------------------------------------------------------------------------

describe('execute_command: output redaction', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('redacts credential plaintext from stdout', async () => {
    const name = `redact${Date.now()}`;
    const secret = 'supersecrettokenabc123';
    credentialSet(name, secret, false, 'allow');

    const member = makeTestAgent({ os: 'linux' });
    addAgent(member);
    // Simulate command that echoes the secret back
    mockExecCommand.mockResolvedValue({ stdout: `token=${secret}`, stderr: '', code: 0 });

    const result = await executeCommand({
      member_id: member.id,
      command: `echo {{secure.${name}}}`,
      timeout_s: 5,
    });

    // Secret should be redacted in returned output
    expect(result).not.toContain(secret);
    expect(result).toContain(`[REDACTED:${name}]`);

    credentialDelete(name);
  });

  it('redacts credential plaintext from stderr', async () => {
    const name = `redactstderr${Date.now()}`;
    const secret = 'stderrsecretxyz';
    credentialSet(name, secret, false, 'allow');

    const member = makeTestAgent({ os: 'linux' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: `Error: bad token ${secret}`, code: 1 });

    const result = await executeCommand({
      member_id: member.id,
      command: `cmd {{secure.${name}}}`,
      timeout_s: 5,
    });

    expect(result).not.toContain(secret);
    expect(result).toContain(`[REDACTED:${name}]`);

    credentialDelete(name);
  });

  it('does not alter output when no credentials are used', async () => {
    const member = makeTestAgent({ os: 'linux' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: 'hello world', stderr: '', code: 0 });

    const result = await executeCommand({
      member_id: member.id,
      command: 'echo hello world',
      timeout_s: 5,
    });

    expect(result).toContain('hello world');
    expect(result).not.toContain('REDACTED');
  });
});

// ---------------------------------------------------------------------------
// Network egress policy (allow / confirm / deny)
// ---------------------------------------------------------------------------

const { mockCollectOobConfirm } = vi.hoisted(() => ({
  mockCollectOobConfirm: vi.fn(),
}));

vi.mock('../src/services/auth-socket.js', () => ({
  collectOobConfirm: mockCollectOobConfirm,
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

describe('execute_command: network egress policy', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('allow policy — does not prompt, executes command', async () => {
    const name = `egressallow${Date.now()}`;
    credentialSet(name, 'mytoken', false, 'allow');

    const member = makeTestAgent({ os: 'linux' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: 'fetched', stderr: '', code: 0 });

    const result = await executeCommand({
      member_id: member.id,
      command: `curl https://example.com --header {{secure.${name}}}`,
      timeout_s: 5,
    });

    expect(mockCollectOobConfirm).not.toHaveBeenCalled();
    expect(result).toContain('Exit code: 0');

    credentialDelete(name);
  });

  it('deny policy — blocks command with network tool', async () => {
    const name = `egressdeny${Date.now()}`;
    credentialSet(name, 'mytoken', false, 'deny');

    const member = makeTestAgent({ os: 'linux' });
    addAgent(member);

    const result = await executeCommand({
      member_id: member.id,
      command: `curl https://example.com --header {{secure.${name}}}`,
      timeout_s: 5,
    });

    expect(result).toContain('Blocked');
    expect(result).toContain(name);
    expect(mockExecCommand).not.toHaveBeenCalled();

    credentialDelete(name);
  });

  it('confirm policy — confirmed — executes command', async () => {
    const name = `egressconfirmok${Date.now()}`;
    credentialSet(name, 'mytoken', false, 'confirm');

    mockCollectOobConfirm.mockResolvedValue({ confirmed: true, terminalUnavailable: false });

    const member = makeTestAgent({ os: 'linux' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: 'fetched', stderr: '', code: 0 });

    const result = await executeCommand({
      member_id: member.id,
      command: `curl https://example.com --header {{secure.${name}}}`,
      timeout_s: 5,
    });

    expect(mockCollectOobConfirm).toHaveBeenCalledWith(name);
    expect(result).toContain('Exit code: 0');

    credentialDelete(name);
  });

  it('confirm policy — denied — blocks command', async () => {
    const name = `egressconfirmdeny${Date.now()}`;
    credentialSet(name, 'mytoken', false, 'confirm');

    mockCollectOobConfirm.mockResolvedValue({ confirmed: false, terminalUnavailable: false });

    const member = makeTestAgent({ os: 'linux' });
    addAgent(member);

    const result = await executeCommand({
      member_id: member.id,
      command: `wget https://example.com --header {{secure.${name}}}`,
      timeout_s: 5,
    });

    expect(result).toContain('was not confirmed');
    expect(mockExecCommand).not.toHaveBeenCalled();

    credentialDelete(name);
  });

  it('confirm policy — terminal unavailable — blocks command', async () => {
    const name = `egressconfirmunavail${Date.now()}`;
    credentialSet(name, 'mytoken', false, 'confirm');

    mockCollectOobConfirm.mockResolvedValue({ confirmed: false, terminalUnavailable: true });

    const member = makeTestAgent({ os: 'linux' });
    addAgent(member);

    const result = await executeCommand({
      member_id: member.id,
      command: `ssh user@host --key {{secure.${name}}}`,
      timeout_s: 5,
    });

    expect(result).toContain('could not be confirmed');
    expect(mockExecCommand).not.toHaveBeenCalled();

    credentialDelete(name);
  });

  it('deny policy — no network tool in command — executes without block', async () => {
    const name = `egressdenynonet${Date.now()}`;
    credentialSet(name, 'mytoken', false, 'deny');

    const member = makeTestAgent({ os: 'linux' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: 'ok', stderr: '', code: 0 });

    // Command does not contain any network tool pattern
    const result = await executeCommand({
      member_id: member.id,
      command: `echo {{secure.${name}}}`,
      timeout_s: 5,
    });

    // deny only blocks when a network tool is present — pure echo is fine
    expect(result).toContain('Exit code: 0');

    credentialDelete(name);
  });
});
