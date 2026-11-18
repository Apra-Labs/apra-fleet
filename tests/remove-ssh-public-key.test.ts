import { describe, it, expect } from 'vitest';
import { LinuxCommands, MacOSCommands, WindowsCommands, WindowsGitBashCommands, getOsCommands } from '../src/os/index.js';

// OsCommands.removeSSHPublicKey: the revocation remove_member sends. The
// member home is resolved in JS and must appear literally; the command never
// expands ~ or a home env var, never uses sed -i (BSD sed rejects it), escapes
// the untrusted key text and matches it as a fixed string.

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIremovekey';
// Shell and regex metacharacters: quote, command substitution, glob, regex.
const HOSTILE_KEY = "ssh-ed25519 AA'$(touch${IFS}/tmp/pwn)`id`.*[a]\\";

const decodePs = (cmd: string): string => {
  const m = /^powershell -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(cmd);
  if (!m) throw new Error(`not an encoded PowerShell command: ${cmd}`);
  return Buffer.from(m[1], 'base64').toString('utf16le');
};

describe('removeSSHPublicKey - POSIX (linux, macos)', () => {
  const builders: Array<[string, LinuxCommands]> = [
    ['linux', new LinuxCommands()],
    ['macos', new MacOSCommands()],
  ];

  for (const [name, cmds] of builders) {
    it(`${name}: targets the resolved home literally, no ~/, no $HOME, no sed -i`, () => {
      const cmd = cmds.removeSSHPublicKey(KEY, '/home/alice/');
      expect(cmd).toContain("_fleet_ak='/home/alice/.ssh/authorized_keys'");
      expect(cmd).not.toContain('~');
      expect(cmd).not.toContain('$HOME');
      expect(cmd).not.toMatch(/sed\s+-i/);
      // Fixed-string match, with an option terminator before the pattern.
      expect(cmd).toContain(`grep -vF -- '${KEY}'`);
      // The filtered file keeps mode 600.
      expect(cmd).toContain('chmod 600');
    });

    it(`${name}: escapes a key with shell/regex metacharacters into one single-quoted literal`, () => {
      const cmd = cmds.removeSSHPublicKey(HOSTILE_KEY, '/home/alice');
      // The only quote in the key is closed/escaped/reopened ('\''); every
      // other metacharacter stays inside single quotes, so nothing expands.
      const expected = `'${HOSTILE_KEY.replace(/'/g, "'\\''")}'`;
      expect(cmd).toContain(`grep -vF -- ${expected} "$_fleet_ak"`);
    });

    it(`${name}: escapes a hostile home path`, () => {
      const cmd = cmds.removeSSHPublicKey(KEY, "/home/o'neil");
      expect(cmd).toContain("_fleet_ak='/home/o'\\''neil/.ssh/authorized_keys'");
    });
  }

  it('macos uses the same portable command as linux', () => {
    expect(new MacOSCommands().removeSSHPublicKey(KEY, '/Users/a')).toBe(new LinuxCommands().removeSSHPublicKey(KEY, '/Users/a'));
  });
});

describe('removeSSHPublicKey - Windows PowerShell', () => {
  const cmds = new WindowsCommands();

  it('is one encoded PowerShell command', () => {
    expect(cmds.removeSSHPublicKey(KEY, 'C:\\Users\\alice')).toMatch(/^powershell -EncodedCommand [A-Za-z0-9+/=]+$/);
  });

  it('targets the resolved user file literally and the admin file for administrators', () => {
    const script = decodePs(cmds.removeSSHPublicKey(KEY, 'C:\\Users\\alice\\'));
    expect(script).toContain("$files = @('C:\\Users\\alice\\.ssh\\authorized_keys')");
    expect(script).not.toContain('$env:USERPROFILE');
    expect(script).not.toContain('~');
    // Admin branch: same probe and path deploySSHPublicKey uses.
    expect(script).toContain('IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)');
    expect(script).toContain('if ($isAdmin) { $files += "$env:ProgramData\\ssh\\administrators_authorized_keys" }');
    const deployAdmin = cmds.deploySSHPublicKey(KEY).join('\n');
    expect(deployAdmin).toContain('$env:ProgramData\\ssh\\administrators_authorized_keys');
  });

  it('matches the key literally (String.Contains, no regex) and escapes quotes', () => {
    const script = decodePs(cmds.removeSSHPublicKey(HOSTILE_KEY, 'C:\\Users\\alice'));
    expect(script).toContain(`$k = '${HOSTILE_KEY.replace(/'/g, "''")}';`);
    expect(script).toContain('-not $_.Contains($k)');
    expect(script).not.toMatch(/-notmatch|-match|\[regex\]/);
  });
});

describe('removeSSHPublicKey - Windows git bash', () => {
  const cmds = new WindowsGitBashCommands();

  it('targets the resolved home literally (backslashes normalised), no ~/, no $HOME, no sed -i', () => {
    for (const home of ['/c/Users/alice', 'C:\\Users\\alice']) {
      const cmd = cmds.removeSSHPublicKey(KEY, home);
      const expected = home.startsWith('/') ? '/c/Users/alice' : 'C:/Users/alice';
      expect(cmd).toContain(`_fleet_ak='${expected}/.ssh/authorized_keys'`);
      expect(cmd).not.toContain('~');
      expect(cmd).not.toContain('$HOME');
      expect(cmd).not.toMatch(/sed\s+-i/);
      expect(cmd).not.toMatch(/Get-|Set-|\$env:/);
    }
  });

  it('also filters administrators_authorized_keys behind the same admin probe deploy uses', () => {
    const cmd = cmds.removeSSHPublicKey(KEY, '/c/Users/alice');
    const deploy = cmds.deploySSHPublicKey(KEY).join('\n');
    expect(deploy).toContain('if net session >/dev/null 2>&1; then');
    expect(cmd).toContain('if net session >/dev/null 2>&1; then _fleet_ak="$(cygpath -u "${ProgramData:-C:/ProgramData}")/ssh/administrators_authorized_keys"');
    // The fixed-string filter runs for both files.
    expect(cmd.match(/grep -vF -- /g)).toHaveLength(2);
  });

  it('escapes a key with shell/regex metacharacters into one single-quoted literal', () => {
    const cmd = cmds.removeSSHPublicKey(HOSTILE_KEY, '/c/Users/alice');
    const expected = `'${HOSTILE_KEY.replace(/'/g, "'\\''")}'`;
    expect(cmd).toContain(`grep -vF -- ${expected} "$_fleet_ak"`);
  });

  it('is what getOsCommands returns for a windows member with the gitbash shell', () => {
    expect(getOsCommands('windows', 'gitbash').removeSSHPublicKey(KEY, '/c/Users/a')).toBe(cmds.removeSSHPublicKey(KEY, '/c/Users/a'));
    expect(getOsCommands('windows').removeSSHPublicKey(KEY, 'C:\\Users\\a')).toBe(new WindowsCommands().removeSSHPublicKey(KEY, 'C:\\Users\\a'));
  });
});
