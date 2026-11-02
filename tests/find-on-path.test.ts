import { describe, it, expect } from 'vitest';
import { findExecutableOnPath, npxUnavailableReason } from '../src/utils/find-on-path.js';

// Injected file table: no real PATH or filesystem is consulted.
const filesIn = (...files: string[]) => (p: string) => files.includes(p);
const pathExt = '.exe;.cmd';

describe('findExecutableOnPath win32 PATHEXT resolution', () => {
  it('prefers foo.cmd over extensionless foo and foo.ps1 in the same dir', () => {
    const isFile = filesIn('C:\\d\\foo', 'C:\\d\\foo.cmd', 'C:\\d\\foo.ps1');
    expect(findExecutableOnPath('foo', { platform: 'win32', envPath: 'C:\\d', pathExt, isFile })).toBe('C:\\d\\foo.cmd');
  });

  it('skips an extensionless foo in an earlier dir and returns foo.cmd from a later one', () => {
    const isFile = filesIn('C:\\dir1\\foo', 'C:\\dir2\\foo.cmd');
    expect(findExecutableOnPath('foo', { platform: 'win32', envPath: 'C:\\dir1;C:\\dir2', pathExt, isFile })).toBe('C:\\dir2\\foo.cmd');
  });

  it('resolves a name already carrying a PATHEXT extension (mixed case)', () => {
    const isFile = filesIn('C:\\d\\foo.CMD');
    expect(findExecutableOnPath('foo.CMD', { platform: 'win32', envPath: 'C:\\d', pathExt, isFile })).toBe('C:\\d\\foo.CMD');
  });

  it('resolves npx to npx.cmd and reports npx available', () => {
    const isFile = filesIn('C:\\node\\npx', 'C:\\node\\npx.cmd');
    const opts = { platform: 'win32' as const, envPath: 'C:\\node', pathExt, isFile };
    expect(findExecutableOnPath('npx', opts)).toBe('C:\\node\\npx.cmd');
    expect(npxUnavailableReason(opts)).toBeNull();
  });

  it('returns null when only an extensionless foo exists', () => {
    const isFile = filesIn('C:\\d\\foo');
    expect(findExecutableOnPath('foo', { platform: 'win32', envPath: 'C:\\d', pathExt, isFile })).toBeNull();
  });
});

describe('findExecutableOnPath posix', () => {
  it('still resolves a bare name', () => {
    const isFile = filesIn('/usr/bin/foo');
    expect(findExecutableOnPath('foo', { platform: 'linux', envPath: '/bin:/usr/bin', isFile })).toBe('/usr/bin/foo');
  });
});
