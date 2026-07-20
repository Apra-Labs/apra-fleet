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
//
// Run as part of the integ-test-playbook.md ## Setup flow, immediately
// after the neutralize step:
//   node scripts/check-sandbox-sync-remote.mjs "$HOME/toy-repo"
//
// Sandbox-only: this script only READS files and runs read-only git
// commands (git rev-list) inside the given clone. It never writes to or
// pushes to any remote, real or otherwise.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Substring identifying the real, shared fleet-e2e-toy Dolt remote that the
// sandbox must never actively sync to. Kept as one constant so both checks
// (and their tests) reference the same identity.
export const HAZARD_REMOTE = 'fleet-e2e-toy';

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

  if (!syncCheck.ok || !outboundCheck.ok) {
    process.exit(1);
  }
  console.log('[check-sandbox-sync-remote] OK: sandbox is isolated from the real fleet-e2e-toy Dolt remote.');
}

// Only run when invoked directly (not when imported for tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
