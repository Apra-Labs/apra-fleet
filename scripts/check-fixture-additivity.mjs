// scripts/check-fixture-additivity.mjs -- the memory-contract/v1 fixture
// corpus must grow ADDITIVELY ONLY across this epic: record-fixtures.mjs
// mints fresh UUIDs on every run, so a full re-run of the recorder churns the
// whole committed corpus even when nothing behavioral changed, and that
// churn is indistinguishable in a diff from a real, reviewed content change.
// The rule this enforces is "no M, no D under memory-contract/v1/fixtures"
// against the epic base ref (scripts/epic-base-ref.mjs) -- not a directory
// allowlist, so new setup fixtures in kb_capture/ or kb_promote/ pass exactly
// like new kb_demote/ or kb_bible_commit/ fixtures do.
//
// KNOWN PRE-EXISTING EXCEPTION (ratchet, same shape as scripts/ascii-
// baseline.mjs): two kb_import fixtures were legitimately modified by an
// EARLIER, already-merged task in this same epic (commit 891833de, "apply
// bible demotion tombstones on import and report a demoted count") before
// this additive-only guard existed -- kb_import's response grew a real new
// `demoted` field, so the two fixtures recording its exact response text
// necessarily changed to match. That is a reviewed, intentional content
// update, not fixture-recorder churn, and reverting it would make those two
// fixtures assert a response shape the tool no longer returns. The baseline
// below is the explicit, auditable record of that one exception -- it may
// only ever be REMOVED (a file fixed back to a clean A-only history) or kept
// exactly as is; any new M or D line against the base, on these paths or any
// other, still fails.

import { spawnSync } from 'node:child_process';

export const KNOWN_PRE_EXISTING_FIXTURE_MODIFICATIONS = new Map([
  [
    'memory-contract/v1/fixtures/kb_import/happy.json',
    'commit 891833de added kb_import response field `demoted`; fixture text updated to match',
  ],
  [
    'memory-contract/v1/fixtures/kb_import/refusal-import-entry-rejected.json',
    'commit 891833de added kb_import response field `demoted`; fixture text updated to match',
  ],
]);

/**
 * Parses `git diff --name-status` output into {status, path} entries.
 * A rename/copy (`R100`, `C75`, ...) keeps its full status token (including
 * the similarity index) so a caller can decide whether to treat it as
 * additive; this guard does not special-case renames, since none exist in
 * the current corpus and a renamed fixture is exactly the kind of silent
 * UUID-churn disguise this check exists to catch.
 */
export function parseNameStatus(diffOutput) {
  return diffOutput
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [status, ...rest] = line.split('\t');
      return { status, path: rest.join('\t') };
    });
}

/**
 * @param {{status: string, path: string}[]} entries
 * @param {Set<string>|Map<string,string>} [allowedModifications] paths
 *   permitted to appear as a modification (status starting with "M") --
 *   never applies to a deletion or any other non-addition status.
 */
export function findNonAdditiveFixtureChanges(entries, allowedModifications = KNOWN_PRE_EXISTING_FIXTURE_MODIFICATIONS) {
  const allowed = allowedModifications instanceof Map ? new Set(allowedModifications.keys()) : allowedModifications;
  return entries.filter((entry) => {
    if (entry.status.startsWith('A')) return false;
    if (entry.status.startsWith('M') && allowed.has(entry.path)) return false;
    return true;
  });
}

/**
 * @param {{cwd?: string, baseRef: string, fixturesPath?: string}} opts
 * @returns {{entries: {status:string,path:string}[], violations: {status:string,path:string}[]}}
 */
export function checkFixtureAdditivity(opts) {
  const { cwd = process.cwd(), baseRef, fixturesPath = 'memory-contract/v1/fixtures' } = opts;
  if (!baseRef) throw new Error('checkFixtureAdditivity requires a resolved baseRef (see resolveEpicBaseRef)');
  const result = spawnSync('git', ['diff', '--name-status', `${baseRef}..HEAD`, '--', fixturesPath], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `git diff --name-status ${baseRef}..HEAD -- ${fixturesPath} failed: ${result.stderr || result.error}`,
    );
  }
  const entries = parseNameStatus(result.stdout);
  return { entries, violations: findNonAdditiveFixtureChanges(entries) };
}
