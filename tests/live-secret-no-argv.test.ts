/**
 * The bound value is never on a command line: every invocation shape on both
 * OS families (pure, any host), plus a real run on this host in which the script
 * records its own command line through the OS.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildLiveInvocation,
  envVarForSecret,
  resolvePosixBash,
  rewriteInlineScript,
  runLiveSecret,
} from '../src/services/live-secret-runner.js';

const CANARY = 'bound-ARGV-CANARY-41c7e9a0';
const BINDINGS = [{ env: envVarForSecret('sp-secret'), secret: 'sp-secret' }];
const INLINE = 'curl --token {{secret.sp-secret}} https://x';
const tools = (tool: string) => `C:\\Windows\\System32\\${tool}.exe`;

function decodePowerShell(b64: string): string {
  return Buffer.from(b64, 'base64').toString('utf16le');
}

describe('env var mapping', () => {
  it('maps - to _ and keeps the case', () => {
    expect(envVarForSecret('sp-secret')).toBe('FLEET_SECRET_sp_secret');
    expect(envVarForSecret('R')).toBe('FLEET_SECRET_R');
  });
});

describe('inline rewrite', () => {
  it('bash: quoted variable reference, nothing to escape', () => {
    expect(rewriteInlineScript(INLINE, BINDINGS, 'linux')).toBe('curl --token "$FLEET_SECRET_sp_secret" https://x');
    expect(rewriteInlineScript(INLINE, BINDINGS, 'darwin')).toBe('curl --token "$FLEET_SECRET_sp_secret" https://x');
  });

  it('PowerShell: braced env reference', () => {
    expect(rewriteInlineScript(INLINE, BINDINGS, 'win32')).toBe('curl --token ${env:FLEET_SECRET_sp_secret} https://x');
  });

  it('a word character right after the placeholder cannot change which variable is read', () => {
    expect(rewriteInlineScript('{{secret.sp-secret}}_x', BINDINGS, 'win32')).toBe('${env:FLEET_SECRET_sp_secret}_x');
    expect(rewriteInlineScript('{{secret.sp-secret}}_x', BINDINGS, 'linux')).toBe('"$FLEET_SECRET_sp_secret"_x');
  });

  it.skipIf(process.platform !== 'win32')('Windows only: PowerShell reads the right variable with a word character after it', async () => {
    const invocation = buildLiveInvocation(
      { inline: `$tok = "{{secret.sp-secret}}_x"; '{"token":"' + $tok + '","expires_at":"2099-01-01T00:00:00Z"}'`, bindings: BINDINGS },
      'win32',
    );
    const out = await runLiveSecret({ credential: 'delim', invocation, env: { FLEET_SECRET_sp_secret: 'value' } });
    expect(out.token).toBe('value_x');
  }, 30_000);

  it('rewrites every occurrence', () => {
    expect(rewriteInlineScript('{{secret.sp-secret}} {{secret.sp-secret}}', BINDINGS, 'linux'))
      .toBe('"$FLEET_SECRET_sp_secret" "$FLEET_SECRET_sp_secret"');
  });
});

describe('invocations carry references only', () => {
  it('inline on POSIX: absolute bash -c with the rewritten script, no placeholder and no value', () => {
    const inv = buildLiveInvocation({ inline: INLINE, bindings: BINDINGS }, 'linux', tools, () => '/bin/bash');
    expect(inv.file).toBe('/bin/bash');
    expect(inv.args).toEqual(['-c', 'curl --token "$FLEET_SECRET_sp_secret" https://x']);
  });

  it('inline on Windows: absolute powershell -EncodedCommand with the rewritten script', () => {
    const inv = buildLiveInvocation({ inline: INLINE, bindings: BINDINGS }, 'win32', tools);
    expect(inv.file).toBe('C:\\Windows\\System32\\powershell.exe');
    expect(inv.args.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
    expect(decodePowerShell(inv.args[5])).toBe('curl --token ${env:FLEET_SECRET_sp_secret} https://x');
  });

  it('script file on POSIX and Windows: the bound env var is not in argv at all', () => {
    const bindings = [{ env: 'CLIENT_SECRET', secret: 'sp-secret' }];
    for (const [platform, program] of [['linux', '/opt/mint.sh'], ['darwin', '/opt/mint.sh'], ['win32', 'C:\\k\\mint.exe'], ['win32', 'C:\\k\\mint.cmd'], ['win32', 'C:\\k\\mint.ps1']] as const) {
      const inv = buildLiveInvocation({ program, args: ['--flag'], bindings }, platform, tools);
      const line = [inv.file, ...inv.args].join(' ');
      expect(line).not.toContain('CLIENT_SECRET');
      expect(line).not.toContain('sp-secret');
      expect(line).toContain('--flag');
    }
  });

  it('refuses an inline script when no absolute shell is found, instead of a bare name', () => {
    expect(() => buildLiveInvocation({ inline: 'x', bindings: [] }, 'linux', tools, () => null)).toThrow(/bash was not found/);
    expect(() => buildLiveInvocation({ inline: 'x', bindings: [] }, 'win32', () => null)).toThrow(/powershell\.exe was not found/);
  });
});

describe('resolvePosixBash', () => {
  it('prefers /bin, then /usr/bin, then absolute PATH entries, and skips relative ones', () => {
    expect(resolvePosixBash('', (p) => p === '/bin/bash')).toBe('/bin/bash');
    expect(resolvePosixBash('', (p) => p === '/usr/bin/bash')).toBe('/usr/bin/bash');
    expect(resolvePosixBash('.:rel:/opt/b', (p) => p === '/opt/b/bash')).toBe('/opt/b/bash');
    expect(resolvePosixBash('.:rel', (p) => p === 'rel/bash' || p === 'bash')).toBeNull();
  });
});

describe('real run on this host: the value reaches the script and is on no command line', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-argv-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const tokenJson = `{"token":"t","expires_at":"2099-01-01T00:00:00Z"}`;

  it('inline: the shell command line holds the reference, the env holds the value', async () => {
    const out = path.join(tmp, 'cmdline.txt');
    const match = path.join(tmp, 'match.txt');
    const inline = process.platform === 'win32'
      ? `(Get-CimInstance Win32_Process -Filter "ProcessId=$PID").CommandLine | Set-Content -LiteralPath '${out}'; ` +
        `if ({{secret.sp-secret}} -eq '${'x'}' + $env:EXPECT_SUFFIX) { 'yes' | Set-Content -LiteralPath '${match}' }; '${tokenJson}'`
      : `ps -ww -o args= -p $$ > '${out}'; [ {{secret.sp-secret}} = "x$EXPECT_SUFFIX" ] && echo yes > '${match}'; printf '%s' '${tokenJson}'`;
    const value = `x${CANARY}`;
    const invocation = buildLiveInvocation({ inline, bindings: BINDINGS }, process.platform);
    expect(JSON.stringify(invocation)).not.toContain(CANARY);

    const result = await runLiveSecret({
      credential: 'inl',
      invocation,
      env: { FLEET_SECRET_sp_secret: value, EXPECT_SUFFIX: CANARY },
    });

    expect(result.token).toBe('t');
    expect(fs.existsSync(match)).toBe(true); // the value did reach the script
    const cmdline = fs.readFileSync(out, 'utf8');
    expect(cmdline.length).toBeGreaterThan(0);
    expect(cmdline).not.toContain(CANARY);
    if (process.platform !== 'win32') expect(cmdline).toContain('$FLEET_SECRET_sp_secret');
  }, 30_000);

  it('script file: the process command line never holds the bound env value', async () => {
    const out = path.join(tmp, 'cmdline.txt');
    const js = path.join(tmp, 'mint.js');
    fs.writeFileSync(js, `
      const fs = require('fs'); const cp = require('child_process');
      const cmd = process.platform === 'win32'
        ? cp.execFileSync('powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Process -Filter "ProcessId=' + process.pid + '").CommandLine'], { encoding: 'utf8' })
        : cp.execFileSync('ps', ['-ww', '-o', 'args=', '-p', String(process.pid)], { encoding: 'utf8' });
      fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ cmd, delivered: process.env.CLIENT_SECRET }));
      process.stdout.write(${JSON.stringify(tokenJson)});
    `);
    const invocation = buildLiveInvocation(
      { program: process.execPath, args: [js], bindings: [{ env: 'CLIENT_SECRET', secret: 's' }] },
      process.platform,
    );
    await runLiveSecret({ credential: 'file', invocation, env: { CLIENT_SECRET: CANARY } });
    const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(seen.delivered).toBe(CANARY);
    expect(seen.cmd).toContain('mint.js');
    expect(seen.cmd).not.toContain(CANARY);
  }, 30_000);
});
