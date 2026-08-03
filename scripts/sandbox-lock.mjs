#!/usr/bin/env node
// Mutual-exclusion lock for the regression-test-playbook.md smoke-test
// sandbox (apra-fleet-egc.1).
//
// Bug: the sandbox lives at a fixed, well-known path ($HOME/temp/.apra-
// fleet-tests) by design -- see the playbook's rationale (no per-run random
// directory, so no hand-off file is needed between ## Setup / ## Test
// scenario / ## Teardown). But a fixed path has no mutual exclusion of its
// own: if two regression passes are ever in flight against the same machine
// at once, the second run's ## Teardown ('node dist/index.js stop' + 'rm -rf
// $SANDBOX') can destroy the first run's sandbox while it is still mid-
// Setup or mid-Test-scenario.
//
// Fix: a lock file living NEXT TO the sandbox (sibling path, '<sandbox>.lock'
// -- deliberately outside the directory '## Teardown' rm -rf's, so the lock
// itself is never a casualty of the very cleanup it is meant to gate) records
// the PID of whoever currently owns the sandbox. ## Setup acquires it (or
// fails loud, 'sandbox busy', non-zero exit) before touching anything;
// ## Teardown only removes the sandbox (and the lock) if it can prove it
// owns it.
//
// Two-phase ownership, to cover the WHOLE Setup-through-Teardown window with
// no gap, given each '## Setup' / '## Test scenario' / '## Teardown' section
// of the playbook runs as its OWN separate shell/process invocation (so a
// PID recorded by one code block is not, by itself, a reliable liveness
// signal for a LATER code block of the same logical run):
//   1. acquire(): '## Setup' claims the lock FIRST, before any mutation
//      (mkdir/install/clone), recording ITS OWN shell's PID ($$). That PID
//      stays alive for the rest of that same '## Setup' code block (one
//      continuous shell process), which covers the early window before the
//      sandbox's own fleet server exists yet.
//   2. markServerStarted(): once '## Setup' has run 'node dist/index.js
//      start', it re-points the lock at the sandbox's own long-lived fleet
//      server PID (read from the sandbox's own server.json) -- that process
//      stays alive for the ENTIRE remainder of the run (through
//      '## Test scenario', how ever long that takes), right up until
//      '## Teardown' stops it. This covers the rest of the window with no
//      gap: the hand-off from the Setup shell's PID to the server's PID
//      happens while the Setup shell's PID is still alive (it is the very
//      process performing the hand-off).
//   3. authorizeAndReleaseLock(): '## Teardown' reads the sandbox's OWN
//      current server PID (same server.json) and compares it to the lock's
//      recorded PID. Only a live PID that does NOT match is refused (that is
//      the actual hazard this bug is about: someone else's live run still
//      owns this sandbox). A missing lock, or a lock recording a PID that is
//      no longer alive (an abandoned/crashed prior run), is treated as safe
//      to reclaim -- otherwise a single crash would permanently strand the
//      sandbox with no way to clean it up.
//
// CLI (used directly by regression-test-playbook.md -- see '## Setup' /
// '## Teardown'):
//   node scripts/sandbox-lock.mjs acquire <sandbox-path> <pid>
//   node scripts/sandbox-lock.mjs mark-server-started <sandbox-path>
//   node scripts/sandbox-lock.mjs release <sandbox-path>
//
// Every exported function below takes an optional 'deps' object (fs
// primitives + an 'isAlive' predicate) purely for test injection -- mirrors
// scripts/check-sandbox-sync-remote.mjs's pattern -- so apra-fleet-egc.2 can
// exercise the busy/stale/owns/refuse decision logic without real processes
// or a real filesystem.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Sibling lock path for a given sandbox directory -- deliberately NOT
 *  inside the sandbox itself, so '## Teardown's `rm -rf "$SANDBOX"` can
 *  never delete the lock out from under a concurrent owner. */
export function lockPathFor(sandboxPath) {
  return `${sandboxPath}.lock`;
}

/** Where the sandbox's own fleet server writes its instance info, matching
 *  src/paths.ts's SERVER_INFO_PATH (FLEET_DIR/server.json,
 *  FLEET_DIR = APRA_FLEET_DATA_DIR or '<home>/.apra-fleet/data') -- computed
 *  here (rather than importing the built module) so this script has no
 *  dependency on 'npm run build' having run first. dataDirOverride mirrors
 *  APRA_FLEET_DATA_DIR if the caller has it set; the playbook never sets it,
 *  but honoring it keeps this in lockstep with production behavior. */
export function serverInfoPathFor(sandboxPath, dataDirOverride = process.env.APRA_FLEET_DATA_DIR) {
  const dataDir = dataDirOverride || path.join(sandboxPath, '.apra-fleet', 'data');
  return path.join(dataDir, 'server.json');
}

const defaultDeps = {
  existsSync: (p) => fs.existsSync(p),
  readFileSync: (p) => fs.readFileSync(p, 'utf-8'),
  writeFileSync: (p, content, options) => fs.writeFileSync(p, content, options),
  unlinkSync: (p) => fs.unlinkSync(p),
  /** True if `pid` names a currently-running process. EPERM (process exists,
   *  owned by someone else) still counts as alive; ESRCH (no such process)
   *  does not; any other error is treated as "can't tell, assume alive"
   *  (fail closed -- never treat an ambiguous check as license to delete). */
  isAlive: (pid) => {
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0) return false;
    try {
      process.kill(n, 0);
      return true;
    } catch (err) {
      if (err && err.code === 'ESRCH') return false;
      return true;
    }
  },
};

function withDefaults(deps) {
  return { ...defaultDeps, ...deps };
}

/** Read the PID recorded in a lock file, or null if there is no lock / it is
 *  empty/unreadable. */
export function readLockPid(lockPath, deps = {}) {
  const d = withDefaults(deps);
  if (!d.existsSync(lockPath)) return null;
  let raw;
  try {
    raw = d.readFileSync(lockPath);
  } catch {
    return null;
  }
  const pid = String(raw).trim();
  return pid.length > 0 ? pid : null;
}

/** Read the sandbox's own fleet-server PID from its server.json, or null if
 *  there is none (server never started, or already stopped/crashed). */
export function readServerPid(sandboxPath, deps = {}) {
  const d = withDefaults(deps);
  const infoPath = serverInfoPathFor(sandboxPath);
  if (!d.existsSync(infoPath)) return null;
  try {
    const parsed = JSON.parse(d.readFileSync(infoPath));
    return parsed && parsed.pid !== undefined && parsed.pid !== null ? String(parsed.pid) : null;
  } catch {
    return null;
  }
}

/** Classify a lock's current state: { busy, stale, pid }. 'busy' means a
 *  live PID holds it (refuse to touch the sandbox); 'stale' means a PID is
 *  recorded but no longer alive (safe to reclaim); neither means no lock at
 *  all. */
export function checkLockState(lockPath, deps = {}) {
  const d = withDefaults(deps);
  const pid = readLockPid(lockPath, d);
  if (pid === null) return { busy: false, stale: false, pid: null };
  if (d.isAlive(pid)) return { busy: true, stale: false, pid };
  return { busy: false, stale: true, pid };
}

/** '## Setup' step 1: claim the lock for `pid` (the Setup shell's own $$),
 *  refusing loud if another live run already holds it. Self-heals a stale
 *  lock (recorded PID no longer alive) by removing it first. Closes the
 *  check-then-write race between two Setup runs starting at the same
 *  instant via an atomic exclusive create ('wx' -- fails with EEXIST if the
 *  file already exists), not a separate exists-check + write. */
export function acquireLock(sandboxPath, pid, deps = {}) {
  const d = withDefaults(deps);
  const lockPath = lockPathFor(sandboxPath);
  const state = checkLockState(lockPath, d);
  if (state.busy) {
    return {
      ok: false,
      message: `sandbox busy -- ${lockPath} is held by live PID ${state.pid}. Another regression run is in progress against ${sandboxPath}. Wait for it to finish (or its Teardown to release the lock) before retrying.`,
    };
  }
  if (state.stale) {
    try {
      d.unlinkSync(lockPath);
    } catch {
      // best effort -- the exclusive create below still fails safely if this didn't work
    }
  }
  try {
    d.writeFileSync(lockPath, String(pid), { flag: 'wx' });
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      return {
        ok: false,
        message: `sandbox busy -- lost the race to acquire ${lockPath}. Another run just started. Retry shortly.`,
      };
    }
    throw err;
  }
  return { ok: true, message: `acquired ${lockPath} for PID ${pid}` };
}

/** '## Setup' step 2 (apra-fleet-egc.1): re-point an already-acquired lock
 *  at the sandbox's own long-lived fleet-server PID, once 'node
 *  dist/index.js start' has actually written server.json. Requires the lock
 *  to already exist (i.e. acquireLock() must have succeeded first) -- this
 *  is a hand-off, not a fresh claim. */
export function markServerStarted(sandboxPath, deps = {}) {
  const d = withDefaults(deps);
  const lockPath = lockPathFor(sandboxPath);
  if (!d.existsSync(lockPath)) {
    return { ok: false, message: `cannot mark server started: no lock at ${lockPath} -- acquireLock() must succeed first.` };
  }
  const serverPid = readServerPid(sandboxPath, d);
  if (serverPid === null) {
    return { ok: false, message: `cannot mark server started: no server.json PID found for sandbox '${sandboxPath}' -- did 'node dist/index.js start' actually run?` };
  }
  d.writeFileSync(lockPath, serverPid);
  return { ok: true, message: `${lockPath} now tracks server PID ${serverPid}` };
}

/** '## Teardown': decide whether this call owns the sandbox, and release
 *  the lock (unlink it) if so. Does NOT touch the sandbox directory itself
 *  or stop the server -- the playbook still does 'node dist/index.js stop'
 *  and 'rm -rf "$SANDBOX"' in bash, gated on this function's (the CLI's)
 *  exit code. Authorization rule:
 *    - no lock at all -> safe (nothing to protect)
 *    - lock's PID is not alive -> safe (stale/abandoned, self-heal)
 *    - lock's PID is alive AND matches this sandbox's own current server
 *      PID -> safe (this is genuinely our own run)
 *    - lock's PID is alive AND does NOT match -> REFUSE: some other live
 *      run currently owns this sandbox. */
export function authorizeAndReleaseLock(sandboxPath, deps = {}) {
  const d = withDefaults(deps);
  const lockPath = lockPathFor(sandboxPath);
  if (!d.existsSync(lockPath)) {
    return { ok: true, message: `no lock at ${lockPath} -- nothing to release; sandbox is free to remove.` };
  }
  const state = checkLockState(lockPath, d);
  const serverPid = readServerPid(sandboxPath, d);
  if (state.busy && state.pid !== serverPid) {
    return {
      ok: false,
      message: `refusing to remove sandbox '${sandboxPath}' -- ${lockPath} names live PID ${state.pid}, which does not match this sandbox's own server PID ('${serverPid ?? 'none'}'). Another run appears to own this sandbox right now; leaving it in place.`,
    };
  }
  try {
    d.unlinkSync(lockPath);
  } catch {
    // best effort
  }
  return { ok: true, message: `released ${lockPath}` };
}

function usageAndExit() {
  console.error('[sandbox-lock] Usage:');
  console.error('  node scripts/sandbox-lock.mjs acquire <sandbox-path> <pid>');
  console.error('  node scripts/sandbox-lock.mjs mark-server-started <sandbox-path>');
  console.error('  node scripts/sandbox-lock.mjs release <sandbox-path>');
  process.exit(2);
}

function main() {
  const [cmd, sandboxPath, pid] = process.argv.slice(2);
  if (!cmd || !sandboxPath) usageAndExit();

  let result;
  if (cmd === 'acquire') {
    if (!pid) usageAndExit();
    result = acquireLock(sandboxPath, pid);
  } else if (cmd === 'mark-server-started') {
    result = markServerStarted(sandboxPath);
  } else if (cmd === 'release') {
    result = authorizeAndReleaseLock(sandboxPath);
  } else {
    usageAndExit();
    return;
  }

  console.error(`[sandbox-lock] ${result.message}`);
  process.exit(result.ok ? 0 : 1);
}

// Only run when invoked directly (not when imported for tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
