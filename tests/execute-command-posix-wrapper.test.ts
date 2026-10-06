import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { executeCommand, GIT_BASH_LAUNCHER_MAX_COMMAND_CHARS } from '../src/tools/execute-command.js';
import type { Agent, SSHExecResult } from '../src/types.js';
import { findRealBash } from './helpers/real-bash.js';

// End-to-end check of the POSIX execute_command wrapper: capture the exact
// string executeCommand() hands to the strategy, then EXECUTE it with a real
// shell (`<shell> -c <string>`) -- string assertions alone cannot catch a
// wrapper that is syntactically broken for some user commands (heredoc at the
// end, trailing &/;/|/#, empty command) or one whose `cd` covers only part of
// the command.

const captured: string[] = [];
const mockExecCommand = vi.fn(async (cmd: string): Promise<SSHExecResult> => {
  captured.push(cmd);
  return { stdout: '', stderr: '', code: 0 };
});

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: vi.fn(),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

const bash = findRealBash();
if (!bash.path) console.warn(`[execute-command-posix-wrapper.test] skipping: ${bash.reason}`);

/** Extra POSIX shells to run the same string under, when installed. */
function optionalShells(): Array<{ name: string; path: string }> {
  if (process.platform === 'win32') return [];
  const out: Array<{ name: string; path: string }> = [];
  for (const name of ['zsh', 'dash']) {
    const r = spawnSync(name, ['-c', 'true'], { encoding: 'utf8', timeout: 5000 });
    if (r.status === 0) out.push({ name, path: name });
    else console.warn(`[execute-command-posix-wrapper.test] ${name} not installed -- ${name} runs skipped`);
  }
  return out;
}

/** Forward-slash path both MSYS bash and POSIX shells accept inside "...". */
function shellPath(p: string): string {
  return p.replace(/\\/g, '/');
}

interface RunResult { status: number | null; stdout: string; stderr: string }

function run(shell: string, script: string, timeoutMs = 20000): RunResult {
  const r = spawnSync(shell, ['-c', script], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Strip the FLEET_PID line (asserting it is first) and CRs. */
function body(r: RunResult): string {
  expect(r.stdout).toMatch(/^FLEET_PID:\d+\r?\n/);
  return r.stdout.replace(/^FLEET_PID:\d+\r?\n/, '').replace(/\r/g, '');
}

interface Case {
  name: string;
  command: string;
  expectStdout?: string;
  expectCode: number;
  /** Uses a bash/zsh-only feature (<<<, pipefail): skipped under dash. */
  bashism?: boolean;
  /** Free-form extra check. */
  check?: (r: RunResult, dir: string) => void;
}

const CASES: Case[] = [
  { name: 'heredoc at end', command: 'cat <<EOF\nhello\nEOF', expectStdout: 'hello\n', expectCode: 0 },
  { name: 'heredoc with trailing newline', command: 'cat <<EOF\nhello\nEOF\n', expectStdout: 'hello\n', expectCode: 0 },
  { name: '<<-EOF strips leading tabs', command: 'cat <<-EOF\n\thello\n\tEOF', expectStdout: 'hello\n', expectCode: 0 },
  { name: "<<'EOF' is literal", command: "cat <<'EOF'\n$HOME `x`\nEOF", expectStdout: '$HOME `x`\n', expectCode: 0 },
  { name: 'multiple heredocs', command: 'cat <<A\none\nA\ncat <<B\ntwo\nB', expectStdout: 'one\ntwo\n', expectCode: 0 },
  { name: 'CRLF heredoc', command: 'cat <<EOF\r\nhello\r\nEOF\r\n', expectStdout: 'hello\n', expectCode: 0 },
  { name: 'trailing &', command: 'echo bg &', expectStdout: 'bg\n', expectCode: 0 },
  { name: 'trailing ;', command: 'echo hi;', expectStdout: 'hi\n', expectCode: 0 },
  { name: 'trailing # comment', command: 'echo hi # a comment', expectStdout: 'hi\n', expectCode: 0 },
  {
    name: 'trailing | is a user syntax error, reported by eval, wrapper intact',
    command: 'echo hi |',
    expectCode: 2,
    check: (r) => { expect(r.stderr).not.toContain('_fleet_pid'); },
  },
  {
    name: 'trailing && is a user syntax error, reported by eval, wrapper intact',
    command: 'echo hi &&',
    expectCode: 2,
    check: (r) => { expect(r.stderr).not.toContain('_fleet_pid'); },
  },
  { name: 'empty command', command: '', expectStdout: '', expectCode: 0 },
  { name: 'exit 0', command: 'exit 0', expectStdout: '', expectCode: 0 },
  { name: 'exit 1', command: 'echo a; exit 1', expectStdout: 'a\n', expectCode: 1 },
  { name: 'exit 3', command: 'exit 3', expectStdout: '', expectCode: 3 },
  { name: 'set -e stops at first failure', command: 'set -e\nfalse\necho unreachable', expectStdout: '', expectCode: 1 },
  { name: 'pipefail', command: 'set -o pipefail; false | true', expectStdout: '', expectCode: 1, bashism: true },
  { name: '<<< here-string', command: 'cat <<< hs', expectStdout: 'hs\n', expectCode: 0, bashism: true },
  { name: 'embedded single quotes', command: `echo 'it'"'"'s' "a'b" 'c'\\''d'`, expectStdout: "it's a'b c'd\n", expectCode: 0 },
  { name: 'multi-line command', command: 'echo L1\necho L2', expectStdout: 'L1\nL2\n', expectCode: 0 },
  {
    name: 'stderr and exit code both propagate',
    command: 'echo out; echo err 1>&2; exit 4',
    expectStdout: 'out\n',
    expectCode: 4,
    check: (r) => { expect(r.stderr.replace(/\r/g, '')).toBe('err\n'); },
  },
];

type MemberKind = { label: string; overrides: Partial<Agent> };
const MEMBER_KINDS: MemberKind[] = [
  { label: 'linux', overrides: { os: 'linux' } },
  { label: 'macos', overrides: { os: 'macos' } },
  { label: 'windows+gitbash', overrides: { os: 'windows', shell: 'gitbash' } },
];

let tmpRoot: string;
let workDir: string;

async function wrapperFor(kind: MemberKind, command: string, runFrom?: string): Promise<string> {
  const member = makeTestAgent({ ...kind.overrides, workFolder: shellPath(workDir) });
  addAgent(member);
  captured.length = 0;
  await executeCommand({ member_id: member.id, command, timeout_s: 5, run_from: runFrom } as any);
  expect(captured).toHaveLength(1);
  return captured[0];
}

describe.skipIf(!bash.path)('execute_command POSIX wrapper executed in a real shell', () => {
  const shells = [{ name: 'bash', path: bash.path! }, ...(bash.path ? optionalShells() : [])];

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-ec-wrap-'));
    workDir = path.join(tmpRoot, 'work dir');
    fs.mkdirSync(workDir);
  });
  afterAll(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });
  beforeEach(() => { backupAndResetRegistry(); vi.clearAllMocks(); });
  afterEach(() => { restoreRegistry(); });

  for (const kind of MEMBER_KINDS) {
    for (const sh of shells) {
      describe(`${kind.label} member, ${sh.name}`, () => {
        for (const c of CASES) {
          const skip = c.bashism && sh.name === 'dash';
          it.skipIf(skip)(c.name, async () => {
            const wrapped = await wrapperFor(kind, c.command);
            const r = run(sh.path, wrapped);
            const out = body(r);
            if (c.expectStdout !== undefined) expect(out).toBe(c.expectStdout);
            expect(r.status).toBe(c.expectCode);
            c.check?.(r, workDir);
          });
        }

        it('`true & pwd` runs pwd in the work folder (cd covers the whole command)', async () => {
          const expected = run(sh.path, `cd "${shellPath(workDir)}" && pwd`).stdout;
          const wrapped = await wrapperFor(kind, 'true & pwd');
          const r = run(sh.path, wrapped);
          expect(r.status).toBe(0);
          expect(body(r)).toBe(expected.replace(/\r/g, ''));
        });

        it('a failed cd blocks every line of a multi-line command', async () => {
          const marker = shellPath(path.join(tmpRoot, `marker-${kind.label}-${sh.name}`));
          const missing = shellPath(path.join(tmpRoot, 'does-not-exist'));
          const wrapped = await wrapperFor(kind, `echo L1\ntouch "${marker}"\necho L3`, missing);
          const r = run(sh.path, wrapped);
          expect(body(r)).toBe('');
          expect(r.status).not.toBe(0);
          expect(fs.existsSync(marker.replace(/\//g, path.sep))).toBe(false);
        });

        it('FLEET_PID is the first stdout line even when the command writes immediately', async () => {
          const wrapped = await wrapperFor(kind, 'echo first');
          const r = run(sh.path, wrapped);
          const lines = r.stdout.replace(/\r/g, '').split('\n');
          expect(lines[0]).toMatch(/^FLEET_PID:\d+$/);
          expect(lines[1]).toBe('first');
        });
      });
    }
  }
});

// ShellCheck lint of the generated wrapper strings. Uses SHELLCHECK_BIN or a
// `shellcheck` on PATH; skips visibly when neither is available (CI's
// ubuntu image ships it).
function findShellcheck(): string | undefined {
  const fromEnv = process.env.SHELLCHECK_BIN;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const r = spawnSync('shellcheck', ['--version'], { encoding: 'utf8', timeout: 10000 });
  return r.status === 0 ? 'shellcheck' : undefined;
}
const shellcheck = findShellcheck();
if (!shellcheck) console.warn('[execute-command-posix-wrapper.test] shellcheck not available (set SHELLCHECK_BIN or install it) -- lint test skipped');

describe.skipIf(!shellcheck)('execute_command POSIX wrapper passes shellcheck', () => {
  let dir: string;
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-ec-sc-')); workDir = dir; });
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  beforeEach(() => { backupAndResetRegistry(); vi.clearAllMocks(); });
  afterEach(() => { restoreRegistry(); });

  for (const c of CASES.filter((x) => x.expectCode !== 2)) {
    it(`no shellcheck errors: ${c.name}`, async () => {
      const wrapped = await wrapperFor(MEMBER_KINDS[0], c.command);
      const file = path.join(dir, 'w.sh');
      fs.writeFileSync(file, `#!/bin/bash\n${wrapped}\n`);
      const r = spawnSync(shellcheck!, ['-S', 'error', '-f', 'gcc', file], { encoding: 'utf8', timeout: 30000 });
      expect(r.stdout + r.stderr).toBe('');
      expect(r.status).toBe(0);
    });
  }
});

// Local Git Bash members run through Git for Windows' bin\bash.exe launcher,
// which truncates long command lines; execute_command must refuse explicitly
// instead of running a truncated command.
describe('execute_command refuses a command over the local Git Bash launcher limit', () => {
  beforeEach(() => { backupAndResetRegistry(); vi.clearAllMocks(); captured.length = 0; });
  afterEach(() => { restoreRegistry(); });

  // 2000 single-quoted words: 6005 chars raw, far longer once eval-quoted.
  const quoteHeavy = 'echo ' + Array.from({ length: 2000 }, () => "'a'").join('');

  async function dispatch(overrides: Partial<Agent>, command: string) {
    const member = makeTestAgent({ workFolder: '/tmp/w', ...overrides });
    addAgent(member);
    return executeCommand({ member_id: member.id, command, timeout_s: 5 } as any);
  }

  it('local gitbash: returns an actionable error and runs nothing', async () => {
    const r = await dispatch({ agentType: 'local', os: 'windows', shell: 'gitbash' }, quoteHeavy);
    expect(mockExecCommand).not.toHaveBeenCalled();
    expect(typeof r).not.toBe('string');
    const { text, structuredContent } = r as { text: string; structuredContent: any };
    expect(text).toMatch(/^\[FAIL\] Command too long for a local Git Bash member/);
    expect(text).toContain(String(GIT_BASH_LAUNCHER_MAX_COMMAND_CHARS));
    expect(text).toContain('send_files');
    expect(structuredContent).toMatchObject({ isError: true, reason: 'command_too_long', exitCode: -1, stdout: '' });
  });

  it('local gitbash: a command under the limit still runs', async () => {
    await dispatch({ agentType: 'local', os: 'windows', shell: 'gitbash' }, 'echo short');
    expect(mockExecCommand).toHaveBeenCalledTimes(1);
  });

  it('remote gitbash and local linux are not limited (no launcher in the path)', async () => {
    await dispatch({ os: 'windows', shell: 'gitbash' }, quoteHeavy);
    await dispatch({ agentType: 'local', os: 'linux' }, quoteHeavy);
    expect(mockExecCommand).toHaveBeenCalledTimes(2);
  });
});

// Pins the measured constant against the real launcher, when installed.
const launcher = 'C:\\Program Files\\Git\\bin\\bash.exe';
const haveLauncher = process.platform === 'win32' && fs.existsSync(launcher);
if (!haveLauncher) console.warn('[execute-command-posix-wrapper.test] Git for Windows bin\\bash.exe launcher not present -- limit pin skipped');

describe.skipIf(!haveLauncher)('GIT_BASH_LAUNCHER_MAX_COMMAND_CHARS matches the real launcher', () => {
  const at = (len: number) => {
    const prefix = 'printf %s ';
    const suffix = ' | wc -c';
    const n = len - prefix.length - suffix.length;
    const r = spawnSync(prefix + 'a'.repeat(n) + suffix, { shell: launcher, encoding: 'utf8', windowsHide: true });
    return r.status === 0 && r.stdout.trim() === String(n);
  };
  it('a command of exactly the limit runs intact; one char more does not', () => {
    expect(at(GIT_BASH_LAUNCHER_MAX_COMMAND_CHARS)).toBe(true);
    expect(at(GIT_BASH_LAUNCHER_MAX_COMMAND_CHARS + 1)).toBe(false);
  });
});
