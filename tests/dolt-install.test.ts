import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  resolveDoltAsset,
  downloadAndExtractDolt,
  verifyDolt,
  UnsupportedDoltPlatformError,
  type DoltInstallDeps,
  type DoltVerifyDeps,
} from '../src/cli/dolt-install.js';

/** Builds a minimal single-entry, STORE-method (uncompressed) .zip fixture. */
function buildZipFixture(entryName: string, content: Buffer): Buffer {
  const nameBuf = Buffer.from(entryName, 'utf-8');
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0); // local file header signature
  localHeader.writeUInt16LE(20, 4); // version needed
  localHeader.writeUInt16LE(0, 6); // flags
  localHeader.writeUInt16LE(0, 8); // compression method: store
  localHeader.writeUInt16LE(0, 10); // mod time
  localHeader.writeUInt16LE(0, 12); // mod date
  localHeader.writeUInt32LE(0, 14); // crc32 (unchecked by our extractor)
  localHeader.writeUInt32LE(content.length, 18); // compressed size
  localHeader.writeUInt32LE(content.length, 22); // uncompressed size
  localHeader.writeUInt16LE(nameBuf.length, 26); // file name length
  localHeader.writeUInt16LE(0, 28); // extra field length

  const localEntry = Buffer.concat([localHeader, nameBuf, content]);
  const localHeaderOffset = 0;

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0); // central directory signature
  centralHeader.writeUInt16LE(20, 4); // version made by
  centralHeader.writeUInt16LE(20, 6); // version needed
  centralHeader.writeUInt16LE(0, 8); // flags
  centralHeader.writeUInt16LE(0, 10); // compression method: store
  centralHeader.writeUInt16LE(0, 12); // mod time
  centralHeader.writeUInt16LE(0, 14); // mod date
  centralHeader.writeUInt32LE(0, 16); // crc32
  centralHeader.writeUInt32LE(content.length, 20); // compressed size
  centralHeader.writeUInt32LE(content.length, 24); // uncompressed size
  centralHeader.writeUInt16LE(nameBuf.length, 28); // file name length
  centralHeader.writeUInt16LE(0, 30); // extra field length
  centralHeader.writeUInt16LE(0, 32); // comment length
  centralHeader.writeUInt16LE(0, 34); // disk number start
  centralHeader.writeUInt16LE(0, 36); // internal attrs
  centralHeader.writeUInt32LE(0, 38); // external attrs
  centralHeader.writeUInt32LE(localHeaderOffset, 42); // local header offset

  const centralEntry = Buffer.concat([centralHeader, nameBuf]);
  const cdOffset = localEntry.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with CD
  eocd.writeUInt16LE(1, 8); // entries on this disk
  eocd.writeUInt16LE(1, 10); // total entries
  eocd.writeUInt32LE(centralEntry.length, 12); // CD size
  eocd.writeUInt32LE(cdOffset, 16); // CD offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localEntry, centralEntry, eocd]);
}

/** Builds a minimal single-entry (ustar) ` .tar.gz` fixture. */
function buildTarGzFixture(entryName: string, content: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(entryName, 0, 100, 'utf-8');
  header.write('0000755\0', 100, 8, 'utf-8'); // mode
  header.write('0000000\0', 108, 8, 'utf-8'); // uid
  header.write('0000000\0', 116, 8, 'utf-8'); // gid
  header.write(content.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf-8'); // size (octal)
  header.write('00000000000\0', 136, 12, 'utf-8'); // mtime
  header.write('        ', 148, 8, 'utf-8'); // checksum placeholder (spaces)
  header.write('0', 156, 1, 'utf-8'); // typeflag: regular file
  header.write('ustar\0', 257, 6, 'utf-8'); // magic
  header.write('00', 263, 2, 'utf-8'); // ustar version

  // Compute and fill in the tar header checksum.
  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += header[i];
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf-8');

  const paddedSize = Math.ceil(content.length / 512) * 512;
  const contentBlock = Buffer.alloc(paddedSize);
  content.copy(contentBlock);

  const endMarker = Buffer.alloc(1024); // two 512-byte zero blocks

  const tarBuf = Buffer.concat([header, contentBlock, endMarker]);
  return zlib.gzipSync(tarBuf);
}

function withPlatformArch(platform: string, arch: string, fn: () => Promise<void>): Promise<void> {
  const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const origArch = Object.getOwnPropertyDescriptor(process, 'arch')!;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'arch', { value: arch, configurable: true });
  return fn().finally(() => {
    Object.defineProperty(process, 'platform', origPlatform);
    Object.defineProperty(process, 'arch', origArch);
  });
}

function fakeDeps(fetchImpl: typeof fetch): DoltInstallDeps {
  return {
    fetch: fetchImpl,
    fs: {
      mkdir: (dir, opts) => fs.promises.mkdir(dir, opts),
      writeFile: (file, data) => fs.promises.writeFile(file, data),
      chmod: (file, mode) => fs.promises.chmod(file, mode),
    },
  };
}

describe('resolveDoltAsset (apra-fleet-ire.1)', () => {
  it('resolves the windows/x64 zip asset', () => {
    const asset = resolveDoltAsset('win32', 'x64');
    expect(asset).toEqual({
      assetName: 'dolt-windows-amd64.zip',
      url: 'https://github.com/dolthub/dolt/releases/download/v2.2.0/dolt-windows-amd64.zip',
      archiveType: 'zip',
      binaryName: 'dolt.exe',
    });
  });

  it('resolves the linux/x64 tar.gz asset', () => {
    const asset = resolveDoltAsset('linux', 'x64');
    expect(asset).toEqual({
      assetName: 'dolt-linux-amd64.tar.gz',
      url: 'https://github.com/dolthub/dolt/releases/download/v2.2.0/dolt-linux-amd64.tar.gz',
      archiveType: 'tar.gz',
      binaryName: 'dolt',
    });
  });

  it('resolves the darwin/x64 tar.gz asset', () => {
    const asset = resolveDoltAsset('darwin', 'x64');
    expect(asset.assetName).toBe('dolt-darwin-amd64.tar.gz');
    expect(asset.binaryName).toBe('dolt');
  });

  it('resolves the darwin/arm64 tar.gz asset', () => {
    const asset = resolveDoltAsset('darwin', 'arm64');
    expect(asset.assetName).toBe('dolt-darwin-arm64.tar.gz');
    expect(asset.binaryName).toBe('dolt');
  });

  it('throws UnsupportedDoltPlatformError on an unsupported combo instead of silently no-op-ing', () => {
    expect(() => resolveDoltAsset('freebsd', 'x64')).toThrow(UnsupportedDoltPlatformError);
    expect(() => resolveDoltAsset('win32', 'arm64')).toThrow(UnsupportedDoltPlatformError);
  });
});

describe('downloadAndExtractDolt (apra-fleet-ire.1)', () => {
  it('extracts an executable dolt binary from a stubbed zip fixture into destDir (win32)', async () => {
    await withPlatformArch('win32', 'x64', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dolt-install-test-'));
      const fakeBinaryContent = Buffer.from('fake dolt.exe binary bytes');
      const zipBuf = buildZipFixture('dolt-windows-amd64/dolt.exe', fakeBinaryContent);

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => zipBuf.buffer.slice(zipBuf.byteOffset, zipBuf.byteOffset + zipBuf.byteLength),
      });

      try {
        const destPath = await downloadAndExtractDolt(tmpDir, fakeDeps(fetchMock as any));

        expect(path.isAbsolute(destPath)).toBe(true);
        expect(destPath.endsWith('dolt.exe')).toBe(true);
        expect(fs.existsSync(destPath)).toBe(true);
        expect(fs.readFileSync(destPath)).toEqual(fakeBinaryContent);
        expect(fetchMock).toHaveBeenCalledWith('https://github.com/dolthub/dolt/releases/download/v2.2.0/dolt-windows-amd64.zip');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  it('extracts an executable dolt binary from a stubbed tar.gz fixture into destDir and chmods it (linux)', async () => {
    await withPlatformArch('linux', 'x64', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dolt-install-test-'));
      const fakeBinaryContent = Buffer.from('fake dolt linux binary bytes');
      const tarGzBuf = buildTarGzFixture('dolt-linux-amd64/dolt', fakeBinaryContent);

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => tarGzBuf.buffer.slice(tarGzBuf.byteOffset, tarGzBuf.byteOffset + tarGzBuf.byteLength),
      });
      const chmodSpy = vi.fn().mockResolvedValue(undefined);
      const deps = fakeDeps(fetchMock as any);
      deps.fs.chmod = chmodSpy;

      try {
        const destPath = await downloadAndExtractDolt(tmpDir, deps);

        expect(destPath.endsWith('dolt')).toBe(true);
        expect(fs.existsSync(destPath)).toBe(true);
        expect(fs.readFileSync(destPath)).toEqual(fakeBinaryContent);
        expect(chmodSpy).toHaveBeenCalledWith(destPath, 0o755);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  it('does not chmod on win32 and never touches system PATH or a system-wide location', async () => {
    await withPlatformArch('win32', 'x64', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dolt-install-test-'));
      const fakeBinaryContent = Buffer.from('fake dolt.exe binary bytes');
      const zipBuf = buildZipFixture('dolt.exe', fakeBinaryContent);

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => zipBuf.buffer.slice(zipBuf.byteOffset, zipBuf.byteOffset + zipBuf.byteLength),
      });
      const chmodSpy = vi.fn().mockResolvedValue(undefined);
      const deps = fakeDeps(fetchMock as any);
      deps.fs.chmod = chmodSpy;

      try {
        const destPath = await downloadAndExtractDolt(tmpDir, deps);
        expect(destPath.startsWith(tmpDir)).toBe(true);
        expect(chmodSpy).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  it('propagates a download failure as a clear error', async () => {
    await withPlatformArch('linux', 'x64', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dolt-install-test-'));
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });

      try {
        await expect(downloadAndExtractDolt(tmpDir, fakeDeps(fetchMock as any))).rejects.toThrow(/HTTP 404/);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});

/** Minimal EventEmitter-like stand-in for a ChildProcess, enough for verifyDolt's use. */
function fakeChild(pid = 4242) {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const child = {
    pid,
    killed: false,
    once: (event: string, cb: (...args: unknown[]) => void) => {
      (listeners[event] ||= []).push(cb);
      return child;
    },
    emit: (event: string, ...args: unknown[]) => {
      (listeners[event] || []).forEach((cb) => cb(...args));
    },
  };
  return child;
}

function fakeVerifyDeps(overrides: Partial<DoltVerifyDeps> = {}): DoltVerifyDeps {
  return {
    execFileSync: vi.fn().mockReturnValue('dolt version 2.2.0\n') as any,
    spawn: vi.fn().mockReturnValue(fakeChild()) as any,
    fs: {
      mkdtempSync: vi.fn().mockReturnValue('/tmp/dolt-verify-fake'),
      rmSync: vi.fn(),
    },
    net: {
      isPortFree: vi.fn().mockResolvedValue(true),
      getEphemeralPort: vi.fn().mockResolvedValue(54321),
      waitForConnect: vi.fn().mockResolvedValue(true),
    },
    killChild: vi.fn(),
    ...overrides,
  };
}

describe('verifyDolt (apra-fleet-ire.2)', () => {
  it('returns { version, serverOk: true } when the server accepts a connection', async () => {
    const deps = fakeVerifyDeps();

    const result = await verifyDolt('/fake/path/dolt', {}, deps);

    expect(result).toEqual({ version: '2.2.0', serverOk: true });
    expect(deps.execFileSync).toHaveBeenCalledWith('/fake/path/dolt', ['version'], expect.objectContaining({
      stdio: 'pipe',
      encoding: 'utf-8',
    }));
  });

  it('parses the version string out of noisier `dolt version` output', async () => {
    const deps = fakeVerifyDeps({
      execFileSync: vi.fn().mockReturnValue('dolt version 2.2.0\ngo1.22\n') as any,
    });

    const result = await verifyDolt('/fake/path/dolt', {}, deps);

    expect(result.version).toBe('2.2.0');
  });

  it('propagates a `dolt version` failure (broken/missing binary should fail the install)', async () => {
    const deps = fakeVerifyDeps({
      execFileSync: vi.fn().mockImplementation(() => {
        throw new Error('spawn dolt ENOENT');
      }) as any,
    });

    await expect(verifyDolt('/fake/path/dolt', {}, deps)).rejects.toThrow(/ENOENT/);
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it('falls back to an ephemeral port when the requested port is busy, without hanging', async () => {
    const deps = fakeVerifyDeps({
      net: {
        isPortFree: vi.fn().mockResolvedValue(false),
        getEphemeralPort: vi.fn().mockResolvedValue(54321),
        waitForConnect: vi.fn().mockResolvedValue(true),
      },
    });

    const result = await verifyDolt('/fake/path/dolt', { port: 3306 }, deps);

    expect(result.serverOk).toBe(true);
    expect(deps.net.getEphemeralPort).toHaveBeenCalled();
    expect(deps.spawn).toHaveBeenCalledWith(
      '/fake/path/dolt',
      expect.arrayContaining(['sql-server', '--port', '54321']),
      expect.anything(),
    );
  });

  it('returns serverOk:false with a reason (does not throw or hang) when the server never accepts a connection', async () => {
    const deps = fakeVerifyDeps({
      net: {
        isPortFree: vi.fn().mockResolvedValue(true),
        getEphemeralPort: vi.fn().mockResolvedValue(54321),
        waitForConnect: vi.fn().mockResolvedValue(false),
      },
    });

    const result = await verifyDolt('/fake/path/dolt', {}, deps);

    expect(result.serverOk).toBe(false);
    expect(result.reason).toMatch(/did not accept connections/);
    expect(result.version).toBe('2.2.0');
  });

  it('reports a spawn error via serverOk:false rather than throwing', async () => {
    const child = fakeChild();
    const deps = fakeVerifyDeps({
      spawn: vi.fn().mockReturnValue(child) as any,
      net: {
        isPortFree: vi.fn().mockResolvedValue(true),
        getEphemeralPort: vi.fn().mockResolvedValue(54321),
        waitForConnect: vi.fn().mockImplementation(async () => {
          child.emit('error', new Error('spawn EACCES'));
          return false;
        }),
      },
    });

    const result = await verifyDolt('/fake/path/dolt', {}, deps);

    expect(result.serverOk).toBe(false);
    expect(result.reason).toMatch(/EACCES/);
  });

  it('always terminates the child and removes the scratch dir, even on failure (try/finally)', async () => {
    const deps = fakeVerifyDeps({
      net: {
        isPortFree: vi.fn().mockResolvedValue(true),
        getEphemeralPort: vi.fn().mockResolvedValue(54321),
        waitForConnect: vi.fn().mockResolvedValue(false),
      },
    });

    await verifyDolt('/fake/path/dolt', {}, deps);

    expect(deps.killChild).toHaveBeenCalledTimes(1);
    expect(deps.fs.rmSync).toHaveBeenCalledWith('/tmp/dolt-verify-fake', { recursive: true, force: true });
  });

  it('always cleans up even when an unexpected error is thrown mid-verification', async () => {
    const deps = fakeVerifyDeps({
      net: {
        isPortFree: vi.fn().mockRejectedValue(new Error('boom')),
        getEphemeralPort: vi.fn(),
        waitForConnect: vi.fn(),
      },
    });

    const result = await verifyDolt('/fake/path/dolt', {}, deps);

    expect(result.serverOk).toBe(false);
    expect(result.reason).toMatch(/boom/);
    expect(deps.fs.rmSync).toHaveBeenCalledWith('/tmp/dolt-verify-fake', { recursive: true, force: true });
  });
});
