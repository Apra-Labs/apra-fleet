#!/usr/bin/env node
// Guard for apra-fleet-eft.25 (and its later extensions): the integ-test-
// playbook.md smoke-test sandbox (toy-repo clone under $HOME/toy-repo) must
// never end up wired to push to the real fleet-e2e-toy Dolt/git remote.
//
// apra-fleet-eft.18.6 RETARGET: apra-fleet-eft.18.5 replaced the old
// bootstrap-then-neutralize flow (clone real Dolt history, then patch
// sync.remote/Dolt-remote/git-origin back to a safe state afterward) with a
// structurally-isolated seed flow: BEFORE any `bd` command ever runs in the
// sandbox clone, both its git `origin` (a sandbox-local bare mirror,
// `$HOME/.apra-fleet-toy-origin.git`) and its Dolt `sync.remote` (a
// sandbox-local throwaway `file://` remote, `$HOME/.apra-fleet-toy-dolt-
// remote`) are wired to sandbox-local paths, then `bd init --from-jsonl`
// seeds the local DB fresh. There is no "commented out" / "absent" state to
// assert anymore -- sync.remote is ACTIVE from the start. So each check
// below now asserts the positive, structural invariant this new flow
// actually provides: every git/Dolt remote the sandbox clone references
// resolves to a path INSIDE the sandbox root (the parent directory of the
// toy-repo clone), never to the real, network-reachable fleet-e2e-toy
// identity or anywhere else outside the sandbox. All four checks from the
// original guard are retained (none deleted) -- only checks 1, 3 and 4
// change *what* "safe" means; check 2 (no outbound commits) keeps its
// original shape (see its own docstring below for why), but apra-fleet-
// eft.18.8's end-to-end verification (real `bd` CLI, not a hand-built
// fixture) found it is now ALWAYS non-zero on the very first successful
// `## Setup` run, so it no longer gates this guard's exit code -- see the
// "apra-fleet-eft.18.8 FINDING" paragraph below check 2 for the reproduced
// root cause.
//
//   1. sync.remote resolves inside the sandbox: `.beads/config.yaml`'s
//      active `sync.remote` value (if any) must resolve to a filesystem
//      path inside the sandbox root -- e.g. the sandbox-local throwaway
//      `$HOME/.apra-fleet-toy-dolt-remote` `file://` remote apra-fleet-
//      eft.18.5's seed step wires. FAILS if it resolves to the real
//      fleet-e2e-toy URL, or to any other path outside the sandbox root.
//   2. no outbound commits (informational only, apra-fleet-eft.18.8): 'git
//      rev-list --left-right --count HEAD...origin/main' in the sandbox
//      clone shows 0 commits ahead of origin/main. Under the pre-eft.18.5
//      bootstrap/neutralize flow this was a hazard check (an "ahead" count
//      meant something might have reached the real remote); under the new
//      flow `origin` is wired sandbox-local from the very start (see check
//      4), so an "ahead" count here no longer implies any real-remote
//      exposure. It is retained as a general sandbox-integrity sanity
//      check (an unexpected diff between the clone and its own
//      sandbox-local mirror is still worth surfacing), per apra-fleet-
//      eft.18.5's SAFETY INVARIANT that no check is dropped outright -- see
//      apra-fleet-eft.18.6/eft.18.7 for the full retarget rationale.
//
//      apra-fleet-eft.18.8 FINDING: `bd init --from-jsonl` itself commits
//      its own scaffolding (AGENTS.md, CLAUDE.md, .beads/hooks, the
//      just-wired `sync.remote` in `.beads/config.yaml`, ...) straight into
//      the sandbox clone -- and that commit is created AFTER `## Setup`
//      already re-pointed `origin` at the sandbox-local `$GIT_MIRROR`, so it
//      is never present there. Reproduced with the real `bd` CLI end-to-end
//      (not a hand-built fixture): this makes the sandbox clone exactly 1
//      commit ahead of `origin/main` on every single successful `## Setup`
//      run, unconditionally -- not an "unexpected" divergence at all, but
//      the expected, benign result of the documented flow. Deliberately NOT
//      fixed by pushing that commit to `$GIT_MIRROR` in `## Setup`: doing so
//      makes `.beads/config.yaml`'s `sync.remote` (already pointing at the
//      real, history-bearing `$DOLT_REMOTE` at that point) part of `origin`'s
//      history too, which then makes `## Reset`'s later plain `bd init
//      --from-jsonl --prefix gh-toy --non-interactive` (no `--remote`, no
//      `--discard-remote`) fail hard with "remote already has Dolt history"
//      -- trading one false positive for a real regression. So check 2 stays
//      exactly as implemented (never deleted, per the SAFETY INVARIANT
//      above) but is downgraded to informational-only in `main()` below;
//      checks 1/3/4 are the ones that actually assert the real-remote
//      isolation invariant this guard exists for.
//   3. Dolt-level remote resolves inside the sandbox (apra-fleet-eft.30):
//      'bd dolt remote list --json' -- every configured Dolt-level remote's
//      URL must resolve inside the sandbox root (see checkDoltRemoteAbsent
//      below, kept under its original name).
//   4. git origin resolves inside the sandbox (apra-fleet-eft.31): the
//      sandbox clone's OWN 'git remote get-url origin' must resolve inside
//      the sandbox root too (see checkGitOriginNotHazard below, kept under
//      its original name) -- closes the apra-fleet-eft.30/eft.35 escape
//      path where a later 'bd dolt' invocation auto-provisions a fresh
//      Dolt-level remote FROM this git origin as a side effect.
//
// "The sandbox root" is, by default, the parent directory of the repoPath
// argument (e.g. `$HOME` when invoked with `$HOME/toy-repo`, matching where
// apra-fleet-eft.18.5's `## Setup` wires `$GIT_MIRROR` and `$DOLT_REMOTE`
// as siblings of the toy-repo clone) -- it can be overridden with an
// explicit third CLI argument / second function argument where needed
// (e.g. by tests).
//
// Run as part of the integ-test-playbook.md ## Setup flow, after the seed
// step:
//   node scripts/check-sandbox-sync-remote.mjs "$HOME/toy-repo"
//
// Sandbox-only: this script only READS files and runs read-only git/bd
// commands (git rev-list, git remote get-url, bd dolt remote list) inside
// the given clone. It never writes to or pushes to any remote, real or
// otherwise.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execBdSync } from './lib/exec-bd.mjs';

// Substring identifying the real, shared fleet-e2e-toy Dolt remote that the
// sandbox must never actively sync to. Kept as one constant so both checks
// (and their tests) reference the same identity.
export const HAZARD_REMOTE = 'fleet-e2e-toy';

/**
 * Default sandbox root for a given toy-repo clone path: its parent
 * directory. Matches integ-test-playbook.md's `## Setup`, which wires
 * `$GIT_MIRROR` (`$HOME/.apra-fleet-toy-origin.git`) and `$DOLT_REMOTE`
 * (`$HOME/.apra-fleet-toy-dolt-remote`) as siblings of the `$HOME/toy-repo`
 * clone this script is invoked against.
 *
 * @param {string} repoPath
 * @returns {string}
 */
export function defaultSandboxPath(repoPath) {
  return path.dirname(repoPath);
}

/**
 * Converts a well-formed 'file://' URL string to a filesystem path via
 * node:url's fileURLToPath(), falling back to normalizing MSYS/git-bash
 * single-letter-segment drive forms ('file:///c/Users/...' ->
 * 'file:///C:/Users/...') and retrying, and finally falling back to the raw
 * remainder-after-'file://' string itself (matching this function's
 * pre-apra-fleet-xuo.9.1 behavior) when neither parse succeeds -- e.g. a
 * POSIX-style path ('file:///home/x/...') evaluated on a win32 host, where
 * fileURLToPath() requires an actual drive letter and would otherwise throw
 * for a case this function must keep resolving (relative to the current
 * drive, exactly as path.resolve() always has) rather than reject outright.
 *
 * @param {string} fileUrl a string starting with 'file://'
 * @returns {string}
 */
function fileUrlToCandidatePath(fileUrl) {
  try {
    return fileURLToPath(fileUrl);
  } catch {
    // fall through to the MSYS-normalization retry below
  }

  const rawRemainder = fileUrl.replace(/^file:\/\//, '');
  // MSYS/git-bash single-letter drive segment ('/c/Users/...' or
  // '/c'): normalize to a real drive path ('C:/Users/...') before retrying
  // fileURLToPath, which requires an actual 'C:'-style drive letter on
  // win32.
  const msys = /^\/([a-zA-Z])(\/.*)?$/.exec(rawRemainder);
  if (msys) {
    const normalizedUrl = `file:///${msys[1].toUpperCase()}:${msys[2] ?? '/'}`;
    try {
      return fileURLToPath(normalizedUrl);
    } catch {
      // fall through to the raw-remainder fallback below
    }
  }

  return rawRemainder;
}

/**
 * Does `remoteValue` (a git/Dolt remote URL or filesystem path) resolve to
 * somewhere INSIDE `sandboxPath`?
 *
 * Handles `file://` URLs and plain filesystem paths by resolving them
 * (relative to the current working directory, same as git/Dolt would) and
 * comparing against the resolved sandbox root via `path.relative` -- never
 * a raw string-prefix check, so a sandbox root of `/tmp/sbx` does not
 * falsely accept a sibling like `/tmp/sbx-evil`. Any other URL scheme
 * (`https://`, `git+https://`, `ssh://`, etc. -- including the real
 * fleet-e2e-toy identity) is never a sandbox-local filesystem path, so it
 * always resolves to "outside" (fail-closed).
 *
 * `file://` URLs are converted to filesystem paths via
 * fileUrlToCandidatePath() (node:url's fileURLToPath(), with a fallback for
 * MSYS/git-bash drive-letter forms -- apra-fleet-xuo.9.1) rather than a raw
 * regex-strip + path.resolve(), which mis-resolved well-formed Windows
 * drive-letter file:// URLs (e.g. 'file:///C:/Users/...' resolved to
 * 'C:\C:\Users\...', always outside any real sandbox path, a false-FAIL of
 * this safety guard -- see apra-fleet-xuo.9's bug report).
 *
 * @param {string} remoteValue
 * @param {string} sandboxPath
 * @returns {boolean}
 */
export function resolvesInsideSandbox(remoteValue, sandboxPath) {
  if (!remoteValue) return false;

  // Strip any '+file://' compound scheme (e.g. 'git+file://') down to 'file://'
  // so Dolt origin URLs like git+file:///.../.apra-fleet-toy-origin.git pointing
  // inside the sandbox are recognized as internal instead of caught by the generic
  // external-scheme branch.
  const normalizedValue = remoteValue.replace(/^[a-z][a-z0-9+.-]*\+file:\/\//i, 'file://');

  const fileUrlMatch = /^file:\/\/(.*)$/.exec(normalizedValue);
  let candidatePath;
  if (fileUrlMatch) {
    candidatePath = fileUrlToCandidatePath(normalizedValue);
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalizedValue)) {
    // Some other URL scheme (https, git+https, ssh, ...) -- never a
    // sandbox-local filesystem path, e.g. the real
    // git+https://github.com/Apra-Labs/fleet-e2e-toy remote.
    return false;
  } else {
    candidatePath = normalizedValue;
  }

  const resolvedCandidate = path.resolve(candidatePath);
  const resolvedSandbox = path.resolve(sandboxPath);
  if (resolvedCandidate === resolvedSandbox) return true;
  const rel = path.relative(resolvedSandbox, resolvedCandidate);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Extract the active (non-commented) `sync.remote` value out of `.beads/
 * config.yaml` text, or `null` if there is none. A line is "active" if,
 * ignoring leading whitespace, it does not start with '#'.
 *
 * @param {string} configText
 * @returns {string | null}
 */
export function parseActiveSyncRemoteValue(configText) {
  for (const line of configText.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const m = /remote:\s*"?([^"#]+?)"?\s*$/.exec(line);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * Does `configText` (the contents of a .beads/config.yaml) contain an
 * ACTIVE (non-commented) line referencing the hazard remote? Retained as a
 * defense-in-depth helper alongside the resolves-inside-sandbox check below
 * -- the real fleet-e2e-toy URL never resolves inside any sandbox path
 * either way, but this gives a more specific FAIL message when it is the
 * hazard identity by name rather than merely "some other external path".
 *
 * @param {string} configText
 * @returns {boolean}
 */
export function isSyncRemoteActive(configText) {
  return configText.split('\n').some((line) => {
    if (!line.includes(HAZARD_REMOTE)) return false;
    return !/^\s*#/.test(line);
  });
}

/**
 * Check that the sandbox clone's `.beads/config.yaml` has no active
 * `sync.remote` referencing the hazard remote, AND that whatever active
 * `sync.remote` it does have (per apra-fleet-eft.18.5's seed step, the
 * sandbox-local throwaway `file://` Dolt remote) resolves to a path INSIDE
 * the sandbox root. No active `sync.remote` at all (e.g. a fresh clone
 * before `bd init` has run) is vacuously safe -- there is nothing wired
 * yet.
 *
 * @param {string} configPath absolute path to .beads/config.yaml
 * @param {string} [sandboxPath] sandbox root; defaults to the grandparent
 *   of configPath (i.e. the parent of the repo the config.yaml lives in).
 * @returns {{ok: boolean, message: string}}
 */
export function checkSyncRemoteInert(configPath, sandboxPath = defaultSandboxPath(path.dirname(configPath))) {
  if (!fs.existsSync(configPath)) {
    return { ok: true, message: `OK: no config.yaml at '${configPath}' -- nothing wired yet.` };
  }
  const text = fs.readFileSync(configPath, 'utf-8');

  if (isSyncRemoteActive(text)) {
    return {
      ok: false,
      message: `FAIL: active sync.remote in '${configPath}' points at ${HAZARD_REMOTE} -- the sandbox seed step must wire sync.remote to a sandbox-local throwaway remote before any bd command runs (see integ-test-playbook.md ## Setup).`,
    };
  }

  const value = parseActiveSyncRemoteValue(text);
  if (value === null) {
    return { ok: true, message: `OK: no active sync.remote in '${configPath}' -- nothing wired yet.` };
  }
  if (!resolvesInsideSandbox(value, sandboxPath)) {
    return {
      ok: false,
      message: `FAIL: active sync.remote in '${configPath}' is '${value}', which resolves outside the sandbox path '${sandboxPath}' -- it must resolve to a sandbox-local throwaway remote.`,
    };
  }
  return {
    ok: true,
    message: `OK: active sync.remote in '${configPath}' ('${value}') resolves inside the sandbox path '${sandboxPath}'.`,
  };
}

/**
 * Parse the two counts out of `git rev-list --left-right --count
 * HEAD...origin/main` output ("<left>\t<right>" or "<left> <right>").
 *
 * @param {string} output
 * @returns {{left: number, right: number}}
 */
export function parseLeftRightCount(output) {
  const parts = output.trim().split(/\s+/).map(Number);
  if (parts.length !== 2 || parts.some((n) => Number.isNaN(n))) {
    throw new Error(`Unexpected 'git rev-list --left-right --count' output: '${output}'`);
  }
  return { left: parts[0], right: parts[1] };
}

/**
 * Check that the sandbox clone has zero outbound commits (nothing pushed to
 * origin/main from this sandbox session). Read-only: runs 'git rev-list',
 * never 'git push' or any other mutating command.
 *
 * Kept unchanged under apra-fleet-eft.18.6's retarget -- see the file-level
 * comment above (check 2) for why this one keeps its original "0 commits
 * ahead" shape rather than an inside-the-sandbox-path assertion: `origin`
 * itself is already covered by checkGitOriginNotHazard below, and being
 * ahead of a sandbox-local origin/main is still worth surfacing as a
 * general integrity signal even though it is no longer a real-remote
 * hazard.
 *
 * apra-fleet-eft.18.8: this function's own ok/message contract is UNCHANGED
 * (still `ok: false` with an "ahead" message once the clone diverges) -- only
 * `main()` below stopped treating a `false` result here as fatal, because
 * `bd init --from-jsonl` in `## Setup` reproducibly leaves the clone exactly
 * 1 commit ahead of `origin/main` on every successful run (see the file-level
 * "apra-fleet-eft.18.8 FINDING" comment above). Callers that need the raw
 * signal (e.g. this file's own tests) still get it from this function
 * directly.
 *
 * @param {string} repoPath
 * @param {{execFileSync: typeof execFileSync}} [deps] injectable for tests
 * @returns {{ok: boolean, message: string}}
 */
export function checkNoOutboundCommits(repoPath, deps = {}) {
  const run = deps.execFileSync ?? execFileSync;
  let output;
  try {
    output = run('git', ['rev-list', '--left-right', '--count', 'HEAD...origin/main'], {
      cwd: repoPath,
      encoding: 'utf-8',
    });
  } catch (err) {
    return {
      ok: false,
      message: `FAIL: could not run 'git rev-list --left-right --count HEAD...origin/main' in '${repoPath}': ${err.message}`,
    };
  }
  const { left, right } = parseLeftRightCount(output);
  if (left !== 0) {
    return {
      ok: false,
      message: `FAIL: sandbox clone at '${repoPath}' is ${left} commit(s) ahead of origin/main -- unexpected divergence from the sandbox-local mirror.`,
    };
  }
  return { ok: true, message: `OK: sandbox clone at '${repoPath}' has 0 commits ahead of origin/main (left=${left}, right=${right}).` };
}

/**
 * Parse the JSON array 'bd dolt remote list --json' prints (one entry per
 * configured Dolt remote, each with at least {name, url}).
 *
 * @param {string} output
 * @returns {Array<{name: string, url?: string}>}
 */
export function parseDoltRemoteList(output) {
  let list;
  try {
    list = JSON.parse(output);
  } catch (err) {
    throw new Error(`Unexpected 'bd dolt remote list --json' output: '${output}'`);
  }
  // bd prints the literal JSON `null` (not `[]`) when no Dolt remotes are
  // configured -- treat that as "no remotes" rather than a parse error.
  if (list === null) {
    return [];
  }
  if (!Array.isArray(list)) {
    throw new Error(`Unexpected 'bd dolt remote list --json' output (not an array): '${output}'`);
  }
  return list;
}

// Known database directory layouts produced by `bd init`. apra-fleet-2cc.1:
// .dolt/ and db/ are legacy; embeddeddolt is the current layout from `bd init`.
// If bd introduces new layouts in the future, add them here to prevent silent
// regression when checkDoltRemoteAbsent optimizes away the `bd dolt remote list`
// call.
const BEADS_DATABASE_DIRS = ['.dolt', 'db', 'embeddeddolt'];

/**
 * Check that every Dolt-level remote (independent of the bd-level
 * sync.remote YAML key checked by checkSyncRemoteInert above) resolves to a
 * path INSIDE the sandbox root -- apra-fleet-eft.18.5's seed step wires
 * `sync.remote` (and therefore Dolt's own remote) to the sandbox-local
 * throwaway `$DOLT_REMOTE` `file://` remote before any bd command runs, so
 * this should always hold from the very first `bd init`. apra-fleet-eft.30:
 * 'bd bootstrap --yes' (the retired flow) used to wire this Dolt-level
 * remote separately from the YAML key, so this check stays independent of
 * checkSyncRemoteInert rather than trusting it alone. Read-only: runs 'bd
 * dolt remote list', never 'bd dolt remote add/remove' or any push/pull.
 *
 * @param {string} repoPath
 * @param {string} [sandboxPath] sandbox root; defaults to the parent of repoPath.
 * @param {{execFileSync: typeof execFileSync}} [deps] injectable for tests
 * @returns {{ok: boolean, message: string}}
 */
export function checkDoltRemoteAbsent(repoPath, sandboxPath = defaultSandboxPath(repoPath), deps = {}) {
  // apra-fleet-2cc.1: routed through the shared execBdSync helper, which
  // resolves on Windows via the real `.../bin/bd.js` script the npm `bd`
  // shim wraps (invoked directly via `process.execPath`, no shell) rather
  // than `{ shell: true }` -- see scripts/lib/exec-bd.mjs's module doc for
  // why (a real `{ shell: true }` shell-metacharacter-injection risk was
  // found and closed here). Every arg on this call is a static literal
  // (never caller-controlled), so this call site was never exposed either
  // way, but it shares the one safe helper rather than a second bespoke
  // invocation. `deps.execFileSync` (test injection) is forwarded through
  // unchanged -- existing tests that stub it with a fake
  // `(cmd, args, opts) => output` function are unaffected.

  // Quick check: if there is no .beads directory at all, or no actual Dolt database
  // within it (no known database directory), skip invoking bd entirely.
  // A beads DB that hasn't been initialized yet has no database files, so there's
  // nothing for bd to query. Return the vacuously-safe result without trying to run bd.
  // (Skip this optimization when deps.execFileSync is provided, to allow tests to
  // inject custom executors for paths that don't actually exist on disk.)
  if (!deps.execFileSync) {
    const beadsDir = path.join(repoPath, '.beads');
    if (!fs.existsSync(beadsDir)) {
      return {
        ok: true,
        message: `OK: 'bd dolt remote list' unavailable at '${repoPath}' (no .beads directory) -- nothing wired yet.`,
      };
    }
    // Check for any known database directory layout.
    const hasDatabase = BEADS_DATABASE_DIRS.some((dir) => fs.existsSync(path.join(beadsDir, dir)));
    if (!hasDatabase) {
      return {
        ok: true,
        message: `OK: 'bd dolt remote list' unavailable at '${repoPath}' (no Dolt database initialized) -- nothing wired yet.`,
      };
    }
  }

  let output;
  try {
    output = execBdSync(['dolt', 'remote', 'list', '--json'], {
      cwd: repoPath,
      encoding: 'utf-8',
    }, deps.execFileSync);
  } catch (err) {
    // No beads DB / no bd binary reachable in this clone (or the command
    // otherwise fails outright): there is nothing to check -- vacuously
    // safe, mirroring checkSyncRemoteInert's no-config.yaml case above.
    return {
      ok: true,
      message: `OK: 'bd dolt remote list' unavailable at '${repoPath}' (${String(err.message).split('\n')[0]}) -- nothing wired yet.`,
    };
  }

  let remotes;
  try {
    remotes = parseDoltRemoteList(output);
  } catch (err) {
    return {
      ok: false,
      message: `FAIL: could not parse 'bd dolt remote list --json' output at '${repoPath}': ${err.message}`,
    };
  }

  const badRemotes = remotes.filter((r) => {
    const url = r.url ?? '';
    if (!url) {
      // No URL to resolve a path from -- fall back to a name-based hazard
      // check so a remote literally named after the hazard identity still
      // fails closed.
      return (r.name ?? '').includes(HAZARD_REMOTE);
    }
    return !resolvesInsideSandbox(url, sandboxPath);
  });
  if (badRemotes.length > 0) {
    const names = badRemotes.map((r) => r.name).join(', ');
    const hazardNamed = badRemotes.some((r) => (r.url ?? '').includes(HAZARD_REMOTE) || (r.name ?? '').includes(HAZARD_REMOTE));
    return {
      ok: false,
      message: hazardNamed
        ? `FAIL: Dolt-level remote(s) [${names}] in '${repoPath}' point at ${HAZARD_REMOTE} -- must resolve to a sandbox-local throwaway remote instead.`
        : `FAIL: Dolt-level remote(s) [${names}] in '${repoPath}' resolve outside the sandbox path '${sandboxPath}'.`,
    };
  }
  return { ok: true, message: `OK: Dolt-level remotes in '${repoPath}' all resolve inside the sandbox path '${sandboxPath}' (or none configured).` };
}

/**
 * Check that the sandbox clone's OWN git 'origin' remote resolves to a path
 * INSIDE the sandbox root. apra-fleet-eft.18.5's seed step points `origin`
 * at a sandbox-local bare mirror (`$GIT_MIRROR`) BEFORE any `bd` command
 * ever runs in the clone, so this should hold from the very start.
 * apra-fleet-eft.31/eft.30/eft.35: this closes the escape path where a
 * LATER 'bd dolt' invocation auto-provisions a fresh Dolt-level remote FROM
 * this git origin as a side effect of needing one -- if `origin` itself
 * were ever the hazard remote, such an auto-provision would re-wire
 * straight back to it even if checkDoltRemoteAbsent currently reports
 * clean.
 *
 * Read-only: runs 'git remote get-url origin', never 'git remote add/set-url'
 * or any push/pull/fetch.
 *
 * @param {string} repoPath
 * @param {string} [sandboxPath] sandbox root; defaults to the parent of repoPath.
 * @param {{execFileSync: typeof execFileSync}} [deps] injectable for tests
 * @returns {{ok: boolean, message: string}}
 */
export function checkGitOriginNotHazard(repoPath, sandboxPath = defaultSandboxPath(repoPath), deps = {}) {
  const run = deps.execFileSync ?? execFileSync;
  let output;
  try {
    output = run('git', ['remote', 'get-url', 'origin'], {
      cwd: repoPath,
      encoding: 'utf-8',
    });
  } catch (err) {
    // No git remote named 'origin' (or no git repo at all here) -- there is
    // nothing for a future 'bd dolt' invocation to derive a hazard remote
    // from, so this is vacuously safe, mirroring the no-config.yaml case in
    // checkSyncRemoteInert above.
    return {
      ok: true,
      message: `OK: 'git remote get-url origin' unavailable at '${repoPath}' (${String(err.message).split('\n')[0]}) -- nothing for a future Dolt remote re-wire to derive from.`,
    };
  }
  const url = output.trim();
  if (!resolvesInsideSandbox(url, sandboxPath)) {
    const hazardNamed = url.includes(HAZARD_REMOTE);
    return {
      ok: false,
      message: hazardNamed
        ? `FAIL: git 'origin' remote in '${repoPath}' is '${url}' -- points at ${HAZARD_REMOTE}, so any future 'bd dolt' invocation that auto-provisions a Dolt remote from git origin would re-wire straight back to the real remote even if the checks above currently report clean.`
        : `FAIL: git 'origin' remote in '${repoPath}' is '${url}', which resolves outside the sandbox path '${sandboxPath}' -- it must resolve to a sandbox-local mirror instead.`,
    };
  }
  return { ok: true, message: `OK: git 'origin' remote in '${repoPath}' ('${url}') resolves inside the sandbox path '${sandboxPath}'.` };
}

function main() {
  const repoPath = process.argv[2] ?? path.join(process.env.HOME ?? '', 'toy-repo');
  if (!repoPath) {
    console.error('[check-sandbox-sync-remote] Usage: node scripts/check-sandbox-sync-remote.mjs <toy-repo-path> [sandbox-root-path]');
    process.exit(2);
  }
  if (!fs.existsSync(repoPath)) {
    console.error(`[check-sandbox-sync-remote] repo path does not exist: '${repoPath}'`);
    process.exit(2);
  }
  const sandboxPath = process.argv[3] ?? defaultSandboxPath(repoPath);
  console.log(`[check-sandbox-sync-remote] using sandbox root '${sandboxPath}' for repo '${repoPath}'.`);

  const configPath = path.join(repoPath, '.beads', 'config.yaml');
  const syncCheck = checkSyncRemoteInert(configPath, sandboxPath);
  console.log(`[check-sandbox-sync-remote] ${syncCheck.message}`);

  // apra-fleet-eft.18.8: informational only -- see checkNoOutboundCommits'
  // own docstring and the file-level "apra-fleet-eft.18.8 FINDING" comment
  // above for why this one no longer gates the exit code below.
  const outboundCheck = checkNoOutboundCommits(repoPath);
  console.log(`[check-sandbox-sync-remote] ${outboundCheck.message}${outboundCheck.ok ? '' : ' (informational only -- does not fail this guard)'}`);

  const doltRemoteCheck = checkDoltRemoteAbsent(repoPath, sandboxPath);
  console.log(`[check-sandbox-sync-remote] ${doltRemoteCheck.message}`);

  const gitOriginCheck = checkGitOriginNotHazard(repoPath, sandboxPath);
  console.log(`[check-sandbox-sync-remote] ${gitOriginCheck.message}`);

  if (!syncCheck.ok || !doltRemoteCheck.ok || !gitOriginCheck.ok) {
    process.exit(1);
  }
  console.log('[check-sandbox-sync-remote] OK: sandbox is isolated from the real fleet-e2e-toy Dolt remote.');
}

// Only run when invoked directly (not when imported for tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
