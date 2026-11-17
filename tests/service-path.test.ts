import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeServicePath, computeServicePathEntries, systemdEnvironmentLine } from '../src/services/service-manager/service-path.js';
import { buildPlist } from '../src/services/service-manager/macos.js';
import { findExecutableOnPath, npxUnavailableReason, splitPath } from '../src/utils/find-on-path.js';

// Injected file table: no real PATH or filesystem is consulted.
const filesIn = (...files: string[]) => (p: string) => files.includes(p);

describe('computeServicePathEntries', () => {
  it('puts node/npx dirs first, then installer PATH, then macOS well-known dirs, de-duplicated', () => {
    const entries = computeServicePathEntries({
      platform: 'darwin',
      envPath: '/usr/bin:/Users/u/.nvm/versions/node/v22/bin:/usr/local/bin:/usr/bin',
      isFile: filesIn('/Users/u/.nvm/versions/node/v22/bin/node', '/Users/u/.nvm/versions/node/v22/bin/npx'),
    });
    expect(entries).toEqual([
      '/Users/u/.nvm/versions/node/v22/bin',
      '/usr/bin',
      '/usr/local/bin',
      '/opt/homebrew/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ]);
  });

  it('linux gets no Homebrew dirs', () => {
    const entries = computeServicePathEntries({ platform: 'linux', envPath: '', isFile: () => false });
    expect(entries).toEqual(['/usr/bin', '/bin', '/usr/sbin', '/sbin']);
  });

  it('launchd-minimal installer PATH still yields Homebrew dirs on macOS', () => {
    expect(computeServicePath({ platform: 'darwin', envPath: '/usr/bin:/bin', isFile: () => false }))
      .toBe('/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin:/usr/sbin:/sbin');
  });

  it('drops relative, empty, and control-character entries and trailing slashes', () => {
    const entries = computeServicePathEntries({
      platform: 'linux',
      envPath: '.:bin::/opt/x/:/bad\nentry:~/bin:/usr/bin/',
      isFile: () => false,
    });
    expect(entries).toEqual(['/opt/x', '/usr/bin', '/bin', '/usr/sbin', '/sbin']);
  });

  it('node and npx dirs lead, in that order', () => {
    const entries = computeServicePathEntries({
      platform: 'linux',
      envPath: '/usr/bin:/home/u/n/bin',
      isFile: filesIn('/home/u/n/bin/npx', '/usr/bin/node'),
    });
    expect(entries.slice(0, 2)).toEqual(['/usr/bin', '/home/u/n/bin']);
  });
});

describe('systemdEnvironmentLine', () => {
  it('quotes the whole assignment', () => {
    expect(systemdEnvironmentLine('PATH', '/usr/bin:/bin')).toBe('Environment="PATH=/usr/bin:/bin"');
  });

  it('escapes backslash, double quote and percent', () => {
    expect(systemdEnvironmentLine('PATH', '/a b/"q"/50%/c\\d'))
      .toBe('Environment="PATH=/a b/\\"q\\"/50%%/c\\\\d"');
  });
});

describe('buildPlist', () => {
  it('carries PATH (xml-escaped) next to the service marker', () => {
    const plist = buildPlist('/bin/apra-fleet', ['--transport', 'http'], '/tmp/log', '/opt/a&b/bin:/usr/bin');
    expect(plist).toContain('<key>APRA_FLEET_SERVICE</key>\n        <string>1</string>');
    expect(plist).toContain('<key>PATH</key>\n        <string>/opt/a&amp;b/bin:/usr/bin</string>');
    // Both inside EnvironmentVariables.
    const env = plist.slice(plist.indexOf('<key>EnvironmentVariables</key>'), plist.indexOf('<key>RunAtLoad</key>'));
    expect(env).toContain('<key>PATH</key>');
    expect(env).toContain('<key>APRA_FLEET_SERVICE</key>');
  });
});

describe('npxUnavailableReason', () => {
  it('null when npx and node resolve', () => {
    expect(npxUnavailableReason({ platform: 'darwin', envPath: '/usr/local/bin', isFile: filesIn('/usr/local/bin/npx', '/usr/local/bin/node') })).toBeNull();
  });

  it('names npx, the searched PATH and the install remedy when npx is missing', () => {
    const r = npxUnavailableReason({ platform: 'darwin', envPath: '/usr/bin:/bin', isFile: () => false });
    expect(r).toContain("npx was not found on the apra-fleet server's PATH (searched: /usr/bin:/bin)");
    expect(r).toContain("re-run 'apra-fleet install'");
  });

  it('posix: npx without node (shebang env node) is also unavailable', () => {
    const r = npxUnavailableReason({ platform: 'linux', envPath: '/opt/npx-only', isFile: filesIn('/opt/npx-only/npx') });
    expect(r).toContain('node (required by npx) was not found');
  });

  it('win32 resolves npx via PATHEXT and does not require node separately', () => {
    const isFile = filesIn('C:\\nodejs\\npx.cmd');
    expect(findExecutableOnPath('npx', { platform: 'win32', envPath: 'C:\\nodejs', pathExt: '.exe;.cmd', isFile })).toBe('C:\\nodejs\\npx.cmd');
    expect(npxUnavailableReason({ platform: 'win32', envPath: 'C:\\nodejs', pathExt: '.exe;.cmd', isFile })).toBeNull();
  });
});

describe('splitPath', () => {
  it('win32 strips surrounding double quotes from entries and drops empties', () => {
    expect(splitPath('"C:\\Program Files\\nodejs";C:\\bin;;"D:\\x"', 'win32')).toEqual(['C:\\Program Files\\nodejs', 'C:\\bin', 'D:\\x']);
  });
  it('posix leaves quotes alone', () => {
    expect(splitPath('/a:/b::', 'linux')).toEqual(['/a', '/b']);
  });
});

describe.skipIf(process.platform === 'win32')('findExecutableOnPath exec bit (real files)', () => {
  it('a non-executable file named node is not resolved; an executable one is', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-bit-'));
    try {
      const f = path.join(dir, 'node');
      fs.writeFileSync(f, '#!/bin/sh\n', { mode: 0o644 });
      fs.chmodSync(f, 0o644);
      expect(findExecutableOnPath('node', { platform: 'linux', envPath: dir })).toBeNull();
      fs.chmodSync(f, 0o755);
      expect(findExecutableOnPath('node', { platform: 'linux', envPath: dir })).toBe(f);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
