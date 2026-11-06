import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildProgramInvocation,
  isBatchProgram,
  quoteCmdArg,
} from '../../src/services/live-secret-runner.js';
import { afterStdinJs, futureIso, makeTempDir, runLaunch, writeNodeHelper } from './token-command-helpers.js';

const CREDENTIAL = 'kb-windows-launch-cred';

const BS = '\\';

/** Every character cmd.exe or the argv parser treats specially, plus a mixed hostile value. */
const HOSTILE_ARGS = [
  'with space',
  'say "hi"',
  '%PATH%',
  '100%',
  '^caret^',
  'a&b',
  'a|b',
  'a<b',
  'a>b',
  '(paren)',
  '!OS!',
  `trail${BS}`,
  `two trail${BS}${BS}`,
  `q${BS}"r`,
  '" & echo pwned & "',
  '',
];

let tmp: string;

beforeEach(() => {
  tmp = makeTempDir('cred-helper-winlaunch-');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('quoteCmdArg (runs on every OS)', () => {
  it('wraps plain text and spaces in double quotes', () => {
    expect(quoteCmdArg('plain')).toBe('"plain"');
    expect(quoteCmdArg('with space')).toBe('"with space"');
    expect(quoteCmdArg('')).toBe('""');
  });

  it('doubles an embedded double quote so cmd.exe quote state never flips', () => {
    expect(quoteCmdArg('say "hi"')).toBe('"say ""hi"""');
  });

  it('breaks every % so no %NAME% can expand', () => {
    expect(quoteCmdArg('%PATH%')).toBe('"%%cd:~,%PATH%%cd:~,%"');
    expect(quoteCmdArg('100%')).toBe('"100%%cd:~,%"');
  });

  it('leaves ^ & | < > ( ) ! literal inside the quotes', () => {
    for (const ch of ['^', '&', '|', '<', '>', '(', ')', '!']) {
      expect(quoteCmdArg(`a${ch}b`)).toBe(`"a${ch}b"`);
    }
  });

  it('doubles trailing backslashes so they cannot escape the closing quote', () => {
    expect(quoteCmdArg(`trail${BS}`)).toBe(`"trail${BS}${BS}"`);
    expect(quoteCmdArg(`two${BS}${BS}`)).toBe(`"two${BS}${BS}${BS}${BS}"`);
  });

  it('doubles backslashes before an embedded quote, and keeps other backslashes literal', () => {
    expect(quoteCmdArg(`q${BS}"r`)).toBe(`"q${BS}${BS}""r"`);
    expect(quoteCmdArg(`C:${BS}dir${BS}file`)).toBe(`"C:${BS}dir${BS}file"`);
  });

  it('never lets a hostile value close the quoting early', () => {
    const quoted = quoteCmdArg('" & echo pwned & "');
    expect(quoted).toBe('""" & echo pwned & """');
    // Every " pair is balanced: cmd.exe stays inside quotes from start to end.
    expect((quoted.match(/"/g) ?? []).length % 2).toBe(0);
  });

  it('throws on a line break or NUL, which cmd.exe cannot carry', () => {
    for (const bad of ['a\nb', 'a\rb', 'a\0b']) {
      expect(() => quoteCmdArg(bad)).toThrow(/line break or NUL/);
    }
  });
});

describe('buildProgramInvocation (runs on every OS)', () => {
  const CMD = `C:${BS}Windows${BS}System32${BS}cmd.exe`;
  const PS = `C:${BS}Windows${BS}System32${BS}WindowsPowerShell${BS}v1.0${BS}powershell.exe`;
  const tools = (tool: string) => (tool === 'cmd' ? CMD : tool === 'powershell' ? PS : null);

  it('launches a .cmd or .bat on Windows through the resolved cmd.exe /d /v:off /s /c with every piece quoted', () => {
    const program = `C:${BS}Program Files${BS}az${BS}az.cmd`;
    const args = ['account', 'get-access-token', '%TEMP%'];
    expect(buildProgramInvocation(program, args, 'win32', tools)).toEqual({
      file: CMD,
      args: ['/d', '/v:off', '/s', '/c', `"${[program, ...args].map(quoteCmdArg).join(' ')}"`],
      windowsVerbatimArguments: true,
    });
    expect(buildProgramInvocation('C:/x/helper.BAT', [], 'win32', tools).file).toBe(CMD);
  });

  it('refuses a batch file when no absolute cmd.exe can be found, instead of a bare name', () => {
    expect(() => buildProgramInvocation('C:/x/helper.cmd', [], 'win32', () => null)).toThrow(/cmd\.exe was not found/);
  });

  it('runs a .ps1 on Windows through the resolved powershell.exe -File', () => {
    const script = `C:${BS}kb${BS}mint.ps1`;
    expect(buildProgramInvocation(script, ['a b'], 'win32', tools)).toEqual({
      file: PS,
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, 'a b'],
      windowsVerbatimArguments: false,
    });
  });

  it('spawns a .exe on Windows directly, never through cmd.exe', () => {
    const inv = buildProgramInvocation(`C:${BS}tools${BS}helper.exe`, ['%PATH%', 'a&b'], 'win32', tools);
    expect(inv).toEqual({ file: `C:${BS}tools${BS}helper.exe`, args: ['%PATH%', 'a&b'], windowsVerbatimArguments: false });
  });

  it('spawns POSIX programs directly, even one named like a batch file', () => {
    expect(buildProgramInvocation('/usr/bin/az', ['a b'], 'linux')).toEqual(
      { file: '/usr/bin/az', args: ['a b'], windowsVerbatimArguments: false });
    expect(buildProgramInvocation('/opt/helper.cmd', ['x'], 'darwin')).toEqual(
      { file: '/opt/helper.cmd', args: ['x'], windowsVerbatimArguments: false });
  });

  it('recognises .cmd and .bat case-insensitively, and nothing else', () => {
    expect(isBatchProgram('az.cmd')).toBe(true);
    expect(isBatchProgram('AZ.CMD')).toBe(true);
    expect(isBatchProgram('run.Bat')).toBe(true);
    expect(isBatchProgram('az.exe')).toBe(false);
    expect(isBatchProgram('cmd.sh')).toBe(false);
  });
});

/** Helper JS: record argv and the parent pid, then answer the protocol. */
function recordingHelperJs(recordPath: string): string {
  return afterStdinJs(
    `fs.writeFileSync(${JSON.stringify(recordPath)},JSON.stringify({argv:process.argv.slice(2),ppid:process.ppid,stdin:input}));` +
    `process.stdout.write(JSON.stringify({token:"tok-from-helper",expires_at:${JSON.stringify(futureIso())}}));`,
  );
}

describe('direct spawn of a non-batch helper (runs on every OS)', () => {
  it('passes hostile argv through unchanged with no shell or cmd.exe in between', async () => {
    const record = path.join(tmp, 'record.json');
    // POSIX: the script itself is the program. Windows: node.exe (a .exe).
    const launch = writeNodeHelper(tmp, 'direct', recordingHelperJs(record), HOSTILE_ARGS);
    expect(isBatchProgram(launch.program)).toBe(false);

    const result = await runLaunch(CREDENTIAL, launch);

    expect(result.token).toBe('tok-from-helper');
    const seen = JSON.parse(fs.readFileSync(record, 'utf8'));
    // The helper's parent is this test process: nothing (no sh, no cmd.exe) sat in between.
    expect(seen.ppid).toBe(process.pid);
    expect(seen.argv).toEqual(HOSTILE_ARGS);
  });
});

describe('Windows .cmd round trip', () => {
  it.skipIf(process.platform !== 'win32')(
    'a .cmd helper forwarding %* receives exactly the registered argv (Windows only: needs cmd.exe; skipped on other OSes)',
    async () => {
      const record = path.join(tmp, 'record.json');
      const dumpScript = path.join(tmp, 'dump.js');
      fs.writeFileSync(dumpScript, recordingHelperJs(record));
      // A directory and file name with spaces and cmd.exe metacharacters, like
      // "C:\Program Files (x86)\...\az.cmd"; the batch forwards %* the way az.cmd does.
      const dir = path.join(tmp, 'Program Files (x86) & %OS%');
      fs.mkdirSync(dir);
      const cmdFile = path.join(dir, 'fake az.cmd');
      fs.writeFileSync(cmdFile, `@"${process.execPath}" "${dumpScript}" %*\r\n`);

      const result = await runLaunch(CREDENTIAL, { program: cmdFile, args: HOSTILE_ARGS });

      expect(result.token).toBe('tok-from-helper');
      const seen = JSON.parse(fs.readFileSync(record, 'utf8'));
      expect(seen.argv).toEqual(HOSTILE_ARGS);
      expect(seen.stdin).toBe('');
    },
  );
});
