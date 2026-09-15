#!/usr/bin/env node
// Phase-4 move-only probe.
//
// Proves the Phase-4 extraction was move-only WITHOUT reading intent out of
// commit messages. For every file in (Phase-4 diff) INTERSECT (set A union B
// union C), take that file's PRE-Phase-4 revision and run it, unmodified,
// against the CURRENT HEAD tree.
//
//   - file is a bin/ entrypoint -> BIN_ENTRYPOINT_SKIP (a self-executing CLI
//                                 launcher would run its own main() for real
//                                 when the probe copies it and runs
//                                 `node --test` on the copy -- process.argv[1]
//                                 resolves to the probe copy, so any
//                                 `isMainModule()`-style guard treats it as a
//                                 direct launch. Excluded from the dynamic
//                                 probe; covered instead by the static
//                                 import-binding check in section (2) of
//                                 phase4-move-only-completeness.test.mjs)
//   - file is a scripts/ entrypoint
//                              -> SCRIPT_ENTRYPOINT_SKIP (same hazard class as
//                                 bin/, and worse: scripts/ holds operator-run
//                                 CLI programs, not test files, and at least
//                                 one of them calls main() unconditionally at
//                                 module-eval time. Running one under
//                                 `node --test` executes it for real, or exits
//                                 non-zero on ordinary CLI-usage grounds such
//                                 as a missing required flag -- neither of
//                                 which says anything about the Phase-4
//                                 facade. Excluded from the dynamic probe;
//                                 covered by the same static check as bin/)
//   - file absent at BASE      -> NEW (added by Phase 4; cannot have been broken by it)
//   - old revision PASSES      -> INTACT (Phase 4 did not force the edit; the old
//                                 assertions still hold against the new facade)
//   - old revision FAILS with a module-resolution / missing-export error
//                              -> FACADE_BREAK (the gate's failure condition)
//   - old revision FAILS otherwise, and the file's CURRENT committed revision
//     (the one actually on disk at HEAD) PASSES against HEAD
//                              -> ANCHOR_DESYNC (the old assertion -- anchored
//                                 on runner.js raw source text, line position,
//                                 phase sequence, watchdog census or similar --
//                                 was superseded by a later, real edit to this
//                                 same file; allowed)
//   - old revision FAILS otherwise, and the CURRENT committed revision ALSO
//     FAILS against HEAD
//                              -> UNEXPLAINED (the failure survives past
//                                 whatever legitimately changed; a live
//                                 regression, not an anchor desync)
//
// The ANCHOR_DESYNC/UNEXPLAINED split is decided by re-running the file's own
// CURRENT revision as an experiment, never by matching words in the OLD
// revision's failure text (apra-fleet-3swo.55: a wording-based corroboration
// check let three files through as ANCHOR_DESYNC purely because their
// assertion messages happened to mention "runner.js", while a fourth file
// failing for the exact same reason -- a later, legitimate behaviour change
// -- was rejected as UNEXPLAINED only because its message named
// role-policies.mjs instead. Whether a real, later behaviour change is
// tolerated must not depend on incidental assertion wording).
//
// Usage: node scripts/phase4-moveonly-probe.mjs [--base <sha>] [--json]
// Run from packages/apra-fleet-se. Exits non-zero if any file is FACADE_BREAK.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');
const REPO = path.resolve(PKG, '..', '..');
const PKG_REL = path.relative(REPO, PKG).split(path.sep).join('/');

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const baseIdx = argv.indexOf('--base');
const BASE_ARG = baseIdx >= 0 ? argv[baseIdx + 1] : null;

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', ...opts });
}

/**
 * BASE is discovered, never hardcoded: the parent of the FIRST commit that
 * introduced either Phase-4 artefact -- fleet-sprint/phases/ or
 * fleet-sprint/sprint-state.mjs. Both paths matter: the first Phase-4 commit
 * (21ab77d6) added sprint-state.mjs only; fleet-sprint/phases/ did not appear
 * until two commits later, so discovering on phases/ alone yields a BASE that
 * is two commits TOO NEW and silently narrows the audited range.
 * Falls back to --base when given.
 */
export const PHASE4_ARTEFACT_PATHS = [
  `${PKG_REL}/fleet-sprint/phases`,
  `${PKG_REL}/fleet-sprint/sprint-state.mjs`,
];

export function discoverBase() {
  if (BASE_ARG) return git(['rev-parse', BASE_ARG]).trim();
  const firstPhaseCommit = git([
    'log', '--reverse', '--format=%H', '--diff-filter=A', 'HEAD', '--',
    ...PHASE4_ARTEFACT_PATHS,
  ]).trim().split('\n').filter(Boolean)[0];
  if (!firstPhaseCommit) {
    throw new Error('could not discover the first Phase-4 commit (no adds under fleet-sprint/phases or sprint-state.mjs)');
  }
  return git(['rev-parse', `${firstPhaseCommit}^`]).trim();
}

/** DISCOVERY COMMAND A -- direct importers of runner.js (static, require, dynamic). */
export function discoverSetA() {
  const out = git([
    'grep', '-l', '-E',
    `(from[[:space:]]*['"]|require\\([[:space:]]*['"]|import\\([[:space:]]*['"])[^'"]*fleet-sprint/runner\\.js['"]`,
    'HEAD', '--', `${PKG_REL}/*.mjs`, `${PKG_REL}/*.js`,
  ]).trim().split('\n').filter(Boolean)
    .map((l) => l.replace(/^HEAD:/, ''))
    .filter((f) => !f.includes('node_modules'));
  return [...new Set(out)];
}

/** DISCOVERY COMMAND B / C -- mock-sprint files, flat (npm test) and slow (npm run test:slow). */
export function discoverSetB() {
  return readdirSync(path.join(PKG, 'test'))
    .filter((f) => /^mock-sprint.*\.test\.mjs$/.test(f))
    .map((f) => `${PKG_REL}/test/${f}`);
}
export function discoverSetC() {
  return readdirSync(path.join(PKG, 'test', 'slow'))
    .filter((f) => /^mock-sprint.*\.test\.mjs$/.test(f))
    .map((f) => `${PKG_REL}/test/slow/${f}`);
}

export function discoverIntersection(base) {
  const changed = new Set(
    git(['diff', '--name-only', `${base}..HEAD`, '--', PKG_REL]).trim().split('\n').filter(Boolean),
  );
  const union = [...new Set([...discoverSetA(), ...discoverSetB(), ...discoverSetC()])];
  return union.filter((f) => changed.has(f)).sort();
}

function existsAtBase(base, repoRelPath) {
  return spawnSync('git', ['cat-file', '-e', `${base}:${repoRelPath}`], { cwd: REPO }).status === 0;
}

/**
 * A failure is a FACADE_BREAK only when the probe could not resolve an import of
 * the runner facade or could not find a binding the facade used to re-export.
 * Everything else is an anchor/census desync.
 */
const FACADE_BREAK_PATTERNS = [
  /ERR_MODULE_NOT_FOUND/,
  /ERR_UNSUPPORTED_DIR_IMPORT/,
  /Cannot find module/i,
  /does not provide an export named/i,
  /ERR_REQUIRE_ESM/,
  /SyntaxError: The requested module/,
  // A facade break has TWO distinct signatures depending on which side fails
  // to link, and an early version of this list carried only the first:
  //   consumer side -- "does not provide an export named 'X'"
  //   facade side   -- "Export 'X' is not defined in module", raised when
  //                    runner.js re-exports a name it no longer has.
  // The end-to-end falsification in the gate test produces the second one, and
  // is the reason it is here.
  /Export '[^']*' is not defined in module/,
];

/**
 * Text-only triage: does this failure look like the facade could not be
 * linked at all? That is the one class classifyFailure can safely decide from
 * wording alone, because a module-resolution or missing-export error is a
 * link-time fact, not a matter of interpretation. Everything else is left as
 * UNEXPLAINED here -- probeFile decides ANCHOR_DESYNC vs UNEXPLAINED by
 * experiment (re-running the file's CURRENT revision), not by matching more
 * words in the OLD revision's failure text. See this file's header for why:
 * a wording-based corroboration check here previously let an ANCHOR_DESYNC
 * classification depend on whether the assertion happened to say "runner.js"
 * (apra-fleet-3swo.55).
 */
export function classifyFailure(output) {
  const hit = FACADE_BREAK_PATTERNS.find((re) => re.test(output));
  if (hit) return { klass: 'FACADE_BREAK', reason: String(hit) };
  return { klass: 'UNEXPLAINED', reason: 'failed without a module-resolution or missing-export error; not yet corroborated as an anchor desync' };
}

/**
 * The behavioural corroboration step for a non-facade-break failure: run the
 * file's CURRENT committed revision (the one actually on disk right now,
 * already reviewed and merged) against HEAD. If it passes, whatever tripped
 * the OLD revision was superseded by a later, real edit to this same file --
 * an anchor desync, regardless of what the OLD failure's assertion text says.
 * If the CURRENT revision ALSO fails, the failure survives past whatever
 * legitimately changed and is a live regression that must not hide behind
 * the anchor-desync class.
 */
export function corroborateAnchorDesync(repoRelPath, timeoutMs = 300000) {
  const absPath = path.join(REPO, repoRelPath);
  const { ok } = runTestFile(absPath, timeoutMs);
  return ok
    ? { klass: 'ANCHOR_DESYNC', reason: 'the CURRENT committed revision of this file passes against HEAD; the OLD revision\'s failure was superseded by a later, legitimate edit to this same file' }
    : { klass: 'UNEXPLAINED', reason: 'the CURRENT committed revision of this file ALSO fails against HEAD; this is a live regression, not an anchor desync' };
}

export function runTestFile(absPath, timeoutMs = 300000) {
  // NODE_TEST_CONTEXT and UPDATE_GOLDEN MUST be stripped. When this probe runs
  // from inside a `node --test` parent, an inherited NODE_TEST_CONTEXT puts the
  // child into child-process-reporter mode, where its exit status no longer
  // reflects the child's own pass/fail -- every probe then reports INTACT and
  // the gate silently becomes vacuous. phase1's runNestedSuite strips the same
  // two variables for the same reason. The '(3) falsification' section of
  // test/phase4-move-only-completeness.test.mjs pins this.
  const env = { ...process.env, NO_COLOR: '1' };
  delete env.NODE_TEST_CONTEXT;
  delete env.UPDATE_GOLDEN;
  const r = spawnSync(process.execPath, ['--test', absPath], {
    cwd: PKG, encoding: 'utf8', timeout: timeoutMs, env,
  });
  const output = `${r.stdout || ''}\n${r.stderr || ''}`;
  // Belt and braces: trust the TAP summary when it is present, not just status.
  const failLine = output.match(/^# fail (\d+)/m);
  const ok = r.status === 0 && (!failLine || failLine[1] === '0') && !/^not ok /m.test(output);
  return { ok, output };
}

/**
 * Matches a repo-relative path under any package's bin/ directory, e.g.
 * `packages/apra-fleet-se/bin/cli.mjs` or `packages/apra-fleet-se/bin/serve.mjs`.
 * These are launcher scripts that self-execute their main() at module-eval
 * time when loaded directly (an `isMainModule()`-style guard comparing
 * `import.meta.url` to `process.argv[1]`) -- see BIN_ENTRYPOINT_SKIP below for
 * why that makes them unsafe to probe dynamically.
 */
const BIN_ENTRYPOINT_RE = /(^|\/)bin\/[^/]+\.m?js$/;

/**
 * Matches a repo-relative path under any package's scripts/ directory, e.g.
 * `packages/apra-fleet-se/scripts/dolt-settle-integration.mjs`. scripts/ holds
 * operator-run maintenance and integration entrypoints -- never test files;
 * the package's `test` script globs only `test/*.test.mjs` -- so running one
 * under `node --test` is never a statement about the Phase-4 facade. See
 * SCRIPT_ENTRYPOINT_SKIP below.
 */
const SCRIPT_ENTRYPOINT_RE = /(^|\/)scripts\/[^/]+\.m?js$/;

export function probeFile(base, repoRelPath, timeoutMs = 300000) {
  // Bin entrypoints are launcher scripts, not test files: copying one to a
  // sibling probe file and running `node --test` on it loads the SAME
  // self-invocation code path a direct CLI launch does (process.argv[1]
  // resolves to the probe copy's own module URL), so its main() runs for
  // real and can exit non-zero on ordinary CLI-usage grounds (e.g. missing
  // required flags) that have nothing to do with the Phase-4 facade.
  // apra-fleet-hzeb.4.2 patched cli.mjs's own isMainModule() to gate on
  // NODE_TEST_CONTEXT so it specifically survives this probe, but that fix
  // is per-file and opt-in -- bin/serve.mjs has the identical self-invoke
  // shape (isMainModule() at bin/serve.mjs:417-425) with no such guard, and
  // any future bin/ entrypoint that starts importing runner.js would trip
  // the same false-positive UNEXPLAINED/FACADE_BREAK the instant it entered
  // the Phase-4 diff intersection, even though nothing about the extraction
  // itself was broken. Rather than depend on every bin/ entrypoint
  // separately opting in to a probe-awareness guard, exclude the class from
  // the DYNAMIC probe entirely: bin/ entrypoints still get their move-only
  // proof from section (2) of phase4-move-only-completeness.test.mjs, a
  // static check (every named binding a set-A importer takes from runner.js
  // exists on its export surface) that covers all of discoverSetA() -- bin/
  // included -- without executing anything, so a real facade break in a
  // bin/ entrypoint is still caught, just not by running its old revision.
  if (BIN_ENTRYPOINT_RE.test(repoRelPath)) {
    return {
      file: repoRelPath,
      klass: 'BIN_ENTRYPOINT_SKIP',
      detail: 'bin/ entrypoints self-execute at module scope when probed under `node --test`; excluded from the dynamic probe, covered instead by the static import-binding check in section (2)',
    };
  }
  // scripts/ entrypoints are the same hazard as bin/, reached by a different
  // door. They are operator-run CLI programs rather than test files, so the
  // dynamic probe's premise -- "this file is a test; run it and see whether it
  // still passes" -- does not hold for them at all:
  //   * scripts/dolt-settle-integration.mjs calls main() unconditionally at
  //     module-eval time (no isMainModule()-style guard exists to opt out
  //     of), which fires a live MCP connection and real dolt operations;
  //   * with no CLI arguments it then exits 2 by its own design ("PRECONDITION
  //     FAILED ... pass --member <name>"), a non-zero exit that has nothing to
  //     do with whether the Phase-4 facade still resolves.
  // Probing one therefore manufactures an UNEXPLAINED classification out of
  // ordinary CLI-usage behaviour, so ANY edit to such a file -- including a
  // comment-only one, which is all it takes to enter the BASE..HEAD half of
  // the intersection -- would turn this gate red (apra-fleet-j918.5.3).
  // Excluded from the DYNAMIC probe on the same terms as bin/: the static
  // import-binding check in section (2) of
  // phase4-move-only-completeness.test.mjs still covers every set-A importer,
  // scripts/ included, without executing anything, so a genuine facade break
  // here is still caught.
  if (SCRIPT_ENTRYPOINT_RE.test(repoRelPath)) {
    return {
      file: repoRelPath,
      klass: 'SCRIPT_ENTRYPOINT_SKIP',
      detail: 'scripts/ entrypoints are operator-run CLI programs, not test files: running one under `node --test` executes its main() for real and/or exits non-zero on ordinary CLI-usage grounds; excluded from the dynamic probe, covered instead by the static import-binding check in section (2)',
    };
  }
  if (!existsAtBase(base, repoRelPath)) {
    return { file: repoRelPath, klass: 'NEW', detail: 'absent at BASE; added during Phase 4' };
  }
  const old = git(['show', `${base}:${repoRelPath}`], { maxBuffer: 64 * 1024 * 1024 });
  // Probe files are written beside the original so relative imports resolve
  // identically, but are dot-prefixed so they never match test/*.test.mjs.
  const dir = path.dirname(path.join(REPO, repoRelPath));
  const probe = path.join(dir, `.phase4probe-${path.basename(repoRelPath)}`);
  try {
    writeFileSync(probe, old);
    const { ok, output } = runTestFile(probe, timeoutMs);
    if (ok) return { file: repoRelPath, klass: 'INTACT', detail: 'pre-Phase-4 revision passes against the HEAD tree' };
    const facade = classifyFailure(output);
    if (facade.klass === 'FACADE_BREAK') {
      return { file: repoRelPath, klass: facade.klass, detail: facade.reason, output: output.slice(-4000) };
    }
    // Not a facade break: decide ANCHOR_DESYNC vs UNEXPLAINED by experiment,
    // not by matching more words in `output`.
    const { klass, reason } = corroborateAnchorDesync(repoRelPath, timeoutMs);
    return { file: repoRelPath, klass, detail: reason, output: output.slice(-4000) };
  } finally {
    rmSync(probe, { force: true });
  }
}

function main() {
  const base = discoverBase();
  const setA = discoverSetA(), setB = discoverSetB(), setC = discoverSetC();
  const intersection = discoverIntersection(base);
  const results = intersection.map((f) => probeFile(base, f));
  const breaks = results.filter((r) => r.klass === 'FACADE_BREAK' || r.klass === 'UNEXPLAINED');

  const summary = {
    base,
    counts: { setA: setA.length, setB: setB.length, setC: setC.length, intersection: intersection.length },
    results: results.map(({ output, ...r }) => r),
    gate: breaks.length === 0 ? 'PASS' : 'FAIL',
  };
  if (JSON_OUT) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`BASE (parent of first Phase-4 commit): ${base}`);
    console.log(`discovered: set A=${setA.length} importers, set B=${setB.length} mock-sprint flat, set C=${setC.length} mock-sprint slow`);
    console.log(`intersection with the Phase-4 diff: ${intersection.length} files\n`);
    for (const r of results) console.log(`  [${r.klass}] ${r.file}\n      ${r.detail}`);
    console.log(`\nGATE (class FACADE_BREAK must be empty): ${summary.gate}`);
    for (const b of breaks) console.log(`\n--- ${b.file} ---\n${b.output}`);
  }
  process.exitCode = breaks.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
