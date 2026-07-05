import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import { sign, verify } from '../../src/hub-service/hub-jwt.js';

const PAYLOAD = { member_id: 'm-1', workspace_id: 'ws-1', role: 'doer' };
const SECRET = 'test-secret-do-not-use-in-prod';

describe('hub-jwt (apra-fleet-us9.4/us9.5)', () => {
  it('sign/verify roundtrip returns the original claims plus a minted jti', () => {
    const { token, jti } = sign(PAYLOAD, SECRET);
    const claims = verify(token, SECRET);
    expect(claims).toEqual({ ...PAYLOAD, jti });
  });

  it('mints a different jti on every call, even for identical payloads', () => {
    const first = sign(PAYLOAD, SECRET);
    const second = sign(PAYLOAD, SECRET);
    expect(first.jti).not.toBe(second.jti);
    expect(first.token).not.toBe(second.token);
  });

  it('rejects a token signed with a different secret', () => {
    const { token } = sign(PAYLOAD, SECRET);
    expect(verify(token, 'a-completely-different-secret')).toBeNull();
  });

  it('rejects a tampered payload (signature no longer matches)', () => {
    const { token, jti } = sign(PAYLOAD, SECRET);
    const [header, , sig] = token.split('.');
    const forgedBody = Buffer.from(JSON.stringify({ ...PAYLOAD, jti, role: 'admin' })).toString('base64url');
    expect(verify(`${header}.${forgedBody}.${sig}`, SECRET)).toBeNull();
  });

  it('rejects a malformed token', () => {
    expect(verify('not-a-jwt', SECRET)).toBeNull();
    expect(verify('', SECRET)).toBeNull();
  });

  it('rejects a token missing jti (e.g. from a pre-us9.5 signer)', () => {
    const b64url = (s: string) => Buffer.from(s).toString('base64url');
    const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const now = Math.floor(Date.now() / 1000);
    const body = b64url(JSON.stringify({ ...PAYLOAD, iat: now, exp: now + 3600 })); // no jti
    const sig = b64url(crypto.createHmac('sha256', SECRET).update(header + '.' + body).digest());
    expect(verify(`${header}.${body}.${sig}`, SECRET)).toBeNull();
  });

  it('rejects an expired token', () => {
    vi.useFakeTimers();
    try {
      const { token } = sign(PAYLOAD, SECRET);
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
      expect(() => sign(PAYLOAD)).toThrow(/HUB_JWT_SECRET/);
    } finally {
      if (original !== undefined) process.env.HUB_JWT_SECRET = original;
    }
  });
});
