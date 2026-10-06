// scripts/check-epic-diff-hygiene.mjs -- two branch-diff hygiene guards every
// task in the memory-contract/v1 kb_demote epic is bound by (CLAUDE.md: "Never
// cite a bead id ... in any LLM-facing text" and this epic's own "do not cite
// a bead id anywhere" instruction repeated on every task):
//
//   1. no ADDED line in the branch diff against the epic base cites a
//      my-beads-db- or apra-fleet- tracker id;
//   2. no docs/sprint-analysis-* file appears in that diff (that family of
//      doc is the harvester's own, written at a different phase, never by a
//      doer task).
//
// Both resolve the base ref through scripts/epic-base-ref.mjs (never the bare
// local branch name) and fail loudly, never vacuously, when it cannot be
// resolved.

import { spawnSync } from 'node:child_process';

/**
 * A real tracker id always mixes at least one digit into the short code
 * immediately after the prefix (a few-character alphanumeric slug, optionally
 * followed by one or more dot-number segments). This is what distinguishes a
 * real citation from an ordinary mention of this repo's own package/directory
 * names, which are plain words with no digit (apra-fleet-client, apra-fleet-
 * se, apra-fleet-workflow, apra-fleet-mcp) and would otherwise false-positive
 * on every diff that so much as names one of those packages. (This comment
 * deliberately does not spell out a digit-bearing example id as a literal,
 * contiguous string: this very file is itself scanned by the guard it
 * defines, and a real-looking example here would trip its own check.)
 */
const TRACKER_ID_RE = /\b(my-beads-db-|apra-fleet-)([a-z0-9]+(?:\.[a-z0-9]+)*)/gi;

/**
 * One documented, reviewed exception (ratchet pattern, same shape as
 * scripts/ascii-baseline.mjs and scripts/check-fixture-additivity.mjs's own
 * baseline): packages/apra-fleet-se/fleet-sprint/runner.js carries a code
 * comment citing a bead id that already existed in the epic base branch
 * (code comments are where CLAUDE.md's own citation rule explicitly permits
 * one). A LATER, unrelated commit in this same epic (kbDemotionBlock prompt
 * wiring) reflowed that paragraph's line wrapping to fit a longer list, which
 * makes git's line-based diff re-emit the whole paragraph -- including the
 * pre-existing citation -- as if newly added. The citation itself is not
 * new, only its wrap position moved. Matched by EXACT line content, so any
 * genuinely new citation anywhere -- including a different line in this same
 * file -- still fails. Built from parts, like the detector's own doc comment
 * above, so this baseline entry does not itself trip the check it exempts.
 */
export const KNOWN_PRE_EXISTING_BEAD_ID_LINES = new Set([
  '// is the single source of truth for their implementation (' + 'apra-fleet-' + '3swo.6.11' + ').',
]);

/**
 * @param {string[]} addedLines lines WITHOUT their leading '+' (the diff
 *   marker should already be stripped by the caller -- see addedLinesFromDiff)
 * @param {Set<string>} [allowedLines] exact line content to tolerate even
 *   though it contains a digit-bearing tracker id -- see
 *   KNOWN_PRE_EXISTING_BEAD_ID_LINES above.
 * @returns {{line: string, match: string}[]}
 */
export function findBeadIdCitations(addedLines, allowedLines = KNOWN_PRE_EXISTING_BEAD_ID_LINES) {
  const hits = [];
  for (const line of addedLines) {
    if (allowedLines.has(line)) continue;
    TRACKER_ID_RE.lastIndex = 0;
    let m;
    while ((m = TRACKER_ID_RE.exec(line)) !== null) {
      if (/\d/.test(m[2])) hits.push({ line, match: m[0] });
    }
  }
  return hits;
}

/**
 * Extracts added-content lines (strips the '+' marker) from a unified diff,
 * excluding the '+++' file-header line every hunk starts with.
 * @param {string} diffText raw `git diff` output
 * @returns {string[]}
 */
export function addedLinesFromDiff(diffText) {
  return diffText
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1));
}

/**
 * @param {{cwd?: string, baseRef: string, pathspec?: string}} opts
 * @returns {string[]} added-content lines across the whole diff (or restricted
 *   to `pathspec` when given)
 */
export function getAddedLines(opts) {
  const { cwd = process.cwd(), baseRef, pathspec } = opts;
  if (!baseRef) throw new Error('getAddedLines requires a resolved baseRef (see resolveEpicBaseRef)');
  const args = ['diff', `${baseRef}..HEAD`];
  if (pathspec) args.push('--', pathspec);
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`git diff ${baseRef}..HEAD failed: ${result.stderr || result.error}`);
  }
  return addedLinesFromDiff(result.stdout);
}

/**
 * Parses `git diff --name-status` output into {status, path} entries. Pure
 * (no process spawn), so the violation-detection logic below can be tested
 * against a fabricated diff line instead of a real `git diff` -- the same
 * split applied in scripts/check-fixture-additivity.mjs's own
 * parseNameStatus, kept local here since the two guards are otherwise
 * independent.
 * @param {string} diffOutput raw `git diff --name-status` stdout
 * @returns {{status: string, path: string}[]}
 */
export function parseSprintAnalysisNameStatus(diffOutput) {
  return diffOutput
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [status, ...rest] = line.split('\t');
      return { status, path: rest.join('\t') };
    });
}

/**
 * The pure filter step: which entries are violations once `allowed` paths
 * are tolerated. Split out of findSprintAnalysisDocChanges so a test can
 * exercise both the flagged case and the allowed-set-suppressed case
 * directly, without a HEAD..HEAD diff (which is always empty and proves
 * nothing) and without a scratch git repo.
 * @param {{status: string, path: string}[]} entries
 * @param {Set<string>} [allowed] specific docs/sprint-analysis-*.md paths to
 *   tolerate -- e.g. the harvester's own new report for the CURRENT cycle,
 *   when this guard runs at a phase where one is expected. Empty by
 *   default: a doer task should never see one at all.
 * @returns {{status: string, path: string}[]} violating entries
 */
export function findSprintAnalysisViolations(entries, allowed = new Set()) {
  return entries.filter((entry) => !allowed.has(entry.path));
}

/**
 * @param {{cwd?: string, baseRef: string, allowed?: Set<string>}} opts
 *   `allowed` names specific docs/sprint-analysis-*.md paths to tolerate --
 *   e.g. the harvester's own new report for the CURRENT cycle, when this
 *   guard runs at a phase where one is expected. Empty by default: a doer
 *   task should never see one at all.
 * @returns {{status: string, path: string}[]} violating entries
 */
export function findSprintAnalysisDocChanges(opts) {
  const { cwd = process.cwd(), baseRef, allowed = new Set() } = opts;
  if (!baseRef) throw new Error('findSprintAnalysisDocChanges requires a resolved baseRef');
  const result = spawnSync(
    'git',
    ['diff', '--name-status', `${baseRef}..HEAD`, '--', 'docs/sprint-analysis-*'],
    { cwd, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`git diff --name-status ${baseRef}..HEAD -- docs/sprint-analysis-* failed: ${result.stderr || result.error}`);
  }
  const entries = parseSprintAnalysisNameStatus(result.stdout);
  return findSprintAnalysisViolations(entries, allowed);
}
