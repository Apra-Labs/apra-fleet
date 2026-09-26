import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

// vi.hoisted so these refs are available inside vi.mock factory closures
const { mockGracefulStop } = vi.hoisted(() => ({
  mockGracefulStop: vi.fn<(fallback?: (pid: number) => void) => Promise<void>>().mockResolvedValue(undefined),
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
    });

    it('calls schtasks /create with onlogon trigger and limited run-level', async () => {
      const mgr = new WindowsServiceManager();
      await mgr.register('/bin/apra-fleet.exe', ['--transport', 'http'], '/logs/fleet.log');
      expect(execFileSync).toHaveBeenCalledWith('schtasks', expect.arrayContaining([
        '/create', '/tn', 'ApraFleet', '/sc', 'onlogon', '/rl', 'limited', '/f',
      ]));
    });
  });

  describe('unregister', () => {
    it('deletes the scheduled task and removes the wrapper bat', async () => {
      const mgr = new WindowsServiceManager();
      await mgr.unregister();
      expect(execFileSync).toHaveBeenCalledWith('schtasks', ['/delete', '/tn', 'ApraFleet', '/f']);
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
      expect(spawn).toHaveBeenCalledWith('schtasks', ['/run', '/tn', 'ApraFleet'], { detached: true, stdio: 'ignore' });
      expect(mockChild.unref).toHaveBeenCalled();
    });
  });

  describe('stop', () => {
    it('calls gracefulStopByServerJson with a fallback function', async () => {
      const mgr = new WindowsServiceManager();
      await mgr.stop();
      expect(mockGracefulStop).toHaveBeenCalledWith(expect.any(Function));
    });

    it('fallback invokes taskkill /F /PID', async () => {
      let capturedFallback: ((pid: number) => void) | undefined;
      mockGracefulStop.mockImplementationOnce(async (fn) => { capturedFallback = fn; });
      const mgr = new WindowsServiceManager();
      await mgr.stop();
      capturedFallback!(4242);
      expect(execFileSync).toHaveBeenCalledWith('taskkill', ['/F', '/PID', '4242']);
    });
  });

  describe('query', () => {
    it('returns installed=true, running=false for Ready status', async () => {
      vi.mocked(execFileSync).mockReturnValue('"ApraFleet","N/A","Ready"\r\n' as any);
      const mgr = new WindowsServiceManager();
      expect(await mgr.query()).toEqual({ installed: true, running: false });
    });

    it('returns installed=true, running=true for Running status', async () => {
      vi.mocked(execFileSync).mockReturnValue('"ApraFleet","N/A","Running"\r\n' as any);
      const mgr = new WindowsServiceManager();
      expect(await mgr.query()).toEqual({ installed: true, running: true });
    });

    it('returns installed=false when task is not found', async () => {
      vi.mocked(execFileSync).mockImplementation(() => { throw new Error('task not found'); });
      const mgr = new WindowsServiceManager();
      expect(await mgr.query()).toEqual({ installed: false, running: false });
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
      expect(content).toContain('ExecStart=/usr/local/bin/apra-fleet --transport http');
      expect(content).toContain('Restart=on-failure');
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
      expect(execFileSync).toHaveBeenCalledWith('systemctl', ['--user', 'disable', 'apra-fleet']);
      expect(execFileSync).toHaveBeenCalledWith('systemctl', ['--user', 'daemon-reload']);
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
  });

  describe('query', () => {
    it('returns installed=false when plist does not exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(await new MacOSServiceManager().query()).toEqual({ installed: false, running: false });
    });

    it('extracts pid from launchctl print output', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(execFileSync).mockReturnValue('com.apra-fleet.server {\n\tpid = 1234\n\tstate = running\n}\n' as any);
      expect(await new MacOSServiceManager().query()).toEqual({ installed: true, running: true, pid: 1234 });
    });

    it('returns running=false when launchctl print fails (not loaded)', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(execFileSync).mockImplementation(() => { throw new Error('Could not find specified service'); });
      expect(await new MacOSServiceManager().query()).toEqual({ installed: true, running: false });
    });

    it('returns running=false when launchctl print shows no pid', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(execFileSync).mockReturnValue('com.apra-fleet.server {\n\tstate = stopped\n}\n' as any);
      expect(await new MacOSServiceManager().query()).toEqual({ installed: true, running: false, pid: undefined });
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
