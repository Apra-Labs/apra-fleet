/**
 * apra-fleet spoke's default file-transfer write sandbox (apra-fleet-us9.12
 * follow-up from the independent adversarial review): destPath in a
 * file_transfer.chunk envelope's payload is SENDER-controlled -- this is
 * the untrusted-input boundary, so a malicious/buggy sender must not be
 * able to write outside RECEIVED_FILES_DIR via `../` traversal or an
 * absolute path.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { sandboxedWriteFile, RECEIVED_FILES_DIR } from '../src/cli/spoke.js';

describe('sandboxedWriteFile', () => {
  afterEach(() => {
    fs.rmSync(RECEIVED_FILES_DIR, { recursive: true, force: true });
  });

  it('writes a normal relative path inside the sandbox', () => {
    sandboxedWriteFile('a.txt', Buffer.from('hello'));
    const written = fs.readFileSync(path.join(RECEIVED_FILES_DIR, 'a.txt'));
    expect(written.toString()).toBe('hello');
  });

  it('writes a relative path with subdirectories inside the sandbox', () => {
    sandboxedWriteFile('sub/dir/b.txt', Buffer.from('nested'));
    const written = fs.readFileSync(path.join(RECEIVED_FILES_DIR, 'sub', 'dir', 'b.txt'));
    expect(written.toString()).toBe('nested');
  });

  it('rejects a path-traversal destPath that would escape the sandbox', () => {
    expect(() => sandboxedWriteFile('../../etc/passwd', Buffer.from('pwned'))).toThrow(/outside the received-files sandbox/);
  });

  it('rejects a deeply nested traversal attempt', () => {
    expect(() => sandboxedWriteFile('a/b/../../../../outside.txt', Buffer.from('pwned'))).toThrow(/outside the received-files sandbox/);
  });

  it('rejects an absolute path destPath', () => {
    const outsideAbs = path.join(os.tmpdir(), 'should-not-exist.txt');
    expect(() => sandboxedWriteFile(outsideAbs, Buffer.from('pwned'))).toThrow(/outside the received-files sandbox/);
    expect(fs.existsSync(outsideAbs)).toBe(false);
  });

  it('apra-fleet-36x: rejects a destPath whose containing directory is a pre-planted symlink pointing outside the sandbox', () => {
    fs.mkdirSync(RECEIVED_FILES_DIR, { recursive: true });
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-symlink-target-'));
    const linkPath = path.join(RECEIVED_FILES_DIR, 'escape-link');
    try {
      fs.symlinkSync(outsideDir, linkPath, 'dir');
    } catch (err) {
      // Creating a symlink can require elevated privileges on some Windows
      // configurations (no Developer Mode). Skip rather than fail the
      // suite on an environment where the attack vector itself can't even
      // be set up -- the guard is still exercised on any environment that
      // CAN create one (Linux/macOS CI, or Windows with Developer Mode).
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
      throw err;
    }

    expect(() => sandboxedWriteFile('escape-link/pwned.txt', Buffer.from('pwned'))).toThrow(/symlink escape detected/);
    expect(fs.existsSync(path.join(outsideDir, 'pwned.txt'))).toBe(false);
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('apra-fleet-36x: rejects writing to a destPath that is itself a pre-planted symlink pointing outside the sandbox', () => {
    fs.mkdirSync(RECEIVED_FILES_DIR, { recursive: true });
    const outsideFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-symlink-file-'), ), 'target.txt');
    fs.writeFileSync(outsideFile, 'original');
    const linkPath = path.join(RECEIVED_FILES_DIR, 'file-link.txt');
    try {
      fs.symlinkSync(outsideFile, linkPath, 'file');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
      throw err;
    }

    expect(() => sandboxedWriteFile('file-link.txt', Buffer.from('pwned'))).toThrow(/symlink escape detected/);
    expect(fs.readFileSync(outsideFile, 'utf-8')).toBe('original');
    fs.rmSync(path.dirname(outsideFile), { recursive: true, force: true });
  });
});
