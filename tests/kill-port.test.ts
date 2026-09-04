import { describe, it, expect } from 'vitest';
// @ts-expect-error -- plain .mjs helper, no type declarations
import {
  parseLsofPids,
  parseNetstatPids,
  findPids,
  waitPortFree,
  ProbeToolMissingError,
} from '../scripts/kill-port.mjs';

// Tests for scripts/kill-port.mjs: regression-test-playbook.md's Setup and
// Reset port-kill loops used to shell out straight to 'lsof -ti tcp:$PORT
// 2>/dev/null || true', which silently reports "port free" on any host
// without lsof (Git Bash on Windows). This suite exercises the parsing and
// retry-loop decision logic via injected deps -- no real ports or processes.

describe('parseLsofPids', () => {
  it('parses one PID per line', () => {
    expect(parseLsofPids('1234\n5678\n')).toEqual(['1234', '5678']);
  });

  it('returns empty array for empty/blank output', () => {
    expect(parseLsofPids('')).toEqual([]);
    expect(parseLsofPids('\n\n')).toEqual([]);
  });

  it('ignores non-numeric noise lines', () => {
    expect(parseLsofPids('1234\nnot-a-pid\n5678')).toEqual(['1234', '5678']);
  });
});

describe('parseNetstatPids', () => {
  const sample = [
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:18700          0.0.0.0:0              LISTENING       4242',
    '  TCP    127.0.0.1:18700        127.0.0.1:51000        ESTABLISHED     4242',
    '  TCP    0.0.0.0:7523           0.0.0.0:0              LISTENING       9999',
    '  UDP    0.0.0.0:18700          *:*                                    5555',
  ].join('\r\n');

  it('matches every row whose local address ends in :port, across TCP/UDP and any state', () => {
    expect(parseNetstatPids(sample, 18700).sort()).toEqual(['4242', '5555']);
  });

  it('does not match a different port', () => {
    expect(parseNetstatPids(sample, 7523)).toEqual(['9999']);
  });

  it('does not false-positive on a port that is merely a substring (e.g. 700 inside 18700)', () => {
    expect(parseNetstatPids(sample, 700)).toEqual([]);
  });

  it('returns empty array for output with no matching rows', () => {
    expect(parseNetstatPids(sample, 65000)).toEqual([]);
  });

  it('excludes PID 0 rows (netstat reports 0 for some TIME_WAIT/closing rows with no real owning process)', () => {
    const withZeroPid = [
      '  TCP    0.0.0.0:18700          0.0.0.0:0              TIME_WAIT       0',
    ].join('\r\n');
    expect(parseNetstatPids(withZeroPid, 18700)).toEqual([]);
  });

  it('does not match on the FOREIGN address column -- a loopback client whose remote port happens to equal the target port is not the server', () => {
    // The client-side socket of a loopback connection to the server: its
    // OWN local address is the ephemeral port (51000), and the foreign
    // address is the server's port (18700). Only the server-side row
    // (local address == :18700, tested above) should match.
    const clientSideRow = '  TCP    127.0.0.1:51000        127.0.0.1:18700        ESTABLISHED     7777';
    expect(parseNetstatPids(clientSideRow, 18700)).toEqual([]);
  });
});

describe('findPids', () => {
  it('throws ProbeToolMissingError when lsof is absent on a POSIX host', () => {
    const deps = {
      platform: 'linux',
      execFileSync: () => {
        throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      },
    };
    expect(() => findPids(18700, deps)).toThrow(ProbeToolMissingError);
  });

  it('throws ProbeToolMissingError when netstat is absent on a Windows host', () => {
    const deps = {
      platform: 'win32',
      execFileSync: () => {
        throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      },
    };
    expect(() => findPids(18700, deps)).toThrow(ProbeToolMissingError);
  });

  it('treats a non-ENOENT lsof failure (nothing bound) as an empty result, not a missing tool', () => {
    const deps = {
      platform: 'linux',
      execFileSync: () => {
        throw Object.assign(new Error('exit 1'), { code: 1 });
      },
    };
    expect(findPids(18700, deps)).toEqual([]);
  });

  it('parses real lsof output on POSIX', () => {
    const deps = { platform: 'linux', execFileSync: () => '4242\n' };
    expect(findPids(18700, deps)).toEqual(['4242']);
  });

  it('parses real netstat output on Windows', () => {
    const deps = {
      platform: 'win32',
      execFileSync: () => '  TCP    0.0.0.0:18700    0.0.0.0:0    LISTENING    4242',
    };
    expect(findPids(18700, deps)).toEqual(['4242']);
  });
});

describe('waitPortFree', () => {
  it('returns ok:true immediately when the port is already free', async () => {
    const deps = { platform: 'linux', execFileSync: () => { throw { code: 1 }; } };
    const result = await waitPortFree(18700, 'test port', 1000, deps);
    expect(result.ok).toBe(true);
  });

  it('kills (via process.kill, not a shelled-out "kill" binary) and re-probes until the port frees, then succeeds', async () => {
    let calls = 0;
    const killed = [];
    const deps = {
      platform: 'linux',
      execFileSync: (cmd) => {
        if (cmd === 'lsof') {
          calls += 1;
          return calls === 1 ? '4242\n' : '';
        }
        return '';
      },
      processKill: (pid) => { killed.push(pid); },
      sleep: async () => {},
      now: () => 0,
    };
    const result = await waitPortFree(18700, 'test port', 5000, deps);
    expect(result.ok).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(killed).toEqual([4242]);
  });

  it('fails loud (ok:false, names the still-bound pid) if the port stays occupied past the deadline', async () => {
    let now = 0;
    const deps = {
      platform: 'linux',
      execFileSync: (cmd) => (cmd === 'lsof' ? '4242\n' : ''),
      processKill: () => {},
      sleep: async () => { now += 1000; },
      now: () => now,
    };
    const result = await waitPortFree(18700, 'test port', 2000, deps);
    expect(result.ok).toBe(false);
    expect(result.pids).toContain('4242');
    expect(result.message).toMatch(/still bound/);
  });

  it('propagates ProbeToolMissingError rather than reporting a false "port free"', async () => {
    const deps = {
      platform: 'linux',
      execFileSync: () => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); },
    };
    await expect(waitPortFree(18700, 'test port', 1000, deps)).rejects.toThrow(ProbeToolMissingError);
  });
});
