import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

// vi.hoisted so these refs are available inside vi.mock factory closures
const { mockGracefulStop } = vi.hoisted(() => ({
  mockGracefulStop: vi.fn<(fallback?: (pid: number) => void) => Promise<boolean | void>>().mockResolvedValue(true),
}));

vi.mock('node:child_process');
vi.mock('node:fs');
vi.mock('node:os', () => ({
  default: {
    homedir: () => '/mock/home',
    userInfo: () => ({ username: 'mockuser' }),
  },
}));
vi.mock('../src/services/service-manager/index.js', () => ({
  gracefulStopByServerJson: mockGracefulStop,
}));

import { WindowsServiceManager } from '../src/services/service-manager/windows.js';
import { LinuxServiceManager } from '../src/services/service-manager/linux.js';
import { MacOSServiceManager } from '../src/services/service-manager/macos.js';

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
describe('WindowsServiceManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(execFileSync).mockReturnValue('' as any);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined as any);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(fs.unlinkSync).mockReturnValue(undefined);
  });

  describe('register', () => {
    it('writes wrapper bat containing the binary invocation', async () => {
      const mgr = new WindowsServiceManager();
      await mgr.register('/bin/apra-fleet.exe', ['--transport', 'http'], '/logs/fleet.log');
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('apra-fleet-service.bat'),
        expect.stringContaining('@echo off'),
        'utf8',
      );
      const call = vi.mocked(fs.writeFileSync).mock.calls[0];
      expect(call[1]).toContain('/bin/apra-fleet.exe');
      expect(call[1]).toContain('"--transport" "http"');
      expect(call[1]).toContain('set APRA_FLEET_SERVICE=1'); // service-launch marker
    });

    // GitHub #585 recovery: /sc onlogon is "Access is denied" for a standard
    // user; the user-scoped XML definition is not.
    it('calls schtasks /create /xml (never /sc onlogon)', async () => {
      const mgr = new WindowsServiceManager();
      await mgr.register('/bin/apra-fleet.exe', ['--transport', 'http'], '/logs/fleet.log');
      expect(execFileSync).toHaveBeenCalledWith('schtasks', [
        '/create', '/tn', 'ApraFleet', '/xml', expect.stringContaining('apra-fleet-task.xml'), '/f',
      ], expect.objectContaining({ timeout: expect.any(Number) }));
      const all = vi.mocked(execFileSync).mock.calls.flatMap(c => c[1] as string[]);
      expect(all).not.toContain('onlogon');
    });
  });

  describe('unregister', () => {
    it('deletes the scheduled task and removes the wrapper bat', async () => {
      const mgr = new WindowsServiceManager();
      await mgr.unregister();
      expect(execFileSync).toHaveBeenCalledWith('schtasks', ['/delete', '/tn', 'ApraFleet', '/f'], expect.objectContaining({ stdio: 'pipe', windowsHide: true }));
      expect(fs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining('apra-fleet-service.bat'));
    });

    it('tolerates task-not-found error (idempotent)', async () => {
      vi.mocked(execFileSync).mockImplementationOnce(() => { throw new Error('cannot find'); });
      const mgr = new WindowsServiceManager();
      await expect(mgr.unregister()).resolves.not.toThrow();
    });
  });

  describe('start', () => {
    it('calls schtasks /run via detached spawn', async () => {
      const { spawn } = await import('node:child_process');
      const mockChild = { unref: vi.fn() };
      vi.mocked(spawn).mockReturnValueOnce(mockChild as any);
      const mgr = new WindowsServiceManager();
      await mgr.start();
      expect(spawn).toHaveBeenCalledWith('schtasks', ['/run', '/tn', 'ApraFleet'], expect.objectContaining({ detached: true, stdio: 'ignore', windowsHide: true }));
      expect(mockChild.unref).toHaveBeenCalled();
    });
  });

  describe('stop', () => {
    it('calls gracefulStopByServerJson with a fallback function', async () => {
      const mgr = new WindowsServiceManager();
      await mgr.stop();
      expect(mockGracefulStop).toHaveBeenCalledWith(expect.any(Function));
    });

    it('returns false when the graceful stop refused to force-kill', async () => {
      mockGracefulStop.mockResolvedValueOnce(false);
      expect(await new WindowsServiceManager().stop()).toBe(false);
    });

    it('fallback invokes taskkill /F /PID', async () => {
      let capturedFallback: ((pid: number) => void) | undefined;
      mockGracefulStop.mockImplementationOnce(async (fn) => { capturedFallback = fn; });
      const mgr = new WindowsServiceManager();
      await mgr.stop();
      capturedFallback!(4242);
      expect(execFileSync).toHaveBeenCalledWith('taskkill', ['/F', '/PID', '4242'], expect.objectContaining({ stdio: 'pipe', windowsHide: true }));
    });
  });

  // -------------------------------------------------------------------------
  // query() -- state matrix.
  //
  // REGRESSION CONTEXT: on a fresh Windows install both scheduled tasks were
  // running and answering /health, yet `apra-fleet status` printed "installed
  // (disabled)" for both, because query() never populated `enabled` at all.
  // It also decided `running` by comparing the schtasks CSV Status column to
  // the English literal 'Running', which is wrong on a localized Windows.
  // The primary source is now an -EncodedCommand Get-ScheduledTask probe that
  // emits the NUMERIC state enum (1=Disabled, 2=Queued, 3=Ready, 4=Running).
  // Expected values below are written out literally, never computed from
  // production code.
  // -------------------------------------------------------------------------
  describe('query', () => {
    /**
     * Route the single mocked execFileSync by command. `probe`/`csv` may be a
     * string (stdout) or an Error to throw; omitted means "this command is
     * unavailable / fails".
     */
    function mockHost(opts: { probe?: string | Error; csv?: string | Error }): void {
      vi.mocked(execFileSync).mockImplementation(((cmd: string) => {
        if (cmd === 'powershell') {
          if (opts.probe === undefined) throw new Error('powershell: not found');
          if (opts.probe instanceof Error) throw opts.probe;
          return opts.probe as any;
        }
        if (cmd === 'schtasks') {
          if (opts.csv === undefined) throw new Error('ERROR: The system cannot find the task');
          if (opts.csv instanceof Error) throw opts.csv;
          return opts.csv as any;
        }
        // No HKCU Run fallback entry on this host (reg query fails).
        if (cmd === 'reg') throw new Error('ERROR: The system was unable to find the specified registry key or value.');
        return '' as any;
      }) as any);
    }

    function decodedProbeScripts(): string[] {
      return vi.mocked(execFileSync).mock.calls
        .filter(([cmd]) => cmd === 'powershell')
        .map(([, args]) => Buffer.from(String((args as string[])[3]), 'base64').toString('utf16le'));
    }

    it('a RUNNING task is installed, running and enabled', async () => {
      mockHost({ probe: '4\r\n' });
      expect(await new WindowsServiceManager().query())
        .toEqual({ installed: true, running: true, enabled: true });
    });

    it('a DISABLED task reports enabled:false', async () => {
      mockHost({ probe: '1\r\n' });
      expect(await new WindowsServiceManager().query())
        .toEqual({ installed: true, running: false, enabled: false, detail: expect.stringContaining('disabled') });
    });

    it('a registered-but-idle READY task is enabled and not running', async () => {
      mockHost({ probe: '3\r\n' });
      expect(await new WindowsServiceManager().query())
        .toEqual({ installed: true, running: false, enabled: true });
    });

    it('a QUEUED task is enabled and not running', async () => {
      mockHost({ probe: '2\r\n' });
      expect(await new WindowsServiceManager().query())
        .toEqual({ installed: true, running: false, enabled: true });
    });

    it('a task that does not exist is not installed', async () => {
      mockHost({ probe: 'NOTFOUND\r\n' });
      expect(await new WindowsServiceManager().query())
        .toEqual({ installed: false, running: false });
    });

    it('probes with -EncodedCommand only, interpolating just this task name', async () => {
      mockHost({ probe: '4\r\n' });
      await new WindowsServiceManager().query();
      const psCalls = vi.mocked(execFileSync).mock.calls.filter(([cmd]) => cmd === 'powershell');
      expect(psCalls).toHaveLength(1);
      const args = psCalls[0][1] as string[];
      // No raw one-liner and no shell expansion (CLAUDE.md Windows rule).
      expect(args).toHaveLength(4);
      expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
      const script = decodedProbeScripts()[0];
      expect(script).toContain('Get-ScheduledTask');
      expect(script).toContain("-TaskName 'ApraFleet'");
      // Numeric state enum, so the mapping is locale-independent.
      expect(script).toContain('[int]$t.State');
      expect(script).not.toContain('$env:');
      expect(script).not.toContain('~');
    });

    it('per-service scoping: the supervisor manager probes only its own task', async () => {
      mockHost({ probe: '4\r\n' });
      await new WindowsServiceManager('fleet-supervisor').query();
      const script = decodedProbeScripts()[0];
      expect(script).toContain("-TaskName 'ApraFleetSupervisor'");
      expect(script).not.toContain("-TaskName 'ApraFleet'");
      for (const [cmd, args] of vi.mocked(execFileSync).mock.calls) {
        if (cmd === 'schtasks') expect(args as string[]).toContain('ApraFleetSupervisor');
      }
    });

    describe('schtasks CSV fallback (PowerShell probe unusable)', () => {
      it('is used when the probe throws, and maps Running honestly', async () => {
        mockHost({ probe: new Error('powershell is not recognized'), csv: '"ApraFleet","N/A","Running"\r\n' });
        expect(await new WindowsServiceManager().query())
          .toEqual({ installed: true, running: true, enabled: true });
        expect(vi.mocked(execFileSync).mock.calls.some(([cmd]) => cmd === 'schtasks')).toBe(true);
      });

      it('maps an explicit Disabled status to enabled:false', async () => {
        mockHost({ probe: new Error('no powershell'), csv: '"ApraFleet","N/A","Disabled"\r\n' });
        expect(await new WindowsServiceManager().query())
          .toEqual({ installed: true, running: false, enabled: false, detail: expect.stringContaining('disabled') });
      });

      it('leaves enabled UNDEFINED for a status string it does not recognize', async () => {
        // Localized Windows: the Status column is not English, so the only
        // honest answer is "registered, not observably running, enable state
        // unknown" -- never a guessed enabled:false.
        mockHost({ probe: new Error('no powershell'), csv: '"ApraFleet","N/A","Wird ausgefuehrt"\r\n' });
        const status = await new WindowsServiceManager().query();
        expect(status).toEqual({ installed: true, running: false });
        expect('enabled' in status).toBe(false);
      });

      it('leaves enabled UNDEFINED for English Ready as well', async () => {
        mockHost({ probe: new Error('no powershell'), csv: '"ApraFleet","N/A","Ready"\r\n' });
        const status = await new WindowsServiceManager().query();
        expect(status).toEqual({ installed: true, running: false });
        expect('enabled' in status).toBe(false);
      });

      it('falls back when the probe returns output it cannot interpret', async () => {
        mockHost({ probe: 'Get-ScheduledTask : Access denied\r\n', csv: '"ApraFleet","N/A","Running"\r\n' });
        expect(await new WindowsServiceManager().query())
          .toEqual({ installed: true, running: true, enabled: true });
      });

      it('returns not installed when neither probe nor schtasks can answer', async () => {
        mockHost({});
        expect(await new WindowsServiceManager().query())
          .toEqual({ installed: false, running: false });
      });
    });

    // GitHub #585: an installed, enabled task must report enabled (status
    // showed every installed task as "installed (disabled)").
    it('reports enabled=true for a task whose XML has <Settings><Enabled>true', async () => {
      vi.mocked(execFileSync).mockImplementation(((_cmd: string, args: string[]) => args.includes('/xml')
        ? '<Task><Settings><Enabled>true</Enabled></Settings><Actions><Exec><Command>x</Command></Exec></Actions></Task>'
        : '"ApraFleet","N/A","Ready"\r\n') as any);
      expect(await new WindowsServiceManager().query()).toEqual({ installed: true, running: false, enabled: true });
    });

    it('reports enabled=false for a task whose (UTF-16) XML has <Settings><Enabled>false', async () => {
      vi.mocked(execFileSync).mockImplementation(((_cmd: string, args: string[]) => args.includes('/xml')
        ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<Task><Settings><Enabled>false</Enabled></Settings></Task>', 'utf16le')])
        : '"ApraFleet","N/A","Disabled"\r\n') as any);
      expect(await new WindowsServiceManager().query()).toEqual({
        installed: true, running: false, enabled: false, detail: expect.stringContaining('disabled'),
      });
    });

    // GitHub #585: no schtasks/taskkill stderr may reach the console above status.
    it('every schtasks probe pipes stdio and hides its window', async () => {
      vi.mocked(execFileSync).mockImplementation(() => { throw new Error('ERROR: The system cannot find the file specified.'); });
      const mgr = new WindowsServiceManager();
      await mgr.query();
      await mgr.isInstalled();
      await mgr.unregister();
      expect(vi.mocked(execFileSync).mock.calls.length).toBeGreaterThanOrEqual(3);
      for (const call of vi.mocked(execFileSync).mock.calls) {
        expect(call[2]).toMatchObject({ stdio: 'pipe', windowsHide: true });
      }
    });
  });

  describe('isInstalled', () => {
    it('returns true when schtasks query succeeds', async () => {
      vi.mocked(execFileSync).mockReturnValue('' as any);
      expect(await new WindowsServiceManager().isInstalled()).toBe(true);
    });

    it('returns false when schtasks query throws', async () => {
      vi.mocked(execFileSync).mockImplementation(() => { throw new Error('not found'); });
      expect(await new WindowsServiceManager().isInstalled()).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Windows -- 'fleet-supervisor' stop must take down the WHOLE process tree.
//
// The scheduled task's action is a wrapper .bat, so the process the Task
// Scheduler owns is a cmd.exe and the apra-fleet process actually holding the
// supervisor port is its CHILD. `schtasks /end` alone could leave that child
// alive as an orphan still bound to the port while query() reported the task
// as not Running -- so `apra-fleet stop` printed "Fleet supervisor service
// stopped." and the next `apra-fleet start` could not bind.
//
// REGRESSION GUARD (which assertion fails if the impl is reverted to a bare
// `schtasks /end` for fleet-supervisor):
//   expect(execFileSync).toHaveBeenCalledWith(
//     'taskkill', ['/F', '/T', '/PID', '4242'])
// in 'taskkills the wrapper pid WITH /T so the apra-fleet child dies with
// it'. A bare /end issues no taskkill at all, so that exact-argument-vector
// assertion is the guard. The ordering assertion in 'discovers the wrapper
// pid BEFORE ending the task' is the second guard -- a reverted impl makes no
// discovery call either, so its discoveryIdx >= 0 expectation fails too.
//
// PLATFORM INDEPENDENCE (same discipline as the header of
// tests/service-manager-name-isolation.test.ts): node:child_process,
// node:fs and node:os are mocked at the top of this file, so execFileSync and
// spawn -- the only child_process entry points this manager uses -- are both
// automocked and NO real powershell / taskkill / schtasks process is ever
// spawned. Nothing below reads or overrides process.platform, so this block
// passes identically on Linux, macOS and Windows.
// ---------------------------------------------------------------------------
describe('WindowsServiceManager -- fleet-supervisor stop terminates the process tree', () => {
  const SUPERVISOR_WRAPPER = 'apra-fleet-supervisor-service.bat';
  const MCP_WRAPPER = 'apra-fleet-service.bat';
  const WRAPPER_PID = 4242;

  function supervisor() {
    return new WindowsServiceManager('fleet-supervisor');
  }

  /** Every execFileSync call as a [command, args] pair, in call order. */
  function calledCommands(): Array<[string, string[]]> {
    return vi.mocked(execFileSync).mock.calls.map(c =>
      [String(c[0]), ((c[1] ?? []) as unknown as string[])],
    );
  }

  /** Index of the first execFileSync call matching a predicate, or -1. */
  function callIndex(pred: (cmd: string, args: string[]) => boolean): number {
    return calledCommands().findIndex(([cmd, args]) => pred(cmd, args));
  }

  /** The PowerShell scripts handed to `powershell -EncodedCommand`, decoded. */
  function decodedDiscoveryScripts(): string[] {
    return calledCommands()
      .filter(([cmd]) => cmd === 'powershell')
      .map(([, args]) => Buffer.from(
        args[args.indexOf('-EncodedCommand') + 1], 'base64',
      ).toString('utf16le'));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined as any);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(fs.unlinkSync).mockReturnValue(undefined);
    // Default simulated host: exactly one live wrapper process, and every
    // command succeeds.
    vi.mocked(execFileSync).mockImplementation((cmd: any, _args: any) =>
      (cmd === 'powershell' ? `${WRAPPER_PID}\r\n` : '') as any,
    );
  });

  it('taskkills the wrapper pid WITH /T so the apra-fleet child dies with it', async () => {
    await supervisor().stop();
    // REGRESSION GUARD -- see the block header. /T is the whole point: it is
    // what extends the kill from the cmd.exe wrapper to its descendants.
    expect(execFileSync).toHaveBeenCalledWith(
      'taskkill', ['/F', '/T', '/PID', String(WRAPPER_PID)], expect.objectContaining({ stdio: 'pipe', windowsHide: true }),
    );
  });

  it('discovers the pid with an encoded PowerShell query scoped to THIS service wrapper', async () => {
    await supervisor().stop();

    const psCalls = calledCommands().filter(([cmd]) => cmd === 'powershell');
    expect(psCalls).toHaveLength(1);
    const [, psArgs] = psCalls[0];
    // Explicit -EncodedCommand, never a raw one-liner: no path or argument is
    // ever handed to a Windows shell to re-parse (CLAUDE.md convention).
    expect(psArgs).toHaveLength(4);
    expect(psArgs.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);

    const script = decodedDiscoveryScripts()[0];
    expect(script).toContain('Win32_Process');
    expect(script).toContain('ProcessId');
    expect(script).toContain(SUPERVISOR_WRAPPER);
    // Scoped to one service: it can never match the MCP server's wrapper.
    expect(script).not.toContain(MCP_WRAPPER);
  });

  it('discovers the wrapper pid BEFORE ending the task -- /end first would orphan the child', async () => {
    await supervisor().stop();
    const discoveryIdx = callIndex(cmd => cmd === 'powershell');
    const treeKillIdx = callIndex((cmd, args) => cmd === 'taskkill' && args.includes('/T'));
    const endIdx = callIndex((cmd, args) => cmd === 'schtasks' && args[0] === '/end');
    expect(discoveryIdx).toBeGreaterThanOrEqual(0);
    expect(treeKillIdx).toBeGreaterThan(discoveryIdx);
    expect(endIdx).toBeGreaterThan(treeKillIdx);
  });

  it('still ends the scheduled task, under its own task name, for scheduler bookkeeping', async () => {
    await supervisor().stop();
    expect(execFileSync).toHaveBeenCalledWith('schtasks', ['/end', '/tn', 'ApraFleetSupervisor'], expect.objectContaining({ stdio: 'pipe', windowsHide: true }));
    expect(execFileSync).not.toHaveBeenCalledWith('schtasks', ['/end', '/tn', 'ApraFleet'], expect.anything());
  });

  it('tree-kills EVERY matching wrapper pid, not just the first', async () => {
    vi.mocked(execFileSync).mockImplementation((cmd: any, _args: any) =>
      (cmd === 'powershell' ? '4242\r\n4243\r\n\r\n' : '') as any,
    );
    await supervisor().stop();
    expect(execFileSync).toHaveBeenCalledWith('taskkill', ['/F', '/T', '/PID', '4242'], expect.objectContaining({ stdio: 'pipe', windowsHide: true }));
    expect(execFileSync).toHaveBeenCalledWith('taskkill', ['/F', '/T', '/PID', '4243'], expect.objectContaining({ stdio: 'pipe', windowsHide: true }));
  });

  it('never uses the MCP server server.json handshake', async () => {
    await supervisor().stop();
    expect(mockGracefulStop).not.toHaveBeenCalled();
  });

  // -- tolerated failures -----------------------------------------------
  it('resolves when nothing is running and the task is not registered', async () => {
    vi.mocked(execFileSync).mockImplementation((cmd: any, _args: any) => {
      if (cmd === 'powershell') return '' as any; // no wrapper process alive
      if (cmd === 'schtasks') throw new Error('ERROR: The system cannot find the file specified.');
      return '' as any;
    });
    await expect(supervisor().stop()).resolves.toBe(true);
    expect(execFileSync).not.toHaveBeenCalledWith('taskkill', expect.anything(), expect.anything());
  });

  it('tolerates the pid exiting between discovery and the kill (taskkill exit 128)', async () => {
    vi.mocked(execFileSync).mockImplementation((cmd: any, _args: any) => {
      if (cmd === 'powershell') return `${WRAPPER_PID}\r\n` as any;
      if (cmd === 'taskkill') {
        const err: any = new Error(`ERROR: The process "${WRAPPER_PID}" not found.`);
        err.status = 128;
        throw err;
      }
      return '' as any;
    });
    await expect(supervisor().stop()).resolves.toBe(true);
  });

  // -- loud failures: a survivor must never read as "stopped" ------------
  it('rejects when the tree-kill genuinely fails, so the caller cannot print success', async () => {
    vi.mocked(execFileSync).mockImplementation((cmd: any, _args: any) => {
      if (cmd === 'powershell') return `${WRAPPER_PID}\r\n` as any;
      if (cmd === 'taskkill') {
        const err: any = new Error('ERROR: Access is denied.');
        err.status = 1;
        throw err;
      }
      return '' as any;
    });
    await expect(supervisor().stop()).rejects.toThrow(
      /Failed to terminate the ApraFleetSupervisor process tree/,
    );
  });

  it('rejects when it cannot even determine whether the tree survived', async () => {
    vi.mocked(execFileSync).mockImplementation((cmd: any, _args: any) => {
      if (cmd === 'powershell') throw new Error('powershell is not recognized');
      return '' as any;
    });
    await expect(supervisor().stop()).rejects.toThrow(
      /Could not determine whether the ApraFleetSupervisor process tree is still running/,
    );
  });

  // -- isolation: the MCP server branch is untouched ---------------------
  it('ISOLATION: the default mcp-server stop() does NOT take the tree-kill path', async () => {
    let capturedFallback: ((pid: number) => void) | undefined;
    mockGracefulStop.mockImplementationOnce(async (fn) => { capturedFallback = fn; });

    await new WindowsServiceManager().stop();

    // Still the server.json handshake, with no new pre-step of any kind.
    expect(mockGracefulStop).toHaveBeenCalledWith(expect.any(Function));
    expect(decodedDiscoveryScripts()).toEqual([]);
    expect(callIndex((cmd, args) => cmd === 'schtasks' && args[0] === '/end')).toBe(-1);

    // Still the plain, non-tree taskkill /F /PID <pid> -- no /T added.
    capturedFallback!(4242);
    expect(execFileSync).toHaveBeenCalledWith('taskkill', ['/F', '/PID', '4242'], expect.objectContaining({ stdio: 'pipe', windowsHide: true }));
    expect(callIndex((cmd, args) => cmd === 'taskkill' && args.includes('/T'))).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// Windows -- 'fleet-supervisor' unregister must ALSO take down the WHOLE
// process tree, not only stop().
//
// apra-fleet-i9ag.2.7: `schtasks /delete` only removes the scheduled task
// definition -- it never terminates a wrapper process that is already
// running. src/cli/uninstall.ts calls unregister() directly (no separate
// stop() call) for the fleet-supervisor service, on the assumption that
// unregister() tears the running process down as part of removing its unit --
// true for systemd/launchd, but previously false on Windows, so the
// apra-fleet child survived `apra-fleet uninstall` and kept holding the
// supervisor port.
// ---------------------------------------------------------------------------
describe('WindowsServiceManager -- fleet-supervisor unregister terminates the process tree', () => {
  const SUPERVISOR_WRAPPER = 'apra-fleet-supervisor-service.bat';
  const WRAPPER_PID = 4242;

  function supervisor() {
    return new WindowsServiceManager('fleet-supervisor');
  }

  /** Every execFileSync call as a [command, args] pair, in call order. */
  function calledCommands(): Array<[string, string[]]> {
    return vi.mocked(execFileSync).mock.calls.map(c =>
      [String(c[0]), ((c[1] ?? []) as unknown as string[])],
    );
  }

  /** Index of the first execFileSync call matching a predicate, or -1. */
  function callIndex(pred: (cmd: string, args: string[]) => boolean): number {
    return calledCommands().findIndex(([cmd, args]) => pred(cmd, args));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined as any);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(fs.unlinkSync).mockReturnValue(undefined);
    // Default simulated host: exactly one live wrapper process, and every
    // command succeeds.
    vi.mocked(execFileSync).mockImplementation((cmd: any, _args: any) =>
      (cmd === 'powershell' ? `${WRAPPER_PID}\r\n` : '') as any,
    );
  });

  it('issues the tree-terminating call BEFORE schtasks /delete', async () => {
    await supervisor().unregister();
    const treeKillIdx = callIndex((cmd, args) => cmd === 'taskkill' && args.includes('/T'));
    const deleteIdx = callIndex((cmd, args) => cmd === 'schtasks' && args[0] === '/delete');
    expect(treeKillIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThan(treeKillIdx);
    expect(execFileSync).toHaveBeenCalledWith(
      'taskkill', ['/F', '/T', '/PID', String(WRAPPER_PID)], expect.objectContaining({ stdio: 'pipe', windowsHide: true }),
    );
    expect(execFileSync).toHaveBeenCalledWith(
      'schtasks', ['/delete', '/tn', 'ApraFleetSupervisor', '/f'], expect.objectContaining({ stdio: 'pipe', windowsHide: true }),
    );
  });

  it('scopes discovery to this service wrapper only', async () => {
    await supervisor().unregister();
    const psCalls = calledCommands().filter(([cmd]) => cmd === 'powershell');
    expect(psCalls).toHaveLength(1);
    const script = Buffer.from(
      psCalls[0][1][psCalls[0][1].indexOf('-EncodedCommand') + 1], 'base64',
    ).toString('utf16le');
    expect(script).toContain(SUPERVISOR_WRAPPER);
  });

  it('tree-kills EVERY matching wrapper pid, not just the first', async () => {
    vi.mocked(execFileSync).mockImplementation((cmd: any, _args: any) =>
      (cmd === 'powershell' ? '4242\r\n4243\r\n\r\n' : '') as any,
    );
    await supervisor().unregister();
    expect(execFileSync).toHaveBeenCalledWith('taskkill', ['/F', '/T', '/PID', '4242'], expect.objectContaining({ stdio: 'pipe', windowsHide: true }));
    expect(execFileSync).toHaveBeenCalledWith('taskkill', ['/F', '/T', '/PID', '4243'], expect.objectContaining({ stdio: 'pipe', windowsHide: true }));
  });

  it('resolves when nothing is running and the task is not registered', async () => {
    vi.mocked(execFileSync).mockImplementation((cmd: any, _args: any) => {
      if (cmd === 'powershell') return '' as any; // no wrapper process alive
      if (cmd === 'schtasks') throw new Error('ERROR: The system cannot find the file specified.');
      return '' as any;
    });
    await expect(supervisor().unregister()).resolves.toBeUndefined();
    expect(execFileSync).not.toHaveBeenCalledWith('taskkill', expect.anything(), expect.anything());
  });

  it('stays tolerant when discovery itself fails -- still deletes the task', async () => {
    vi.mocked(execFileSync).mockImplementation((cmd: any, _args: any) => {
      if (cmd === 'powershell') throw new Error('powershell is not recognized');
      return '' as any;
    });
    await expect(supervisor().unregister()).resolves.toBeUndefined();
    expect(execFileSync).toHaveBeenCalledWith(
      'schtasks', ['/delete', '/tn', 'ApraFleetSupervisor', '/f'], expect.objectContaining({ stdio: 'pipe', windowsHide: true }),
    );
  });

  it('stays tolerant when the tree-kill itself fails -- still deletes the task', async () => {
    vi.mocked(execFileSync).mockImplementation((cmd: any, _args: any) => {
      if (cmd === 'powershell') return `${WRAPPER_PID}\r\n` as any;
      if (cmd === 'taskkill') throw new Error('ERROR: Access is denied.');
      return '' as any;
    });
    await expect(supervisor().unregister()).resolves.toBeUndefined();
    expect(execFileSync).toHaveBeenCalledWith(
      'schtasks', ['/delete', '/tn', 'ApraFleetSupervisor', '/f'], expect.objectContaining({ stdio: 'pipe', windowsHide: true }),
    );
  });

  // -- isolation: the MCP server branch is unaffected ---------------------
  it('ISOLATION: the default mcp-server unregister() does NOT take the tree-kill path', async () => {
    await new WindowsServiceManager().unregister();
    expect(execFileSync).not.toHaveBeenCalledWith('powershell', expect.anything());
    expect(callIndex((cmd, args) => cmd === 'taskkill' && args.includes('/T'))).toBe(-1);
    expect(execFileSync).toHaveBeenCalledWith('schtasks', ['/delete', '/tn', 'ApraFleet', '/f'], expect.objectContaining({ stdio: 'pipe', windowsHide: true }));
    expect(fs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining('apra-fleet-service.bat'));
  });
});

// ---------------------------------------------------------------------------
// Linux
// ---------------------------------------------------------------------------
describe('LinuxServiceManager', () => {
  const savedXdg = process.env.XDG_RUNTIME_DIR;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.XDG_RUNTIME_DIR = '/run/user/1000';
    vi.mocked(execFileSync).mockReturnValue('' as any);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined as any);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(fs.unlinkSync).mockReturnValue(undefined);
    // Default: systemd available, unit file not installed
    // Normalize separators for cross-platform compatibility (Windows uses backslash)
    vi.mocked(fs.existsSync).mockImplementation((p) =>
      String(p).replace(/\\/g, '/').endsWith('/systemd'),
    );
  });

  afterEach(() => {
    if (savedXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = savedXdg;
  });

  describe('non-systemd detection', () => {
    it('throws a clear error on register when systemd is absent', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      await expect(
        new LinuxServiceManager().register('/bin/apra-fleet', [], '/tmp/fleet.log'),
      ).rejects.toThrow('systemd user mode is not available');
    });

    it('throws a clear error on start when systemd is absent', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      await expect(new LinuxServiceManager().start()).rejects.toThrow('systemd user mode is not available');
    });

    it('throws a clear error on stop when systemd is absent', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      await expect(new LinuxServiceManager().stop()).rejects.toThrow('systemd user mode is not available');
    });
  });

  describe('register', () => {
    it('writes unit file with correct content', async () => {
      await new LinuxServiceManager().register(
        '/usr/local/bin/apra-fleet', ['--transport', 'http'], '/home/user/fleet.log',
      );
      const [, content] = vi.mocked(fs.writeFileSync).mock.calls[0];
      expect(content).toContain('Type=simple');
      // The executable is quoted so a home-directory path containing a space
      // cannot silently produce a broken unit.
      expect(content).toContain('ExecStart="/usr/local/bin/apra-fleet" --transport http');
      expect(content).toContain('Restart=on-failure');
      expect(content).toContain('Environment=APRA_FLEET_SERVICE=1'); // service-launch marker
      expect(content).toContain('WantedBy=default.target');
    });

    it('runs daemon-reload and enable after writing unit file', async () => {
      await new LinuxServiceManager().register('/bin/apra-fleet', [], '/tmp/fleet.log');
      expect(execFileSync).toHaveBeenCalledWith('systemctl', ['--user', 'daemon-reload']);
      expect(execFileSync).toHaveBeenCalledWith('systemctl', ['--user', 'enable', 'apra-fleet']);
    });

    it('warns (not throws) when loginctl enable-linger fails', async () => {
      vi.mocked(execFileSync).mockImplementation((cmd: any, args: any) => {
        if (cmd === 'loginctl') throw new Error('permission denied');
        return '' as any;
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await new LinuxServiceManager().register('/bin/apra-fleet', [], '/tmp/fleet.log');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('loginctl enable-linger failed'));
    });
  });

  describe('unregister', () => {
    it('gracefully stops then disables and removes the unit file', async () => {
      await new LinuxServiceManager().unregister();
      expect(mockGracefulStop).toHaveBeenCalled();
      expect(execFileSync).toHaveBeenCalledWith('systemctl', ['--user', 'disable', 'apra-fleet'], expect.objectContaining({ stdio: 'pipe' }));
      expect(execFileSync).toHaveBeenCalledWith('systemctl', ['--user', 'daemon-reload'], expect.objectContaining({ stdio: 'pipe' }));
    });

    it('is idempotent when unit is not installed', async () => {
      vi.mocked(execFileSync).mockImplementation(() => { throw new Error('not found'); });
      await expect(new LinuxServiceManager().unregister()).resolves.not.toThrow();
    });
  });

  describe('start', () => {
    it('calls systemctl --user start', async () => {
      await new LinuxServiceManager().start();
      expect(execFileSync).toHaveBeenCalledWith('systemctl', ['--user', 'start', 'apra-fleet']);
    });
  });

  describe('stop', () => {
    it('calls gracefulStopByServerJson', async () => {
      await new LinuxServiceManager().stop();
      expect(mockGracefulStop).toHaveBeenCalled();
    });

    it('returns false when the graceful stop refused to force-kill', async () => {
      mockGracefulStop.mockResolvedValueOnce(false);
      expect(await new LinuxServiceManager().stop()).toBe(false);
    });
  });

  describe('query', () => {
    it('returns installed=false when unit file does not exist', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p) =>
        String(p).replace(/\\/g, '/').endsWith('/systemd'), // only systemd dir
      );
      expect(await new LinuxServiceManager().query()).toEqual({ installed: false, running: false });
    });

    it('returns running=true and enabled=true for active/enabled unit', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(execFileSync).mockImplementation((_cmd: any, args: any) => {
        if ((args as string[]).includes('is-active')) return 'active\n' as any;
        if ((args as string[]).includes('is-enabled')) return 'enabled\n' as any;
        return '' as any;
      });
      expect(await new LinuxServiceManager().query()).toEqual({ installed: true, running: true, enabled: true });
    });

    it('returns running=false and enabled=false for inactive/disabled unit', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(execFileSync).mockImplementation((_cmd: any, args: any) => {
        if ((args as string[]).includes('is-active')) return 'inactive\n' as any;
        if ((args as string[]).includes('is-enabled')) return 'disabled\n' as any;
        return '' as any;
      });
      expect(await new LinuxServiceManager().query()).toEqual({ installed: true, running: false, enabled: false });
    });

    // GitHub #585 review: systemctl probe errors must not print above status.
    it('systemctl probes pipe stdio', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(execFileSync).mockImplementation(() => { throw new Error('Failed to connect to bus'); });
      await new LinuxServiceManager().query();
      const probes = vi.mocked(execFileSync).mock.calls.filter((c) => c[0] === 'systemctl');
      expect(probes.length).toBe(2);
      for (const call of probes) expect(call[2]).toMatchObject({ stdio: 'pipe' });
    });
  });

  describe('isInstalled', () => {
    it('returns true when unit file exists', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      expect(await new LinuxServiceManager().isInstalled()).toBe(true);
    });

    it('returns false when unit file does not exist', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p) =>
        String(p).endsWith('/systemd'),
      );
      expect(await new LinuxServiceManager().isInstalled()).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Linux -- 'fleet-supervisor' service (the second registered service).
//
// The reference unit shape:
//   ExecStart="<installed apra-fleet binary>" supervisor
//   WorkingDirectory=<installed>/workflows/fleet-sprint
//   Restart=no
// These tests pin this manager's generic executable+args rendering (quoted
// executable, unquoted args) plus the independence of the two units. That the
// SUPERVISOR is the caller passing the binary and the single 'supervisor'
// argument is pinned in tests/supervisor-service.test.ts.
// ---------------------------------------------------------------------------
describe('LinuxServiceManager -- fleet-supervisor service', () => {
  const savedXdg = process.env.XDG_RUNTIME_DIR;
  const NODE = '/home/dev/.apra-fleet/bin/apra-fleet';
  const SERVE = 'supervisor';
  const WORKDIR = '/home/dev/.apra-fleet/workflows/fleet-sprint';
  const LOG = '/home/dev/.apra-fleet/data/fleet-supervisor.log';

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.XDG_RUNTIME_DIR = '/run/user/1000';
    vi.mocked(execFileSync).mockReturnValue('' as any);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined as any);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(fs.unlinkSync).mockReturnValue(undefined);
    vi.mocked(fs.existsSync).mockImplementation((p) =>
      String(p).replace(/\\/g, '/').endsWith('/systemd'),
    );
  });

  afterEach(() => {
    if (savedXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = savedXdg;
  });

  function supervisor() {
    return new LinuxServiceManager('fleet-supervisor');
  }

  it('exposes its service id', () => {
    expect(supervisor().serviceId).toBe('fleet-supervisor');
    expect(new LinuxServiceManager().serviceId).toBe('mcp-server');
  });

  it('writes a SEPARATE unit file named fleet-supervisor.service', async () => {
    await supervisor().register(NODE, [SERVE], LOG, { workingDirectory: WORKDIR });
    const [unitPath] = vi.mocked(fs.writeFileSync).mock.calls[0];
    const normalized = String(unitPath).replace(/\\/g, '/');
    expect(normalized).toContain('/.config/systemd/user/fleet-supervisor.service');
    expect(normalized).not.toContain('apra-fleet.service');
  });

  it('writes ExecStart with the quoted executable, WorkingDirectory and Restart=no', async () => {
    await supervisor().register(NODE, [SERVE], LOG, { workingDirectory: WORKDIR });
    const [, content] = vi.mocked(fs.writeFileSync).mock.calls[0];
    expect(content).toContain('Description=Apra Fleet Sprint Supervisor');
    expect(content).toContain(`ExecStart="${NODE}" ${SERVE}`);
    expect(content).toContain(`WorkingDirectory=${WORKDIR}`);
    expect(content).toContain('Restart=no');
    expect(content).not.toContain('Restart=on-failure');
    expect(content).toContain(`StandardOutput=append:${LOG}`);
    expect(content).toContain(`StandardError=append:${LOG}`);
    expect(content).toContain('WantedBy=default.target');
    // The #584 service-launch marker is the MCP server's only: the supervisor
    // must not leak it into the processes it spawns.
    expect(content).not.toContain('APRA_FLEET_SERVICE');
  });

  it('omits WorkingDirectory when none is supplied', async () => {
    await supervisor().register(NODE, [SERVE], LOG);
    const [, content] = vi.mocked(fs.writeFileSync).mock.calls[0];
    expect(content).not.toContain('WorkingDirectory=');
  });

  it('enables the supervisor unit -- not the MCP server unit', async () => {
    await supervisor().register(NODE, [SERVE], LOG, { workingDirectory: WORKDIR });
    expect(execFileSync).toHaveBeenCalledWith('systemctl', ['--user', 'daemon-reload']);
    expect(execFileSync).toHaveBeenCalledWith('systemctl', ['--user', 'enable', 'fleet-supervisor']);
    expect(execFileSync).not.toHaveBeenCalledWith('systemctl', ['--user', 'enable', 'apra-fleet']);
  });

  it('start/query/isInstalled all target the supervisor unit', async () => {
    await supervisor().start();
    expect(execFileSync).toHaveBeenCalledWith('systemctl', ['--user', 'start', 'fleet-supervisor']);

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(execFileSync).mockImplementation((_cmd: any, args: any) => {
      if ((args as string[]).includes('is-active')) return 'active\n' as any;
      if ((args as string[]).includes('is-enabled')) return 'enabled\n' as any;
      return '' as any;
    });
    expect(await supervisor().query()).toEqual({ installed: true, running: true, enabled: true });
    expect(execFileSync).toHaveBeenCalledWith(
      'systemctl', ['--user', 'is-active', 'fleet-supervisor'], { encoding: 'utf8', stdio: 'pipe' },
    );
    expect(await supervisor().isInstalled()).toBe(true);
  });

  it('stops via systemctl, NOT via the MCP server server.json handshake', async () => {
    await supervisor().stop();
    expect(mockGracefulStop).not.toHaveBeenCalled();
    expect(execFileSync).toHaveBeenCalledWith('systemctl', ['--user', 'stop', 'fleet-supervisor'], expect.objectContaining({ stdio: 'pipe', timeout: expect.any(Number) }));
  });

  it('unregisters without the MCP server server.json handshake', async () => {
    await supervisor().unregister();
    expect(mockGracefulStop).not.toHaveBeenCalled();
    expect(execFileSync).toHaveBeenCalledWith('systemctl', ['--user', 'disable', 'fleet-supervisor'], expect.objectContaining({ stdio: 'pipe' }));
    expect(execFileSync).toHaveBeenCalledWith('systemctl', ['--user', 'stop', 'fleet-supervisor'], expect.objectContaining({ stdio: 'pipe' }));
    expect(fs.unlinkSync).toHaveBeenCalledWith(
      expect.stringContaining('fleet-supervisor.service'),
    );
  });

  it('reports not-installed when only the MCP server unit exists', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p).replace(/\\/g, '/');
      return s.endsWith('/systemd') || s.endsWith('/apra-fleet.service');
    });
    expect(await supervisor().isInstalled()).toBe(false);
    expect(await new LinuxServiceManager().isInstalled()).toBe(true);
  });

  it('still requires systemd', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    await expect(supervisor().register(NODE, [SERVE], LOG)).rejects.toThrow(
      'systemd user mode is not available',
    );
  });
});

// ---------------------------------------------------------------------------
// Cross-platform: the supervisor never collides with the MCP server's names
// ---------------------------------------------------------------------------
describe('service identity is distinct per platform', () => {
  it('windows uses a distinct task name and wrapper bat', async () => {
    vi.clearAllMocks();
    vi.mocked(execFileSync).mockReturnValue('' as any);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined as any);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    const mgr = new WindowsServiceManager('fleet-supervisor');
    await mgr.register('C:\\node\\node.exe', ['C:\\wf\\serve.mjs'], 'C:\\logs\\sup.log', {
      workingDirectory: 'C:\\wf',
    });
    const [wrapperPath, content] = vi.mocked(fs.writeFileSync).mock.calls[0];
    expect(String(wrapperPath)).toContain('apra-fleet-supervisor-service.bat');
    expect(String(content)).not.toContain('APRA_FLEET_SERVICE'); // #584 marker is the MCP server's only
    expect(String(content)).toContain('cd /d "C:\\wf"');
    expect(execFileSync).toHaveBeenCalledWith('schtasks', expect.arrayContaining([
      '/create', '/tn', 'ApraFleetSupervisor',
    ]), expect.anything());
  });

  // main #629 model on v0.5's per-service managers: the supervisor gets the
  // same user-scoped XML task + hidden launcher as the MCP server, but NO
  // revive TimeTrigger (restartOnFailure=false) and its own launcher/XML/Run
  // value, so it can never collide with the MCP server's files.
  it('windows supervisor task: user-scoped XML, no revive trigger, its own launcher and Run value', async () => {
    vi.clearAllMocks();
    vi.mocked(execFileSync).mockImplementation(((cmd: string, args: string[]) => {
      if (cmd === 'schtasks' && args[0] === '/create') throw new Error('ERROR: Access is denied.');
      if (cmd === 'schtasks') throw new Error('ERROR: The system cannot find the file specified.');
      return '';
    }) as any);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined as any);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(fs.unlinkSync).mockReturnValue(undefined);
    const runReg = vi.fn((_args: string[]) => '');
    const mgr = new WindowsServiceManager('fleet-supervisor', undefined, undefined, {
      probeWsh: () => true, runReg, env: { USERDOMAIN: 'BOX', USERNAME: 'alice', SystemRoot: 'C:\\Windows' },
    });
    expect(await mgr.register('C:\\node\\node.exe', ['C:\\wf\\serve.mjs'], 'C:\\logs\\sup.log', { workingDirectory: 'C:\\wf' }))
      .toBe('run-key');
    const writes = vi.mocked(fs.writeFileSync).mock.calls.map(c => [String(c[0]).replace(/\\/g, '/'), c[1]] as const);
    const xmlWrite = writes.find(([p]) => p.endsWith('/apra-fleet-supervisor-task.xml'));
    expect(xmlWrite).toBeDefined();
    const xml = (xmlWrite![1] as Buffer).subarray(2).toString('utf16le');
    expect(xml).toContain('<LogonTrigger>');
    expect(xml).toContain('<UserId>BOX\\alice</UserId>');
    expect(xml).not.toContain('<TimeTrigger>');
    expect(xml).toContain('Apra Fleet Sprint Supervisor');
    expect(xml).toContain('apra-fleet-supervisor-service.js');
    expect(writes.some(([p]) => p.endsWith('/apra-fleet-supervisor-service.js'))).toBe(true);
    expect(writes.some(([p]) => p.endsWith('/apra-fleet-service.js'))).toBe(false);
    expect(execFileSync).toHaveBeenCalledWith('schtasks', expect.arrayContaining(['/create', '/tn', 'ApraFleetSupervisor', '/xml']), expect.anything());
    expect(runReg).toHaveBeenCalledWith(expect.arrayContaining(['add', '/v', 'ApraFleetSupervisor']));
    expect(runReg).not.toHaveBeenCalledWith(expect.arrayContaining(['/v', 'ApraFleet']));
  });

  it('macos uses a distinct plist label, no KeepAlive, and a WorkingDirectory', async () => {
    vi.clearAllMocks();
    vi.mocked(execFileSync).mockReturnValue('' as any);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined as any);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    const mgr = new MacOSServiceManager('fleet-supervisor');
    await mgr.register('/usr/local/bin/node', ['/wf/serve.mjs'], '/logs/sup.log', {
      workingDirectory: '/wf',
    });
    const [plistPath, content] = vi.mocked(fs.writeFileSync).mock.calls[0];
    expect(String(plistPath)).toContain('com.apra-fleet.supervisor.plist');
    expect(String(content)).toContain('<string>com.apra-fleet.supervisor</string>');
    expect(String(content)).toContain('<key>WorkingDirectory</key>');
    expect(String(content)).toContain('<string>/wf</string>');
    expect(String(content)).not.toContain('<key>KeepAlive</key>');
    expect(String(content)).not.toContain('APRA_FLEET_SERVICE'); // #584 marker is the MCP server's only
  });
});

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------
describe('MacOSServiceManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(execFileSync).mockReturnValue('' as any);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined as any);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(fs.unlinkSync).mockReturnValue(undefined);
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  describe('register', () => {
    it('writes plist with Label, ProgramArguments, RunAtLoad, KeepAlive', async () => {
      await new MacOSServiceManager().register(
        '/usr/local/bin/apra-fleet', ['--transport', 'http'], '/Users/user/fleet.log',
      );
      const plistCall = vi.mocked(fs.writeFileSync).mock.calls.find(c =>
        String(c[0]).endsWith('.plist'),
      );
      expect(plistCall).toBeDefined();
      const content = String(plistCall![1]);
      expect(content).toContain('<string>com.apra-fleet.server</string>');
      expect(content).toContain('<string>/usr/local/bin/apra-fleet</string>');
      expect(content).toContain('<true/>'); // RunAtLoad
      expect(content).toContain('<key>SuccessfulExit</key>');
      expect(content).toContain('<false/>'); // KeepAlive.SuccessfulExit
      expect(content).toContain('<key>APRA_FLEET_SERVICE</key>'); // service-launch marker
    });

    it('bootouts before bootstrap to be idempotent', async () => {
      await new MacOSServiceManager().register('/bin/apra-fleet', [], '/tmp/fleet.log');
      const calls = vi.mocked(execFileSync).mock.calls.map(c => c[1] as string[]);
      const bootoutIdx = calls.findIndex(a => a.includes('bootout'));
      const bootstrapIdx = calls.findIndex(a => a.includes('bootstrap'));
      expect(bootoutIdx).toBeGreaterThanOrEqual(0);
      expect(bootstrapIdx).toBeGreaterThan(bootoutIdx);
    });

    it('tolerates bootout error on first registration', async () => {
      // bootout throws "not loaded" (first exec call), bootstrap succeeds (second exec call)
      vi.mocked(execFileSync).mockImplementationOnce(() => { throw new Error('not loaded'); });
      vi.mocked(execFileSync).mockImplementationOnce(() => {});
      const mgr = new MacOSServiceManager();
      await expect(mgr.register('/bin/apra-fleet', [], '/tmp/fleet.log')).resolves.not.toThrow();
    });
  });

  describe('unregister', () => {
    it('bootouts service and removes plist file', async () => {
      await new MacOSServiceManager().unregister();
      expect(execFileSync).toHaveBeenCalledWith('launchctl', expect.arrayContaining(['bootout']));
      expect(fs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining('com.apra-fleet.server.plist'));
    });

    it('tolerates bootout error when service is not loaded', async () => {
      vi.mocked(execFileSync).mockImplementationOnce(() => { throw new Error('No such process'); });
      await expect(new MacOSServiceManager().unregister()).resolves.not.toThrow();
    });
  });

  describe('start', () => {
    it('calls launchctl kickstart', async () => {
      await new MacOSServiceManager().start();
      expect(execFileSync).toHaveBeenCalledWith('launchctl', expect.arrayContaining(['kickstart']));
    });
  });

  describe('stop', () => {
    it('calls gracefulStopByServerJson', async () => {
      await new MacOSServiceManager().stop();
      expect(mockGracefulStop).toHaveBeenCalled();
    });

    it('returns false when the graceful stop refused to force-kill', async () => {
      mockGracefulStop.mockResolvedValueOnce(false);
      expect(await new MacOSServiceManager().stop()).toBe(false);
    });
  });

  describe('query', () => {
    it('returns installed=false when plist does not exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(await new MacOSServiceManager().query()).toEqual({ installed: false, running: false });
    });

    it('extracts pid from launchctl print output', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(execFileSync).mockReturnValue('com.apra-fleet.server {\n\tpid = 1234\n\tstate = running\n}\n' as any);
      expect(await new MacOSServiceManager().query()).toEqual({ installed: true, running: true, pid: 1234, enabled: true });
    });

    it('returns running=false when launchctl print fails (not loaded)', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(execFileSync).mockImplementation(() => { throw new Error('Could not find specified service'); });
      expect(await new MacOSServiceManager().query()).toEqual({ installed: true, running: false, enabled: true });
    });

    it('returns running=false when launchctl print shows no pid', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(execFileSync).mockReturnValue('com.apra-fleet.server {\n\tstate = stopped\n}\n' as any);
      expect(await new MacOSServiceManager().query()).toEqual({ installed: true, running: false, pid: undefined, enabled: true });
    });

    // GitHub #585: installed + enabled shows (enabled); a disabled label shows disabled.
    it('reports enabled=false when launchctl print-disabled lists the label as disabled', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(execFileSync).mockImplementation(((_cmd: string, args: string[]) => args[0] === 'print-disabled'
        ? 'disabled services = {\n\t"com.apra-fleet.server" => disabled\n\t"com.other" => enabled\n}\n'
        : 'com.apra-fleet.server {\n\tpid = 7\n}\n') as any);
      expect(await new MacOSServiceManager().query()).toEqual({ installed: true, running: true, pid: 7, enabled: false });
    });

    it('reports enabled=true when print-disabled lists the label as enabled (older "=> false" form too)', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(execFileSync).mockImplementation(((_cmd: string, args: string[]) => args[0] === 'print-disabled'
        ? 'disabled services = {\n\t"com.apra-fleet.server" => false\n}\n'
        : 'com.apra-fleet.server {\n\tpid = 7\n}\n') as any);
      expect(await new MacOSServiceManager().query()).toEqual({ installed: true, running: true, pid: 7, enabled: true });
    });

    it('launchctl probes pipe stdio', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(execFileSync).mockImplementation(() => { throw new Error('Could not find specified service'); });
      await new MacOSServiceManager().query();
      for (const call of vi.mocked(execFileSync).mock.calls) {
        expect(call[2]).toMatchObject({ stdio: 'pipe' });
      }
    });
  });

  describe('isInstalled', () => {
    it('returns true when plist file exists', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      expect(await new MacOSServiceManager().isInstalled()).toBe(true);
    });

    it('returns false when plist file does not exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(await new MacOSServiceManager().isInstalled()).toBe(false);
    });
  });
});
