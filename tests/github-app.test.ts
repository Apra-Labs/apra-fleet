import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { createAppJWT, loadPrivateKey, mapAccessLevel, mintGitToken } from '../src/services/github-app.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Generate a test RSA key pair for JWT tests
const { privateKey: testPrivateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

describe('loadPrivateKey', () => {
  it('throws when file does not exist', () => {
    expect(() => loadPrivateKey('/nonexistent/path.pem')).toThrow('not found');
  });

  it('throws when file content is not a PEM key', () => {
    const tmpFile = path.join(os.tmpdir(), `fleet-test-badkey-${Date.now()}.pem`);
    fs.writeFileSync(tmpFile, 'not a private key');
    try {
      expect(() => loadPrivateKey(tmpFile)).toThrow('does not start with -----BEGIN');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('reads a valid PEM file', () => {
    const tmpFile = path.join(os.tmpdir(), `fleet-test-goodkey-${Date.now()}.pem`);
    fs.writeFileSync(tmpFile, testPrivateKey);
    try {
      const key = loadPrivateKey(tmpFile);
      expect(key).toContain('-----BEGIN');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});

describe('createAppJWT', () => {
  it('creates a valid 3-part JWT', () => {
    const jwt = createAppJWT('12345', testPrivateKey);
    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);

    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });

    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    expect(payload.iss).toBe('12345');
    expect(payload.exp - payload.iat).toBe(660); // 10min + 60s backdate
  });

  it('produces a verifiable RS256 signature', () => {
    const { publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    // Use the matching private key from this pair
    const { privateKey: pk } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    // Just verify the JWT structure is parseable and the signature is base64url
    const jwt = createAppJWT('999', testPrivateKey);
    const [h, p, sig] = jwt.split('.');
    expect(sig.length).toBeGreaterThan(10);
    // Verify signature using crypto.verify
    const isValid = crypto.verify(
      'sha256',
      Buffer.from(`${h}.${p}`),
      testPrivateKey, // For self-verification, use the key that signed it
      Buffer.from(sig, 'base64url'),
    );
    expect(isValid).toBe(true);
  });
});

describe('mapAccessLevel', () => {
  it('maps all access levels correctly', () => {
    expect(mapAccessLevel('read')).toEqual({ contents: 'read', metadata: 'read' });
    expect(mapAccessLevel('push')).toEqual({ contents: 'write', metadata: 'read', workflows: 'write' });
    expect(mapAccessLevel('push+pr')).toEqual({ contents: 'write', pull_requests: 'write', metadata: 'read', workflows: 'write' });
    expect(mapAccessLevel('admin')).toEqual({ contents: 'write', administration: 'write', actions: 'write', metadata: 'read', workflows: 'write' });
    expect(mapAccessLevel('issues')).toEqual({ issues: 'write', pull_requests: 'write', discussions: 'write', metadata: 'read' });
    expect(mapAccessLevel('full')).toEqual({
      contents: 'write', administration: 'write', issues: 'write',
      pull_requests: 'write', actions: 'write', discussions: 'write', metadata: 'read', workflows: 'write',
    });
  });

  it('falls back to read for unknown levels', () => {
    expect(mapAccessLevel('bogus')).toEqual({ contents: 'read', metadata: 'read' });
  });

  it.each(['push', 'push+pr', 'admin', 'full'])(
    "grants workflows:'write' (plus its existing keys) for level '%s'",
    (level) => {
      const perms = mapAccessLevel(level);
      expect(perms.workflows).toBe('write');
      // The workflows grant must be additive, not a replacement -- every
      // pre-existing key for this level must still be present.
      const withoutWorkflows: Record<string, string> = { ...perms };
      delete withoutWorkflows.workflows;
      expect(Object.keys(withoutWorkflows).length).toBeGreaterThan(0);
    },
  );

  it.each(['read', 'issues'])("does not grant workflows for level '%s'", (level) => {
    expect(mapAccessLevel(level)).not.toHaveProperty('workflows');
  });
});

describe('mintGitToken', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns { token, expiresAt } on a 201 and sends the full permission map in the request body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ token: 'ghs_abc123', expires_at: '2026-09-22T12:00:00Z' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const permissions = mapAccessLevel('push');
    const result = await mintGitToken('12345', testPrivateKey, 999, ['owner/repo'], permissions);

    expect(result).toEqual({ token: 'ghs_abc123', expiresAt: '2026-09-22T12:00:00Z' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('/app/installations/999/access_tokens');
    const body = JSON.parse((opts as { body: string }).body);
    expect(body.permissions).toEqual(permissions);
  });

  it('raises an operator-referral error on a 422 ungranted-permission response and does not retry with reduced permissions', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ message: "The permission 'workflows' is not granted to this installation." }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const permissions = mapAccessLevel('push');

    let caught: unknown;
    try {
      await mintGitToken('12345', testPrivateKey, 999, ['owner/repo'], permissions);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/workflows/);
    expect((caught as Error).message).toMatch(/App's settings|Permissions & events/);

    // Exactly one fetch call -- no second, reduced-permission retry after the 422.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
