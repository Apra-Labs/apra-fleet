import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Capture spawn calls so we can assert on the args passed to the terminal emulator.
const spawnCalls: Array<{ cmd: string; args: string[] }> = [];

vi.mock('node:child_process', () => {
  return {
    spawn: (cmd: string, args: string[]) => {
      spawnCalls.push({ cmd, args });
      // Minimal fake ChildProcess: records handlers, never auto-exits.
      return {
        pid: 4242,
        on: () => {},
        unref: () => {},
        stdin: { write: () => {}, end: () => {} },
      };
    },
    // findLinuxTerminal() does `which <term>`; make gnome-terminal resolve.
    execSync: (command: string) => {
      if (command.includes('which gnome-terminal')) return Buffer.from('/usr/bin/gnome-terminal');
      throw new Error('not found');
    },
    ChildProcess: class {},
  };
});

describe('launchAuthTerminal -- Linux gnome-terminal --wait', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.skipIf(process.platform !== 'linux')(
    'passes --wait so the client process stays alive until the secret CLI exits',
    async () => {
      // Ensure the graphical-display branch is taken (not the headless fallback).
      vi.stubEnv('DISPLAY', ':0');
      vi.stubEnv('WAYLAND_DISPLAY', '');

      const { launchAuthTerminal } = await import('../src/services/auth-socket.js');
      const result = launchAuthTerminal('mach1', [], () => {});

      expect(result).toBe('launched');
      expect(spawnCalls.length).toBe(1);
      const { cmd, args } = spawnCalls[0];
      expect(cmd).toBe('gnome-terminal');
      // --wait must precede the '--' separator that introduces the command.
      const waitIdx = args.indexOf('--wait');
      const sepIdx = args.indexOf('--');
      expect(waitIdx).toBeGreaterThanOrEqual(0);
      expect(sepIdx).toBeGreaterThan(waitIdx);
    },
  );
});
