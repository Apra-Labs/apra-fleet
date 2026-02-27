import { describe, it, expect, vi, afterEach } from 'vitest';
import { validateCredentials, credentialStatusNote } from '../src/utils/credential-validation.js';

function makeCreds(overrides: Record<string, any> = {}) {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat01-test',
      expiresAt: new Date(Date.now() + 7200000).toISOString(), // 2 hours
      refreshToken: 'rt-test',
      ...overrides,
    },
  });
}

describe('validateCredentials', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('returns valid for a token with > 1 hour left', () => {
    expect(validateCredentials(makeCreds())).toEqual({ status: 'valid' });
  });

  it('returns valid at exactly 1 hour boundary', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    const creds = makeCreds({ expiresAt: '2025-01-01T01:00:00Z' });
    // exactly 1 hour = 3600000ms, threshold is 3600000ms, so msLeft < threshold is false → valid
    expect(validateCredentials(creds)).toEqual({ status: 'valid' });
  });

  it('returns near-expiry at 59 minutes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    const creds = makeCreds({ expiresAt: '2025-01-01T00:59:00Z' });
    expect(validateCredentials(creds)).toEqual({ status: 'near-expiry', minutesLeft: 59 });
  });

  it('returns near-expiry with 1 minute left', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    const creds = makeCreds({ expiresAt: '2025-01-01T00:00:30Z' });
    expect(validateCredentials(creds)).toEqual({ status: 'near-expiry', minutesLeft: 1 });
  });

  it('returns expired-refreshable when expired with refresh token', () => {
    const creds = makeCreds({ expiresAt: '2020-01-01T00:00:00Z', refreshToken: 'rt-xxx' });
    expect(validateCredentials(creds)).toEqual({ status: 'expired-refreshable' });
  });

  it('returns expired-no-refresh when expired without refresh token', () => {
    const creds = makeCreds({ expiresAt: '2020-01-01T00:00:00Z', refreshToken: undefined });
    expect(validateCredentials(creds)).toEqual({ status: 'expired-no-refresh' });
  });

  it('returns expired-no-refresh at exactly 0ms left', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    const creds = makeCreds({ expiresAt: '2025-01-01T00:00:00Z', refreshToken: undefined });
    expect(validateCredentials(creds)).toEqual({ status: 'expired-no-refresh' });
  });

  it('returns null for unparseable JSON', () => {
    expect(validateCredentials('not json')).toBeNull();
  });

  it('returns null for missing claudeAiOauth', () => {
    expect(validateCredentials('{}')).toBeNull();
  });

  it('returns null for missing expiresAt', () => {
    expect(validateCredentials(JSON.stringify({ claudeAiOauth: { accessToken: 'x' } }))).toBeNull();
  });
});

describe('credentialStatusNote', () => {
  it('returns empty for valid', () => {
    expect(credentialStatusNote({ status: 'valid' })).toBe('');
  });

  it('returns empty for null', () => {
    expect(credentialStatusNote(null)).toBe('');
  });

  it('includes minutes for near-expiry', () => {
    const note = credentialStatusNote({ status: 'near-expiry', minutesLeft: 15 });
    expect(note).toContain('expires in ~15 minutes');
    expect(note).toContain('/login');
  });

  it('uses singular for 1 minute', () => {
    const note = credentialStatusNote({ status: 'near-expiry', minutesLeft: 1 });
    expect(note).toContain('~1 minute');
    expect(note).not.toContain('minutes');
  });

  it('mentions auto-refresh for expired-refreshable', () => {
    const note = credentialStatusNote({ status: 'expired-refreshable' });
    expect(note).toContain('auto-refresh');
  });

  it('mentions /login for expired-no-refresh', () => {
    const note = credentialStatusNote({ status: 'expired-no-refresh' });
    expect(note).toContain('/login');
    expect(note).toContain('expired');
  });
});
