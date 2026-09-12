#!/usr/bin/env node
// Phase-4 move-only probe.
//
// Proves the Phase-4 extraction was move-only WITHOUT reading intent out of
// commit messages. For every file in (Phase-4 diff) INTERSECT (set A union B
// union C), take that file's PRE-Phase-4 revision and run it, unmodified,
// against the CURRENT HEAD tree.
//
//   - file absent at BASE      -> NEW (added by Phase 4; cannot have been broken by it)
//   - old revision PASSES      -> INTACT (Phase 4 did not force the edit; the old
//                                 assertions still hold against the new facade)
//   - old revision FAILS with a module-resolution / missing-export error
//                              -> FACADE_BREAK (the gate's failure condition)
//   - old revision FAILS otherwise
//                              -> ANCHOR_DESYNC (test anchored on runner.js raw
//                                 source text, line position, phase sequence or
//                                 symbol census; allowed, and the current revision
//                                 of the file must pass)
//
// The only judgement left is FACADE_BREAK vs ANCHOR_DESYNC, and that is decided
// by the error the probe emits, not by a human reading a diff hunk.
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
 * ANCHOR_DESYNC is not a catch-all default. To be admitted, the failure must
 * positively name runner.js (or a Phase-4 destination module) -- i.e. the test
 * failed BECAUSE it reads runner.js as raw source text, line position, phase
 * sequence or symbol census, which is exactly what a move legitimately shifts.
 * A failure that mentions neither is UNEXPLAINED and fails the gate, so an
 * unrelated real regression cannot hide behind the anchor class.
 */
const ANCHOR_CORROBORATION = /runner\.js|fleet-sprint\/phases\/|sprint-state\.mjs/;

export function classifyFailure(output) {
  const hit = FACADE_BREAK_PATTERNS.find((re) => re.test(output));
  if (hit) return { klass: 'FACADE_BREAK', reason: String(hit) };
  if (ANCHOR_CORROBORATION.test(output)) {
    return { klass: 'ANCHOR_DESYNC', reason: 'assertion names runner.js / a Phase-4 destination module as its anchor; no module-resolution or missing-export error' };
  }
  return { klass: 'UNEXPLAINED', reason: 'failed without a module-resolution error AND without naming runner.js or a Phase-4 destination -- not admissible as an anchor desync' };
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

export function probeFile(base, repoRelPath) {
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
    const { ok, output } = runTestFile(probe);
    if (ok) return { file: repoRelPath, klass: 'INTACT', detail: 'pre-Phase-4 revision passes against the HEAD tree' };
    const { klass, reason } = classifyFailure(output);
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
