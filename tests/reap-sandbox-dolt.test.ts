import { describe, it, expect } from 'vitest';
// @ts-expect-error -- plain .mjs helper, no type declarations
import {
  parsePsRows,
  parseWindowsRows,
  matchesSandboxDolt,
  listCandidates,
  reapSandboxDolt,
  ProbeToolMissingError,
} from '../scripts/reap-sandbox-dolt.mjs';

// Tests for scripts/reap-sandbox-dolt.mjs: regression-test-playbook.md's
// Teardown dolt-sql-server reap used to shell out straight to
// 'pgrep -f "dolt.*sql-server.*$SANDBOX" 2>/dev/null || true', which (a)
// silently no-ops on any host without pgrep (Git Bash on Windows), and
// (b) can never match when dolt-settle.mjs's resolveDoltStatus falls back
// to a RELATIVE default data dir, since the spawned command line then
// carries no absolute sandbox path at all. This suite exercises the
// portable parsing, the two-branch match rule, and the retry-loop decision
// logic via injected deps -- no real processes.

const SANDBOX = '/home/runner/temp/.apra-fleet-tests';

describe('parsePsRows', () => {
  it('derives startedAt from etimes (process age in seconds)', () => {
    const output = '  123   45   dolt sql-server --host 127.0.0.1 --port 13301 --data-dir /some/dir';
    const rows = parsePsRows(output, 1000);
    expect(rows).toEqual([{ pid: 123, startedAt: 955, args: 'dolt sql-server --host 127.0.0.1 --port 13301 --data-dir /some/dir' }]);
  });

  it('ignores unparsable lines', () => {
    expect(parsePsRows('garbage line with no columns', 1000)).toEqual([]);
  });

  it('returns empty array for blank output', () => {
    expect(parsePsRows('', 1000)).toEqual([]);
  });
});

describe('parseWindowsRows', () => {
  it('parses pipe-delimited pid|epoch|commandline rows', () => {
    const output = '4242|900|"C:\\dolt.exe" sql-server --host 127.0.0.1 --port 13301 --data-dir C:\\sandbox\\.beads\\embeddeddolt';
    expect(parseWindowsRows(output)).toEqual([
      { pid: 4242, startedAt: 900, args: '"C:\\dolt.exe" sql-server --host 127.0.0.1 --port 13301 --data-dir C:\\sandbox\\.beads\\embeddeddolt' },
    ]);
  });

  it('ignores rows missing the epoch column', () => {
    expect(parseWindowsRows('4242|not-a-number|dolt sql-server')).toEqual([]);
  });
});

describe('matchesSandboxDolt', () => {
  it('matches when the absolute sandbox path appears on the command line', () => {
    const row = { pid: 1, startedAt: 500, args: `dolt sql-server --data-dir ${SANDBOX}/toy-repo/.beads/dolt` };
    expect(matchesSandboxDolt(row, { sandboxPath: SANDBOX, since: 0 })).toBe(true);
  });

  it('does not match a non-sql-server dolt process even with the sandbox path present', () => {
    const row = { pid: 1, startedAt: 500, args: `dolt status --data-dir ${SANDBOX}/toy-repo/.beads/dolt` };
    expect(matchesSandboxDolt(row, { sandboxPath: SANDBOX, since: 0 })).toBe(false);
  });

  it('matches the RELATIVE default data dir only when started at/after "since"', () => {
    const row = { pid: 1, startedAt: 1000, args: 'dolt sql-server --host 127.0.0.1 --port 13301 --data-dir .beads/embeddeddolt' };
    expect(matchesSandboxDolt(row, { sandboxPath: SANDBOX, since: 999 })).toBe(true);
    expect(matchesSandboxDolt(row, { sandboxPath: SANDBOX, since: 1001 })).toBe(false);
  });

  it('does not match the relative default with no "since" bound (undefined/NaN)', () => {
    const row = { pid: 1, startedAt: 1000, args: 'dolt sql-server --data-dir .beads/embeddeddolt' };
    expect(matchesSandboxDolt(row, { sandboxPath: SANDBOX, since: undefined })).toBe(false);
    expect(matchesSandboxDolt(row, { sandboxPath: SANDBOX, since: NaN })).toBe(false);
  });

  it('does not match an unrelated dolt sql-server with neither the sandbox path nor the relative default', () => {
    const row = { pid: 1, startedAt: 1000, args: 'dolt sql-server --host 127.0.0.1 --port 13350 --data-dir /var/lib/dolt/production' };
    expect(matchesSandboxDolt(row, { sandboxPath: SANDBOX, since: 0 })).toBe(false);
  });

  it('normalizes backslashes so a Windows sandbox path still matches', () => {
    const winSandbox = 'C:\\Users\\runner\\temp\\.apra-fleet-tests';
    const row = { pid: 1, startedAt: 500, args: 'dolt sql-server --data-dir C:\\Users\\runner\\temp\\.apra-fleet-tests\\toy-repo\\.beads\\dolt' };
    expect(matchesSandboxDolt(row, { sandboxPath: winSandbox, since: 0 })).toBe(true);
  });
});

describe('listCandidates', () => {
  it('throws ProbeToolMissingError when ps is absent on a POSIX host', () => {
    const deps = {
      platform: 'linux',
      execFileSync: () => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); },
    };
    expect(() => listCandidates(deps)).toThrow(ProbeToolMissingError);
  });

  it('throws ProbeToolMissingError when powershell is absent on a Windows host', () => {
    const deps = {
      platform: 'win32',
      execFileSync: () => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); },
    };
    expect(() => listCandidates(deps)).toThrow(ProbeToolMissingError);
  });

  it('rethrows a non-ENOENT PowerShell failure on Windows rather than swallowing it as "no processes found"', () => {
    // Get-CimInstance's own -ErrorAction SilentlyContinue already makes the
    // real "nothing found" case exit 0 with empty output, so a non-zero
    // exit here means the probe script itself failed (bad quoting, CIM
    // access denied, etc.) -- treating that as an empty result would be a
    // false "no matching processes remain".
    const deps = {
      platform: 'win32',
      execFileSync: () => { throw Object.assign(new Error('script error'), { code: 1, stdout: '' }); },
    };
    expect(() => listCandidates(deps)).toThrow(/script error/);
  });
});

describe('reapSandboxDolt', () => {
  it('returns ok:true immediately when no candidates match', async () => {
    const deps = {
      platform: 'linux',
      execFileSync: () => '',
      now: () => 0,
    };
    const result = await reapSandboxDolt({ sandboxPath: SANDBOX, since: 0, deadlineMs: 1000 }, deps);
    expect(result.ok).toBe(true);
  });

  it('kills (via process.kill, not a shelled-out "kill" binary) a matching process and succeeds once it is gone', async () => {
    let calls = 0;
    const killed = [];
    const deps = {
      platform: 'linux',
      execFileSync: (cmd) => {
        if (cmd === 'ps') {
          calls += 1;
          return calls === 1
            ? `4242   30   dolt sql-server --data-dir ${SANDBOX}/toy-repo/.beads/dolt`
            : '';
        }
        return '';
      },
      processKill: (pid) => { killed.push(pid); },
      sleep: async () => {},
      now: () => 1000,
    };
    const result = await reapSandboxDolt({ sandboxPath: SANDBOX, since: 0, deadlineMs: 5000 }, deps);
    expect(result.ok).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(killed).toEqual([4242]);
  });

  it('fails loud, naming the surviving process, if it outlives the deadline', async () => {
    let now = 0;
    const deps = {
      platform: 'linux',
      execFileSync: (cmd) => (cmd === 'ps'
        ? `4242   30   dolt sql-server --data-dir ${SANDBOX}/toy-repo/.beads/dolt`
        : ''),
      processKill: () => {},
      sleep: async () => { now += 1000; },
      now: () => now,
    };
    const result = await reapSandboxDolt({ sandboxPath: SANDBOX, since: 0, deadlineMs: 2000 }, deps);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/pid 4242/);
  });

  it('never widens to a bare match: an unrelated dolt sql-server on the same host is left untouched', async () => {
    const deps = {
      platform: 'linux',
      execFileSync: (cmd) => (cmd === 'ps'
        ? '9999   30   dolt sql-server --host 127.0.0.1 --port 13350 --data-dir /var/lib/dolt/production'
        : ''),
      now: () => 1000,
    };
    const result = await reapSandboxDolt({ sandboxPath: SANDBOX, since: 0, deadlineMs: 1000 }, deps);
    expect(result.ok).toBe(true);
    expect(result.matches).toEqual([]);
  });
});
