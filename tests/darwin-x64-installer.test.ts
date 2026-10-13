/**
 * macOS x64 installer wiring (apra-fleet-b4g.115): ci.yml builds and publishes
 * apra-fleet-installer-darwin-x64, RELEASE_ASSETS maps macos/x64 to it, so an
 * Intel Mac member can be upgraded from a non-Mac orchestrator, and package-sea
 * rejects a node binary that has no SEA fuse (a launcher stub) up front.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RELEASE_ASSETS, releaseAssetNameFor, chooseInstallSource } from '../src/services/member-fleet-install.js';
import { checkSeaFuse, SEA_FUSE_SENTINEL } from '../scripts/package-sea.mjs';

const CI = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');

/** Names of release assets missing from each of the three ci.yml places. */
function missingFromCi(ci: string, assets: string[]): { matrix: string[]; sums: string[]; release: string[] } {
  const matrix = new Set([...ci.matchAll(/^\s*binary:\s*(\S+)\s*$/gm)].map((m) => m[1]));
  const sumsLine = ci.split(/\r?\n/).find((l) => l.includes('sha256sum') && l.includes('SHA256SUMS')) ?? '';
  const sums = new Set(sumsLine.split(/\s+/));
  const release = new Set([...ci.matchAll(/^\s*release-binaries\/(\S+)\s*$/gm)].map((m) => m[1]));
  return {
    matrix: assets.filter((a) => !matrix.has(a)),
    sums: assets.filter((a) => !sums.has(a)),
    release: assets.filter((a) => !release.has(a)),
  };
}

describe('ci.yml and RELEASE_ASSETS agree', () => {
  const assets = Object.values(RELEASE_ASSETS);

  it('RELEASE_ASSETS maps macos/x64 to the darwin-x64 installer', () => {
    expect(releaseAssetNameFor({ os: 'macos', arch: 'x64' } as any)).toBe('apra-fleet-installer-darwin-x64');
    expect(assets).toContain('apra-fleet-installer-darwin-x64');
  });

  it('every RELEASE_ASSETS value is in the build matrix, the SHA256SUMS command and the release-binaries list', () => {
    expect(missingFromCi(CI, assets)).toEqual({ matrix: [], sums: [], release: [] });
  });

  it('the check fails when darwin-x64 is removed from any ONE of the three places', () => {
    const asset = 'apra-fleet-installer-darwin-x64';
    const variants = {
      matrix: CI.replace(/^\s*binary:\s*apra-fleet-installer-darwin-x64\s*$/m, '            binary: removed'),
      sums: CI.replace(` ${asset} `, ' '),
      release: CI.replace(new RegExp(`^\\s*release-binaries/${asset}\\s*$`, 'm'), ''),
    } as const;
    for (const [place, text] of Object.entries(variants)) {
      expect(text, place).not.toBe(CI);
      const missing = missingFromCi(text, assets);
      expect(missing[place as keyof typeof missing], place).toEqual([asset]);
    }
  });
});

describe('member upgrade of an Intel Mac from a Windows orchestrator', () => {
  it('resolves the darwin-x64 release asset, not unsupported-platform', () => {
    const src = chooseInstallSource({ os: 'macos', arch: 'x64' } as any, { os: 'windows', arch: 'x64' } as any, 'C:\fleet.exe', 'v0.4.4_abc123');
    expect(src).toMatchObject({ kind: 'release-asset', assetName: 'apra-fleet-installer-darwin-x64' });
    // Stable first (BUILD_INFO-gated), then the exact-build prerelease.
    expect((src as any).url).toBe('https://github.com/Apra-Labs/apra-fleet/releases/download/v0.4.4/apra-fleet-installer-darwin-x64');
    expect((src as any).candidates.map((c: any) => c.tag)).toEqual(['v0.4.4', 'v0.4.4_abc123']);
  });
});

describe('package-sea checkSeaFuse', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sea-fuse-'));
  const withFuse = path.join(dir, 'node-with-fuse');
  const launcher = path.join(dir, 'node-launcher');
  fs.writeFileSync(withFuse, Buffer.concat([Buffer.from('\x7fELF-header'), Buffer.from(SEA_FUSE_SENTINEL + ':0'), Buffer.from('tail')]));
  fs.writeFileSync(launcher, 'stub launcher linked to libnode.dylib');

  it('accepts a binary that carries the sentinel', () => {
    expect(checkSeaFuse(withFuse)).toEqual({ ok: true });
  });
  it('rejects a binary without it, naming the cause and the fix', () => {
    const r = checkSeaFuse(launcher) as { ok: false; message: string };
    expect(r.ok).toBe(false);
    expect(r.message).toContain(SEA_FUSE_SENTINEL);
    expect(r.message).toMatch(/launcher stub/);
    expect(r.message).toMatch(/official node from nodejs\.org/);
  });
  it('reports an unreadable binary instead of throwing', () => {
    const r = checkSeaFuse(path.join(dir, 'missing')) as { ok: false; message: string };
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/cannot read the node binary/);
  });
  it('the running node (which CI packages with) passes', () => {
    expect(checkSeaFuse(process.execPath)).toEqual({ ok: true });
  });
  it('cleanup', () => { fs.rmSync(dir, { recursive: true, force: true }); });
});
