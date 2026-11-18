/**
 * Linux ARM64 (aarch64) installer wiring: ci.yml builds and publishes
 * apra-fleet-installer-linux-arm64, member installs map an aarch64 member to
 * it, and `apra-fleet update` (INSTALLER_ASSETS) offers the same set of
 * assets the member path does.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { RELEASE_ASSETS, releaseAssetNameFor, normalizeArch, chooseInstallSource } from '../src/services/member-fleet-install.js';
import { INSTALLER_ASSETS, installerAssetName } from '../src/cli/update.js';

const CI = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
const ASSET = 'apra-fleet-installer-linux-arm64';

describe('linux-arm64 installer', () => {
  it('an aarch64 member (uname -m) resolves to the linux-arm64 release asset', () => {
    expect(normalizeArch('aarch64\n')).toBe('arm64');
    expect(releaseAssetNameFor({ os: 'linux', arch: 'arm64' } as any)).toBe(ASSET);
    const src = chooseInstallSource({ os: 'linux', arch: 'arm64' } as any, { os: 'windows', arch: 'x64' } as any, 'C:\\fleet.exe', 'v0.4.4_abc123');
    expect(src).toMatchObject({ kind: 'release-asset', assetName: ASSET });
  });

  it('ci.yml builds it on an arm runner and lists it wherever the other installers are', () => {
    expect(CI).toMatch(/- os: ubuntu-24\.04-arm\s*\n\s*binary: apra-fleet-installer-linux-arm64\s*\n/);
    const sumsLines = CI.split(/\r?\n/).filter((l) => l.includes('sha256sum') && l.includes('SHA256SUMS'));
    expect(sumsLines.length).toBe(2); // stable release + prerelease
    for (const l of sumsLines) expect(l.split(/\s+/)).toContain(ASSET);
    expect(CI).toMatch(/^\s*release-binaries\/apra-fleet-installer-linux-arm64\s*$/m);
    const filesLine = CI.split(/\r?\n/).find((l) => /^\s*FILES="apra-fleet-installer/.test(l)) ?? '';
    expect(filesLine).toContain(ASSET);
    const loopLine = CI.split(/\r?\n/).find((l) => /for f in apra-fleet-installer/.test(l)) ?? '';
    expect(loopLine).toContain(ASSET);
  });

  it('apra-fleet update maps linux/arm64 to it and offers exactly the member-install asset set', () => {
    expect(installerAssetName('linux', 'arm64')).toBe(ASSET);
    expect(installerAssetName('linux', 'x64')).toBe('apra-fleet-installer-linux-x64');
    expect(installerAssetName('darwin', 'x64')).toBe('apra-fleet-installer-darwin-x64');
    expect(installerAssetName('win32', 'arm64')).toBeNull();
    expect(new Set(Object.values(INSTALLER_ASSETS))).toEqual(new Set(Object.values(RELEASE_ASSETS)));
  });
});
