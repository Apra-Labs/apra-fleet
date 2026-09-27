/**
 * Portable beads (bd) CLI download/checksum-verify/extract helper
 * (apra-fleet-i9ag.13.1).
 *
 * Fixes the fresh-install bug where the installer's beads step shelled out to
 * `npm install -g @beads/bd`: on a machine with no node/npm (exactly what the
 * released single-file binary promises to support) that step failed and was
 * silently skipped, leaving the console backlog and Sprints with no bd. This
 * module resolves the correct gastownhall/beads release asset for the running
 * platform/arch and downloads+checksum-verifies+extracts the single static
 * binary into a caller-supplied destDir (BIN_DIR, NEVER system PATH).
 *
 * Mirrors the shape of dolt-install.ts (pinned version constant, resolve-asset
 * function, typed unsupported-platform error, injectable deps object with a
 * real-deps default, download/extract, verify) and shares its single-file
 * archive readers via archive-extract.ts.
 *
 * Release facts this module encodes (verified against the real release API):
 *  - The git TAG is v-prefixed (v1.3.0) but the ASSET names are NOT (1.3.0).
 *  - Both archive families are FLAT: the binary (`bd` / `bd.exe`) sits at the
 *    archive root, with no directory prefix.
 *  - beads publishes MORE platforms than dolt does -- including linux/arm64
 *    and windows/arm64, which dolt's pinned version does not. Do not copy
 *    dolt's unsupported-combo list here.
 *  - `checksums.txt` is a plain sha256sum-format listing (hash, two spaces,
 *    filename) covering every archive.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { extractSingleFileFromZip, extractSingleFileFromTarGz } from './archive-extract.js';

/** Pinned beads version. Matches the version the installer previously pinned via npm. */
export const BEADS_VERSION = '1.3.0';
/** The release TAG is v-prefixed even though the asset names are not. */
export const BEADS_RELEASE_TAG = `v${BEADS_VERSION}`;
const BEADS_RELEASE_BASE = `https://github.com/gastownhall/beads/releases/download/${BEADS_RELEASE_TAG}`;
/** sha256sum-format listing covering every published archive at this tag. */
export const BEADS_CHECKSUMS_URL = `${BEADS_RELEASE_BASE}/checksums.txt`;

export interface BeadsAsset {
  assetName: string;
  url: string;
  archiveType: 'zip' | 'tar.gz';
  /** Name of the binary INSIDE the archive; both families are flat, so this is also its basename on disk. */
  binaryName: string;
  checksumsUrl: string;
}

/** Typed error thrown for a platform/arch combo with no published beads release asset. */
export class UnsupportedBeadsPlatformError extends Error {
  readonly platform: string;
  readonly arch: string;
  constructor(platform: string, arch: string) {
    super(`Unsupported platform/arch for portable beads install: ${platform}/${arch}`);
    this.name = 'UnsupportedBeadsPlatformError';
    this.platform = platform;
    this.arch = arch;
  }
}

/** Typed error thrown when a downloaded archive's sha256 does not match checksums.txt. */
export class BeadsChecksumMismatchError extends Error {
  readonly assetName: string;
  readonly expected: string;
  readonly actual: string;
  constructor(assetName: string, expected: string, actual: string) {
    super(
      `Checksum mismatch for beads release asset "${assetName}": ` +
        `expected sha256 ${expected}, got ${actual}`,
    );
    this.name = 'BeadsChecksumMismatchError';
    this.assetName = assetName;
    this.expected = expected;
    this.actual = actual;
  }
}

/** Typed error thrown when the release checksums listing itself cannot be obtained/parsed. */
export class BeadsChecksumUnavailableError extends Error {
  readonly assetName: string;
  constructor(assetName: string, reason: string) {
    super(`Cannot verify beads release asset "${assetName}": ${reason}`);
    this.name = 'BeadsChecksumUnavailableError';
    this.assetName = assetName;
  }
}

/** Typed error thrown when the installed binary's version output is not recognisable. */
export class BeadsVersionProbeError extends Error {
  constructor(beadsPath: string, reason: string) {
    super(`Could not determine the beads version of "${beadsPath}": ${reason}`);
    this.name = 'BeadsVersionProbeError';
  }
}

/** node's process.platform token -> the token used in the beads asset name. */
const PLATFORM_TOKENS: Record<string, string> = {
  linux: 'linux',
  darwin: 'darwin',
  win32: 'windows',
};

/** node's process.arch token -> the token used in the beads asset name. */
const ARCH_TOKENS: Record<string, string> = {
  x64: 'amd64',
  arm64: 'arm64',
};

/**
 * Resolves the gastownhall/beads v1.3.0 release asset for the given
 * platform/arch. All six published combos are supported: linux, darwin and
 * windows on both amd64 and arm64. Throws UnsupportedBeadsPlatformError --
 * naming both platform and arch -- rather than returning undefined or
 * silently no-op'ing for anything else (the tag also carries android_arm64,
 * freebsd_amd64 and a contract-corpus archive; those are deliberately out of
 * the supported matrix).
 */
export function resolveBeadsAsset(platform: string, arch: string): BeadsAsset {
  const osToken = PLATFORM_TOKENS[platform];
  const archToken = ARCH_TOKENS[arch];
  if (!osToken || !archToken) {
    throw new UnsupportedBeadsPlatformError(platform, arch);
  }

  const archiveType: 'zip' | 'tar.gz' = platform === 'win32' ? 'zip' : 'tar.gz';
  // NOTE: asset names carry the BARE version (1.3.0), not the v-prefixed tag.
  const assetName = `beads_${BEADS_VERSION}_${osToken}_${archToken}.${archiveType}`;

  return {
    assetName,
    url: `${BEADS_RELEASE_BASE}/${assetName}`,
    archiveType,
    binaryName: platform === 'win32' ? 'bd.exe' : 'bd',
    checksumsUrl: BEADS_CHECKSUMS_URL,
  };
}

export interface BeadsInstallDeps {
  fetch: typeof fetch;
  fs: {
    mkdir: (dir: string, opts: { recursive: true }) => Promise<string | undefined>;
    writeFile: (file: string, data: Uint8Array) => Promise<void>;
    chmod: (file: string, mode: number) => Promise<void>;
  };
}

const realDeps: BeadsInstallDeps = {
  fetch: (...a) => globalThis.fetch(...a),
  fs: {
    mkdir: (dir, opts) => fs.promises.mkdir(dir, opts),
    writeFile: (file, data) => fs.promises.writeFile(file, data),
    chmod: (file, mode) => fs.promises.chmod(file, mode),
  },
};

/**
 * Parses a sha256sum-format listing (`<hash>  <filename>` per line) and
 * returns the hash recorded for assetName, or undefined if absent.
 */
export function parseChecksumsForAsset(checksumsText: string, assetName: string): string | undefined {
  for (const rawLine of checksumsText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([0-9a-fA-F]{64})\s+\*?(\S+)$/);
    if (!match) continue;
    // Some listings prefix the filename with a path; compare the basename.
    if (match[2].replace(/\\/g, '/').split('/').pop() === assetName) {
      return match[1].toLowerCase();
    }
  }
  return undefined;
}

/**
 * Downloads the platform-appropriate beads v1.3.0 release asset, verifies its
 * sha256 against the release's checksums.txt, and extracts the single static
 * bd binary into destDir (caller-supplied, BIN_DIR -- NEVER system PATH, no
 * admin rights required). Returns the absolute path to the extracted,
 * executable binary.
 *
 * The checksum is verified BEFORE anything is written, so a mismatch leaves no
 * partial or unverified binary behind in destDir.
 */
export async function downloadAndExtractBeads(
  destDir: string,
  deps: BeadsInstallDeps = realDeps,
): Promise<string> {
  const platform = process.platform;
  const arch = process.arch;
  const asset = resolveBeadsAsset(platform, arch);

  // 1. Expected checksum first -- an unverifiable download is a hard failure.
  const checksumsRes = await deps.fetch(asset.checksumsUrl);
  if (!checksumsRes.ok) {
    throw new BeadsChecksumUnavailableError(
      asset.assetName,
      `failed to download ${asset.checksumsUrl}: HTTP ${checksumsRes.status}`,
    );
  }
  const expected = parseChecksumsForAsset(await checksumsRes.text(), asset.assetName);
  if (!expected) {
    throw new BeadsChecksumUnavailableError(
      asset.assetName,
      `no sha256 entry for it in ${asset.checksumsUrl}`,
    );
  }

  // 2. The archive itself.
  const res = await deps.fetch(asset.url);
  if (!res.ok) {
    throw new Error(`Failed to download beads release asset "${asset.assetName}": HTTP ${res.status}`);
  }
  const archiveBuf = Buffer.from(await res.arrayBuffer());

  // 3. Verify BEFORE extracting or writing anything.
  const actual = crypto.createHash('sha256').update(archiveBuf).digest('hex');
  if (actual !== expected) {
    throw new BeadsChecksumMismatchError(asset.assetName, expected, actual);
  }

  // 4. Both archive families are flat: the binary is at the archive root.
  const binaryBuf = asset.archiveType === 'zip'
    ? extractSingleFileFromZip(archiveBuf, asset.binaryName)
    : extractSingleFileFromTarGz(archiveBuf, asset.binaryName);

  await deps.fs.mkdir(destDir, { recursive: true });
  const destPath = path.join(destDir, asset.binaryName);
  await deps.fs.writeFile(destPath, binaryBuf);

  if (platform !== 'win32') {
    await deps.fs.chmod(destPath, 0o755);
  }

  return path.resolve(destPath);
}

/** Injectable seam for verifyBeads so tests never exec a real bd process. */
export interface BeadsVerifyDeps {
  execFileSync: typeof execFileSync;
}

const realVerifyDeps: BeadsVerifyDeps = { execFileSync };

/**
 * Proves a downloaded bd binary is actually usable by running its own version
 * command, and returns the parsed version string. Throws on a non-zero exit (a
 * broken/missing binary must fail the install outright -- see the installer
 * step, where beads failures are fatal).
 *
 * Both `bd version` and `bd --version` work on the real binary and both print
 * a line beginning with the literal text `bd version `, followed by the semver
 * and then commit detail that DIFFERS between the two forms (and will differ
 * again on a rebuilt release). So this parses the `bd version <semver>` prefix
 * rather than expecting the whole line to be a bare semver.
 */
export async function verifyBeads(
  beadsPath: string,
  deps: BeadsVerifyDeps = realVerifyDeps,
): Promise<string> {
  // NO `shell` flag, on any platform -- the structurally identical sibling of
  // verifyDolt()'s version probe, fixed with it in apra-fleet-i9ag.12.5 (see
  // dolt-install.ts for the full mechanism). This copy previously carried
  // `shell: process.platform === 'win32'` with a comment calling it "the
  // convention in dolt-install.ts verifyDolt", so fixing only that one would
  // have left this one broken while deleting the convention it cited.
  //
  // It matters MORE here than for dolt: a beads verify failure is FATAL (the
  // install exits non-zero), so on a Windows profile containing a space --
  // 'C:\Users\First Last\.apra-fleet\bin\bd.exe' -- shell:true made the probe
  // fail and took the whole install down, rather than merely warning.
  const versionOut = deps.execFileSync(beadsPath, ['--version'], {
    stdio: 'pipe',
    encoding: 'utf-8',
  }) as string;

  const text = (versionOut ?? '').toString();
  const match = text.match(/bd version\s+(\d+\.\d+\.\d+\S*)/i);
  if (!match) {
    throw new BeadsVersionProbeError(
      beadsPath,
      `unexpected '--version' output: ${JSON.stringify(text.trim().slice(0, 200))}`,
    );
  }
  return match[1];
}
