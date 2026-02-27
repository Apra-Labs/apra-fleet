import { describe, it, expect } from 'vitest';
import { detectOS } from '../src/utils/platform.js';
import { getOsCommands } from '../src/os/index.js';
import type { OsCommands } from '../src/os/index.js';

describe('detectOS', () => {
  it('detects OS from uname and ver output', () => {
    expect(detectOS('Linux', '')).toBe('linux');
    expect(detectOS('Darwin', '')).toBe('macos');
    expect(detectOS('', 'Microsoft Windows [Version 10.0.19045]')).toBe('windows');
  });

  it('defaults to linux for unknown output', () => {
    expect(detectOS('SomeUnknownOS', '')).toBe('linux');
  });

  it('prioritizes Windows detection from ver over uname', () => {
    expect(detectOS('Linux', 'Microsoft Windows')).toBe('windows');
  });

  it('detects Windows from Git Bash / MSYS2 / Cygwin uname output', () => {
    expect(detectOS('MINGW64_NT-10.0-19045', '')).toBe('windows');
    expect(detectOS('MSYS_NT-10.0', '')).toBe('windows');
    expect(detectOS('CYGWIN_NT-10.0', '')).toBe('windows');
  });

  it('detects Windows from PowerShell $env:OS output', () => {
    expect(detectOS('', 'Windows_NT')).toBe('windows');
  });
});

describe('OsCommands via getOsCommands', () => {
  const linux = getOsCommands('linux');
  const macos = getOsCommands('macos');
  const windows = getOsCommands('windows');
  const all: [string, OsCommands][] = [['linux', linux], ['macos', macos], ['windows', windows]];

  it('returns singletons', () => {
    expect(getOsCommands('linux')).toBe(linux);
    expect(getOsCommands('macos')).toBe(macos);
    expect(getOsCommands('windows')).toBe(windows);
  });

  describe('resource commands', () => {
    it('generates OS-specific CPU commands', () => {
      expect(linux.cpuLoad()).toBe('uptime');
      expect(macos.cpuLoad()).toContain('vm.loadavg');
      expect(windows.cpuLoad()).toContain('dwMemoryLoad');
    });

    it('generates OS-specific memory commands', () => {
      expect(linux.memory()).toBe('free -m');
      expect(macos.memory()).toContain('vm_stat');
      expect(windows.memory()).toContain('ullTotalPhys');
    });

    it('generates disk commands with folder interpolation', () => {
      expect(linux.disk('/home/user')).toContain('/home/user');
      expect(macos.disk('/opt/app')).toContain('/opt/app');
      expect(windows.disk('C:\\work')).toContain('DriveInfo');
    });
  });

  describe('shell wrapping', () => {
    it('wraps commands appropriately per OS', () => {
      expect(linux.shellWrap('echo hi')).toBe('echo hi');
      expect(macos.shellWrap('echo hi')).toBe('echo hi');
      expect(windows.shellWrap('echo hi')).toBe('echo hi');
    });
  });

  describe('claude CLI commands', () => {
    for (const [name, cmds] of all) {
      it(`${name}: claudeVersion includes --version`, () => {
        expect(cmds.claudeVersion()).toContain('--version');
      });

      it(`${name}: claudeCommand prepends PATH`, () => {
        const cmd = cmds.claudeCommand('-p "hello"');
        expect(cmd).toContain('claude -p "hello"');
      });

      it(`${name}: installClaude returns an install command`, () => {
        expect(cmds.installClaude().length).toBeGreaterThan(10);
      });
    }
  });

  describe('filesystem commands', () => {
    it('generates mkdir commands', () => {
      expect(linux.mkdir('/tmp/test')).toBe('mkdir -p "/tmp/test"');
      expect(macos.mkdir('/tmp/test')).toBe('mkdir -p "/tmp/test"');
      expect(windows.mkdir('C:\\test')).toContain('New-Item');
    });
  });

  describe('env commands', () => {
    it('generates setenv commands for each OS', () => {
      const linuxCmds = linux.setEnv('MY_VAR', 'value');
      expect(linuxCmds.length).toBe(3);
      expect(linuxCmds[0]).toContain('.bashrc');

      const macosCmds = macos.setEnv('MY_VAR', 'value');
      expect(macosCmds.length).toBe(4);
      expect(macosCmds.some(c => c.includes('.zshrc'))).toBe(true);

      const winCmds = windows.setEnv('MY_VAR', 'value');
      expect(winCmds.length).toBe(1);
      expect(winCmds[0]).toContain('SetEnvironmentVariable');
    });

    it('generates unsetenv commands for each OS', () => {
      const linuxCmds = linux.unsetEnv('MY_VAR');
      expect(linuxCmds.length).toBe(3);
      expect(linuxCmds[0]).toContain('sed');
      expect(linuxCmds[2]).toContain('unset MY_VAR');

      const macosCmds = macos.unsetEnv('MY_VAR');
      expect(macosCmds.length).toBe(4);
      expect(macosCmds[3]).toContain('unset MY_VAR');

      const winCmds = windows.unsetEnv('MY_VAR');
      expect(winCmds[0]).toContain('SetEnvironmentVariable');
    });
  });

  describe('auth commands', () => {
    for (const [name, cmds] of all) {
      it(`${name}: credentialFileCheck returns a check command`, () => {
        const cmd = cmds.credentialFileCheck();
        expect(cmd).toContain('credentials.json');
      });

      it(`${name}: credentialFileWrite produces a write command`, () => {
        const cmd = cmds.credentialFileWrite('{"token":"abc"}');
        expect(cmd).toMatch(/credentials\.json|EncodedCommand/);
      });

      it(`${name}: credentialFileRemove produces a remove command`, () => {
        const cmd = cmds.credentialFileRemove();
        expect(cmd.length).toBeGreaterThan(5);
      });

      it(`${name}: apiKeyCheck returns a check command`, () => {
        const cmd = cmds.apiKeyCheck();
        expect(cmd).toContain('ANTHROPIC_API_KEY');
      });
    }
  });

  describe('fleet process check', () => {
    for (const [name, cmds] of all) {
      it(`${name}: contains fleet-busy, other-busy, idle`, () => {
        const cmd = cmds.fleetProcessCheck('/home/user/project');
        expect(cmd).toContain('fleet-busy');
        expect(cmd).toContain('other-busy');
        expect(cmd).toContain('idle');
      });

      it(`${name}: includes session ID when provided`, () => {
        const cmd = cmds.fleetProcessCheck('/home/user/project', 'sess-abc-123');
        expect(cmd).toContain('sess-abc-123');
      });

      it(`${name}: handles missing session ID without undefined`, () => {
        const cmd = cmds.fleetProcessCheck('/srv/app');
        expect(cmd).not.toContain('undefined');
      });
    }

    it('rejects invalid session IDs', () => {
      expect(() => linux.fleetProcessCheck('/home/user', 'sess;whoami')).toThrow('Invalid session ID');
      expect(() => windows.fleetProcessCheck('C:\\work', 'sess$(cmd)')).toThrow('Invalid session ID');
    });
  });

  describe('prompt building', () => {
    for (const [name, cmds] of all) {
      it(`${name}: builds a prompt command with folder and base64`, () => {
        const cmd = cmds.buildPromptCommand('/tmp/work', 'aGVsbG8=');
        expect(cmd).toContain('aGVsbG8=');
        expect(cmd).toContain('--output-format json');
      });

      it(`${name}: includes session resume when provided`, () => {
        const cmd = cmds.buildPromptCommand('/tmp/work', 'aGVsbG8=', 'abc-123-def');
        expect(cmd).toContain('--resume');
        expect(cmd).toContain('abc-123-def');
      });
    }
  });

  describe('resource output parsing', () => {
    it('linux: parseMemory extracts used/total from free -m output', () => {
      const freeOutput = '              total        used        free\nMem:          31824        2454       29370\nSwap:          2048           0        2048\n';
      expect(linux.parseMemory(freeOutput)).toBe('2454 MB / 31824 MB');
    });

    it('macos: parseMemory returns trimmed output', () => {
      expect(macos.parseMemory('some vm_stat output')).toBe('some vm_stat output');
    });

    it('windows: parseMemory returns trimmed output', () => {
      expect(windows.parseMemory('38000 MB / 65000 MB')).toBe('38000 MB / 65000 MB');
    });

    it('linux: parseDisk extracts second line from df output', () => {
      const dfOutput = 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1       461G   78G  360G  18% /\n';
      expect(linux.parseDisk(dfOutput)).toBe('/dev/sda1       461G   78G  360G  18% /');
    });
  });

  describe('cleanExec', () => {
    it('linux: wraps with env -i bash -l -c', () => {
      const { command, env, shell } = linux.cleanExec('echo hello');
      expect(command).toBe("env -i bash -l -c 'echo hello'");
      expect(env).toBeUndefined();
      expect(shell).toBeUndefined();
    });

    it('linux: escapes single quotes in command', () => {
      const { command } = linux.cleanExec("echo 'quoted'");
      expect(command).toBe("env -i bash -l -c 'echo '\\''quoted'\\'''");
    });

    it('macos: inherits linux cleanExec', () => {
      const { command, env, shell } = macos.cleanExec('echo hello');
      expect(command).toBe("env -i bash -l -c 'echo hello'");
      expect(env).toBeUndefined();
      expect(shell).toBeUndefined();
    });

    it.skipIf(process.platform !== 'win32')('windows: returns pristine env and powershell shell', () => {
      const { command, env, shell } = windows.cleanExec('echo hello');
      expect(command).toBe('echo hello');
      expect(shell).toBe('powershell.exe');
      expect(env).toBeDefined();
      expect(env!['Path'] ?? env!['PATH']).toBeTruthy();
      expect(env!['USERPROFILE']).toBeTruthy();
    });

    it.skipIf(process.platform !== 'win32')('windows: env excludes process-only vars', () => {
      process.env.__FLEET_TEST_MARKER__ = 'should-not-appear';
      try {
        const { env } = windows.cleanExec('echo hello');
        expect(env!['__FLEET_TEST_MARKER__']).toBeUndefined();
      } finally {
        delete process.env.__FLEET_TEST_MARKER__;
      }
    });
  });
});

describe('injection prevention', () => {
  const linux = getOsCommands('linux');
  const windows = getOsCommands('windows');

  it('escapes folder injection in disk command', () => {
    const cmd = linux.disk('/home/user/$(whoami)/project');
    expect(cmd).toContain('\\$(whoami)');
  });

  it('escapes folder injection in mkdir command', () => {
    const cmd = linux.mkdir('/tmp/$(rm -rf /)');
    expect(cmd).toContain('\\$(rm');

    const winCmd = windows.mkdir('C:\\test"&whoami&"');
    expect(winCmd).toContain('New-Item');
    expect(winCmd).toContain('""');
    expect(winCmd).toContain('^&');
  });

  it('escapes folder injection in fleet process check', () => {
    const cmd = linux.fleetProcessCheck('/home/user/$(whoami)');
    expect(cmd).toContain('\\$');
    expect(cmd).toContain('\\(');

    const winCmd = windows.fleetProcessCheck('C:\\Users\\dev"&whoami&"project');
    expect(winCmd).toContain('""');
    expect(winCmd).toContain('^&');
  });

  it('escapes injection in setenv values', () => {
    const linuxCmds = linux.setEnv('MY_VAR', '"; rm -rf / #');
    for (const cmd of linuxCmds) {
      expect(cmd).toContain('\\"');
    }

    // PowerShell single-quote escaping: values are wrapped in '...', no shell metachar expansion
    const winCmds = windows.setEnv('MY_VAR', "test'injection");
    expect(winCmds[0]).toContain("''");
    expect(winCmds[0]).toContain('SetEnvironmentVariable');
  });
});
