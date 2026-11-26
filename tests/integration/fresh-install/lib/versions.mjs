// Pure version-variable resolution for the fresh-install harness.
// The expected version NEVER comes from the candidate under test: it is the
// --expect-version flag, else the repo's version.json (core only), else -- for
// --report-only -- the value recorded in the earlier report.json. An unknown
// version stays null; lib/verdict.mjs then records the checks that need it as
// INCONCLUSIVE instead of satisfying them.

const CORE_RE = /(\d+\.\d+\.\d+)/;

/** "v0.4.6_abc" / "0.4.6" -> "0.4.6", or null. */
export function versionCoreOf(v) {
  const m = CORE_RE.exec(String(v ?? ''));
  return m ? m[1] : null;
}

/** The repo's version.json version (core), or null when absent/unreadable. */
export function repoVersionCore(readText) {
  try { return versionCoreOf(JSON.parse(readText()).version); } catch { return null; }
}

/**
 * @param {{ expectVersionArg?: string|null, repoVersion?: string|null, pinnedBaseline?: string|null,
 *           needBase: boolean, reportOnly?: boolean, priorVars?: {expectVersion?: string|null, baselineVersion?: string|null}|null }} i
 * @returns {{ vars: {expectVersion: string|null, baselineVersion: string|null}, note: string }}
 */
export function resolveVersionVars(i) {
  const prior = i.reportOnly ? (i.priorVars ?? null) : null;
  let expectVersion = null;
  let note;
  if (i.expectVersionArg) {
    expectVersion = i.expectVersionArg; note = `Expected version pinned by --expect-version: ${expectVersion}.`;
  } else if (prior?.expectVersion) {
    expectVersion = prior.expectVersion; note = `Expected version reused from the recorded report.json: ${expectVersion}.`;
  } else if (versionCoreOf(i.repoVersion)) {
    expectVersion = versionCoreOf(i.repoVersion); note = `Expected version core derived from the repo version.json: ${expectVersion} (the candidate's own --version is never used).`;
  } else {
    note = 'Expected version is UNKNOWN: no --expect-version and no readable repo version.json; version checks are INCONCLUSIVE.';
  }
  let baselineVersion = null;
  if (i.needBase) baselineVersion = i.pinnedBaseline ?? prior?.baselineVersion ?? null;
  return { vars: { expectVersion, baselineVersion }, note };
}
