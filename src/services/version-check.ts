// T2.4 (F7, D6): server version handshake. The running server's compiled-in
// serverVersion (src/version.ts) is fixed at process start (build-time
// BUILD_VERSION define for SEA/esbuild, or a version.json read for dev/npm).
// If the repo is rebuilt (version.json/version bumped) while an MCP server
// process from before the rebuild is still running, serverVersion goes
// stale in memory -- this is the "bit us twice" scenario D6 targets. This
// module does a FRESH on-disk read every time it is called, independent of
// process start, so fleet_status can detect that drift.
//
// Degraded-safe throughout: any failure (missing version.json, SEA asset
// unavailable, malformed JSON) yields null so the caller omits the check
// silently. This NEVER fails or delays fleet_status, and there is no
// auto-restart -- surface only (D6).
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSea } from '../cli/install.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Walk up from startDir looking for version.json, capped at 5 levels (same
 * shape as the findProjectRoot pattern in src/cli/install.ts:88-95) so a
 * missing file degrades instead of walking to the filesystem root.
 */
function findProjectRootFrom(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, 'version.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function readVersionJson(startDir: string): string | null {
  const root = findProjectRootFrom(startDir);
  if (!root) return null;
  try {
    const vf = JSON.parse(readFileSync(join(root, 'version.json'), 'utf-8')) as { version?: unknown };
    return typeof vf.version === 'string' ? `v${vf.version}` : null;
  } catch {
    return null;
  }
}

// SEA binaries embed version.json inside the manifest.json asset (see
// buildDevManifest in src/cli/install.ts) rather than shipping a bare file on
// disk -- read it via the same 'node:sea' asset mechanism isSea() uses.
function readSeaManifestVersion(): string | null {
  try {
    const sea = require('node:sea');
    const buf = sea.getAsset('manifest.json');
    const text = new TextDecoder().decode(buf);
    const manifest = JSON.parse(text) as { version?: unknown };
    return typeof manifest.version === 'string' ? `v${manifest.version}` : null;
  } catch {
    return null;
  }
}

/**
 * Read the on-disk version of the code this process was launched from. Never
 * throws -- returns null on any failure. startDir is an injectable seam for
 * tests (defaults to this module's own directory, which works for both tsc
 * dist/services/version-check.js and esbuild bundles, walking up to find
 * version.json at the package root).
 */
export function readDiskVersion(startDir?: string): string | null {
  try {
    if (isSea()) return readSeaManifestVersion();
    return readVersionJson(startDir ?? __dirname);
  } catch {
    return null;
  }
}

export interface VersionMismatch {
  running: string;
  disk: string;
}

/**
 * Compare the compiled-in serverVersion against a fresh on-disk read.
 * Strips any dev git-hash suffix from `running` (serverVersion may carry
 * "_abcdef", see src/version.ts) before comparing, since the disk read is a
 * bare "vX.Y.Z" -- only a real version bump should be flagged, not a
 * hash-suffix artifact of dev mode. Returns null (no mismatch, or the disk
 * version could not be read) rather than throwing.
 */
export function checkVersionMismatch(running: string, startDir?: string): VersionMismatch | null {
  try {
    const disk = readDiskVersion(startDir);
    if (!disk) return null;
    const runningBase = running.split('_')[0];
    if (runningBase === disk) return null;
    return { running, disk };
  } catch {
    return null;
  }
}
