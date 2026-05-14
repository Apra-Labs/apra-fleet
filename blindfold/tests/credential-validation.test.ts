import { describe, it, expect } from 'vitest';
import { validateCredentials, credentialStatusNote } from '../src/credential-validation.js';

describe('validateCredentials', () => {
  it('returns null for non-JSON', () => {
    expect(validateCredentials('not json')).toBeNull();
  });

  it('returns null for missing expiresAt', () => {
    expect(validateCredentials('{}')).toBeNull();
  });

  it('returns null for nested-only expiresAt (no top-level)', () => {
    expect(validateCredentials(JSON.stringify({ claudeAiOauth: { expiresAt: new Date().toISOString() } }))).toBeNull();
  });

  it('returns valid for far-future expiry', () => {
    const future = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const result = validateCredentials(JSON.stringify({ expiresAt: future }));
    expect(result).toEqual({ status: 'valid' });
  });

  it('returns near-expiry when within 1 hour', () => {
    const nearFuture = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const result = validateCredentials(JSON.stringify({ expiresAt: nearFuture }));
    expect(result?.status).toBe('near-expiry');
  });

  it('returns expired-refreshable when expired with refresh token', () => {
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    const result = validateCredentials(JSON.stringify({
      expiresAt: past, refreshToken: 'rt',
    }));
    expect(result).toEqual({ status: 'expired-refreshable' });
  });

  it('returns expired-no-refresh when expired without refresh token', () => {
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    const result = validateCredentials(JSON.stringify({
      expiresAt: past,
    }));
    expect(result).toEqual({ status: 'expired-no-refresh' });
  });
});

describe('credentialStatusNote', () => {
  it('returns empty for null', () => {
    expect(credentialStatusNote(null)).toBe('');
  });

  it('returns empty for valid', () => {
    expect(credentialStatusNote({ status: 'valid' })).toBe('');
  });

  it('returns note for near-expiry', () => {
    const note = credentialStatusNote({ status: 'near-expiry', minutesLeft: 15 });
    expect(note).toContain('15 minutes');
  });

  it('handles singular minute', () => {
    const note = credentialStatusNote({ status: 'near-expiry', minutesLeft: 1 });
    expect(note).toContain('1 minute');
    expect(note).not.toContain('minutes');
  });

  it('returns note for expired-refreshable', () => {
    const note = credentialStatusNote({ status: 'expired-refreshable' });
    expect(note).toContain('refresh token');
  });

  it('returns note for expired-no-refresh', () => {
    const note = credentialStatusNote({ status: 'expired-no-refresh' });
    expect(note).toContain('expired');
  });
});
