import { describe, it, expect, vi } from 'vitest';
import { sign, verify, type HubJwtClaims } from '../../src/hub-service/hub-jwt.js';

const CLAIMS: HubJwtClaims = { member_id: 'm-1', workspace_id: 'ws-1', role: 'doer' };
const SECRET = 'test-secret-do-not-use-in-prod';

describe('hub-jwt (apra-fleet-us9.4)', () => {
  it('sign/verify roundtrip returns the original claims', () => {
    const token = sign(CLAIMS, SECRET);
    expect(verify(token, SECRET)).toEqual(CLAIMS);
  });

  it('rejects a token signed with a different secret', () => {
    const token = sign(CLAIMS, SECRET);
    expect(verify(token, 'a-completely-different-secret')).toBeNull();
  });

  it('rejects a tampered payload (signature no longer matches)', () => {
    const token = sign(CLAIMS, SECRET);
    const [header, , sig] = token.split('.');
    const forgedBody = Buffer.from(JSON.stringify({ ...CLAIMS, role: 'admin' })).toString('base64url');
    expect(verify(`${header}.${forgedBody}.${sig}`, SECRET)).toBeNull();
  });

  it('rejects a malformed token', () => {
    expect(verify('not-a-jwt', SECRET)).toBeNull();
    expect(verify('', SECRET)).toBeNull();
  });

  it('rejects an expired token', () => {
    vi.useFakeTimers();
    try {
      const token = sign(CLAIMS, SECRET);
      vi.advanceTimersByTime((7 * 24 * 60 * 60 + 1) * 1000);
      expect(verify(token, SECRET)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws a clear error if HUB_JWT_SECRET is unset and no explicit secret is passed', () => {
    const original = process.env.HUB_JWT_SECRET;
    delete process.env.HUB_JWT_SECRET;
    try {
      expect(() => sign(CLAIMS)).toThrow(/HUB_JWT_SECRET/);
    } finally {
      if (original !== undefined) process.env.HUB_JWT_SECRET = original;
    }
  });
});
