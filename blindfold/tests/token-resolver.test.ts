import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initBlindfold, resetConfig } from '../src/config.js';
import { credentialSet, _clearSessionStore } from '../src/credential-store.js';
import {
  resolveSecureTokens,
  resolveSecureField,
  redactOutput,
  containsSecureTokens,
} from '../src/token-resolver.js';

describe('token-resolver', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blindfold-resolver-'));
    resetConfig();
    initBlindfold({ dataDir: testDir });
    _clearSessionStore();
  });

  afterEach(() => {
    _clearSessionStore();
    resetConfig();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('containsSecureTokens', () => {
    it('detects {{secure.NAME}} tokens', () => {
      expect(containsSecureTokens('echo {{secure.MY_KEY}}')).toBe(true);
    });

    it('returns false for plain text', () => {
      expect(containsSecureTokens('echo hello')).toBe(false);
    });

    it('returns false for partial matches', () => {
      expect(containsSecureTokens('echo {{secure.}}')).toBe(false);
    });
  });

  describe('resolveSecureField', () => {
    it('resolves a single token', () => {
      credentialSet('DB_PASS', 'hunter2', false, 'allow');
      const result = resolveSecureField('{{secure.DB_PASS}}');
      expect(result).toEqual({ resolved: 'hunter2' });
    });

    it('resolves multiple tokens', () => {
      credentialSet('USER', 'admin', false, 'allow');
      credentialSet('PASS', 'secret', false, 'allow');
      const result = resolveSecureField('{{secure.USER}}:{{secure.PASS}}');
      expect(result).toEqual({ resolved: 'admin:secret' });
    });

    it('returns error for missing credential', () => {
      const result = resolveSecureField('{{secure.MISSING}}');
      expect(result).toHaveProperty('error');
      expect((result as any).error).toContain('MISSING');
    });

    it('returns error for denied credential', () => {
      credentialSet('SCOPED', 'val', false, 'allow', ['member-a']);
      const result = resolveSecureField('{{secure.SCOPED}}', 'member-b');
      expect(result).toHaveProperty('error');
    });

    it('returns text unchanged when no tokens present', () => {
      const result = resolveSecureField('plain text');
      expect(result).toEqual({ resolved: 'plain text' });
    });
  });

  describe('resolveSecureTokens', () => {
    it('resolves tokens with shell escaping (Unix)', () => {
      credentialSet('KEY', "it's a secret", false, 'allow');
      const result = resolveSecureTokens('echo {{secure.KEY}}', { os: 'linux' });
      expect('resolved' in result).toBe(true);
      if ('resolved' in result) {
        expect(result.resolved).toBe("echo 'it'\\''s a secret'");
        expect(result.credentials).toHaveLength(1);
        expect(result.credentials[0].name).toBe('KEY');
      }
    });

    it('resolves tokens with PowerShell escaping (Windows)', () => {
      credentialSet('KEY', "it's", false, 'allow');
      const result = resolveSecureTokens('echo {{secure.KEY}}', { os: 'windows' });
      expect('resolved' in result).toBe(true);
      if ('resolved' in result) {
        expect(result.resolved).toBe("echo 'it''s'");
      }
    });

    it('skips shell escaping when shellEscape is false', () => {
      credentialSet('KEY', 'raw-value', false, 'allow');
      const result = resolveSecureTokens('{{secure.KEY}}', { shellEscape: false });
      expect('resolved' in result).toBe(true);
      if ('resolved' in result) {
        expect(result.resolved).toBe('raw-value');
      }
    });

    it('rejects sec:// handles', () => {
      const result = resolveSecureTokens('echo sec://MY_KEY');
      expect(result).toHaveProperty('error');
      expect((result as any).error).toContain('sec://');
    });

    it('returns error for missing credential', () => {
      const result = resolveSecureTokens('echo {{secure.NOPE}}');
      expect(result).toHaveProperty('error');
    });

    it('returns empty credentials for text without tokens', () => {
      const result = resolveSecureTokens('echo hello');
      expect('resolved' in result).toBe(true);
      if ('resolved' in result) {
        expect(result.resolved).toBe('echo hello');
        expect(result.credentials).toHaveLength(0);
      }
    });

    it('respects member scoping', () => {
      credentialSet('SCOPED', 'val', false, 'allow', ['member-a']);
      const result = resolveSecureTokens('echo {{secure.SCOPED}}', { caller: 'member-b' });
      expect(result).toHaveProperty('error');
    });

    it('resolves with network_policy metadata', () => {
      credentialSet('NET', 'val', false, 'deny');
      const result = resolveSecureTokens('curl {{secure.NET}}');
      expect('resolved' in result).toBe(true);
      if ('resolved' in result) {
        expect(result.credentials[0].network_policy).toBe('deny');
      }
    });
  });

  describe('redactOutput', () => {
    it('replaces plaintext with [REDACTED:NAME]', () => {
      const output = 'Connected with password hunter2 to server';
      const result = redactOutput(output, [{ name: 'PASS', plaintext: 'hunter2' }]);
      expect(result).toBe('Connected with password [REDACTED:PASS] to server');
    });

    it('redacts multiple credentials', () => {
      const output = 'user=admin pass=secret';
      const result = redactOutput(output, [
        { name: 'USER', plaintext: 'admin' },
        { name: 'PASS', plaintext: 'secret' },
      ]);
      expect(result).toBe('user=[REDACTED:USER] pass=[REDACTED:PASS]');
    });

    it('handles empty plaintext gracefully', () => {
      const output = 'some output';
      const result = redactOutput(output, [{ name: 'EMPTY', plaintext: '' }]);
      expect(result).toBe('some output');
    });

    it('returns output unchanged when no credentials', () => {
      const result = redactOutput('hello world', []);
      expect(result).toBe('hello world');
    });
  });
});
