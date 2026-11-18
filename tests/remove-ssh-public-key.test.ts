import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { LinuxCommands, MacOSCommands, WindowsCommands, WindowsGitBashCommands, getOsCommands } from '../src/os/index.js';
import { authorizedKeyMatch } from '../src/os/ssh-key-match.js';
import { rsaPublicKeyToOpenSSH } from '../src/tools/setup-ssh-key.js';
import { SSH_PUBLIC_KEYS, SSH_INVALID_KEYS, truncatedKeys } from './fixtures/ssh-public-keys.js';

// OsCommands.removeSSHPublicKey: the revocation remove_member sends. The
// member home is resolved in JS and must appear literally; the command never
// expands ~ or a home env var, never uses sed -i (BSD sed rejects it), escapes
// the untrusted key text and matches it as a fixed string. A match that is
// not a complete "<type> <base64>" key (empty, type only, truncated,
// garbage) is refused: it would delete every line, or every key sharing its
// prefix.

const KEY = SSH_PUBLIC_KEYS.ed25519;
// Shell and regex metacharacters: quote, command substitution, glob, regex.
const HOSTILE_KEY = "ssh-ed25519 AA'$(touch${IFS}/tmp/pwn)`id`.*[a]\\";
// Each would match unrelated lines: '' every line, a bare type every key of it.
const DEGENERATE_KEYS: Array<[string, string]> = [
  ['empty', ''],
  ['one-word', 'ssh-rsa'],
  ['short-body', 'ssh-rsa AAAA'],
  ['unknown-type', 'not-a-key AAAAC3NzaC1lZDI1NTE5AAAAIremovekey'],
  ['other-type-body', `ssh-rsa ${KEY.split(' ')[1]}`],
  ['truncated', KEY.slice(0, KEY.length - 8)],
  ['commented', `${KEY} user@host`],
  ['hostile', HOSTILE_KEY],
];

describe('authorizedKeyMatch', () => {
  it('takes type + base64 from a real key line, dropping the comment', () => {
    expect(authorizedKeyMatch(`  ${KEY} fleet@host\n`)).toBe(KEY);
  });
  it.each([
    ['empty', ''],
    ['whitespace', '  \n'],
    ['one word', 'ssh-rsa'],
    ['short body', 'ssh-ed25519 AAAAC3Nza'],
    ['unknown type', 'not-a-key AAAAC3NzaC1lZDI1NTE5AAAAIremovekey'],
    ['body names another type', `ssh-rsa ${KEY.split(' ')[1]}`],
    ['not base64', HOSTILE_KEY],
    ['non-canonical base64 (unpadded)', SSH_PUBLIC_KEYS.ecdsa256.replace(/=$/, '')],
    ...Object.entries(SSH_INVALID_KEYS),
  ])('rejects %s', (_name, line) => {
    expect(authorizedKeyMatch(line)).toBeNull();
  });

  // A truncated key is a prefix of every key sharing its header: an ecdsa key
  // cut inside its point matches every key on that curve.
  for (const [name, key] of Object.entries(SSH_PUBLIC_KEYS)) {
    it(`accepts a complete ${name} key`, () => {
      expect(authorizedKeyMatch(`${key} fleet@host\r\n`)).toBe(key);
    });
    it.each(truncatedKeys(key))(`rejects ${name} truncated: %s`, (_cut, truncated) => {
      expect(authorizedKeyMatch(truncated)).toBeNull();
    });
  }

  it('accepts the RSA-4096 key setup_ssh_key writes, and rejects it truncated', () => {
    const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 4096, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const line = rsaPublicKeyToOpenSSH(publicKey, 'apra-fleet-x');
    const key = line.split(' ').slice(0, 2).join(' ');
    expect(authorizedKeyMatch(line)).toBe(key);
    for (const [, truncated] of truncatedKeys(key)) expect(authorizedKeyMatch(truncated)).toBeNull();
  });
});

describe('removeSSHPublicKey refuses a degenerate key match on every OS', () => {
  const builders: Array<[string, { removeSSHPublicKey(k: string, h: string): string }, string]> = [
    ['linux', new LinuxCommands(), '/home/alice'],
    ['macos', new MacOSCommands(), '/Users/alice'],
    ['windows', new WindowsCommands(), 'C:\\Users\\alice'],
    ['windows gitbash', new WindowsGitBashCommands(), '/c/Users/alice'],
  ];
  for (const [os, cmds, home] of builders) {
    for (const [name, key] of DEGENERATE_KEYS) {
      it(`${os}: throws on a ${name} match`, () => {
        expect(() => cmds.removeSSHPublicKey(key, home)).toThrow(/not a "<type> <base64>" public key/);
      });
    }
    it(`${os}: accepts a valid match`, () => {
      expect(cmds.removeSSHPublicKey(KEY, home)).toBeTruthy();
    });
  }
});

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

  it('matches the key literally (String.Contains, no regex)', () => {
    const script = decodePs(cmds.removeSSHPublicKey(KEY, 'C:\\Users\\alice'));
    expect(script).toContain(`$k = '${KEY}';`);
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

  it('is what getOsCommands returns for a windows member with the gitbash shell', () => {
    expect(getOsCommands('windows', 'gitbash').removeSSHPublicKey(KEY, '/c/Users/a')).toBe(cmds.removeSSHPublicKey(KEY, '/c/Users/a'));
    expect(getOsCommands('windows').removeSSHPublicKey(KEY, 'C:\\Users\\a')).toBe(new WindowsCommands().removeSSHPublicKey(KEY, 'C:\\Users\\a'));
  });
});
