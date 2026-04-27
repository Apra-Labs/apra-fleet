import { describe, it, expect, afterEach } from 'vitest';
import {
  credentialSet,
  credentialDelete,
  credentialResolve,
  credentialUpdate,
} from '../src/services/credential-store.js';
import { credentialStoreUpdate } from '../src/tools/credential-store-update.js';

// Clean up test credentials after each test
const TEST_PREFIX = 'test_update_cred_';
afterEach(() => {
  // Best-effort cleanup — ignore missing
  credentialDelete(`${TEST_PREFIX}session`);
  credentialDelete(`${TEST_PREFIX}policy`);
  credentialDelete(`${TEST_PREFIX}ttl`);
  credentialDelete(`${TEST_PREFIX}multi`);
  credentialDelete(`${TEST_PREFIX}ttl0`);
});

// ---------------------------------------------------------------------------
// credentialUpdate service function
// ---------------------------------------------------------------------------

describe('credentialUpdate service', () => {
  it('updates members on a session credential', () => {
    const name = `${TEST_PREFIX}session`;
    credentialSet(name, 'secret', false, 'allow');

    const updated = credentialUpdate(name, { members: 'alice,bob' });
    expect(updated).not.toBeNull();
    expect(updated!.members).toBe('alice,bob');
    expect(updated!.network_policy).toBe('allow'); // unchanged
  });

  it('updates network_policy only', () => {
    const name = `${TEST_PREFIX}policy`;
    credentialSet(name, 'secret', false, 'allow');

    const updated = credentialUpdate(name, { network_policy: 'deny' });
    expect(updated).not.toBeNull();
    expect(updated!.network_policy).toBe('deny');
  });

  it('updates ttl_seconds (sets expiresAt in the future)', () => {
    const name = `${TEST_PREFIX}ttl`;
    credentialSet(name, 'secret', false, 'allow');
    const before = Date.now();

    const updated = credentialUpdate(name, { expiresAt: Date.now() + 3600 * 1000 });
    expect(updated).not.toBeNull();
    expect(updated!.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000 - 10);
  });

  it('removes expiresAt when null is passed', () => {
    const name = `${TEST_PREFIX}ttl0`;
    credentialSet(name, 'secret', false, 'allow');
    credentialUpdate(name, { expiresAt: Date.now() + 3600 * 1000 });

    const cleared = credentialUpdate(name, { expiresAt: null });
    expect(cleared).not.toBeNull();
    expect(cleared!.expiresAt).toBeUndefined();
  });

  it('updates multiple fields at once', () => {
    const name = `${TEST_PREFIX}multi`;
    credentialSet(name, 'secret', false, 'allow');
    const before = Date.now();

    const updated = credentialUpdate(name, {
      members: '*',
      network_policy: 'confirm',
      expiresAt: Date.now() + 7200 * 1000,
    });
    expect(updated).not.toBeNull();
    expect(updated!.members).toBe('*');
    expect(updated!.network_policy).toBe('confirm');
    expect(updated!.expiresAt).toBeGreaterThanOrEqual(before + 7200 * 1000 - 10);
  });

  it('returns null for unknown credential', () => {
    expect(credentialUpdate('does_not_exist_xyz', { members: '*' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// credentialStoreUpdate tool
// ---------------------------------------------------------------------------

describe('credentialStoreUpdate tool', () => {
  it('updates members only', async () => {
    const name = `${TEST_PREFIX}session`;
    credentialSet(name, 'secret', false, 'allow');

    const result = await credentialStoreUpdate({ name, members: 'team-alpha' });
    expect(result).toContain(`✅ Credential "${name}" updated.`);
    expect(result).toContain('"members":"team-alpha"');
  });

  it('updates ttl_seconds only', async () => {
    const name = `${TEST_PREFIX}ttl`;
    credentialSet(name, 'secret', false, 'allow');

    const result = await credentialStoreUpdate({ name, ttl_seconds: 3600 });
    expect(result).toContain(`✅ Credential "${name}" updated.`);
    expect(result).toContain('"expiresAt"');
  });

  it('updates network_policy only', async () => {
    const name = `${TEST_PREFIX}policy`;
    credentialSet(name, 'secret', false, 'allow');

    const result = await credentialStoreUpdate({ name, network_policy: 'deny' });
    expect(result).toContain(`✅ Credential "${name}" updated.`);
    expect(result).toContain('"network_policy":"deny"');
  });

  it('updates multiple fields at once', async () => {
    const name = `${TEST_PREFIX}multi`;
    credentialSet(name, 'secret', false, 'allow');

    const result = await credentialStoreUpdate({ name, members: '*', network_policy: 'confirm', ttl_seconds: 7200 });
    expect(result).toContain(`✅ Credential "${name}" updated.`);
    expect(result).toContain('"members":"*"');
    expect(result).toContain('"network_policy":"confirm"');
    expect(result).toContain('"expiresAt"');
  });

  it('ttl_seconds=0 removes expiry', async () => {
    const name = `${TEST_PREFIX}ttl0`;
    credentialSet(name, 'secret', false, 'allow');
    await credentialStoreUpdate({ name, ttl_seconds: 3600 });

    const result = await credentialStoreUpdate({ name, ttl_seconds: 0 });
    expect(result).toContain(`✅ Credential "${name}" updated.`);
    expect(result).toContain('"expiresAt":null');
  });

  it('returns error for credential not found', async () => {
    const result = await credentialStoreUpdate({ name: 'does_not_exist_xyz', members: '*' });
    expect(result).toBe('❌ Credential "does_not_exist_xyz" not found.');
  });

  it('returns error when no fields provided', async () => {
    const result = await credentialStoreUpdate({ name: 'any_name' });
    expect(result).toBe('❌ No fields to update — specify at least one of: members, ttl_seconds, network_policy.');
  });
});
