import { describe, it, expect } from 'vitest';
// @ts-expect-error plain .mjs script without types
import { checkSsh2Native } from '../scripts/check-ssh2-native.mjs';

const resolve = () => '/fake/node_modules/ssh2/package.json';

describe('check-ssh2-native', () => {
  it('succeeds and reports the binding path when it loads', () => {
    const r = checkSsh2Native({ resolve, load: () => ({ AESGCMCipher: class {} }) });
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.bindingPath).toContain('sshcrypto.node');
    expect(r.message).toContain(r.bindingPath);
  });

  it('fails loudly naming sshcrypto.node and the remedy when load throws', () => {
    const r = checkSsh2Native({ resolve, load: () => { throw new Error('Cannot find module'); } });
    expect(r.ok).toBe(false);
    expect(r.exitCode).not.toBe(0);
    expect(r.message).toContain('sshcrypto.node');
    expect(r.message).toMatch(/rebuild with build tools present/);
  });

  it('fails when the module loads but exports no native ciphers (empty stub)', () => {
    const r = checkSsh2Native({ resolve, load: () => ({}) });
    expect(r.exitCode).not.toBe(0);
    expect(r.message).toContain('sshcrypto.node');
  });

  it('fails when ssh2 itself cannot be resolved', () => {
    const r = checkSsh2Native({ resolve: () => { throw new Error('nope'); }, load: () => ({}) });
    expect(r.exitCode).not.toBe(0);
    expect(r.message).toContain('sshcrypto.node');
  });
});
