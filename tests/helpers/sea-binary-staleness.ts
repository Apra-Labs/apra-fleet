// apra-fleet-v6t7.17.1: staleness detection for the packaged SEA binary
// (dist/apra-fleet-installer-<os>-<arch>[.exe]) exercised by
// tests/sea-http-verify.test.ts's "SEA binary smoke" suite.
//
// Root cause this fixes: that suite previously gated only on
// it.skipIf(!binaryExists) -- file EXISTENCE, not freshness. A binary built
// before a change to any SEA-relevant input (the esbuild entry graph under
// src/, the console route wiring under src/console/, the packaged UI assets
// under packages/apra-fleet-shell-ui/, or the SEA manifest generator itself,
// scripts/gen-sea-config.mjs / scripts/build-sea.mjs) still "exists", so the
// suite ran against it and failed with a bare functional-looking assertion
// (e.g. "expected 404 to be 200" on GET /ui) -- indistinguishable from a
// real regression. `npm run build:binary` fixed it immediately.
//
// This module is split into a PURE predicate (evaluateSeaBinaryStaleness)
// that takes already-resolved inputs and makes the stale/fresh/unknown call
// with no I/O at all, and an IMPURE gatherer (resolveSeaBinaryStaleness)
// that shells out to `git` and reads real file mtimes to build those inputs
// from an actual on-disk repo + binary. tests/sea-binary-staleness.test.ts
// (apra-fleet-v6t7.17.2) drives the pure predicate directly with injected
// inputs, so it needs no real binary build.
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Tracked (git-visible) paths whose content feeds the SEA binary build.
 * Relative to the repo root. Deliberately does NOT include
 * packages/apra-fleet-shell-ui/dist -- that tree is gitignored (built UI
 * assets), so `git diff`/`git status` can never see a change there; its
 * freshness is instead checked via mtime in resolveSeaBinaryStaleness().
 */
export const SEA_RELEVANT_GIT_PATHS = [
  'scripts/gen-sea-config.mjs',
  'scripts/build-sea.mjs',
  'packages/apra-fleet-shell-ui/src',
  'packages/apra-fleet-shell-ui/package.json',
  'src',
];

/** The gitignored built-UI-asset proxy file checked via mtime (see header). */
export const SEA_UI_DIST_MTIME_PROXY = join('packages', 'apra-fleet-shell-ui', 'dist', 'index.html');

const HASH_RE = /\bv?[\d]+\.[\d]+\.[\d]+_([0-9a-f]{6,40})\b/;

/**
 * Extracts the short git hash `build-sea.mjs` bakes into BUILD_VERSION
 * (e.g. "v0.4.3_6ef5d6" -> "6ef5d6") from a binary's `--version` output.
 * Returns null when no such suffix is present (e.g. a dev/npm build with no
 * git info at build time -- see src/version.ts's own hash-less fallback).
 */
export function parseBuildHash(versionOutput: string): string | null {
  const m = HASH_RE.exec(versionOutput);
  return m ? m[1] : null;
}

export interface SeaStalenessInput {
  /** The short git hash parsed from the binary's own --version output, or null if it could not be parsed at all. */
  buildHash: string | null;
  /**
   * Whether buildHash resolves to a real, locally-known commit (e.g. via
   * `git cat-file -e <hash>^{commit}`). Ignored when buildHash is null.
   * false covers "hash string present but not in this repo's history" (a
   * shallow clone, a rebased/rewritten history, or a hash typo) -- treated
   * identically to a missing hash: we cannot safely diff against it.
   */
  hashResolvable: boolean;
  /**
   * SEA-relevant paths (tracked git changes since buildHash, PLUS any
   * currently-uncommitted changes to those same paths, PLUS the UI-dist
   * mtime proxy when it is newer than the binary) that differ from what the
   * binary was built against. Empty means "nothing relevant changed" --
   * fresh. Non-empty means stale; the list is folded into the failure
   * message so a human can see WHY without re-deriving it.
   */
  changedRelevantFiles: string[];
}

export interface SeaStalenessVerdict {
  stale: boolean;
  /** true only for the "cannot tell" case (unresolvable hash); implies stale. */
  unknown: boolean;
  /** Empty when fresh; otherwise contains both 'stale' and 'npm run build:binary' verbatim, per this lane's fail-loud contract. */
  message: string;
}

/**
 * Pure staleness predicate -- no I/O, fully exercised by injected inputs.
 * See tests/sea-binary-staleness.test.ts for the stale / fresh / unresolvable
 * cases this must satisfy.
 */
export function evaluateSeaBinaryStaleness(input: SeaStalenessInput): SeaStalenessVerdict {
  if (input.buildHash === null || !input.hashResolvable) {
    const hashDesc = input.buildHash === null ? '<no hash embedded>' : input.buildHash;
    return {
      stale: true,
      unknown: true,
      message:
        `SEA binary smoke: dist binary staleness is stale-unknown -- its build hash (${hashDesc}) ` +
        'does not resolve to a commit in this repository (shallow clone, rewritten history, or a ' +
        'dev/npm build with no git info at build time), so freshness cannot be verified against HEAD. ' +
        'Treating as stale. Run "npm run build:binary" to get a binary this suite can positively verify.',
    };
  }

  if (input.changedRelevantFiles.length > 0) {
    return {
      stale: true,
      unknown: false,
      message:
        `SEA binary smoke: dist binary is stale -- built at ${input.buildHash}, but SEA-relevant ` +
        `input(s) changed since then: ${input.changedRelevantFiles.join(', ')}. Run "npm run build:binary" ` +
        'and re-run this suite.',
    };
  }

  return { stale: false, unknown: false, message: '' };
}

/**
 * Impure gatherer: runs the real binary's `--version`, checks the parsed
 * hash against this repo's git history, diffs SEA-relevant tracked paths
 * (committed since that hash, plus anything currently uncommitted), and
 * folds in an mtime check against the gitignored UI-dist proxy file --
 * then hands all of that to the pure predicate above.
 *
 * Never throws: any git/spawn failure degrades to the same "stale-unknown"
 * verdict evaluateSeaBinaryStaleness() already produces for an unresolvable
 * hash, since none of those failure modes can be told apart from "we simply
 * cannot verify freshness" from the caller's point of view.
 */
export function resolveSeaBinaryStaleness(opts: { binaryPath: string; root: string }): SeaStalenessVerdict {
  const { binaryPath, root } = opts;

  let versionOutput = '';
  try {
    versionOutput = execFileSync(binaryPath, ['--version'], { cwd: root, encoding: 'utf-8', timeout: 10_000 });
  } catch {
    return evaluateSeaBinaryStaleness({ buildHash: null, hashResolvable: false, changedRelevantFiles: [] });
  }

  const buildHash = parseBuildHash(versionOutput);
  if (buildHash === null) {
    return evaluateSeaBinaryStaleness({ buildHash: null, hashResolvable: false, changedRelevantFiles: [] });
  }

  let hashResolvable = false;
  try {
    execFileSync('git', ['cat-file', '-e', `${buildHash}^{commit}`], { cwd: root, encoding: 'utf-8' });
    hashResolvable = true;
  } catch {
    hashResolvable = false;
  }

  if (!hashResolvable) {
    return evaluateSeaBinaryStaleness({ buildHash, hashResolvable: false, changedRelevantFiles: [] });
  }

  const changedRelevantFiles: string[] = [];
  try {
    const committed = execFileSync(
      'git',
      ['diff', '--name-only', buildHash, 'HEAD', '--', ...SEA_RELEVANT_GIT_PATHS],
      { cwd: root, encoding: 'utf-8' },
    )
      .split(/\r?\n/)
      .filter(Boolean);
    changedRelevantFiles.push(...committed);
  } catch {
    // A diff failure with an already-resolvable hash is unexpected, but
    // fail safe (treat as no committed changes found) rather than throw --
    // the uncommitted-changes check and the mtime proxy below still run.
  }

  try {
    const uncommitted = execFileSync('git', ['status', '--porcelain', '--', ...SEA_RELEVANT_GIT_PATHS], {
      cwd: root,
      encoding: 'utf-8',
    })
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.slice(3).trim());
    changedRelevantFiles.push(...uncommitted);
  } catch {
    // best-effort, see above
  }

  try {
    const uiDistProxy = join(root, SEA_UI_DIST_MTIME_PROXY);
    if (existsSync(uiDistProxy) && existsSync(binaryPath)) {
      const uiMtime = statSync(uiDistProxy).mtimeMs;
      const binaryMtime = statSync(binaryPath).mtimeMs;
      if (uiMtime > binaryMtime) {
        changedRelevantFiles.push(`${SEA_UI_DIST_MTIME_PROXY} (rebuilt after the binary was built)`);
      }
    }
  } catch {
    // best-effort mtime probe, see above
  }

  return evaluateSeaBinaryStaleness({
    buildHash,
    hashResolvable: true,
    changedRelevantFiles: Array.from(new Set(changedRelevantFiles)),
  });
}
