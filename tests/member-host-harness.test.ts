/**
 * Pure helpers of the member-host harness (tests/integration/member-host):
 * the disposable opt-in refusal, the quote-led command cases and the sandbox
 * path / spawn-env resolution. Runs on any OS; no VM, no network, no ssh.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DISPOSABLE_FLAG, DISPOSABLE_PS_SWITCH, disposableRefusal } from './integration/member-host/lib/opt-in.mjs';
import { QUOTE_LED_CASES, verifyEcho } from './integration/member-host/lib/commands.mjs';
import { assertInside, isInside, resolveSandbox, sandboxEnv } from './integration/member-host/lib/sandbox.mjs';
import { wrapPosixEncoded } from '../src/services/member-fleet-install.js';

const HARNESS = path.join(__dirname, 'integration', 'member-host');

describe('member-host opt-in refusal', () => {
  const ok = { env: { CI: 'true' }, optInFlag: true, platform: 'win32', needWindows: true };

  it('allows only CI=true AND the explicit flag', () => {
    expect(disposableRefusal(ok)).toBeNull();
  });

  it('refuses loudly without the flag, without CI=true, or without both', () => {
    expect(disposableRefusal({ ...ok, optInFlag: false })).toMatch(/^REFUSED:.*--i-am-disposable was not passed/);
    expect(disposableRefusal({ ...ok, env: {} })).toMatch(/^REFUSED:.*env CI is not "true"/);
    const both = disposableRefusal({ env: {}, optInFlag: false })!;
    expect(both).toMatch(/env CI is not "true"; --i-am-disposable was not passed/);
    expect(disposableRefusal({ ...ok, env: { CI: '1' } })).toMatch(/^REFUSED:/);
  });

  it('the OpenSSH + Git Bash setup is Windows-only', () => {
    expect(disposableRefusal({ ...ok, platform: 'linux' })).toMatch(/Windows setup/);
    expect(disposableRefusal({ env: { CI: 'true' }, optInFlag: true, platform: 'linux', needWindows: false })).toBeNull();
  });

  it('the setup script mirrors the refusal: exits 2 unless -IAmDisposable AND CI=true', () => {
    const ps = fs.readFileSync(path.join(HARNESS, 'setup-openssh-gitbash.ps1'), 'utf8');
    expect(DISPOSABLE_PS_SWITCH).toBe('-IAmDisposable');
    expect(ps).toMatch(/\[switch\]\$IAmDisposable/);
    expect(ps).toMatch(/if \(-not \$IAmDisposable -or \$env:CI -ne 'true'\)/);
    // the refusal branch exits non-zero before any system change
    const refuseAt = ps.indexOf("exit 2");
    expect(refuseAt).toBeGreaterThan(0);
    for (const change of ['Add-WindowsCapability', 'New-LocalUser', 'ssh-keygen', 'Start-Service']) {
      expect(ps.indexOf(change)).toBeGreaterThan(refuseAt);
    }
  });

  it('the setup script never touches real credentials: key is generated per run in the temp dir', () => {
    const ps = fs.readFileSync(path.join(HARNESS, 'setup-openssh-gitbash.ps1'), 'utf8');
    expect(ps).toMatch(/RUNNER_TEMP/);
    expect(ps).toMatch(/ssh-keygen -q -t ed25519/);
    expect(ps).toMatch(/from=`"127\.0\.0\.1,::1`"/); // authorized for localhost only
    expect(ps).not.toMatch(/\.ssh[\\/]id_|GITHUB_TOKEN|\$env:.*(TOKEN|SECRET)/);
    expect(/[^\x00-\x7f]/.test(ps)).toBe(false);
  });

  it('keeps the flag spelling shared with the fresh-install harness', () => {
    expect(DISPOSABLE_FLAG).toBe('--i-am-disposable');
  });
});

describe('member-host quote-led command cases', () => {
  it('has a case starting with a single-quoted path and one with embedded double quotes', () => {
    const [single, dbl] = QUOTE_LED_CASES;
    expect(single.command.startsWith("'")).toBe(true);
    expect(dbl.command.startsWith('"')).toBe(true);
    expect(dbl.command).toContain('\\"');
  });

  it('every case begins with a quote (the shape sshd + Git Bash mangled)', () => {
    for (const c of QUOTE_LED_CASES) expect(/^['"]/.test(c.command), c.id).toBe(true);
  });

  it('verifyEcho compares the exact argv echo and ignores only trailing newlines / CR', () => {
    const c = QUOTE_LED_CASES[0];
    expect(verifyEcho(c, `${c.expected}\r\n`).ok).toBe(true);
    expect(verifyEcho(c, c.expected).ok).toBe(true);
    expect(verifyEcho(c, 'alpha|beta|gamma').ok).toBe(false); // lost the space inside 'be ta'
    expect(verifyEcho(c, '').ok).toBe(false);                // the bare binary ran: no argv
    expect(verifyEcho(QUOTE_LED_CASES[1], 'a quoted b|c').ok).toBe(false); // embedded quotes stripped
    expect(verifyEcho(QUOTE_LED_CASES[1], QUOTE_LED_CASES[1].expected).ok).toBe(true);
  });

  it('the commands travel base64 + eval: the wrapped form starts with no quote and carries none of the payload quotes', () => {
    for (const c of QUOTE_LED_CASES) {
      const wrapped = wrapPosixEncoded(c.command);
      expect(wrapped.startsWith('s=$(echo ')).toBe(true);
      expect(wrapped).not.toContain("'");
      const b64 = /echo ([A-Za-z0-9+/=]+) \|/.exec(wrapped)![1];
      expect(Buffer.from(b64, 'base64').toString('utf8')).toBe(c.command);
    }
  });
});

describe('member-host sandbox path resolution', () => {
  const root = path.join(os.tmpdir(), 'mh-test-root');
  const sb = resolveSandbox(root);

  it('every resolved path is inside the sandbox root', () => {
    for (const p of Object.values(sb)) expect(isInside(sb.root, p), p).toBe(true);
  });

  it('HOME, USERPROFILE and GIT_CONFIG_GLOBAL point inside the sandbox for the spawn env', () => {
    const env = sandboxEnv({ HOME: '/real/home', USERPROFILE: 'C:\\Users\\real', GIT_CONFIG_GLOBAL: '/real/.gitconfig', PATH: '/bin' }, sb);
    for (const k of ['HOME', 'USERPROFILE', 'GIT_CONFIG_GLOBAL', 'TMP', 'TEMP', 'TMPDIR', 'APRA_FLEET_DATA_DIR']) {
      expect(isInside(sb.root, env[k]), `${k}=${env[k]}`).toBe(true);
    }
    expect(env.PATH).toBe('/bin');
  });

  it('assertInside refuses a path outside the sandbox, including .. escapes', () => {
    expect(() => assertInside(sb, sb.home, sb.out)).not.toThrow();
    expect(() => assertInside(sb, path.join(root, '..', 'elsewhere'))).toThrow(/outside the sandbox/);
    expect(() => assertInside(sb, path.join(sb.home, '..', '..', 'x'))).toThrow(/outside the sandbox/);
    expect(() => assertInside(sb, os.homedir())).toThrow(/outside the sandbox/);
  });

  it('the generated SSH key lives in the sandbox key dir, not under a real home', () => {
    expect(isInside(sb.keyDir, sb.keyPath)).toBe(true);
    expect(isInside(os.homedir(), sb.keyPath) && !isInside(sb.root, sb.keyPath)).toBe(false);
  });
});
