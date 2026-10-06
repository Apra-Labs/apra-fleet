import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

vi.mock('node:child_process');
vi.mock('node:fs');
vi.mock('node:os', () => ({
  default: {
    homedir: () => '/mock/home',
    userInfo: () => ({ username: 'mockuser' }),
  },
}));
vi.mock('../src/services/service-manager/index.js', () => ({
  gracefulStopByServerJson: vi.fn().mockResolvedValue(true),
}));

import { WindowsServiceManager, buildWrapperBat, cmdSetLine } from '../src/services/service-manager/windows.js';
import { LinuxServiceManager } from '../src/services/service-manager/linux.js';
import { MacOSServiceManager } from '../src/services/service-manager/macos.js';

function written(suffix: string): string {
  const call = vi.mocked(fs.writeFileSync).mock.calls.find(c => String(c[0]).endsWith(suffix));
  expect(call).toBeDefined();
  return String(call![1]);
}

describe('RegisterOptions.env -- Windows wrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(execFileSync).mockReturnValue('' as any);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined as any);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
  });

  it('writes a set line before the binary line', async () => {
    await new WindowsServiceManager().register('/bin/apra-fleet.exe', [], '/logs/fleet.log',
      { env: { APRA_FLEET_DATA_DIR: 'C:\\inst\\data' } });
    const bat = written('apra-fleet-service.bat');
    expect(bat).toContain('set "APRA_FLEET_DATA_DIR=C:\\inst\\data"');
    expect(bat.indexOf('APRA_FLEET_DATA_DIR')).toBeLessThan(bat.indexOf('/bin/apra-fleet.exe'));
  });

  it('keeps a space and an ampersand literal; doubles percent', () => {
    expect(cmdSetLine('APRA_FLEET_DATA_DIR', 'C:\\My Dir\\a&b%X%')).toBe('set "APRA_FLEET_DATA_DIR=C:\\My Dir\\a&b%%X%%"');
  });

  it('refuses a value it cannot quote, and a bad name', () => {
    expect(() => cmdSetLine('A', 'x"y')).toThrow(/double quote/);
    expect(() => cmdSetLine('A B', 'x')).toThrow(/Invalid/);
  });

  it('is byte-identical with no env or an empty env', () => {
    const base = buildWrapperBat('b.exe', ['x'], 'C:\\l\\f.log');
    expect(buildWrapperBat('b.exe', ['x'], 'C:\\l\\f.log', { env: {} })).toBe(base);
    expect(base).not.toMatch(/set "/);
  });
});

describe('RegisterOptions.env -- Linux unit', () => {
  const savedXdg = process.env.XDG_RUNTIME_DIR;
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.XDG_RUNTIME_DIR = '/run/user/1000';
    vi.mocked(execFileSync).mockReturnValue('' as any);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined as any);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(fs.existsSync).mockImplementation((p) => String(p).replace(/\\/g, '/').endsWith('/systemd'));
  });
  afterEach(() => {
    if (savedXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = savedXdg;
  });

  it('writes a quoted Environment= line, space-safe', async () => {
    await new LinuxServiceManager().register('/bin/apra-fleet', [], '/tmp/f.log',
      { env: { APRA_FLEET_DATA_DIR: '/srv/my inst/data' } });
    expect(written('apra-fleet.service')).toContain('Environment="APRA_FLEET_DATA_DIR=/srv/my inst/data"');
  });

  it('adds nothing without env', async () => {
    await new LinuxServiceManager().register('/bin/apra-fleet', [], '/tmp/f.log');
    expect(written('apra-fleet.service')).not.toContain('APRA_FLEET_DATA_DIR');
  });
});

describe('RegisterOptions.env -- macOS plist', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(execFileSync).mockReturnValue('' as any);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined as any);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  it('writes the variable with XML-escaped value (space, &, <)', async () => {
    await new MacOSServiceManager().register('/bin/apra-fleet', [], '/tmp/f.log',
      { env: { APRA_FLEET_DATA_DIR: '/Users/a b/x&y<z' } });
    const plist = written('.plist');
    expect(plist).toContain('<key>APRA_FLEET_DATA_DIR</key>');
    expect(plist).toContain('<string>/Users/a b/x&amp;y&lt;z</string>');
  });

  it('adds nothing without env', async () => {
    await new MacOSServiceManager().register('/bin/apra-fleet', [], '/tmp/f.log');
    expect(written('.plist')).not.toContain('APRA_FLEET_DATA_DIR');
  });
});
