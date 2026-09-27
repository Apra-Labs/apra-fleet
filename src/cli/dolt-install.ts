/**
 * Portable dolt CLI download/extract helper (apra-fleet-ire.1).
 *
 * PoC (2026-07-16, dolt-poc-v2) confirmed that having a real dolt binary
 * available -- no admin/system install needed -- unlocks the documented
 * dolt_conflicts / dolt_conflicts_resolve resolve-in-place path for Dolt
 * merge conflicts, which is otherwise completely blocked in bd's embedded
 * mode. This module resolves the correct dolt v2.2.0 release asset for the
 * running platform/arch and downloads+extracts the single static binary
 * into a caller-supplied destDir (BIN_DIR-adjacent, NEVER system PATH).
 *
 * Mirrors the fetch/asset-download pattern in update.ts (line ~32-70) and
 * the deps-injection-for-testability pattern in join.ts (JoinDeps/realDeps).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { extractSingleFileFromZip, extractSingleFileFromTarGz } from './archive-extract.js';

export const DOLT_VERSION = 'v2.2.0';
const DOLT_RELEASE_BASE = `https://github.com/dolthub/dolt/releases/download/${DOLT_VERSION}`;

export type SupportedPlatform = 'win32' | 'linux' | 'darwin';

export interface DoltAsset {
  assetName: string;
  url: string;
  archiveType: 'zip' | 'tar.gz';
  binaryName: string;
}

/** Typed error thrown for a platform/arch combo with no known dolt release asset. */
export class UnsupportedDoltPlatformError extends Error {
  constructor(platform: string, arch: string) {
    super(`Unsupported platform/arch for portable dolt install: ${platform}/${arch}`);
    this.name = 'UnsupportedDoltPlatformError';
  }
}

/**
 * Resolves the dolthub/dolt v2.2.0 release asset for the given platform/arch.
 * Throws UnsupportedDoltPlatformError rather than silently no-op'ing on an
 * unsupported combo (e.g. win32/arm64, linux/arm64 -- not published upstream
 * for this pinned version).
 */
export function resolveDoltAsset(platform: string, arch: string): DoltAsset {
  const binaryName = platform === 'win32' ? 'dolt.exe' : 'dolt';

  let assetName: string | undefined;
  let archiveType: 'zip' | 'tar.gz' | undefined;

  if (platform === 'win32' && arch === 'x64') {
    assetName = 'dolt-windows-amd64.zip';
    archiveType = 'zip';
  } else if (platform === 'linux' && arch === 'x64') {
    assetName = 'dolt-linux-amd64.tar.gz';
    archiveType = 'tar.gz';
  } else if (platform === 'darwin' && arch === 'x64') {
    assetName = 'dolt-darwin-amd64.tar.gz';
    archiveType = 'tar.gz';
  } else if (platform === 'darwin' && arch === 'arm64') {
    assetName = 'dolt-darwin-arm64.tar.gz';
    archiveType = 'tar.gz';
  }

  if (!assetName || !archiveType) {
    throw new UnsupportedDoltPlatformError(platform, arch);
  }

  return {
    assetName,
    url: `${DOLT_RELEASE_BASE}/${assetName}`,
    archiveType,
    binaryName,
  };
}

export interface DoltInstallDeps {
  fetch: typeof fetch;
  fs: {
    mkdir: (dir: string, opts: { recursive: true }) => Promise<string | undefined>;
    writeFile: (file: string, data: Uint8Array) => Promise<void>;
    chmod: (file: string, mode: number) => Promise<void>;
  };
}

const realDeps: DoltInstallDeps = {
  fetch: (...a) => globalThis.fetch(...a),
  fs: {
    mkdir: (dir, opts) => fs.promises.mkdir(dir, opts),
    writeFile: (file, data) => fs.promises.writeFile(file, data),
    chmod: (file, mode) => fs.promises.chmod(file, mode),
  },
};

/**
 * Downloads the platform-appropriate dolt v2.2.0 release asset and extracts
 * the single static dolt binary into destDir (caller-supplied,
 * BIN_DIR-adjacent -- NEVER system PATH, no admin rights required). Returns
 * the absolute path to the extracted, executable binary.
 */
export async function downloadAndExtractDolt(
  destDir: string,
  deps: DoltInstallDeps = realDeps,
): Promise<string> {
  const platform = process.platform;
  const arch = process.arch;
  const asset = resolveDoltAsset(platform, arch);

  const res = await deps.fetch(asset.url);
  if (!res.ok) {
    throw new Error(`Failed to download dolt release asset "${asset.assetName}": HTTP ${res.status}`);
  }
  const archiveBuf = Buffer.from(await res.arrayBuffer());

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

/**
 * Result of verifyDolt (apra-fleet-ire.2). The version check throws on
 * failure (a broken/missing binary should fail the install outright), but
 * the server smoke-test portion never throws -- it reports serverOk:false
 * with a reason so the caller can warn-not-fail.
 */
export interface DoltVerifyResult {
  version: string;
  serverOk: boolean;
  reason?: string;
}

export interface VerifyDoltOptions {
  /** Port to try first for the sql-server smoke test. Default 3306. */
  port?: number;
  /** Bounded wait (ms) for the server to accept a TCP connection. Default 15000. */
  waitTimeoutMs?: number;
}

/** Injectable seams for verifyDolt so tests never spawn a real dolt process. */
export interface DoltVerifyDeps {
  execFileSync: typeof execFileSync;
  spawn: typeof spawn;
  fs: {
    mkdtempSync: (prefix: string) => string;
    rmSync: (dir: string, opts: { recursive: true; force: true }) => void;
  };
  net: {
    isPortFree: (port: number) => Promise<boolean>;
    getEphemeralPort: () => Promise<number>;
    waitForConnect: (port: number, timeoutMs: number) => Promise<boolean>;
  };
  /** Terminates the spawned dolt sql-server child. Platform-specific (mirrors stop.ts). */
  killChild: (child: ChildProcess) => void;
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true));
    });
  });
}

function getEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Bounded poll for a TCP connection to succeed; never hangs past timeoutMs. */
function waitForConnect(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = net.createConnection({ port, host: '127.0.0.1' });
      const finish = (ok: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        if (ok) {
          resolve(true);
          return;
        }
        if (Date.now() >= deadline) {
          resolve(false);
          return;
        }
        setTimeout(attempt, 150);
      };
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      socket.setTimeout(Math.min(500, Math.max(0, deadline - Date.now())), () => finish(false));
    };
    attempt();
  });
}

/** Platform-specific child termination, mirroring the convention in cli/stop.ts. */
function killChild(child: ChildProcess): void {
  if (child.pid === undefined || child.killed) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
    } catch {
      // best-effort
    }
  } else {
    try {
      child.kill('SIGKILL');
    } catch {
      // best-effort
    }
  }
}

const realVerifyDeps: DoltVerifyDeps = {
  execFileSync,
  spawn,
  fs: {
    mkdtempSync: (prefix) => fs.mkdtempSync(prefix),
    rmSync: (dir, opts) => fs.rmSync(dir, opts),
  },
  net: { isPortFree, getEphemeralPort, waitForConnect },
  killChild,
};

/**
 * Proves a downloaded dolt binary is actually usable:
 *  1. Runs `dolt version` (execFileSync, shell-LESS on every platform -- see
 *     the version-probe call below for why) and parses the version string.
 *     Throws if this fails -- a broken/missing binary should fail the install
 *     outright.
 *  2. Smoke-tests a real `dolt sql-server` against a throwaway scratch data
 *     dir on a configurable port (default 3306; falls back to an ephemeral
 *     free port if the requested one is already in use), waits (bounded,
 *     ~15s cap) for it to accept a TCP connection, then terminates the
 *     child and removes the scratch dir. This portion never throws -- it
 *     returns serverOk:false with a reason so the caller can warn-not-fail.
 *
 * The scratch dir and dolt child are always cleaned up (try/finally), even
 * if the server never comes up or something throws mid-way.
 */
export async function verifyDolt(
  doltPath: string,
  opts: VerifyDoltOptions = {},
  deps: DoltVerifyDeps = realVerifyDeps,
): Promise<DoltVerifyResult> {
  // NO `shell` flag, on any platform (apra-fleet-i9ag.12.5). It used to be
  // `shell: process.platform === 'win32'`, which BREAKS whenever the install
  // path contains a space: with shell:true Node joins the file and args into a
  // single UNQUOTED command string for cmd.exe/sh, so `dolt version` under
  // 'C:\Users\First Last\.apra-fleet\bin\dolt.exe' is parsed as the command
  // 'C:\Users\First' with the rest as arguments and the probe fails. doltPath is
  // always BIN_DIR/dolt[.exe] (BIN_DIR = os.homedir()/.apra-fleet/bin), and a
  // space in a Windows user profile is entirely ordinary.
  //
  // shell:true was never needed here: it is only required to run a .cmd/.bat
  // wrapper (e.g. npm's), and this is an absolute path to a real executable.
  // Dropping it also keeps the invocation argv-array and shell-less, so no
  // argument can be reinterpreted as shell syntax.
  const versionOut = deps.execFileSync(doltPath, ['version'], {
    stdio: 'pipe',
    encoding: 'utf-8',
  }) as string;
  const versionMatch = versionOut.match(/(\d+\.\d+\.\d+\S*)/);
  const version = versionMatch ? versionMatch[1] : versionOut.trim();

  const requestedPort = opts.port ?? 3306;
  const waitTimeoutMs = opts.waitTimeoutMs ?? 15000;

  let scratchDir: string | undefined;
  let child: ChildProcess | undefined;
  try {
    scratchDir = deps.fs.mkdtempSync(path.join(os.tmpdir(), 'dolt-verify-'));

    let port = requestedPort;
    const portFree = await deps.net.isPortFree(requestedPort);
    if (!portFree) {
      try {
        port = await deps.net.getEphemeralPort();
      } catch (err) {
        return { version, serverOk: false, reason: `No free port available: ${(err as Error).message}` };
      }
    }

    child = deps.spawn(doltPath, ['sql-server', '--port', String(port), '--data-dir', scratchDir], {
      stdio: 'ignore',
    });

    let spawnError: Error | undefined;
    child.once('error', (err) => {
      spawnError = err;
    });

    const connected = await deps.net.waitForConnect(port, waitTimeoutMs);

    if (spawnError) {
      return { version, serverOk: false, reason: `Failed to spawn dolt sql-server: ${spawnError.message}` };
    }
    if (!connected) {
      return {
        version,
        serverOk: false,
        reason: `dolt sql-server did not accept connections on port ${port} within ${waitTimeoutMs}ms`,
      };
    }
    return { version, serverOk: true };
  } catch (err) {
    return { version, serverOk: false, reason: (err as Error).message };
  } finally {
    if (child) {
      deps.killChild(child);
    }
    if (scratchDir) {
      try {
        deps.fs.rmSync(scratchDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
}
