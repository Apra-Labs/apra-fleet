import { describe, it, expect } from 'vitest';
import { getOsCommands } from '../../src/os/index.js';
import { getProvider } from '../../src/providers/index.js';
import { durableOutputPath } from '../../src/os/linux.js';

/**
 * apra-fleet-8hb.2 -- regression guard for apra-fleet-8hb.1.
 *
 * `set -o pipefail` is a bash/zsh-ism. `set` is a POSIX "special built-in", so
 * on a dash/ash login shell an unrecognised option to it is a FATAL parse
 * error that terminates the *whole* shell outright -- not just that
 * statement -- aborting every durable-tee dispatch for such members
 * (verified live: `dash -c 'set -o pipefail; echo hi'` prints nothing but
 * `dash: 1: set: Illegal option -o pipefail` and exits 2; the guarded form
 * `(set -o pipefail) 2>/dev/null && set -o pipefail; echo hi` prints `hi`
 * and exits 0).
 *
 * This pins the command string src/os/linux.ts#buildAgentPromptCommand emits
 * for an invocation with opts.inv: it must not unconditionally emit a bare
 * `set -o pipefail` as its first statement (which would abort a dash/ash
 * shell before ever reaching the CLI/tee), while it must still tee stdout to
 * the durable per-invocation output file.
 */
describe('durable-tee wrapper is safe on POSIX sh (apra-fleet-8hb.2)', () => {
  const linux = getOsCommands('linux');
  const claudeProvider = getProvider('claude');

  it('does not emit a bare unconditional "set -o pipefail" as the first statement', () => {
    const cmd = linux.buildAgentPromptCommand(claudeProvider, {
      folder: '/home/testuser/project',
      promptFile: '.fleet-task.md',
      inv: 'abc12',
    });

    // The buggy, pre-fix form opened the backgrounded subshell with a bare
    // `set -o pipefail;` immediately -- e.g. `{ set -o pipefail; cd "..." ...`.
    // On dash/ash that line alone is a fatal parse error that kills the whole
    // shell (not just the statement), so the CLI invocation and the tee to
    // durableOutputPath never even run. Assert that exact unconditional,
    // unguarded shape is absent.
    expect(cmd).not.toMatch(/\{\s*set -o pipefail\s*;/);

    // It must instead be guarded (probed inside a subshell so an unsupported
    // `set -o pipefail` only kills the probe, not the login shell) or the
    // whole tee pipeline explicitly wrapped in `bash -c`/`zsh -c` so it never
    // runs under a POSIX-only shell at all.
    const isGuarded = /\(set -o pipefail\)\s*2>\/dev\/null\s*&&\s*set -o pipefail/.test(cmd);
    const isExplicitlyWrappedInBashOrZsh = /\b(bash|zsh)\s+-c\b/.test(cmd);
    expect(isGuarded || isExplicitlyWrappedInBashOrZsh).toBe(true);
  });

  it('still tees the CLI stdout to the durable per-invocation output file', () => {
    const cmd = linux.buildAgentPromptCommand(claudeProvider, {
      folder: '/home/testuser/project',
      promptFile: '.fleet-task.md',
      inv: 'abc12',
    });

    expect(cmd).toContain(`| tee "${durableOutputPath('abc12')}"`);
  });

  it('leaves the command untouched (no pipefail handling at all) when no invocation id is supplied', () => {
    const cmd = linux.buildAgentPromptCommand(claudeProvider, {
      folder: '/home/testuser/project',
      promptFile: '.fleet-task.md',
    });

    expect(cmd).not.toContain('pipefail');
    expect(cmd).not.toContain('tee');
  });
});
