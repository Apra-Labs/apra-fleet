// GOMAXPROCS default for bd/dolt started by fleet on Windows members
// (src/os/go-concurrency.ts). Platform-independent: no Windows host needed.
import { describe, it, expect } from 'vitest';
import {
  withGoMaxProcsDefault,
  GO_MAXPROCS_DEFAULT_PWSH,
  GO_MAXPROCS_DEFAULT_GITBASH,
} from '../src/os/go-concurrency.js';
import { getOsCommands, LinuxCommands } from '../src/os/index.js';
import { getProvider } from '../src/providers/index.js';

describe('withGoMaxProcsDefault (pure Windows child-env rule)', () => {
  it('adds GOMAXPROCS=1 when absent', () => {
    expect(withGoMaxProcsDefault({ Path: 'C:\\Windows' })).toEqual({ Path: 'C:\\Windows', GOMAXPROCS: '1' });
  });

  it('leaves an existing GOMAXPROCS value untouched', () => {
    expect(withGoMaxProcsDefault({ Path: 'C:\\Windows', GOMAXPROCS: '4' })).toEqual({ Path: 'C:\\Windows', GOMAXPROCS: '4' });
  });

  it('honours an existing value under any casing (Windows env names are case-insensitive)', () => {
    expect(withGoMaxProcsDefault({ GoMaxProcs: '8' })).toEqual({ GoMaxProcs: '8' });
  });

  it('treats an empty value as unset', () => {
    expect(withGoMaxProcsDefault({ GOMAXPROCS: '' })).toEqual({ GOMAXPROCS: '1' });
  });

  it('does not mutate its input', () => {
    const env = { Path: 'x' };
    withGoMaxProcsDefault(env);
    expect(env).toEqual({ Path: 'x' });
  });
});

const claude = getProvider('claude');
const posixOpts = {
  folder: '/home/u/work', promptFile: '.fleet-task.md', sessionId: 'sess-1', resuming: true,
  unattended: 'auto', model: 'opus', maxTurns: 10, inv: 'inv1',
} as const;
const winOpts = { ...posixOpts, folder: 'C:\\Users\\u\\work' } as const;

describe('remote Windows member command strings carry the GOMAXPROCS default', () => {
  it('PowerShell agent launch sets the default (only when unset) before the CLI runs', () => {
    const cmd = getOsCommands('windows').buildAgentPromptCommand(claude, winOpts as never);
    expect(GO_MAXPROCS_DEFAULT_PWSH).toBe("if (-not $env:GOMAXPROCS) { $env:GOMAXPROCS = '1' }; ");
    expect(cmd).toContain(`Set-Location "C:\\Users\\u\\work"; ${GO_MAXPROCS_DEFAULT_PWSH}`);
    expect(cmd.indexOf(GO_MAXPROCS_DEFAULT_PWSH)).toBeLessThan(cmd.indexOf('claude'));
  });

  it('PowerShell execute_command wrapper sets the default (only when unset)', () => {
    expect(getOsCommands('windows').wrapInWorkFolder('C:\\w', 'bd dolt pull'))
      .toBe(`Set-Location "C:\\w"; ${GO_MAXPROCS_DEFAULT_PWSH}$env:Path = "$env:Path;$env:USERPROFILE\\.apra-fleet\\bin"; bd dolt pull`);
  });

  it('Git Bash agent launch and execute_command wrapper set the default (only when unset)', () => {
    expect(GO_MAXPROCS_DEFAULT_GITBASH).toBe('[ -n "${GOMAXPROCS:-}" ] || export GOMAXPROCS=1; ');
    const gb = getOsCommands('windows', 'gitbash');
    const linux = new LinuxCommands();
    expect(gb.buildAgentPromptCommand(claude, winOpts as never))
      .toBe(`${GO_MAXPROCS_DEFAULT_GITBASH}${linux.buildAgentPromptCommand(claude, winOpts as never)}`);
    expect(gb.wrapInWorkFolder('/c/w', 'bd dolt pull'))
      .toBe(`${GO_MAXPROCS_DEFAULT_GITBASH}cd "/c/w" && export PATH="$PATH:$HOME/.apra-fleet/bin" && bd dolt pull`);
  });
});

describe('linux/macOS member command strings are byte-identical to before', () => {
  // Captured from the builders before the GOMAXPROCS change.
  const PROMPT = '{ (set -o pipefail) 2>/dev/null && set -o pipefail; cd "/home/u/work" && export PATH="$HOME/.local/bin:$PATH:$HOME/.apra-fleet/bin" && unset ANTIGRAVITY_SOURCE_METADATA CLAUDE_SOURCE_METADATA COPILOT_SOURCE_METADATA CODEX_SOURCE_METADATA && claude -p "[inv1] Your task is described in .fleet-task.md in the current directory. Read that file first, then execute the task." --output-format json --max-turns 10 --resume "sess-1" --permission-mode auto --model "opus" | tee "/tmp/.fleet-out-inv1.json"; } & _fleet_pid=$!; printf \'FLEET_PID:%s\\n\' "$_fleet_pid"; wait "$_fleet_pid"; exit $?';
  const WRAP = 'cd "/home/u/work" && export PATH="$PATH:$HOME/.apra-fleet/bin" && bd dolt pull';

  for (const os of ['linux', 'macos'] as const) {
    it(`${os}: agent launch and execute_command wrapper unchanged, no GOMAXPROCS`, () => {
      const cmds = getOsCommands(os);
      expect(cmds.buildAgentPromptCommand(claude, posixOpts as never)).toBe(PROMPT);
      expect(cmds.wrapInWorkFolder('/home/u/work', 'bd dolt pull')).toBe(WRAP);
    });
  }
});
