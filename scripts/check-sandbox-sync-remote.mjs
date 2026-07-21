#!/usr/bin/env node
// Guard for apra-fleet-eft.25: the integ-test-playbook.md smoke-test sandbox
// (toy-repo clone under $HOME/toy-repo) must never end up wired to push to
// the real fleet-e2e-toy Dolt remote. This script asserts the eft.25.1
// remedy actually holds, in two parts:
//
//   1. sync.remote inert: no ACTIVE (uncommented) line in the sandbox
//      clone's .beads/config.yaml references the real
//      git+https://github.com/Apra-Labs/fleet-e2e-toy remote. This FAILS
//      right after a bare 'bd bootstrap --yes' (which re-activates
//      sync.remote -- the eft.25 bug) and PASSES once the eft.25.1
//      neutralize step (see integ-test-playbook.md ## Setup) has run.
//   2. no outbound commits: 'git rev-list --left-right --count
//      HEAD...origin/main' in the sandbox clone shows 0 commits ahead of
//      origin/main -- i.e. nothing has actually been pushed to the real
//      remote from this sandbox session.
//   3. Dolt-level remote absent (apra-fleet-eft.30): 'bd dolt remote list
//      --json' carries no remote pointing at the hazard identity (see
//      checkDoltRemoteAbsent below).
//   4. git origin not itself the hazard (apra-fleet-eft.31): the sandbox
//      clone's OWN 'git remote get-url origin' does not point at the hazard
//      remote either (see checkGitOriginNotHazard below) -- checks 1-3 can
//      all report clean at snapshot time yet a LATER 'bd dolt' invocation
//      still auto-provisions a fresh Dolt-level remote FROM this git origin
//      (observed live, C4/C5: "Configured Dolt remote origin from git
//      origin." followed by a live push attempt), re-arming exactly what
//      check 3 just found absent.
//
// Run as part of the integ-test-playbook.md ## Setup flow, immediately
// after the neutralize step:
//   node scripts/check-sandbox-sync-remote.mjs "$HOME/toy-repo"
//
// Sandbox-only: this script only READS files and runs read-only git/bd
// commands (git rev-list, git remote get-url, bd dolt remote list) inside
// the given clone. It never writes to or pushes to any remote, real or
// otherwise.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Substring identifying the real, shared fleet-e2e-toy Dolt remote that the
// sandbox must never actively sync to. Kept as one constant so both checks
// (and their tests) reference the same identity.
export const HAZARD_REMOTE = 'fleet-e2e-toy';

// apra-fleet-eft.30: the eft.25.1 neutralize step only patches the bd-level
// sync.remote YAML key -- 'bd bootstrap --yes' ALSO wires Dolt's OWN
// internal remote (independent of that YAML key) to the real fleet-e2e-toy
// remote, so a per-cycle D-push can still target it even when the YAML
// check above reports OK. This third check asserts Dolt's own remote list
// (via 'bd dolt remote list --json') carries no remote pointing at
// HAZARD_REMOTE.

/**
 * Does `configText` (the contents of a .beads/config.yaml) contain an
 * ACTIVE (non-commented) line referencing the hazard remote?
 *
 * A line is "active" if, ignoring leading whitespace, it does not start
 * with '#'. This intentionally mirrors the eft.25.1 neutralize step's own
 * sed pattern (`/^[[:space:]]*#/!s/^/# /`) so the check and the remedy agree
 * on what "commented out" means.
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
 * Check that the sandbox clone's .beads/config.yaml has no active
 * sync.remote pointing at the hazard remote.
 *
 * @param {string} configPath absolute path to .beads/config.yaml
 * @returns {{ok: boolean, message: string}}
 */
export function checkSyncRemoteInert(configPath) {
  if (!fs.existsSync(configPath)) {
    // No config.yaml at all -- there is nothing to be active, so this is
    // vacuously safe (e.g. a clone that never ran bd bootstrap).
    return { ok: true, message: `OK: no config.yaml at '${configPath}' -- nothing to neutralize.` };
  }
  const text = fs.readFileSync(configPath, 'utf-8');
  if (isSyncRemoteActive(text)) {
    return {
      ok: false,
      message: `FAIL: active sync.remote in '${configPath}' still points at ${HAZARD_REMOTE} -- run the eft.25.1 neutralize step before any auto-sprint run.`,
    };
  }
  return { ok: true, message: `OK: sync.remote in '${configPath}' is inert (no active reference to ${HAZARD_REMOTE}).` };
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
      message: `FAIL: sandbox clone at '${repoPath}' is ${left} commit(s) ahead of origin/main -- outbound commits may have reached the real remote.`,
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
  if (!Array.isArray(list)) {
    throw new Error(`Unexpected 'bd dolt remote list --json' output (not an array): '${output}'`);
  }
  return list;
}

/**
 * Check that Dolt's OWN internal remote list (independent of the bd-level
 * sync.remote YAML key checked by checkSyncRemoteInert above) contains no
 * remote pointing at the hazard remote. apra-fleet-eft.30: 'bd bootstrap
 * --yes' wires this Dolt-level remote separately from the YAML key, so the
 * YAML check alone can report OK while a per-cycle D-push still targets the
 * real fleet-e2e-toy remote. Read-only: runs 'bd dolt remote list', never
 * 'bd dolt remote add/remove' or any push/pull.
 *
 * @param {string} repoPath
 * @param {{execFileSync: typeof execFileSync}} [deps] injectable for tests
 * @returns {{ok: boolean, message: string}}
 */
export function checkDoltRemoteAbsent(repoPath, deps = {}) {
  const run = deps.execFileSync ?? execFileSync;
  let output;
  try {
    output = run('bd', ['dolt', 'remote', 'list', '--json'], {
      cwd: repoPath,
      encoding: 'utf-8',
    });
  } catch (err) {
    // No beads DB / no bd binary reachable in this clone (or the command
    // otherwise fails outright): there is nothing wired to the hazard
    // remote at the Dolt level either -- vacuously safe, mirroring
    // checkSyncRemoteInert's no-config.yaml case above.
    return {
      ok: true,
      message: `OK: 'bd dolt remote list' unavailable at '${repoPath}' (${String(err.message).split('\n')[0]}) -- nothing to disarm.`,
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

  const hazardRemotes = remotes.filter(
    (r) => (r.url ?? '').includes(HAZARD_REMOTE) || (r.name ?? '').includes(HAZARD_REMOTE)
  );
  if (hazardRemotes.length > 0) {
    const names = hazardRemotes.map((r) => r.name).join(', ');
    return {
      ok: false,
      message: `FAIL: Dolt-level remote(s) [${names}] in '${repoPath}' still point at ${HAZARD_REMOTE} -- run the eft.30.1 Dolt-remote disarm step before any auto-sprint run.`,
    };
  }
  return { ok: true, message: `OK: Dolt-level remotes in '${repoPath}' contain no reference to ${HAZARD_REMOTE}.` };
}

/**
 * apra-fleet-eft.31: check that the sandbox clone's OWN git 'origin' remote
 * does not itself point at the hazard remote. C4/C5 showed the three checks
 * above (isSyncRemoteActive / checkNoOutboundCommits / checkDoltRemoteAbsent)
 * can all report clean at the moment this script runs, yet a LATER 'bd dolt'
 * invocation (e.g. the eft.35-fixed doltPullBefore, before that fix landed)
 * auto-provisions -- "Configured Dolt remote origin from git origin." -- a
 * fresh Dolt-level remote FROM the clone's git origin as a side effect of
 * needing one. If that git origin is itself the hazard remote, any such
 * auto-provision re-arms exactly the Dolt-level wiring eft.30.1's upfront
 * disarm cleared, even though nothing was wired at snapshot time. Checking
 * the git origin directly closes this escape path: it flags the raw
 * material for a future re-wire, not just its current absence.
 *
 * Read-only: runs 'git remote get-url origin', never 'git remote add/set-url'
 * or any push/pull/fetch.
 *
 * @param {string} repoPath
 * @param {{execFileSync: typeof execFileSync}} [deps] injectable for tests
 * @returns {{ok: boolean, message: string}}
 */
export function checkGitOriginNotHazard(repoPath, deps = {}) {
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
  if (url.includes(HAZARD_REMOTE)) {
    return {
      ok: false,
      message: `FAIL: git 'origin' remote in '${repoPath}' is '${url}' -- points at ${HAZARD_REMOTE}, so any future 'bd dolt' invocation that auto-provisions a Dolt remote from git origin (apra-fleet-eft.30/eft.35) would re-wire straight back to the real remote even if the checks above currently report clean.`,
    };
  }
  return { ok: true, message: `OK: git 'origin' remote in '${repoPath}' ('${url}') does not reference ${HAZARD_REMOTE}.` };
}

function main() {
  const repoPath = process.argv[2] ?? path.join(process.env.HOME ?? '', 'toy-repo');
  if (!repoPath) {
    console.error('[check-sandbox-sync-remote] Usage: node scripts/check-sandbox-sync-remote.mjs <toy-repo-path>');
    process.exit(2);
  }

  const configPath = path.join(repoPath, '.beads', 'config.yaml');
  const syncCheck = checkSyncRemoteInert(configPath);
  console.log(`[check-sandbox-sync-remote] ${syncCheck.message}`);

  const outboundCheck = checkNoOutboundCommits(repoPath);
  console.log(`[check-sandbox-sync-remote] ${outboundCheck.message}`);

  const doltRemoteCheck = checkDoltRemoteAbsent(repoPath);
  console.log(`[check-sandbox-sync-remote] ${doltRemoteCheck.message}`);

  const gitOriginCheck = checkGitOriginNotHazard(repoPath);
  console.log(`[check-sandbox-sync-remote] ${gitOriginCheck.message}`);

  if (!syncCheck.ok || !outboundCheck.ok || !doltRemoteCheck.ok || !gitOriginCheck.ok) {
    process.exit(1);
  }
  console.log('[check-sandbox-sync-remote] OK: sandbox is isolated from the real fleet-e2e-toy Dolt remote.');
}

// Only run when invoked directly (not when imported for tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
