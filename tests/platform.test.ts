import { describe, it, expect } from 'vitest';
import { detectOS, isContainedInWorkFolder } from '../src/utils/platform.js';
import { getSSHConfig } from '../src/services/ssh.js';
import { getOsCommands } from '../src/os/index.js';
import type { OsCommands } from '../src/os/index.js';
import { getProvider } from '../src/providers/index.js';

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

  describe('generic agent CLI commands', () => {
    const claudeProvider = getProvider('claude');
    const geminiProvider = getProvider('gemini');

    for (const [name, cmds] of all) {
      it(`${name}: agentVersion includes --version for claude provider`, () => {
        expect(cmds.agentVersion(claudeProvider)).toContain('--version');
        expect(cmds.agentVersion(claudeProvider)).toContain('claude');
      });

      it(`${name}: agentVersion includes --version for gemini provider`, () => {
        expect(cmds.agentVersion(geminiProvider)).toContain('--version');
        expect(cmds.agentVersion(geminiProvider)).toContain('gemini');
      });

      it(`${name}: agentCommand prepends PATH for claude`, () => {
        const cmd = cmds.agentCommand(claudeProvider, '-p "hello"');
        expect(cmd).toContain('claude -p "hello"');
      });

      it(`${name}: installAgent returns an install command`, () => {
        expect(cmds.installAgent(claudeProvider).length).toBeGreaterThan(10);
      });

      it(`${name}: installAgent uses macos install for gemini on macos`, () => {
        // macOS uses provider.installCommand('macos')
        const isWindows = name === 'windows';
        const isLinux = name === 'linux';
        const cmd = cmds.installAgent(geminiProvider);
        expect(cmd).toContain('gemini-cli');
        if (!isWindows && !isLinux) {
          // macOS: same npm command
          expect(cmd).toContain('npm');
        }
      });

      it(`${name}: updateAgent returns an update command`, () => {
        const cmd = cmds.updateAgent(claudeProvider);
        expect(cmd).toContain('claude update');
      });
    }

    describe('buildAgentPromptCommand', () => {
      const opts = { folder: '/tmp/work', promptFile: '.fleet-task.md' };

      for (const [name, cmds] of all) {
        it(`${name}: claude provider buildAgentPromptCommand includes prompt file reference and flags`, () => {
          const generic = cmds.buildAgentPromptCommand(claudeProvider, opts);
          expect(generic).toContain('.fleet-task.md');
          expect(generic).toContain('--output-format json');
          expect(generic).toContain('--max-turns 50');
        });

        it(`${name}: gemini provider uses gemini binary`, () => {
          const cmd = cmds.buildAgentPromptCommand(geminiProvider, opts);
          expect(cmd).toContain('gemini');
          expect(cmd).toContain('.fleet-task.md');
          expect(cmd).toContain('--output-format json');
          expect(cmd).not.toContain('--max-turns'); // gemini doesn't support max-turns
        });
      }

      it('windows: gemini prompt command uses PowerShell syntax', () => {
        const cmd = windows.buildAgentPromptCommand(geminiProvider, opts);
        expect(cmd).toContain('Set-Location');
        expect(cmd).toContain('.fleet-task.md');
        expect(cmd).toContain('gemini');
      });

      it('windows: claude prompt command includes max-turns', () => {
        const cmd = windows.buildAgentPromptCommand(claudeProvider, opts);
        expect(cmd).toContain('--max-turns 50');
      });
    });
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
      expect(macosCmds.length).toBe(5);
      expect(macosCmds.some(c => c.includes('.zshrc'))).toBe(true);
      expect(macosCmds.some(c => c.includes('.zshenv'))).toBe(true);

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
      expect(macosCmds.length).toBe(5);
      expect(macosCmds.some(c => c.includes('.zshenv'))).toBe(true);
      expect(macosCmds[4]).toContain('unset MY_VAR');

      const winCmds = windows.unsetEnv('MY_VAR');
      expect(winCmds[0]).toContain('SetEnvironmentVariable');
    });
  });

  describe('auth commands', () => {
    for (const [name, cmds] of all) {
      it(`${name}: credentialFileCheck returns a check command`, () => {
        const cmd = cmds.credentialFileCheck('~/.claude/.credentials.json');
        expect(cmd).toContain('credentials.json');
      });

      it(`${name}: credentialFileWrite produces a write command`, () => {
        const cmd = cmds.credentialFileWrite('{\"token\":\"abc\"}', '~/.claude/.credentials.json');
        expect(cmd).toMatch(/credentials\.json|EncodedCommand/);
      });

      it(`${name}: credentialFileRemove produces a remove command`, () => {
        const cmd = cmds.credentialFileRemove('~/.claude/.credentials.json');
        expect(cmd.length).toBeGreaterThan(5);
      });

      it(`${name}: apiKeyCheck returns a check command`, () => {
        const cmd = cmds.apiKeyCheck();
        expect(cmd).toContain('ANTHROPIC_API_KEY');
      });

      it(`${name}: apiKeyCheck accepts a provider-specific env var name`, () => {
        const cmd = cmds.apiKeyCheck('GEMINI_API_KEY');
        expect(cmd).toContain('GEMINI_API_KEY');
        expect(cmd).not.toContain('ANTHROPIC_API_KEY');
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

  describe('wrapInWorkFolder', () => {
    it('linux: wraps with cd and &&', () => {
      expect(linux.wrapInWorkFolder('/home/user/project', 'echo hi'))
        .toBe('cd "/home/user/project" && echo hi');
    });

    it('macos: inherits linux wrapInWorkFolder', () => {
      expect(macos.wrapInWorkFolder('/opt/app', 'ls -la'))
        .toBe('cd "/opt/app" && ls -la');
    });

    it('windows: wraps with Set-Location', () => {
      expect(windows.wrapInWorkFolder('C:\\Users\\dev\\project', 'Get-ChildItem'))
        .toContain('Set-Location');
      expect(windows.wrapInWorkFolder('C:\\Users\\dev\\project', 'Get-ChildItem'))
        .toContain('Get-ChildItem');
    });

    it('escapes folder injection in linux', () => {
      const cmd = linux.wrapInWorkFolder('/home/$(whoami)/project', 'echo hi');
      expect(cmd).toContain('\\$(whoami)');
    });

    it('escapes folder injection in windows', () => {
      const cmd = windows.wrapInWorkFolder('C:\\test"&whoami&"', 'echo hi');
      expect(cmd).toContain('""');
      expect(cmd).toContain('^&');
    });
  });

  describe('git credential helper', () => {
    for (const [name, cmds] of all) {
      it(`${name}: gitCredentialHelperWrite uses host-specific credential config key`, () => {
        const cmd = cmds.gitCredentialHelperWrite('github.com', 'x-access-token', 'ghs_testtoken123');
        expect(cmd).toContain('github.com');
        expect(cmd).toContain('x-access-token');
        expect(cmd).toContain('credential.https://github.com.helper');
        expect(cmd).toContain('fleet-git-credential');
      });

      it(`${name}: gitCredentialHelperWrite writes stack-reset empty entry before helper`, () => {
        const cmd = cmds.gitCredentialHelperWrite('github.com', 'x-access-token', 'ghs_testtoken123');
        const replacePos = cmd.indexOf('--replace-all');
        const addPos = cmd.indexOf('--add');
        expect(replacePos).toBeGreaterThan(-1);
        expect(addPos).toBeGreaterThan(-1);
        expect(replacePos).toBeLessThan(addPos);
      });

      it(`${name}: gitCredentialHelperRemove cleans up host-specific git config entry`, () => {
        const cmd = cmds.gitCredentialHelperRemove('github.com');
        expect(cmd).toContain('fleet-git-credential');
        expect(cmd).toContain('credential.https://github.com.helper');
        expect(cmd).toContain('--unset-all');
      });
    }

    it('linux: writes a shell script credential helper', () => {
      const cmd = linux.gitCredentialHelperWrite('github.com', 'x-access-token', 'ghs_abc');
      expect(cmd).toContain('#!/bin/sh');
      expect(cmd).toContain('chmod');
    });

    it('windows: writes a batch script credential helper', () => {
      const cmd = windows.gitCredentialHelperWrite('github.com', 'x-access-token', 'ghs_abc');
      expect(cmd).toContain('@echo off');
      expect(cmd).toContain('Set-Content');
    });

    // VCS multi-host: verify credential helper works for all three VCS hosts
    const vcsHosts: [string, string, string][] = [
      ['github.com', 'x-access-token', 'ghs_token123'],
      ['bitbucket.org', 'user@example.com', 'ATBBtoken456'],
      ['dev.azure.com', '', 'azure-pat-789'],
    ];
    for (const [name, cmds] of all) {
      for (const [host, user, token] of vcsHosts) {
        it(`${name}: credential helper embeds ${host} host-specific config key and credentials`, () => {
          const cmd = cmds.gitCredentialHelperWrite(host, user, token);
          expect(cmd).toContain(host);
          expect(cmd).toContain(token);
          expect(cmd).toContain(`credential.https://${host}.helper`);
        });
      }
    }
  });

  describe('cleanExec', () => {
    it.skipIf(process.platform !== 'linux')('linux: returns pristine env from login shell', () => {
      const { command, env, shell } = linux.cleanExec('echo hello');
      expect(command).toBe('echo hello');
      expect(shell).toBeUndefined();
      expect(env).toBeDefined();
      expect(env!['HOME']).toBeTruthy();
      expect(env!['PATH']).toBeTruthy();
    });

    it.skipIf(process.platform !== 'linux')('linux: env excludes process-only vars', () => {
      process.env.__FLEET_TEST_MARKER__ = 'should-not-appear';
      try {
        const { env } = linux.cleanExec('echo hello');
        expect(env!['__FLEET_TEST_MARKER__']).toBeUndefined();
      } finally {
        delete process.env.__FLEET_TEST_MARKER__;
      }
    });

    it.skipIf(process.platform !== 'darwin')('macos: inherits linux cleanExec', () => {
      const { command, env, shell } = macos.cleanExec('echo hello');
      expect(command).toBe('echo hello');
      expect(shell).toBeUndefined();
      expect(env).toBeDefined();
      expect(env!['HOME']).toBeTruthy();
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

describe('isContainedInWorkFolder', () => {
  it('accepts POSIX relative paths', () => {
    expect(isContainedInWorkFolder('/remote/work', 'file.txt')).toBe(true);
    expect(isContainedInWorkFolder('/remote/work', 'sub/file.txt')).toBe(true);
  });

  it('accepts POSIX absolute path inside workFolder', () => {
    expect(isContainedInWorkFolder('/remote/work', '/remote/work/file.txt')).toBe(true);
  });

  it('rejects POSIX path escaping via ..', () => {
    expect(isContainedInWorkFolder('/remote/work', '../escape.txt')).toBe(false);
    expect(isContainedInWorkFolder('/remote/work', '/etc/passwd')).toBe(false);
  });

  describe('Windows remote workFolder (#146)', () => {
    const winFolder = 'C:\\Users\\aUser\\ODM';

    it('accepts backslash relative path', () => {
      expect(isContainedInWorkFolder(winFolder, 'build\\logs\\net.log')).toBe(true);
    });

    it('accepts forward slash relative path', () => {
      expect(isContainedInWorkFolder(winFolder, 'build/logs/net.log')).toBe(true);
    });

    it('accepts filename only', () => {
      expect(isContainedInWorkFolder(winFolder, 'net.log')).toBe(true);
    });

    it('accepts absolute Windows path inside workFolder', () => {
      expect(isContainedInWorkFolder(winFolder, 'C:\\Users\\aUser\\ODM\\net.log')).toBe(true);
    });

    it('rejects path escaping via ..', () => {
      expect(isContainedInWorkFolder(winFolder, '..\\escape.txt')).toBe(false);
    });

    it('rejects absolute Windows path outside workFolder', () => {
      expect(isContainedInWorkFolder(winFolder, 'C:\\Users\\other\\secret.txt')).toBe(false);
    });
  });
});

describe('SSH username with spaces (#144)', () => {
  it('getSSHConfig passes username with spaces intact', () => {
    const agent: any = {
      host: '192.168.1.1',
      port: 22,
      username: 'tester tester',
      authType: 'password',
      encryptedPassword: undefined,
    };
    // Must not throw and must preserve the space-containing username
    const config = getSSHConfig(agent);
    expect(config.username).toBe('tester tester');
  });

  it('getSSHConfig passes username without spaces intact', () => {
    const agent: any = {
      host: '192.168.1.1',
      port: 22,
      username: 'normaluser',
      authType: 'password',
      encryptedPassword: undefined,
    };
    const config = getSSHConfig(agent);
    expect(config.username).toBe('normaluser');
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

