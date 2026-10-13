import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openOwnerOnlyLog, shortSid } from '../src/utils/log-helpers.js';

// The server log is opened by openOwnerOnlyLog (getFd's first call). These
// tests drive it against a temp data dir so nothing outside that dir is
// touched; every temp dir is removed afterwards.
const tmpDirs: string[] = [];
const fds: number[] = [];
afterEach(() => {
  for (const fd of fds.splice(0)) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tempDataDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-log-perms-'));
  tmpDirs.push(root);
  return path.join(root, 'data');
}

describe.skipIf(process.platform === 'win32')('server log is owner-only on POSIX (skipped on win32: no POSIX mode bits; the Windows path is covered below)', () => {
  it('a fresh start creates the data dir and logs dir 0700 and fleet-<pid>.log 0600', () => {
    const dataDir = tempDataDir();
    const { fd, logFile, problems } = openOwnerOnlyLog(dataDir, 4242);
    fds.push(fd);
    expect(problems).toEqual([]);
    expect(logFile).toBe(path.join(dataDir, 'logs', 'fleet-4242.log'));
    expect(fs.statSync(logFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dataDir, 'logs')).mode & 0o777).toBe(0o700);
  });

  it('pre-existing 0644 fleet.log and fleet-<pid>.log and 0755 dirs are tightened at start', () => {
    const dataDir = tempDataDir();
    const logsDir = path.join(dataDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true, mode: 0o755 });
    fs.chmodSync(dataDir, 0o755);
    fs.chmodSync(logsDir, 0o755);
    const serviceLog = path.join(dataDir, 'fleet.log');
    const pidLog = path.join(logsDir, 'fleet-4243.log');
    for (const f of [serviceLog, pidLog]) {
      fs.writeFileSync(f, 'old line\n');
      fs.chmodSync(f, 0o644);
    }

    const { fd, problems } = openOwnerOnlyLog(dataDir, 4243);
    fds.push(fd);
    expect(problems).toEqual([]);
    expect(fs.statSync(serviceLog).mode & 0o777).toBe(0o600);
    expect(fs.statSync(pidLog).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(logsDir).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(pidLog, 'utf8')).toBe('old line\n');
  });
});

describe('server log is owner-only on Windows (platform and execFile mocked)', () => {
  it('restricts the data dir, logs dir, fleet-<pid>.log and fleet.log to the current user with icacls', () => {
    const dataDir = tempDataDir();
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'fleet.log'), '');
    const calls: Array<[string, string[]]> = [];
    const { fd, logFile, problems } = openOwnerOnlyLog(dataDir, 4244, {
      platform: 'win32',
      windowsUser: 'TESTDOM\\tester',
      execFile: (file, args) => { calls.push([file, args]); },
    });
    fds.push(fd);
    expect(problems).toEqual([]);
    expect(calls).toEqual([
      ['icacls', [dataDir, '/inheritance:r', '/grant:r', 'TESTDOM\\tester:(OI)(CI)F']],
      ['icacls', [path.join(dataDir, 'logs'), '/inheritance:r', '/grant:r', 'TESTDOM\\tester:(OI)(CI)F']],
      ['icacls', [logFile, '/inheritance:r', '/grant:r', 'TESTDOM\\tester:F']],
      ['icacls', [path.join(dataDir, 'fleet.log'), '/inheritance:r', '/grant:r', 'TESTDOM\\tester:F']],
    ]);
  });

  it('an icacls failure is reported, never fatal: the log still opens', () => {
    const dataDir = tempDataDir();
    const { fd, problems } = openOwnerOnlyLog(dataDir, 4245, {
      platform: 'win32',
      windowsUser: 'tester',
      execFile: () => { throw new Error('Access is denied.'); },
    });
    fds.push(fd);
    expect(fd).toBeGreaterThanOrEqual(0);
    expect(problems.length).toBe(3);
    expect(problems[0]).toContain('Access is denied.');
  });
});

describe('shortSid', () => {
  it('keeps only the first 8 characters of a session id', () => {
    const sid = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
    expect(shortSid(sid)).toBe('1a2b3c4d...');
    expect(shortSid(sid)).not.toContain(sid.slice(8));
    expect(shortSid(undefined)).toBe('none');
  });
});
