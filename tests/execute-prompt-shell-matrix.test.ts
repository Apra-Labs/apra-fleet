/**
 * apra-fleet-7dir.5.5: table-driven coverage over the member's REGISTERED
 * SHELL for the three sites apra-fleet-7dir.5.4 fixed in execute-prompt.ts --
 * writePromptFile/deletePromptFile, the durable stdout mirror gate, and the
 * orphan-recovery `unsupported` flag.
 *
 * New file, deliberately NOT an extension of tests/execute-prompt.test.ts:
 * that file is 2000+ lines of positional `calls[N]` indexing, and interleaving
 * a 4-row shell matrix into it would perturb readability there for no benefit.
 * tests/execute-prompt-orphan-recovery.test.ts already covers the *OS*-only
 * branch of the durable mirror / recovery gate (linux/macos/windows); this
 * file is the sibling that adds the *shell* dimension on top, mirroring
 * tests/shell-matrix-command-builders.test.ts's own file-header rationale:
 *
 * This file deliberately does NOT mock `agent-helpers.js` or hand-roll a
 * local `isPosixShell`/`isPosixShellMember` copy for its assertions -- it
 * exercises the REAL production wiring end to end through executePrompt(),
 * so a regression that reverts apra-fleet-7dir.5.4's gitbash routing back to
 * an OS-only branch fails a `gitbash` row here, on ANY platform (this suite
 * itself only ever stubs `strategy.execCommand`; it never spawns a real
 * PowerShell or bash process, so it runs identically on a Linux CI box with
 * neither installed -- the defect class this pins only ever manifested on a
 * live Windows box with Git for Windows, which a Linux-only CI can otherwise
 * never exercise).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  makeTestAgent,
  makeTestLocalAgent,
  backupAndResetRegistry,
  restoreRegistry,
  resultText,
  decodePowerShellEncodedCommand,
} from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { executePrompt, provisionedRemoteAgents } from '../src/tools/execute-prompt.js';
import type { Agent, SSHExecResult } from '../src/types.js';
import { encryptPassword } from '../src/utils/crypto.js';

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
  readMemberStatus: vi.fn(() => 'idle'),
}));

const mockExecCommand = vi.fn<
  (cmd: string, timeout?: number, maxTotalMs?: number, onPid?: (pid: number) => void) => Promise<SSHExecResult>
>();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: vi.fn(),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock('../src/services/agent-provisioner.js', () => ({
  provisionAgents: vi.fn().mockResolvedValue({ pushed: [] }),
  remoteAgentsDir: vi.fn().mockReturnValue('.claude/agents/pm'),
}));

vi.mock('../src/utils/workspace-trust.js', () => ({
  seedWorkspaceTrust: vi.fn().mockResolvedValue(undefined),
}));

type ShellRow = 'gitbash' | 'pwsh7' | 'powershell5' | undefined;
const SHELL_ROWS: ShellRow[] = ['gitbash', 'pwsh7', 'powershell5', undefined];
const isPosixRow = (shell: ShellRow): boolean => shell === 'gitbash';

const FIXED_WORK_FOLDER = 'C:\\Users\\bella\\project';

function makeWindowsRemoteAgent(shell: ShellRow, idSuffix: string): Agent {
  return makeTestAgent({
    friendlyName: `shell-matrix-prompt-${idSuffix}`,
    os: 'windows',
    shell,
    workFolder: FIXED_WORK_FOLDER,
  });
}

// ---------------------------------------------------------------------------
// 1. writePromptFile / deletePromptFile: shell matrix over a multi-chunk prompt
// ---------------------------------------------------------------------------

describe('execute_prompt prompt-file transfer: shell matrix (apra-fleet-7dir.5.5)', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    vi.useFakeTimers();
    provisionedRemoteAgents.clear();
  });

  afterEach(() => {
    restoreRegistry();
    vi.useRealTimers();
  });

  it.each(SHELL_ROWS)('writes and deletes a multi-chunk prompt with shell=%s', async (shell) => {
    const member = makeWindowsRemoteAgent(shell, `write-${shell ?? 'unset'}`);
    addAgent(member);
    const bigPrompt = 'A'.repeat(9500); // 3 chunks: 4000 + 4000 + 1500
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'ok', session_id: `sess-${shell ?? 'unset'}` }),
      stderr: '',
      code: 0,
    });

    const result = await executePrompt({ member_id: member.id, prompt: bigPrompt, resume: false, timeout_s: 5 });
    expect(resultText(result)).toContain('ok');

    const calls = mockExecCommand.mock.calls;
    // 3 write chunks + main command + delete = 5 calls on EVERY row -- a
    // gitbash member's enabled durable mirror rides along on the SAME
    // deletePromptFile round trip (extraPaths), not an extra exec.
    expect(calls.length).toBe(5);
    const writeCalls = calls.slice(0, 3).map((c) => c[0] as string);
    const deleteCall = calls[4][0] as string;

    if (isPosixRow(shell)) {
      // gitbash: routed to the POSIX branch (apra-fleet-7dir.5.4) -- identical
      // shape to a real POSIX (linux/macos) member.
      for (const cmd of writeCalls) {
        expect(cmd).not.toMatch(/powershell/i);
        expect(cmd).not.toMatch(/EncodedCommand/i);
      }
      expect(writeCalls[0]).toContain('mkdir -p');
      expect(writeCalls[0]).toMatch(/> \.fleet-task\.md$/);
      expect(writeCalls[1]).toMatch(/>> \.fleet-task\.md$/);
      expect(writeCalls[2]).toMatch(/>> \.fleet-task\.md$/);

      const reconstructed = writeCalls
        .map((cmd) => {
          const m = cmd.match(/echo '([^']+)' \| base64 -d/);
          return m ? Buffer.from(m[1], 'base64').toString('utf-8') : '';
        })
        .join('');
      expect(reconstructed).toBe(bigPrompt);

      // Delete: POSIX rm -f, AND cleans up the durable mirror (extraPaths) in
      // the SAME round trip, since the mirror is enabled for a remote gitbash
      // member (apra-fleet-7dir.5.4).
      expect(deleteCall).toContain('rm -f');
      expect(deleteCall).toContain('.fleet-out-');
    } else {
      // pwsh7 / powershell5 / unset: unchanged PowerShell -EncodedCommand chain.
      for (const cmd of writeCalls) {
        expect(cmd).toMatch(/^powershell -EncodedCommand /);
      }
      const decoded = writeCalls.map((cmd) => decodePowerShellEncodedCommand(cmd));
      expect(decoded[0]).toContain('Set-Content');
      expect(decoded[1]).toContain('Add-Content');
      expect(decoded[2]).toContain('Add-Content');
      const reconstructed = decoded
        .map((psScript) => {
          const m = psScript.match(/-Value '([\s\S]*)' -NoNewline/);
          return m ? m[1].replace(/''/g, "'") : '';
        })
        .join('');
      expect(reconstructed).toBe(bigPrompt);

      // Delete: Remove-Item, and the durable-mirror gate is OFF for these rows
      // -- the file never gets referenced.
      expect(deleteCall).toMatch(/^powershell -EncodedCommand /);
      const deletedDecoded = decodePowerShellEncodedCommand(deleteCall);
      expect(deletedDecoded).toContain('Remove-Item');
      expect(deletedDecoded).not.toContain('.fleet-out-');
    }
  });

  it('pwsh7, powershell5 and unset write/delete a single-chunk prompt with a byte-identical, golden command (unchanged from today)', async () => {
    const writeCmds: string[] = [];
    const deleteCmds: string[] = [];
    const shortPrompt = 'hello from the shell matrix';

    for (const shell of ['pwsh7', 'powershell5', undefined] as ShellRow[]) {
      backupAndResetRegistry();
      mockExecCommand.mockReset();
      const member = makeWindowsRemoteAgent(shell, `golden-${shell ?? 'unset'}`);
      addAgent(member);
      mockExecCommand.mockResolvedValue({
        stdout: JSON.stringify({ result: 'ok', session_id: 'sess-golden' }),
        stderr: '',
        code: 0,
      });

      // eslint-disable-next-line no-await-in-loop -- sequential by design, each
      // shell must run against its own freshly-reset mock/registry.
      await executePrompt({ member_id: member.id, prompt: shortPrompt, resume: false, timeout_s: 5 });
      const calls = mockExecCommand.mock.calls;
      // 1 write + main + delete = 3 calls (below the chunk threshold).
      expect(calls.length).toBe(3);
      writeCmds.push(calls[0][0] as string);
      deleteCmds.push(calls[2][0] as string);
    }

    // Cross-shell: all three rows must be byte-identical to each other.
    expect(new Set(writeCmds).size).toBe(1);
    expect(new Set(deleteCmds).size).toBe(1);

    // Golden: the decoded script body must match today's exact template, so an
    // accidental change to the Set-Content/Remove-Item shape fails loudly even
    // though all three rows still agree with each other.
    const decodedWrite = decodePowerShellEncodedCommand(writeCmds[0]);
    expect(decodedWrite).toBe(
      `New-Item -Path '${FIXED_WORK_FOLDER}' -ItemType Directory -Force | Out-Null; `
      + `Set-Location "${FIXED_WORK_FOLDER}"; Set-Content -Path ".fleet-task.md" -Value '${shortPrompt}' -NoNewline -Encoding UTF8`,
    );
    const decodedDelete = decodePowerShellEncodedCommand(deleteCmds[0]);
    expect(decodedDelete).toBe(
      `Set-Location "${FIXED_WORK_FOLDER}"; Remove-Item ".fleet-task.md" -Force -ErrorAction SilentlyContinue`,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Durable stdout mirror gate + orphan-recovery `unsupported` flag: these
// are ONE decision (execute-prompt.ts's `durableMirrorSupported` predicate
// feeds both `durablePath` and `unsupported`) and must never drift apart.
// ---------------------------------------------------------------------------

/**
 * Routes the mocked exec by command SHAPE (decoding a -EncodedCommand blob
 * first) rather than by call index, so the recovery path's extra probes
 * cannot silently shift a positional queue -- mirrors
 * tests/execute-prompt-orphan-recovery.test.ts's installExecRouter.
 */
interface Recorder {
  cmds: string[];
  livenessAnswers: string[];
  durableOutput: string | null;
}

function installExecRouter(rec: Recorder, capturedPid: number): void {
  mockExecCommand.mockImplementation(
    async (cmd: string, _t?: number, _m?: number, onPid?: (pid: number) => void): Promise<SSHExecResult> => {
      rec.cmds.push(cmd);
      const decoded = decodePowerShellEncodedCommand(cmd);
      if (/FLEET_PID/.test(decoded)) {
        onPid?.(capturedPid);
        return { stdout: '', stderr: '', code: 0 };
      }
      if (/^kill -0 /.test(cmd) || /Get-Process -Id/.test(decoded)) {
        const answer = rec.livenessAnswers.length > 1 ? rec.livenessAnswers.shift()! : rec.livenessAnswers[0];
        return { stdout: `${answer}\n`, stderr: '', code: 0 };
      }
      if (/^cat "/.test(cmd) || /Get-Content -Path/.test(decoded)) {
        return rec.durableOutput === null
          ? { stdout: '', stderr: '', code: 1 }
          : { stdout: rec.durableOutput, stderr: '', code: 0 };
      }
      // write / delete round trips -- irrelevant to this describe block.
      return { stdout: '', stderr: '', code: 0 };
    },
  );
}

const CAPTURED_PID = 24601;

describe('execute_prompt durable mirror + orphan-recovery coupling: shell matrix (apra-fleet-7dir.5.5)', () => {
  let rec: Recorder;

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    provisionedRemoteAgents.clear();
    process.env['ORPHAN_RECOVERY_POLL_MS'] = '1';
    delete process.env['ORPHAN_RECOVERY_MAX_WAIT_MS'];
    rec = { cmds: [], livenessAnswers: ['DEAD'], durableOutput: null };
  });

  afterEach(() => {
    restoreRegistry();
    delete process.env['ORPHAN_RECOVERY_POLL_MS'];
    delete process.env['ORPHAN_RECOVERY_MAX_WAIT_MS'];
  });

  it.each(SHELL_ROWS)('shell=%s: mirror and recovery agree on a remote member (both on or both off)', async (shell) => {
    const member = makeWindowsRemoteAgent(shell, `recover-${shell ?? 'unset'}`);
    addAgent(member);
    rec.livenessAnswers = ['ALIVE', 'DEAD'];
    rec.durableOutput = JSON.stringify({ result: 'the real answer', session_id: 'sess-recovered' });
    installExecRouter(rec, CAPTURED_PID);

    const result = await executePrompt({ member_id: member.id, prompt: 'plan it', resume: false, timeout_s: 5 });
    const structured = (result as any).structuredContent;

    if (isPosixRow(shell)) {
      // gitbash: mirror ON, recovery attempted and succeeds.
      expect(structured.isError).toBeUndefined();
      expect(resultText(result)).toContain('the real answer');
      expect(rec.cmds.some((c) => /^kill -0 /.test(c))).toBe(true);
      expect(rec.cmds.some((c) => /^cat ".*\.fleet-out-.*\.json"/.test(c))).toBe(true);
      expect(rec.cmds.some((c) => c.includes('rm -f') && c.includes('.fleet-out-'))).toBe(true);
    } else {
      // pwsh7 / powershell5 / unset: mirror OFF, recovery never attempted --
      // the pre-existing empty_response behavior applies verbatim.
      expect(structured.isError).toBe(true);
      expect(structured.reason).toBe('empty_response');
      expect(rec.cmds.some((c) => /^kill -0 /.test(c))).toBe(false);
      expect(rec.cmds.some((c) => /Get-Process -Id/.test(decodePowerShellEncodedCommand(c)))).toBe(false);
      expect(rec.cmds.some((c) => /^cat "/.test(c))).toBe(false);
      expect(rec.cmds.some((c) => /Get-Content -Path/.test(decodePowerShellEncodedCommand(c)))).toBe(false);
      // No durable-file reference anywhere, including cleanup.
      expect(rec.cmds.some((c) => c.includes('.fleet-out-'))).toBe(false);
    }
  });

  it('a windows member registered as gitbash but running LOCALLY keeps the mirror OFF (deliberately excluded from the flip)', async () => {
    // apra-fleet-7dir.5.4: orphan recovery exists for a torn-down SSH channel,
    // which a local spawn does not have, and deletePromptFile's local branch
    // would fs.unlinkSync('/tmp/...') through Node on Windows (resolving to
    // C:\tmp), not the MSYS /tmp bash teed to -- so `agentType !== 'local'` is
    // a THIRD input to the durableMirrorSupported predicate that none of the
    // remote rows above exercise. Pin it directly: deleting the
    // `agentType !== 'local'` conjunct from production must fail this test.
    // makeTestLocalAgent's default workFolder must exist for real -- writePromptFile's
    // local branch does a real fs.writeFileSync into it (short-circuits before
    // ever touching strategy.execCommand). Scoped to a temp dir and cleaned up
    // below, per this suite's "no filesystem access outside its temp sandbox"
    // constraint.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-shell-matrix-local-'));
    try {
      const member = makeTestLocalAgent({
        friendlyName: 'shell-matrix-local-gitbash',
        os: 'windows',
        shell: 'gitbash',
        workFolder: tmpDir,
      });
      addAgent(member);
      // local agents never call strategy.execCommand for writePromptFile /
      // deletePromptFile (fs.writeFileSync/unlinkSync short-circuit first), so
      // the router only ever needs to answer the main dispatch call.
      rec.livenessAnswers = ['ALIVE', 'DEAD'];
      rec.durableOutput = JSON.stringify({ result: 'should never be read', session_id: 'sess-local' });
      installExecRouter(rec, CAPTURED_PID);

      const result = await executePrompt({ member_id: member.id, prompt: 'plan it', resume: false, timeout_s: 5 });
      const structured = (result as any).structuredContent;

      expect(structured.isError).toBe(true);
      expect(structured.reason).toBe('empty_response');
      // No liveness probe, no durable-file READ: recovery never attempted.
      // (The main dispatch command legitimately still CONTAINS a `tee
      // ".../.fleet-out-<inv>.json"` clause -- WindowsGitBashCommands inherits
      // LinuxCommands.buildAgentPromptCommand's tee unconditionally on `inv`,
      // independent of the recovery gate decision, per apra-fleet-7dir.5.4's
      // own "already been teeing its stdout ... with nothing reading it" note
      // -- so this only asserts nothing EVER READS that file back.)
      expect(rec.cmds.some((c) => /^kill -0 /.test(c))).toBe(false);
      expect(rec.cmds.some((c) => /^cat ".*\.fleet-out-/.test(c))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// F14: the env prefix is computed ONCE and carried by the main launch AND all
// four retry dispatches
// ---------------------------------------------------------------------------

/**
 * execute-prompt.ts has five places that hand a provider prompt command to
 * strategy.execCommand: the main launch, and four independently-gated retry
 * paths (dispatch exception, stale session, server overloaded, and the
 * workspace-trust self-heal). They all concatenate the SAME `envPrefix`
 * computed once near the top of the function.
 *
 * That "computed once" shape is exactly what makes a regression cheap: drop
 * the concatenation at any ONE retry site and that retry silently runs with
 * a different environment than the attempt it is replacing -- a member.env
 * variable, or an auth credential, simply missing on the second try. Each
 * case below drives one specific retry gate and asserts the prefix on EVERY
 * prompt dispatch the run produced, so no site can regress unnoticed.
 */
describe('execute_prompt env prefix: main launch + all four retry sites (F14)', () => {
  const MEMBER_ENV = { FLEET_S9_A: 'one', FLEET_S9_B: 'two' };
  const AUTH_VALUE = 'super-secret-credential';
  const EXPECTED_PREFIX =
    "export FLEET_S9_A='one' && export FLEET_S9_B='two' && "
    + "export API_TOKEN='" + AUTH_VALUE + "' && ";

  function envMember(overrides: Partial<Agent> = {}): Agent {
    return makeTestAgent({
      friendlyName: `env-prefix-prompt-${Math.random().toString(36).slice(2)}`,
      os: 'linux',
      workFolder: '/home/testuser/project',
      env: MEMBER_ENV,
      encryptedEnvVars: { API_TOKEN: encryptPassword(AUTH_VALUE) },
      ...overrides,
    });
  }

  /**
   * A prompt dispatch is identified by the provider command the OS layer
   * builds, NOT by call index: the run also makes prompt-file write/delete
   * round trips, and their count varies by scenario. Every call that IS a
   * prompt dispatch must carry the prefix; the file round trips are
   * deliberately out of scope (they are not the member's program).
   */
  function promptDispatches(): string[] {
    return mockExecCommand.mock.calls
      .map((c) => c[0] as string)
      // '--output-format' is the provider prompt command's own flag. Do NOT
      // widen this to ' -p ' -- the prompt-file write round trip starts with
      // `mkdir -p`, which would be swept in and inflate the count.
      .filter((cmd) => cmd.includes('--output-format'));
  }

  function expectEveryPromptDispatchPrefixed(expectedCount: number): void {
    const dispatches = promptDispatches();
    expect(dispatches.length).toBe(expectedCount);
    for (const cmd of dispatches) {
      expect(cmd.startsWith(EXPECTED_PREFIX), `dispatch missing env prefix: ${cmd.slice(0, 160)}`).toBe(true);
    }
  }

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    provisionedRemoteAgents.clear();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('site 1/5 -- the main launch carries the prefix', async () => {
    const member = envMember();
    addAgent(member);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'ok', session_id: 's1' }), stderr: '', code: 0,
    });

    await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });
    expectEveryPromptDispatchPrefixed(1);
  });

  it('site 2/5 -- the dispatch-exception retry carries the prefix', async () => {
    const member = envMember();
    addAgent(member);
    let call = 0;
    mockExecCommand.mockImplementation(async (cmd: string) => {
      // Only the prompt dispatch throws; prompt-file round trips succeed.
      if (cmd.includes('--output-format')) {
        call += 1;
        if (call === 1) throw new Error('inactivity timeout');
        return { stdout: JSON.stringify({ result: 'ok', session_id: 's2' }), stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });
    // Original attempt + the fresh-session retry, both prefixed.
    expectEveryPromptDispatchPrefixed(2);
  });

  it('site 3/5 -- the stale-session retry carries the prefix', async () => {
    const member = envMember({ sessionId: 'stale-session-id' });
    addAgent(member);
    let call = 0;
    mockExecCommand.mockImplementation(async (cmd: string) => {
      if (cmd.includes('--output-format')) {
        call += 1;
        if (call === 1) return { stdout: '', stderr: 'No conversation found with session ID', code: 1 };
        return { stdout: JSON.stringify({ result: 'ok', session_id: 's3' }), stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    await executePrompt({ member_id: member.id, prompt: 'hi', resume: true, timeout_s: 5 });
    expectEveryPromptDispatchPrefixed(2);
  });

  it('site 4/5 -- the server-overloaded retry carries the prefix', async () => {
    const member = envMember();
    addAgent(member);
    let call = 0;
    mockExecCommand.mockImplementation(async (cmd: string) => {
      if (cmd.includes('--output-format')) {
        call += 1;
        if (call === 1) return { stdout: '', stderr: 'API Error: 529 overloaded_error', code: 1 };
        return { stdout: JSON.stringify({ result: 'ok', session_id: 's4' }), stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });
    expectEveryPromptDispatchPrefixed(2);
  }, 30000);

  it('site 5/5 -- the workspace-trust self-heal retry carries the prefix', async () => {
    const member = envMember();
    addAgent(member);
    let call = 0;
    mockExecCommand.mockImplementation(async (cmd: string) => {
      if (cmd.includes('--output-format')) {
        call += 1;
        // exit 0 + empty stdout + a trust-gate stderr tail is the specific
        // shape that reaches the seedWorkspaceTrust self-heal branch.
        if (call === 1) {
          // The exact phrase src/utils/prompt-errors.ts classifies as
          // workspace_not_trusted -- an approximation would fall through to
          // plain empty_response and never reach the self-heal retry.
          return { stdout: '', stderr: 'Error: this workspace has not been trusted', code: 0 };
        }
        return { stdout: JSON.stringify({ result: 'ok', session_id: 's5' }), stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });
    expectEveryPromptDispatchPrefixed(2);
  }, 30000);

  it('a gitbash Windows member gets the POSIX prefix on its prompt dispatch', async () => {
    const member = envMember({ os: 'windows', shell: 'gitbash', workFolder: 'C:/Users/bella/project' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'ok', session_id: 's6' }), stderr: '', code: 0,
    });

    await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });
    const dispatches = promptDispatches();
    expect(dispatches.length).toBeGreaterThan(0);
    for (const cmd of dispatches) {
      expect(cmd.startsWith(EXPECTED_PREFIX)).toBe(true);
      expect(cmd).not.toContain('$env:FLEET_S9_A=');
    }
  });

  it('a PowerShell Windows member gets the PowerShell prefix on its prompt dispatch', async () => {
    const member = envMember({ os: 'windows', shell: 'pwsh7', workFolder: 'C:/Users/bella/project' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'ok', session_id: 's7' }), stderr: '', code: 0,
    });

    await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });
    const psPrefix =
      "$env:FLEET_S9_A='one'; $env:FLEET_S9_B='two'; $env:API_TOKEN='" + AUTH_VALUE + "'; ";
    const dispatches = promptDispatches();
    expect(dispatches.length).toBeGreaterThan(0);
    for (const cmd of dispatches) {
      expect(cmd.startsWith(psPrefix)).toBe(true);
      expect(cmd).not.toContain('export FLEET_S9_A=');
    }
  });
});
