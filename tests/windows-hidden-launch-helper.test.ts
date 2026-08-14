/**
 * Unit tests for the hidden-launch helper (apra-fleet-5ti7.1,
 * src/os/windows.ts: buildDetachedHiddenLaunchCommand / launchDetachedHidden).
 *
 * Scope is the HELPER ITSELF -- assert on the command it builds by injecting
 * a stub executor. No real process is spawned; runs green on Linux CI.
 *
 * The "both call sites use the helper" spy assertion belongs to the sibling
 * task apra-fleet-5ti7.2, which appends to this file. This file is kept
 * structured (exported helpers, injectable executor stub) so that append can
 * happen cleanly.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import {
  buildDetachedHiddenLaunchCommand,
  launchDetachedHidden,
  stripCliXmlEnvelope,
  DETACHED_VISIBLE_WINDOW_TITLE,
  type DetachedLaunchOptions,
  type DetachedLaunchExecutor,
} from '../src/os/windows.js';
import { launchMcpServerWindows } from '../src/cli/launch-mcp-server-windows.js';
import { launchFleetSupervisorWindows } from '../src/cli/launch-fleet-supervisor-windows.js';

/**
 * buildDetachedHiddenLaunchCommand() always emits
 * `powershell -EncodedCommand <base64 utf16le>` (wrapPowerShellEncoded).
 * Decode back to the underlying PowerShell script so assertions can inspect
 * it directly -- this also guards the cmd.exe quote-stripping regression
 * that the raw-interpolated-string ad hoc attempts suffered from.
 */
export function decodeEncodedCommand(cmd: string): string {
  const m = /^powershell -EncodedCommand (.+)$/.exec(cmd);
  expect(m, `expected an -EncodedCommand invocation, got: ${cmd}`).not.toBeNull();
  return Buffer.from(m![1], 'base64').toString('utf16le');
}

/** A stub executor that records the command it was given and returns success. */
export function makeStubExecutor(
  pid = 4242,
  overrides: Partial<{ stdout: string; stderr: string; status: number }> = {},
): { executor: DetachedLaunchExecutor; calls: string[] } {
  const calls: string[] = [];
  const executor: DetachedLaunchExecutor = vi.fn((command: string) => {
    calls.push(command);
    return {
      stdout: overrides.stdout ?? `FLEET_LAUNCH_PID:${pid}`,
      stderr: overrides.stderr ?? '',
      status: overrides.status ?? 0,
    };
  });
  return { executor, calls };
}

const baseOpts: DetachedLaunchOptions = {
  command: 'C:\\Program Files\\Apra Fleet\\apra-fleet.exe',
  args: ['start', '--headless'],
  cwd: 'C:\\Users\\svc account\\apra-fleet',
  logFile: 'C:\\Users\\svc account\\apra-fleet\\logs\\fleet.log',
};

describe('buildDetachedHiddenLaunchCommand: encoding and quote-stripping guard', () => {
  it('1. is always wrapped via wrapPowerShellEncoded -- not a raw interpolated string', () => {
    const cmd = buildDetachedHiddenLaunchCommand(baseOpts);
    expect(cmd).toMatch(/^powershell -EncodedCommand \S+$/);
    const decoded = decodeEncodedCommand(cmd);
    // The decoded script must differ from the wrapper line itself -- i.e. we
    // really decoded something, not just echoed back the same text.
    expect(decoded).not.toBe(cmd);
    expect(decoded).toContain('Win32_Process');
  });
});

describe('buildDetachedHiddenLaunchCommand: SW_HIDE / STARTUPINFO contract', () => {
  it('2. sets ShowWindow = $SW_HIDE (0) and calls Win32_Process Create, by default', () => {
    const decoded = decodeEncodedCommand(buildDetachedHiddenLaunchCommand(baseOpts));
    expect(decoded).toContain('$SW_HIDE = 0');
    expect(decoded).toMatch(/ShowWindow\s*=\s*(\[uint16\])?\$SW_HIDE/);
    expect(decoded).toContain('Win32_Process');
    // apra-fleet-5ti7.2 review fix: the legacy [wmiclass] COM binding is used
    // instead of Invoke-CimMethod (which throws "Type mismatch" live when an
    // embedded Win32_ProcessStartup CIM instance is passed through
    // -Arguments) -- assert the .Create( call rather than the CIM-specific
    // -MethodName Create syntax.
    expect(decoded).toMatch(/Win32_Process'\)\.Create\(/);
    // STARTF_USESHOWWINDOW is implicit in WMI's ShowWindow property (WMI sets
    // dwFlags |= STARTF_USESHOWWINDOW for us) -- assert the property that
    // drives it is present rather than a literal dwFlags token.
    expect(decoded).toContain('Win32_ProcessStartup');
  });
});

describe('buildDetachedHiddenLaunchCommand: fully-resolved paths', () => {
  it('3. no $HOME, ~, backtick, or %VAR% survives into the decoded script, including with spaces in paths', () => {
    const decoded = decodeEncodedCommand(buildDetachedHiddenLaunchCommand(baseOpts));
    expect(decoded).not.toContain('$HOME');
    expect(decoded).not.toMatch(/(^|[^$])~(?!\d)/); // no bare ~ (allow none at all)
    expect(decoded).not.toContain('~');
    expect(decoded).not.toContain('`');
    expect(decoded).not.toMatch(/%[A-Za-z_][A-Za-z0-9_]*%/);
    // The space-containing paths must actually appear (fully resolved), not
    // be dropped or truncated at the space.
    expect(decoded).toContain('svc account');
    expect(decoded).toContain('Program Files');
  });

  it('3b. resolves paths even when cwd/logFile/command all contain spaces together', () => {
    const spaced: DetachedLaunchOptions = {
      command: 'C:\\Program Files\\My App\\app with space.exe',
      args: [],
      cwd: 'C:\\Users\\a user\\work dir',
      logFile: 'C:\\Users\\a user\\work dir\\log file.log',
    };
    const decoded = decodeEncodedCommand(buildDetachedHiddenLaunchCommand(spaced));
    expect(decoded).not.toContain('$HOME');
    expect(decoded).not.toContain('~');
    expect(decoded).not.toContain('`');
    expect(decoded).not.toMatch(/%[A-Za-z_][A-Za-z0-9_]*%/);
    expect(decoded).toContain('a user');
    expect(decoded).toContain('work dir');
    expect(decoded).toContain('app with space.exe');
  });
});

describe('launchDetachedHidden: structured failure on non-zero/error return, no throw', () => {
  it('4a. a non-zero status from the executor produces a structured failure with stderr preserved', () => {
    const { executor } = makeStubExecutor(0, { status: 1, stderr: 'Win32_Process Create failed ReturnValue=2', stdout: '' });
    let result;
    expect(() => {
      result = launchDetachedHidden(baseOpts, executor);
    }).not.toThrow();
    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        stderr: expect.stringContaining('ReturnValue=2'),
      }),
    );
  });

  it('4b. an executor that throws still yields a structured failure, not a thrown error', () => {
    const throwingExecutor: DetachedLaunchExecutor = vi.fn(() => {
      throw Object.assign(new Error('boom'), { stderr: Buffer.from('access denied'), status: 5 });
    });
    let result;
    expect(() => {
      result = launchDetachedHidden(baseOpts, throwingExecutor);
    }).not.toThrow();
    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        stderr: expect.stringContaining('access denied'),
      }),
    );
  });

  it('4c. success (status 0, PID marker present) yields ok: true with the parsed pid', () => {
    const { executor } = makeStubExecutor(9876);
    const result = launchDetachedHidden(baseOpts, executor);
    expect(result).toEqual(expect.objectContaining({ ok: true, pid: 9876 }));
  });

  it('4d. status 0 but no PID marker in stdout is still a structured failure, not a false success', () => {
    const { executor } = makeStubExecutor(0, { status: 0, stdout: 'no marker here' });
    const result = launchDetachedHidden(baseOpts, executor);
    expect(result).toEqual(expect.objectContaining({ ok: false }));
  });
});

describe('stripCliXmlEnvelope: decode CLIXML down to a readable message (apra-fleet-i8qj.14)', () => {
  it('7a. leaves plain (non-CLIXML) stderr untouched', () => {
    expect(stripCliXmlEnvelope('access denied')).toBe('access denied');
    expect(stripCliXmlEnvelope('')).toBe('');
  });

  it('7b. extracts and decodes the <S S="Error"> text out of a CLIXML envelope', () => {
    const raw =
      '#< CLIXML\r\n' +
      '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
      '<S S="Error">The term &#39;nope&#39; is not recognized_x000D__x000A_</S>' +
      '<S S="Error">At line:1 char:1_x000D__x000A_</S>' +
      '</Objs>';
    const decoded = stripCliXmlEnvelope(raw);
    expect(decoded).not.toContain('CLIXML');
    expect(decoded).not.toContain('_x000D_');
    expect(decoded).toContain("The term &#39;nope&#39; is not recognized");
    expect(decoded).toContain('At line:1 char:1');
  });

  it('7c. launchDetachedHidden folds a CLIXML stderr down to a single readable message on failure', () => {
    const cliXmlStderr =
      '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
      '<S S="Error">hidden launch failed with exit code 1_x000D__x000A_</S></Objs>';
    const { executor } = makeStubExecutor(0, { status: 1, stderr: cliXmlStderr, stdout: '' });
    const result = launchDetachedHidden(baseOpts, executor);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stderr).not.toContain('CLIXML');
      expect(result.stderr).not.toContain('_x000D_');
      expect(result.error).toContain('hidden launch failed with exit code 1');
    }
  });
});

describe('buildDetachedHiddenLaunchCommand: opt-out titled-window path', () => {
  it('5a. hiding is the default when no opt-out is passed', () => {
    const decoded = decodeEncodedCommand(buildDetachedHiddenLaunchCommand(baseOpts));
    expect(decoded).toMatch(/ShowWindow\s*=\s*(\[uint16\])?\$SW_HIDE/);
    expect(decoded).not.toContain(DETACHED_VISIBLE_WINDOW_TITLE);
  });

  it('5b. showWindow: true emits an explicit title and SW_SHOWNORMAL, not hidden', () => {
    const decoded = decodeEncodedCommand(
      buildDetachedHiddenLaunchCommand({ ...baseOpts, showWindow: true }),
    );
    expect(decoded).toMatch(/ShowWindow\s*=\s*(\[uint16\])?\$SW_SHOWNORMAL/);
    expect(decoded).toContain(DETACHED_VISIBLE_WINDOW_TITLE);
  });

  it('5c. showWindow: true with a custom title uses the custom title, not the default', () => {
    const decoded = decodeEncodedCommand(
      buildDetachedHiddenLaunchCommand({ ...baseOpts, showWindow: true, title: 'My Custom Title' }),
    );
    expect(decoded).toContain('My Custom Title');
    expect(decoded).not.toContain(DETACHED_VISIBLE_WINDOW_TITLE);
  });
});

describe('call sites route through the shared hidden-launch helper (apra-fleet-5ti7.2)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('6a. launchMcpServerWindows routes through the injected hidden-launch executor, not a hand-rolled command', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const { executor, calls } = makeStubExecutor(1111);
    const result = launchMcpServerWindows(
      { execPath: 'C:\\Program Files\\Apra Fleet\\apra-fleet.exe', cwd: 'C:\\Users\\svc account\\apra-fleet', logFile: 'C:\\Users\\svc account\\apra-fleet\\logs\\fleet.log' },
      executor,
    );
    expect(calls).toHaveLength(1);
    // The command handed to the executor must be the encoded hidden-launch
    // invocation built by buildDetachedHiddenLaunchCommand -- not a raw,
    // hand-rolled Invoke-CimMethod/`cmd /c start` string.
    expect(calls[0]).toMatch(/^powershell -EncodedCommand \S+$/);
    const decoded = decodeEncodedCommand(calls[0]);
    expect(decoded).toContain('Win32_Process');
    expect(decoded).toMatch(/ShowWindow\s*=\s*(\[uint16\])?\$SW_HIDE/);
    expect(decoded).toContain('run');
    expect(decoded).toContain('--transport');
    expect(decoded).toContain('http');
    expect(result).toEqual(expect.objectContaining({ ok: true, pid: 1111 }));
  });

  it('6b. launchFleetSupervisorWindows routes through the injected hidden-launch executor, not a hand-rolled command', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const { executor, calls } = makeStubExecutor(2222);
    const result = launchFleetSupervisorWindows(
      { repoRoot: 'C:\\Users\\svc account\\apra-fleet' },
      executor,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^powershell -EncodedCommand \S+$/);
    const decoded = decodeEncodedCommand(calls[0]);
    expect(decoded).toContain('Win32_Process');
    expect(decoded).toMatch(/ShowWindow\s*=\s*(\[uint16\])?\$SW_HIDE/);
    expect(decoded).toContain('serve.mjs');
    expect(result).toEqual(expect.objectContaining({ ok: true, pid: 2222 }));
  });

  it('6c. launchMcpServerWindows fails fast (no executor call) when execPath does not exist -- apra-fleet-5ti7.2 AC4', () => {
    const { executor, calls } = makeStubExecutor(9999);
    const result = launchMcpServerWindows(
      { execPath: 'C:\\nonexistent\\apra-fleet-xyz.exe', cwd: 'C:\\Users\\svc account\\apra-fleet', logFile: 'C:\\Users\\svc account\\apra-fleet\\logs\\fleet.log' },
      executor,
    );
    // The failure must be reported (non-zero exit / structured error), not a
    // silent no-op that returns success for a wrapper process while the real
    // target never started.
    expect(calls).toHaveLength(0);
    expect(result.ok).toBe(false);
    expect(result).toEqual(expect.objectContaining({ ok: false, error: expect.stringContaining('C:\\nonexistent\\apra-fleet-xyz.exe') }));
  });

  it('6d. launchFleetSupervisorWindows fails fast (no executor call) when serve.mjs does not exist -- apra-fleet-5ti7.2 AC4', () => {
    const { executor, calls } = makeStubExecutor(9999);
    const result = launchFleetSupervisorWindows(
      { repoRoot: 'C:\\nonexistent\\apra-fleet-checkout' },
      executor,
    );
    expect(calls).toHaveLength(0);
    expect(result.ok).toBe(false);
    expect(result).toEqual(expect.objectContaining({ ok: false, error: expect.stringContaining('serve.mjs') }));
  });
});
