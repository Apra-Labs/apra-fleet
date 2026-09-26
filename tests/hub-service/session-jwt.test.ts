import { describe, it, expect, vi } from 'vitest';
import { signSession, verifySession } from '../../src/hub-service/session-jwt.js';

const SECRET = 'test-hub-secret';

describe('session-jwt (apra-fleet-us9.16)', () => {
  it('sign/verify roundtrip returns sub and jti', () => {
    const { token, jti } = signSession('user-1', SECRET);
    expect(verifySession(token, SECRET)).toEqual({ sub: 'user-1', jti });
  });

  it('mints a different jti on every call', () => {
    const a = signSession('user-1', SECRET);
    const b = signSession('user-1', SECRET);
    expect(a.jti).not.toBe(b.jti);
  });

  it('rejects a token signed with a different secret', () => {
    const { token } = signSession('user-1', SECRET);
    expect(verifySession(token, 'wrong-secret')).toBeNull();
  });

  it('rejects a malformed token', () => {
    expect(verifySession('not-a-jwt', SECRET)).toBeNull();
    expect(verifySession('', SECRET)).toBeNull();
  });

  it('rejects an expired token', () => {
    vi.useFakeTimers();
    try {
      const { token } = signSession('user-1', SECRET);
      vi.advanceTimersByTime((7 * 24 * 60 * 60 + 1) * 1000);
      expect(verifySession(token, SECRET)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws a clear error if HUB_JWT_SECRET is unset and no explicit secret is passed', () => {
    const original = process.env.HUB_JWT_SECRET;
    delete process.env.HUB_JWT_SECRET;
    try {
      expect(() => signSession('user-1')).toThrow(/HUB_JWT_SECRET/);
    } finally {
      if (original !== undefined) process.env.HUB_JWT_SECRET = original;
    }
  });
});
