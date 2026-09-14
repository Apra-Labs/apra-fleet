// Guards the beads export commit against a divergent local Dolt DB replacing the
// committed id set (my-beads-db-27m.12). auto-sprint.js runs `bd export -o
// .beads/issues.jsonl` and then stages the file with a plain `git add`. When
// BEADS_DIR points at a workspace whose Dolt DB diverges from the repo's committed
// export, that export can silently drop most of the committed ids while the file
// still grows in byte size -- a size/line-count check would not catch this, so the
// guard compares the ID SET instead.
//
// Mirrors the kb-export.ts shrink guard (src/tools/kb-export.ts, maybeAutoCommitBible):
// an export that drops ids present in the committed .beads/issues.jsonl is written to
// disk but NOT staged/committed unless an explicit operator opt-in is given
// (AUTO_SPRINT_ALLOW_EXPORT_SHRINK=1), mirroring that file's `bible: { autoCommit: true }`.
//
// Kept in a separate module so this logic can be unit-tested without the workflow
// runtime (same reason lib/parse-sprint-args.mjs exists -- see that file's header).
// The dispatched shell agent runs inside an arbitrary target repo's checkout (not
// necessarily this monorepo), so it cannot `import` this file -- auto-sprint.js embeds
// an inline, self-contained `node -e` copy of this same logic. Keep both in sync when
// changing the algorithm.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Parses a .beads/issues.jsonl-style blob (one JSON object per line) into the set of
// issue ids present. Malformed / blank lines are ignored rather than treated as errors,
// since a partial or missing file must degrade to "no ids" (empty committed set), not a
// crash.
export function parseIds(text) {
  const ids = new Set();
  for (const line of String(text || '').split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && obj.id) ids.add(obj.id);
    } catch {
      // ignore malformed line
    }
  }
  return ids;
}

// Returns the ids present in `committedText` but absent from `freshText`, i.e. ids the
// new export would silently drop from the committed history.
export function computeDroppedIds(committedText, freshText) {
  const committed = parseIds(committedText);
  const fresh = parseIds(freshText);
  return [...committed].filter((id) => !fresh.has(id));
}

// Reads the currently committed .beads/issues.jsonl (from HEAD) and the freshly
// exported one on disk at `${repoPath}/.beads/issues.jsonl`, and stages the fresh file
// with `git add` ONLY if doing so would not drop any committed id -- unless
// `allowShrink` is explicitly set. Returns a receipt describing what happened; never
// throws for a missing HEAD blob or missing export file (both degrade to empty text).
export function runExportShrinkGuard(repoPath, { allowShrink = false } = {}) {
  let committedText = '';
  try {
    committedText = execFileSync('git', ['show', 'HEAD:.beads/issues.jsonl'], {
      cwd: repoPath, encoding: 'utf8',
    });
  } catch {
    committedText = ''; // no HEAD blob yet (new repo / first export) -- nothing to drop
  }

  let freshText = '';
  try {
    freshText = readFileSync(`${repoPath}/.beads/issues.jsonl`, 'utf8');
  } catch {
    freshText = ''; // export did not write a file -- treat as dropping everything
  }

  const dropped = computeDroppedIds(committedText, freshText);

  if (dropped.length > 0 && !allowShrink) {
    return { staged: false, dropped, allowed: false };
  }

  execFileSync('git', ['add', '.beads/issues.jsonl'], { cwd: repoPath });
  return { staged: true, dropped, allowed: dropped.length > 0 };
}

// CLI entry point, mirroring the inline auto-sprint.js command:
//   node export-shrink-guard.mjs <repoPath>
// Exit code is always 0 (refusing to stage is a normal, non-fatal outcome, not an error
// this step should report as a failure). Note this is NOT because
// SHELL_DISPATCH_PROMPT_HEADER (auto-sprint.js) tolerates non-zero exit -- it doesn't; it
// only instructs the dispatched agent to run each listed command exactly once, in order,
// and says nothing about exit status. Exit 0 here matters because the guard's own refusal
// must not look like a broken command to whatever reads this step's result.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const repoPath = process.argv[2];
  const allowShrink = process.env.AUTO_SPRINT_ALLOW_EXPORT_SHRINK === '1';
  const result = runExportShrinkGuard(repoPath, { allowShrink });
  if (!result.staged) {
    console.log(
      `EXPORT_GUARD_REFUSED: ${result.dropped.length} committed id(s) missing from new ` +
      `export (e.g. ${result.dropped.slice(0, 5).join(', ')}). Written to disk but NOT ` +
      `staged/committed. Set AUTO_SPRINT_ALLOW_EXPORT_SHRINK=1 to override.`
    );
  } else {
    console.log(
      `EXPORT_GUARD_OK: staged .beads/issues.jsonl` +
      (result.allowed ? ` (override used, ${result.dropped.length} dropped)` : '')
    );
  }
  process.exit(0);
}
