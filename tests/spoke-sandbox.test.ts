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
});
