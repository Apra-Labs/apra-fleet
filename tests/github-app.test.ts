import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { createAppJWT, loadPrivateKey, mapAccessLevel } from '../src/services/github-app.js';
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
    expect(mapAccessLevel('push')).toEqual({ contents: 'write', metadata: 'read' });
    expect(mapAccessLevel('admin')).toEqual({ contents: 'write', administration: 'write', actions: 'write', metadata: 'read' });
    expect(mapAccessLevel('issues')).toEqual({ issues: 'write', pull_requests: 'write', metadata: 'read' });
    expect(mapAccessLevel('full')).toEqual({
      contents: 'write', administration: 'write', issues: 'write',
      pull_requests: 'write', actions: 'write', metadata: 'read',
    });
  });

  it('falls back to read for unknown levels', () => {
    expect(mapAccessLevel('bogus')).toEqual({ contents: 'read', metadata: 'read' });
  });
});
