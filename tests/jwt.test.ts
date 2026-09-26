import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { JwtClaims } from '../src/services/jwt.js';

const CLAIMS: JwtClaims = {
  member_id: 'member-1',
  workspace_id: 'ws-1',
  role: 'doer',
  work_folder: '/tmp/w',
};

// jwt.ts computes its key file path (KEY_PATH = homedir + '.apra-fleet/fleet.key')
// ONCE at module load time, so a plain vi.spyOn(os, 'homedir') after import has no
// effect -- it would silently read/write the REAL current user's key file. Instead,
// mock node:os for dynamic re-imports and vi.resetModules() before each test so
// jwt.ts's KEY_PATH is freshly recomputed against a fresh temp home every time.
let tmpHome: string;
let jwtMod: typeof import('../src/services/jwt.js');

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-jwt-test-'));
  vi.resetModules();
  vi.doMock('node:os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:os')>();
    return { ...actual, default: { ...actual, homedir: () => tmpHome }, homedir: () => tmpHome };
  });
  jwtMod = await import('../src/services/jwt.js');
});

afterEach(() => {
  vi.doUnmock('node:os');
  vi.resetModules();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('jwt', () => {
  describe('getOrCreateKey', () => {
    it('creates a 64-char hex key on first call', () => {
      const key = jwtMod.getOrCreateKey();
      expect(key).toMatch(/^[0-9a-f]{64}$/);
    });

    it('returns the SAME key on subsequent calls (persisted, not regenerated)', () => {
      const first = jwtMod.getOrCreateKey();
      const second = jwtMod.getOrCreateKey();
      expect(second).toBe(first);
    });

    it('persists the key to ~/.apra-fleet/fleet.key with mode 0600', () => {
      const key = jwtMod.getOrCreateKey();
      const keyPath = path.join(tmpHome, '.apra-fleet', 'fleet.key');
      expect(fs.readFileSync(keyPath, 'utf8').trim()).toBe(key);
      if (process.platform !== 'win32') {
        const mode = fs.statSync(keyPath).mode & 0o777;
        expect(mode).toBe(0o600);
      }
    });

    it('regenerates the key if the existing file content is not 64 chars (corrupt/truncated)', () => {
      const dir = path.join(tmpHome, '.apra-fleet');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'fleet.key'), 'not-a-real-key');
      const key = jwtMod.getOrCreateKey();
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      expect(key).not.toBe('not-a-real-key');
    });
  });

  describe('sign / verify roundtrip', () => {
    it('verify() returns the original claims for a freshly signed token', () => {
      const token = jwtMod.sign(CLAIMS);
      const claims = jwtMod.verify(token);
      expect(claims).toEqual(CLAIMS);
    });

    it('produces a token with exactly 3 dot-separated segments', () => {
      const token = jwtMod.sign(CLAIMS);
      expect(token.split('.')).toHaveLength(3);
    });

    it('preserves optional project_id when present', () => {
      const withProject: JwtClaims = { ...CLAIMS, project_id: 'proj-1' };
      const token = jwtMod.sign(withProject);
      expect(jwtMod.verify(token)).toEqual(withProject);
    });

    it('omits project_id from the returned claims when not present in the signed payload', () => {
      const token = jwtMod.sign(CLAIMS);
      const claims = jwtMod.verify(token);
      expect(claims).not.toHaveProperty('project_id');
    });
  });

  describe('verify() rejection paths', () => {
    it('rejects a token with a tampered signature', () => {
      const token = jwtMod.sign(CLAIMS);
      const [header, body] = token.split('.');
      const tampered = `${header}.${body}.` + 'a'.repeat(43);
      expect(jwtMod.verify(tampered)).toBeNull();
    });

    it('rejects a token whose payload was tampered with (signature no longer matches)', () => {
      const token = jwtMod.sign(CLAIMS);
      const [header, , sig] = token.split('.');
      const forgedBody = Buffer.from(JSON.stringify({ ...CLAIMS, role: 'admin' })).toString('base64url');
      expect(jwtMod.verify(`${header}.${forgedBody}.${sig}`)).toBeNull();
    });

    it('rejects a malformed token (wrong number of segments)', () => {
      expect(jwtMod.verify('not-a-jwt')).toBeNull();
      expect(jwtMod.verify('only.two')).toBeNull();
      expect(jwtMod.verify('a.b.c.d')).toBeNull();
    });

    it('rejects an empty string', () => {
      expect(jwtMod.verify('')).toBeNull();
    });

    it('rejects a token signed with a DIFFERENT key (e.g. after key rotation)', () => {
      const token = jwtMod.sign(CLAIMS);
      // Rotate the key out from under the token.
      const keyPath = path.join(tmpHome, '.apra-fleet', 'fleet.key');
      fs.writeFileSync(keyPath, 'f'.repeat(64));
      expect(jwtMod.verify(token)).toBeNull();
    });

    it('rejects an expired token', () => {
      vi.useFakeTimers();
      try {
        const token = jwtMod.sign(CLAIMS);
        vi.advanceTimersByTime((7 * 24 * 60 * 60 + 1) * 1000); // past the 7-day expiry
        expect(jwtMod.verify(token)).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('rejects a token missing a required claim (e.g. workspace_id)', () => {
      const key = jwtMod.getOrCreateKey();
      const b64url = (s: string) => Buffer.from(s).toString('base64url');
      const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
      const now = Math.floor(Date.now() / 1000);
      const body = b64url(JSON.stringify({ member_id: 'm', role: 'doer', work_folder: '/w', iat: now, exp: now + 3600 }));
      const sig = Buffer.from(crypto.createHmac('sha256', key).update(header + '.' + body).digest()).toString('base64url');
      expect(jwtMod.verify(`${header}.${body}.${sig}`)).toBeNull();
    });
  });
});
