import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as ChildProcessModule from 'node:child_process';

// The Windows branch of launchAuthTerminal opens the credential-entry console.
// Its --prompt text embeds caller-supplied username/host values, so it must
// never be parsed by cmd.exe (% expansion, & | ^ < > operators) or PowerShell.
const spawnCalls: Array<{ file: string; args: string[]; opts: { env?: Record<string, string>; windowsHide?: boolean } }> = [];

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof ChildProcessModule>();
  return {
    ...real,
    spawn: (file: string, args: string[], opts: any) => {
      spawnCalls.push({ file, args, opts });
      return { pid: 4242, on: () => {}, unref: () => {}, stdin: { write: () => {}, end: () => {} } };
    },
  };
});

const HOSTILE_PROMPT = 'Enter SSH password for u"&calc&"@h ^ %PATH% | whoami > x <y \\" end\\';
const HOSTILE_MEMBER = 'mem&ber%OS%';

describe('launchAuthTerminal -- Windows console launch quoting', () => {
  const realPlatform = process.platform;

  beforeEach(() => {
    spawnCalls.length = 0;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.stubEnv('SESSIONNAME', 'Console');
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
    vi.unstubAllEnvs();
  });

  async function launch() {
    const { launchAuthTerminal } = await import('../src/services/auth-socket.js');
    const result = launchAuthTerminal(HOSTILE_MEMBER, ['--prompt', HOSTILE_PROMPT], () => {});
    expect(result).toBe('launched');
    expect(spawnCalls.length).toBe(1);
    return spawnCalls[0];
  }

  it('never puts caller-influenced text on a cmd.exe or PowerShell command line', async () => {
    const call = await launch();
    expect(call.file).not.toMatch(/^cmd(\.exe)?$/i);
    expect(call.file).toBe('powershell');
    expect(call.opts.windowsHide).toBe(true);

    // The launcher argv is fixed flags + base64; none of the hostile text.
    const joined = call.args.join(' ');
    expect(joined).not.toContain('calc');
    expect(joined).not.toContain('%PATH%');
    expect(joined).not.toContain('mem&ber');
    const enc = call.args[call.args.indexOf('-EncodedCommand') + 1];
    const script = Buffer.from(enc, 'base64').toString('utf16le');
    expect(script).toContain('Start-Process -FilePath $exe -ArgumentList $argLine -Wait -PassThru');
    expect(script).not.toContain('calc');
    expect(script).not.toContain('mem&ber');

    // The values travel via env vars only.
    expect(call.opts.env!.APRA_FLEET_OOB_ARGS).toContain('calc');
    expect(call.opts.env!.APRA_FLEET_OOB_WINDOW_TITLE).toBe('Fleet Password Entry');
  });

  it.skipIf(realPlatform !== 'win32')(
    'the argument line round-trips through the real Windows CRT argv parser unchanged',
    async () => {
      const call = await launch();
      const { quoteWindowsArgv } = await import('../src/utils/shell-escape.js');
      const real = await vi.importActual<typeof ChildProcessModule>('node:child_process');
      const code = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
      // Same verbatim command-line tail Start-Process hands to CreateProcess.
      const out = real.spawnSync(
        process.execPath,
        ['-e', quoteWindowsArgv(code), call.opts.env!.APRA_FLEET_OOB_ARGS],
        // windowsVerbatimArguments makes libuv write argv[0] unquoted, so an
        // exec path containing a space (e.g. under Program Files) would be split
        // by the child CRT. Quote argv0 explicitly.
        { argv0: quoteWindowsArgv(process.execPath), windowsVerbatimArguments: true, windowsHide: true, encoding: 'utf8' },
      );
      expect(out.status).toBe(0);
      const argv = JSON.parse(out.stdout) as string[];
      const exe = call.opts.env!.APRA_FLEET_OOB_EXE;
      expect(typeof exe).toBe('string');
      // Dev mode: [index.js, secret, --set, <member>, --prompt, <prompt>]
      expect(argv.slice(-5)).toEqual(['secret', '--set', HOSTILE_MEMBER, '--prompt', HOSTILE_PROMPT]);
    },
  );
});
