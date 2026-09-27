import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import {
  resolveBeadsAsset,
  downloadAndExtractBeads,
  verifyBeads,
  parseChecksumsForAsset,
  UnsupportedBeadsPlatformError,
  BeadsChecksumMismatchError,
  BeadsChecksumUnavailableError,
  BeadsVersionProbeError,
  BEADS_VERSION,
  BEADS_CHECKSUMS_URL,
  type BeadsInstallDeps,
  type BeadsVerifyDeps,
} from '../src/cli/beads-install.js';

// apra-fleet-i9ag.13.3 -- unit coverage for the portable beads (bd) release
// installer primitives added in apra-fleet-i9ag.13.1. Every assertion here uses
// an injected fetch and a SYNTHETIC archive: the real assets are ~53MB each and
// an automated suite must never download one. The one thing synthetic fixtures
// structurally cannot catch -- a wrong real URL / asset name / inner archive
// layout -- is covered by the one-time MANUAL real-install check recorded in the
// task close-out, deliberately not automated here.
//
// Wiring coverage for install.ts's beads step lives in install-beads.test.ts.

const RELEASE_BASE = `https://github.com/gastownhall/beads/releases/download/v${BEADS_VERSION}`;
// The REAL host platform, captured before any withPlatformArch() override, so
// POSIX-only assertions (file mode bits) can be gated on the actual host rather
// than on the platform the module under test has been told it is running on.
// NTFS has no 0755, so an unguarded mode assertion would fail on the Windows CI runner.
const REAL_PLATFORM = process.platform;

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
  centralHeader.writeUInt32LE(0, 42); // local header offset

  const centralEntry = Buffer.concat([centralHeader, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with CD
  eocd.writeUInt16LE(1, 8); // entries on this disk
  eocd.writeUInt16LE(1, 10); // total entries
  eocd.writeUInt32LE(centralEntry.length, 12); // CD size
  eocd.writeUInt32LE(localEntry.length, 16); // CD offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localEntry, centralEntry, eocd]);
}

/** Builds a minimal single-entry (ustar) `.tar.gz` fixture -- FLAT, like the real assets. */
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

  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += header[i];
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf-8');

  const paddedSize = Math.ceil(content.length / 512) * 512;
  const contentBlock = Buffer.alloc(paddedSize);
  content.copy(contentBlock);

  const endMarker = Buffer.alloc(1024); // two 512-byte zero blocks
  return zlib.gzipSync(Buffer.concat([header, contentBlock, endMarker]));
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
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

function realFsDeps(fetchImpl: typeof fetch): BeadsInstallDeps {
  return {
    fetch: fetchImpl,
    fs: {
      mkdir: (dir, opts) => fs.promises.mkdir(dir, opts),
      writeFile: (file, data) => fs.promises.writeFile(file, data),
      chmod: (file, mode) => fs.promises.chmod(file, mode),
    },
  };
}

/**
 * An injected fetch that serves a synthetic checksums.txt plus one synthetic
 * archive. `checksumOverride` lets a test publish a checksum that does NOT match
 * the archive bytes, which is the mismatch case.
 */
function fakeFetch(opts: {
  assetName: string;
  archive: Buffer;
  checksumOverride?: string;
  checksumsBody?: string;
  checksumsStatus?: number;
  archiveStatus?: number;
}): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const checksums = opts.checksumsBody
    ?? `${opts.checksumOverride ?? sha256(opts.archive)}  ${opts.assetName}\n`;

  const fetchImpl = (async (url: any) => {
    const u = String(url);
    urls.push(u);
    if (u.endsWith('/checksums.txt')) {
      const status = opts.checksumsStatus ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => checksums,
      } as unknown as Response;
    }
    const status = opts.archiveStatus ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      arrayBuffer: async () => opts.archive.buffer.slice(
        opts.archive.byteOffset,
        opts.archive.byteOffset + opts.archive.byteLength,
      ),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  return { fetch: fetchImpl, urls };
}

function tmpDestDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'beads-install-test-'));
}

describe('resolveBeadsAsset -- published asset matrix (apra-fleet-i9ag.13.3)', () => {
  // The exact asset names published at the v1.3.0 tag. NOTE the deliberate
  // asymmetry the installer has to get right: the TAG is v-prefixed (v1.3.0)
  // while the ASSET names carry the bare version (1.3.0).
  const matrix: Array<{
    platform: string;
    arch: string;
    assetName: string;
    archiveType: 'zip' | 'tar.gz';
    binaryName: string;
  }> = [
    { platform: 'linux', arch: 'x64', assetName: 'beads_1.3.0_linux_amd64.tar.gz', archiveType: 'tar.gz', binaryName: 'bd' },
    { platform: 'linux', arch: 'arm64', assetName: 'beads_1.3.0_linux_arm64.tar.gz', archiveType: 'tar.gz', binaryName: 'bd' },
    { platform: 'darwin', arch: 'x64', assetName: 'beads_1.3.0_darwin_amd64.tar.gz', archiveType: 'tar.gz', binaryName: 'bd' },
    { platform: 'darwin', arch: 'arm64', assetName: 'beads_1.3.0_darwin_arm64.tar.gz', archiveType: 'tar.gz', binaryName: 'bd' },
    { platform: 'win32', arch: 'x64', assetName: 'beads_1.3.0_windows_amd64.zip', archiveType: 'zip', binaryName: 'bd.exe' },
    { platform: 'win32', arch: 'arm64', assetName: 'beads_1.3.0_windows_arm64.zip', archiveType: 'zip', binaryName: 'bd.exe' },
  ];

  it.each(matrix)(
    'resolves $platform/$arch to $assetName',
    ({ platform, arch, assetName, archiveType, binaryName }) => {
      expect(resolveBeadsAsset(platform, arch)).toEqual({
        assetName,
        url: `${RELEASE_BASE}/${assetName}`,
        archiveType,
        binaryName,
        checksumsUrl: BEADS_CHECKSUMS_URL,
      });
    },
  );

  it('covers exactly the six published combos -- beads publishes linux/arm64 and win32/arm64 that dolt does not', () => {
    const resolved = matrix.map(m => resolveBeadsAsset(m.platform, m.arch).assetName);
    expect(new Set(resolved).size).toBe(6);
    // Guard the two combos dolt's pinned version has no asset for, so nobody
    // copies dolt's unsupported-combo list over here.
    expect(resolveBeadsAsset('linux', 'arm64').assetName).toBe('beads_1.3.0_linux_arm64.tar.gz');
    expect(resolveBeadsAsset('win32', 'arm64').assetName).toBe('beads_1.3.0_windows_arm64.zip');
  });

  it('builds the URL from the v-prefixed TAG while the asset name stays un-prefixed', () => {
    const asset = resolveBeadsAsset('linux', 'x64');
    expect(asset.url).toContain('/download/v1.3.0/');
    expect(asset.assetName).toBe('beads_1.3.0_linux_amd64.tar.gz');
    expect(asset.assetName).not.toContain('v1.3.0');
  });

  // Unpublished combos must throw a TYPED error naming BOTH platform and arch,
  // not return undefined and not silently no-op.
  const unpublished: Array<[string, string]> = [
    ['win32', 'ia32'],
    ['sunos', 'x64'],
    ['android', 'arm64'],   // published at the tag but deliberately out of the matrix
    ['freebsd', 'x64'],     // ditto
    ['linux', 'ppc64'],
  ];

  it.each(unpublished)('throws the typed error for the unpublished combo %s/%s', (platform, arch) => {
    let caught: unknown;
    try {
      resolveBeadsAsset(platform, arch);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnsupportedBeadsPlatformError);
    const error = caught as UnsupportedBeadsPlatformError;
    expect(error.name).toBe('UnsupportedBeadsPlatformError');
    expect(error.message).toContain(platform);
    expect(error.message).toContain(arch);
    expect(error.platform).toBe(platform);
    expect(error.arch).toBe(arch);
  });
});

describe('parseChecksumsForAsset (apra-fleet-i9ag.13.3)', () => {
  const body = [
    'aaaa0000aaaa0000aaaa0000aaaa0000aaaa0000aaaa0000aaaa0000aaaa0000  beads_1.3.0_linux_amd64.tar.gz',
    'bbbb1111bbbb1111bbbb1111bbbb1111bbbb1111bbbb1111bbbb1111bbbb1111  beads_1.3.0_windows_amd64.zip',
    '',
  ].join('\n');

  it('returns the hash recorded for the named asset', () => {
    expect(parseChecksumsForAsset(body, 'beads_1.3.0_windows_amd64.zip'))
      .toBe('bbbb1111bbbb1111bbbb1111bbbb1111bbbb1111bbbb1111bbbb1111bbbb1111');
  });

  it('returns undefined when the asset has no entry', () => {
    expect(parseChecksumsForAsset(body, 'beads_1.3.0_darwin_arm64.tar.gz')).toBeUndefined();
  });

  it('ignores blank and malformed lines rather than mis-parsing them', () => {
    const messy = `# a comment\n\nnot-a-hash beads_1.3.0_linux_amd64.tar.gz\n${body}`;
    expect(parseChecksumsForAsset(messy, 'beads_1.3.0_linux_amd64.tar.gz'))
      .toBe('aaaa0000aaaa0000aaaa0000aaaa0000aaaa0000aaaa0000aaaa0000aaaa0000');
  });
});

describe('downloadAndExtractBeads (apra-fleet-i9ag.13.3)', () => {
  it('extracts the flat tar.gz bd entry into destDir with mode 0755 on POSIX', async () => {
    const destDir = tmpDestDir();
    try {
      await withPlatformArch('linux', 'x64', async () => {
        const binaryContent = Buffer.from('#!/bin/sh\necho "bd version 1.3.0"\n');
        // FLAT archive: `bd` at the root, with no directory prefix -- the real layout.
        const archive = buildTarGzFixture('bd', binaryContent);
        const { fetch: f, urls } = fakeFetch({ assetName: 'beads_1.3.0_linux_amd64.tar.gz', archive });

        const written = await downloadAndExtractBeads(destDir, realFsDeps(f));

        expect(written).toBe(path.resolve(path.join(destDir, 'bd')));
        expect(fs.readFileSync(written)).toEqual(binaryContent);
        // 0o755 -- executable. POSIX only; NTFS has no such mode bits.
        if (REAL_PLATFORM !== 'win32') {
          expect(fs.statSync(written).mode & 0o777).toBe(0o755);
        }
        // checksums.txt is fetched BEFORE the archive: an unverifiable download
        // must never be written.
        expect(urls[0]).toBe(BEADS_CHECKSUMS_URL);
        expect(urls[1]).toBe(`${RELEASE_BASE}/beads_1.3.0_linux_amd64.tar.gz`);
      });
    } finally {
      fs.rmSync(destDir, { recursive: true, force: true });
    }
  });

  it('extracts the flat zip bd.exe entry for windows', async () => {
    const destDir = tmpDestDir();
    try {
      await withPlatformArch('win32', 'x64', async () => {
        const binaryContent = Buffer.from('MZ fake windows binary');
        const archive = buildZipFixture('bd.exe', binaryContent);
        const { fetch: f } = fakeFetch({ assetName: 'beads_1.3.0_windows_amd64.zip', archive });

        const written = await downloadAndExtractBeads(destDir, realFsDeps(f));

        expect(path.basename(written)).toBe('bd.exe');
        expect(fs.readFileSync(written)).toEqual(binaryContent);
      });
    } finally {
      fs.rmSync(destDir, { recursive: true, force: true });
    }
  });

  it('REJECTS a checksum mismatch with the typed error and leaves NO binary in destDir', async () => {
    const destDir = tmpDestDir();
    try {
      await withPlatformArch('linux', 'x64', async () => {
        const archive = buildTarGzFixture('bd', Buffer.from('tampered payload'));
        const bogus = 'd'.repeat(64); // a published hash the bytes do not match
        const { fetch: f } = fakeFetch({
          assetName: 'beads_1.3.0_linux_amd64.tar.gz',
          archive,
          checksumOverride: bogus,
        });

        const err = await downloadAndExtractBeads(destDir, realFsDeps(f)).catch(e => e);

        expect(err).toBeInstanceOf(BeadsChecksumMismatchError);
        expect(err.name).toBe('BeadsChecksumMismatchError');
        expect(err.message).toContain('beads_1.3.0_linux_amd64.tar.gz');
        expect(err.expected).toBe(bogus);
        expect(err.actual).toBe(sha256(archive));

        // The whole point: nothing partial or unverified survives the rejection.
        expect(fs.readdirSync(destDir)).toEqual([]);
        expect(fs.existsSync(path.join(destDir, 'bd'))).toBe(false);
      });
    } finally {
      fs.rmSync(destDir, { recursive: true, force: true });
    }
  });

  it('rejects, writing nothing, when checksums.txt has no entry for the asset', async () => {
    const destDir = tmpDestDir();
    try {
      await withPlatformArch('linux', 'x64', async () => {
        const archive = buildTarGzFixture('bd', Buffer.from('payload'));
        const { fetch: f } = fakeFetch({
          assetName: 'beads_1.3.0_linux_amd64.tar.gz',
          archive,
          checksumsBody: `${'a'.repeat(64)}  some_other_asset.tar.gz\n`,
        });

        const err = await downloadAndExtractBeads(destDir, realFsDeps(f)).catch(e => e);

        expect(err).toBeInstanceOf(BeadsChecksumUnavailableError);
        expect(err.message).toContain('beads_1.3.0_linux_amd64.tar.gz');
        expect(fs.readdirSync(destDir)).toEqual([]);
      });
    } finally {
      fs.rmSync(destDir, { recursive: true, force: true });
    }
  });

  it('rejects, writing nothing, when checksums.txt itself cannot be downloaded', async () => {
    const destDir = tmpDestDir();
    try {
      await withPlatformArch('linux', 'x64', async () => {
        const archive = buildTarGzFixture('bd', Buffer.from('payload'));
        const { fetch: f } = fakeFetch({
          assetName: 'beads_1.3.0_linux_amd64.tar.gz',
          archive,
          checksumsStatus: 404,
        });

        const err = await downloadAndExtractBeads(destDir, realFsDeps(f)).catch(e => e);

        expect(err).toBeInstanceOf(BeadsChecksumUnavailableError);
        expect(err.message).toContain('404');
        expect(fs.readdirSync(destDir)).toEqual([]);
      });
    } finally {
      fs.rmSync(destDir, { recursive: true, force: true });
    }
  });

  it('rejects, writing nothing, when the archive download itself fails', async () => {
    const destDir = tmpDestDir();
    try {
      await withPlatformArch('linux', 'x64', async () => {
        const archive = buildTarGzFixture('bd', Buffer.from('payload'));
        const { fetch: f } = fakeFetch({
          assetName: 'beads_1.3.0_linux_amd64.tar.gz',
          archive,
          archiveStatus: 500,
        });

        const err = await downloadAndExtractBeads(destDir, realFsDeps(f)).catch(e => e);

        expect(err).toBeInstanceOf(Error);
        expect(err.message).toContain('beads_1.3.0_linux_amd64.tar.gz');
        expect(err.message).toContain('500');
        expect(fs.readdirSync(destDir)).toEqual([]);
      });
    } finally {
      fs.rmSync(destDir, { recursive: true, force: true });
    }
  });

  it('propagates the typed unsupported-platform error without fetching anything', async () => {
    const destDir = tmpDestDir();
    try {
      await withPlatformArch('sunos', 'x64', async () => {
        const f = vi.fn();
        const err = await downloadAndExtractBeads(destDir, realFsDeps(f as any)).catch(e => e);

        expect(err).toBeInstanceOf(UnsupportedBeadsPlatformError);
        expect(f).not.toHaveBeenCalled();
        expect(fs.readdirSync(destDir)).toEqual([]);
      });
    } finally {
      fs.rmSync(destDir, { recursive: true, force: true });
    }
  });
});

describe('verifyBeads (apra-fleet-i9ag.13.3)', () => {
  function verifyDeps(impl: () => unknown): BeadsVerifyDeps {
    return { execFileSync: impl as unknown as BeadsVerifyDeps['execFileSync'] };
  }

  // Both forms print a line starting 'bd version ' but with DIFFERENT trailing
  // commit detail, so the parser must key off the prefix, not the whole line.
  it.each([
    ['bd version 1.3.0 (f45b249ce: HEAD@f45b249ce6b4)\n'],
    ['bd version 1.3.0 (f45b249ce)\n'],
  ])('parses the version out of %j', async (output) => {
    await expect(verifyBeads('/some/bin/bd', verifyDeps(() => output))).resolves.toBe('1.3.0');
  });

  it('executes the binary at the given path with its version flag', async () => {
    const execFileSync = vi.fn(() => 'bd version 1.3.0 (f45b249ce)\n');
    await verifyBeads('/some/bin/bd', verifyDeps(execFileSync));
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(execFileSync.mock.calls[0][0]).toBe('/some/bin/bd');
    expect(execFileSync.mock.calls[0][1]).toEqual(['--version']);
  });

  // apra-fleet-i9ag.12.5 -- this probe used to pass
  // `shell: process.platform === 'win32'`. With shell:true Node joins file+args
  // into ONE UNQUOTED command string, so a bd.exe under a Windows profile
  // containing a space ('C:\Users\First Last\.apra-fleet\bin\bd.exe') is parsed
  // as the command 'C:\Users\First' and the probe fails -- and because a beads
  // verify failure is FATAL, it took the whole install down.
  it('passes NO shell flag, so a path containing a space cannot be re-split', async () => {
    const execFileSync = vi.fn(() => 'bd version 1.3.0 (f45b249ce)\n');
    await verifyBeads('/some bin dir/bd', verifyDeps(execFileSync));

    const opts = execFileSync.mock.calls[0][2] as Record<string, unknown>;
    // Asserted as an ABSENT/falsy key rather than via objectContaining, which
    // would happily ignore an extra shell:true.
    expect('shell' in opts ? opts.shell : undefined).toBeUndefined();
    expect(opts).toEqual({ stdio: 'pipe', encoding: 'utf-8' });
  });

  it('really verifies a binary whose absolute path contains a space (real execFileSync)', async () => {
    // The end-to-end form of the assertion above: the REAL execFileSync against
    // a REAL executable in a directory with a space in its name. This fails if
    // the shell flag is ever reintroduced, on any platform.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beads verify space-'));
    try {
      const isWin = process.platform === 'win32';
      const binPath = path.join(dir, isWin ? 'bd.cmd' : 'bd');
      if (isWin) {
        fs.writeFileSync(binPath, '@echo bd version 1.3.0 (f45b249ce)\r\n');
      } else {
        fs.writeFileSync(binPath, '#!/bin/sh\necho "bd version 1.3.0 (f45b249ce)"\n');
        fs.chmodSync(binPath, 0o755);
      }
      expect(binPath).toContain(' '); // the property under test actually holds

      await expect(verifyBeads(binPath)).resolves.toBe('1.3.0');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws on a non-zero exit (execFileSync throwing) rather than reporting a version', async () => {
    await expect(
      verifyBeads('/some/bin/bd', verifyDeps(() => { throw new Error('bd: cannot execute binary file'); })),
    ).rejects.toThrow('cannot execute binary file');
  });

  it('throws the typed probe error on unrecognisable version output', async () => {
    const err = await verifyBeads('/some/bin/bd', verifyDeps(() => 'not a version line\n')).catch(e => e);
    expect(err).toBeInstanceOf(BeadsVersionProbeError);
    expect(err.message).toContain('/some/bin/bd');
  });
});
