// scripts/check-epic-diff-hygiene.mjs -- two branch-diff hygiene guards every
// task in the memory-contract/v1 kb_demote epic is bound by (CLAUDE.md: "Never
// cite a bead id ... in any LLM-facing text" and this epic's own "do not cite
// a bead id anywhere" instruction repeated on every task):
//
//   1. no ADDED line in the branch diff against the epic base cites a
//      my-beads-db- or apra-fleet- tracker id, EXCEPT inside a recorded bd
//      replay fixture (`test/fixtures/bd-recordings/*.jsonl`), which is
//      captured `bd` CLI output rather than LLM-facing or runtime-printed
//      text -- see RECORDED_BD_FIXTURE_DIR below for the full rationale and
//      for why that tolerance is path-attributed, not content-matched;
//   2. no docs/sprint-analysis-* file appears in that diff (that family of
//      doc is the harvester's own, written at a different phase, never by a
//      doer task).
//
// Both resolve the base ref through scripts/epic-base-ref.mjs (never the bare
// local branch name) and fail loudly, never vacuously, when it cannot be
// resolved.

import { spawnSync } from 'node:child_process';

/**
 * A real apra-fleet- tracker id always mixes at least one digit into the
 * short code immediately after the prefix (a few-character alphanumeric
 * slug, optionally followed by one or more dot-number segments). That digit
 * requirement is what distinguishes a real apra-fleet- citation from an
 * ordinary mention of this repo's own package/directory names, which are
 * plain words with no digit (apra-fleet-client, apra-fleet-se, apra-fleet-
 * workflow, apra-fleet-mcp) and would otherwise false-positive on every diff
 * that so much as names one of those packages. (This comment deliberately
 * does not spell out a digit-bearing example id as a literal, contiguous
 * string: this very file is itself scanned by the guard it defines, and a
 * real-looking example here would trip its own check.)
 *
 * No package or directory in this repo is named with the my-beads-db-
 * prefix, so there is nothing for a digit requirement to protect there --
 * and requiring one let a purely alphabetic my-beads-db- short code (e.g.
 * this epic's own bare id) pass uncaught, which is exactly the citation
 * CLAUDE.md's rule is meant to catch. The digit test below is therefore
 * applied ONLY when the matched prefix is apra-fleet-, never for
 * my-beads-db-.
 */
const TRACKER_ID_RE = /\b(my-beads-db-|apra-fleet-)([a-z0-9]+(?:\.[a-z0-9]+)*)/gi;

/** True when `prefix` is the one tracker prefix the digit requirement still applies to. */
function prefixRequiresDigit(prefix) {
  return /^apra-fleet-$/i.test(prefix);
}

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
 * PATH-BASED TOLERANCE: recorded bd replay fixtures.
 *
 * CLAUDE.md's citation rule targets LLM-facing or runtime-printed text --
 * prompts, playbooks, schema descriptions, strings a script prints or writes
 * at runtime. A file under a `test/fixtures/bd-recordings/` directory is none
 * of those: it is CAPTURED TOOL OUTPUT. Every `.jsonl` line in it is the
 * verbatim stdout/stderr of a real `bd` CLI invocation made while the test
 * suite ran, written by the recorder, never authored by hand (the directory's
 * own README and test/bd-recordings-fidelity.test.mjs both forbid
 * hand-editing it). If the scenario under test creates a bead, bd's own
 * output echoes that bead's id back dozens of times, so ANY new mock-sprint
 * scenario necessarily lands tracker ids in its recording. Scanning that
 * output for citations therefore measures what `bd` printed, not what an
 * author wrote, and the only way to "fix" a hit is to hand-edit a fixture --
 * which is itself forbidden.
 *
 * The tolerance is deliberately narrow in BOTH axes:
 *   - by path: only files inside a `test/fixtures/bd-recordings/` directory;
 *   - by extension: only `.jsonl` recordings. That directory's own README.md
 *     is ordinary prose a human/agent reads, so it stays fully scanned.
 * Everything else -- including a source, prompt or doc file that merely
 * MENTIONS a recording -- is still scanned, because the decision is made from
 * the diff's file attribution, never from the line's content.
 */
export const RECORDED_BD_FIXTURE_DIR = 'test/fixtures/bd-recordings/';

/**
 * @param {string|null|undefined} path repo-relative path from the diff's
 *   `+++ b/<path>` header, or null/undefined when attribution is unknown.
 * @returns {boolean} true only for a recorded bd replay fixture. Unknown
 *   attribution returns false (fail CLOSED: an unattributed line is scanned).
 */
export function isRecordedBdFixturePath(path) {
  if (typeof path !== 'string' || path.length === 0) return false;
  const normalized = path.replace(/\\/g, '/');
  const inDir = normalized.startsWith(RECORDED_BD_FIXTURE_DIR) || normalized.includes(`/${RECORDED_BD_FIXTURE_DIR}`);
  return inDir && normalized.endsWith('.jsonl');
}

/**
 * @param {(string|{path?: string|null, line: string})[]} addedLines added
 *   lines WITHOUT their leading '+' (the diff marker should already be
 *   stripped by the caller). Each entry is either a bare content line (no
 *   file attribution -- always scanned) or an attributed
 *   `{path, line}` entry as produced by addedEntriesFromDiff/getAddedLines.
 * @param {Set<string>} [allowedLines] exact line content to tolerate even
 *   though it contains a digit-bearing tracker id -- see
 *   KNOWN_PRE_EXISTING_BEAD_ID_LINES above.
 * @returns {{line: string, path: string|null, match: string}[]}
 */
export function findBeadIdCitations(addedLines, allowedLines = KNOWN_PRE_EXISTING_BEAD_ID_LINES) {
  const hits = [];
  for (const entry of addedLines) {
    const line = typeof entry === 'string' ? entry : entry.line;
    const path = typeof entry === 'string' ? null : (entry.path ?? null);
    if (allowedLines.has(line)) continue;
    // Path-attributed tolerance -- decided from the diff's file header, never
    // from what the line says. See RECORDED_BD_FIXTURE_DIR above.
    if (isRecordedBdFixturePath(path)) continue;
    TRACKER_ID_RE.lastIndex = 0;
    let m;
    while ((m = TRACKER_ID_RE.exec(line)) !== null) {
      if (!prefixRequiresDigit(m[1]) || /\d/.test(m[2])) hits.push({ line, path, match: m[0] });
    }
  }
  return hits;
}

/**
 * Extracts added-content lines from a unified diff WITH the file each one
 * belongs to, by tracking the `+++ b/<path>` header that opens every file
 * section. This attribution is what makes a path-based tolerance possible at
 * all: `addedLinesFromDiff` (below, kept for callers that only want content)
 * throws the path away, so by the time a bare string reaches
 * findBeadIdCitations there is nothing left to attribute it to.
 *
 * A deletion-side header (`+++ /dev/null`) clears the current path, so the
 * lines after it are treated as unattributed and scanned.
 * @param {string} diffText raw `git diff` output
 * @returns {{path: string|null, line: string}[]}
 */
export function addedEntriesFromDiff(diffText) {
  const entries = [];
  let currentPath = null;
  let previous = '';
  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('+++')) {
      // A '+++' line is a file header, never content -- the pre-existing
      // behaviour of this parser, preserved exactly. It only RE-ATTRIBUTES
      // when it also has a real header's shape ('+++ b/<path>' or
      // '+++ /dev/null', immediately after the '---' source-side header), so
      // an added content line that merely happens to begin with '++' cannot
      // silently re-point attribution at an attacker-chosen path.
      const target = raw.slice(3).trim();
      const looksLikeHeader = previous.startsWith('---') && (target === '/dev/null' || target.startsWith('b/'));
      if (looksLikeHeader) currentPath = target === '/dev/null' ? null : target.slice(2);
      previous = raw;
      continue;
    }
    if (raw.startsWith('+')) entries.push({ path: currentPath, line: raw.slice(1) });
    previous = raw;
  }
  return entries;
}

/**
 * Extracts added-content lines (strips the '+' marker) from a unified diff,
 * excluding the '+++' file-header line every hunk starts with. Content-only
 * view of addedEntriesFromDiff, kept because several callers/tests want bare
 * lines; prefer addedEntriesFromDiff when file attribution matters.
 * @param {string} diffText raw `git diff` output
 * @returns {string[]}
 */
export function addedLinesFromDiff(diffText) {
  return addedEntriesFromDiff(diffText).map((entry) => entry.line);
}

/**
 * @param {{cwd?: string, baseRef: string, pathspec?: string}} opts
 * @returns {{path: string|null, line: string}[]} added-content lines across
 *   the whole diff (or restricted to `pathspec` when given), each carrying
 *   the file it came from so findBeadIdCitations can apply its path-based
 *   tolerance. Feed the result straight to findBeadIdCitations.
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
  return addedEntriesFromDiff(result.stdout);
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
