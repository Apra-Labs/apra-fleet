// scripts/epic-base-ref.mjs -- resolves a sprint epic's base branch to a
// commit SHA for diff-based guards (fixture-additivity, bead-id-in-diff,
// sprint-analysis-doc, etc).
//
// WHY THIS EXISTS: the memory-contract/v1 kb_demote epic's own guards were
// originally written against the BARE local branch name
// (`u1_kb_redesign_base`). On a clone that never checked that branch out
// locally -- every fresh clone, and this repo's current state -- that name
// does not resolve at all (`git rev-parse u1_kb_redesign_base` fails with
// "unknown revision or path not in the working tree"). A guard that silently
// swallows that failure (e.g. a try/catch that falls back to an empty diff)
// does not fail: it PASSES VACUOUSLY, which is the exact false-success shape
// this epic's own acceptance criteria forbid elsewhere. This module exists so
// every diff-based guard in the epic resolves the same way and fails LOUDLY,
// with a clear remediation, instead of each guard growing its own silent
// fallback.
//
// RESOLUTION ORDER (first one that resolves wins):
//   1. the remote-tracking ref `origin/<branchName>` directly -- this is what
//      every acceptance criterion in this epic actually names;
//   2. `git merge-base HEAD origin/<branchName>` -- a fork-point fallback for
//      a worktree whose HEAD has diverged far enough that a direct diff
//      against (1) would be misleading, while the remote-tracking ref itself
//      still exists.
// If NEITHER resolves (the remote-tracking ref itself is missing -- e.g. the
// remote was never fetched), this throws a descriptive Error rather than
// returning null/undefined/empty-string, so a caller cannot accidentally
// treat "unresolved" as "clean".

import { spawnSync } from 'node:child_process';

/**
 * @param {string} branchName bare branch name, e.g. "u1_kb_redesign_base"
 *   (never pass "origin/..." here -- this function adds that prefix itself).
 * @param {{ cwd?: string }} [opts]
 * @returns {string} a resolved commit SHA
 * @throws {Error} when neither the remote-tracking ref nor a merge-base
 *   against it resolves.
 */
export function resolveEpicBaseRef(branchName, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const remoteRef = `origin/${branchName}`;

  const direct = spawnSync('git', ['rev-parse', '--verify', remoteRef], { cwd, encoding: 'utf8' });
  if (direct.status === 0) return direct.stdout.trim();

  const mergeBase = spawnSync('git', ['merge-base', 'HEAD', remoteRef], { cwd, encoding: 'utf8' });
  if (mergeBase.status === 0) return mergeBase.stdout.trim();

  throw new Error(
    `Cannot resolve epic base ref for branch "${branchName}": neither "git rev-parse ` +
      `--verify ${remoteRef}" nor "git merge-base HEAD ${remoteRef}" resolved. This guard ` +
      `never diffs against the bare local name "${branchName}" (it may not exist on this ` +
      `clone at all). Fix: fetch the remote-tracking branch (git fetch origin ${branchName}) ` +
      `so ${remoteRef} resolves, then re-run.`,
  );
}
