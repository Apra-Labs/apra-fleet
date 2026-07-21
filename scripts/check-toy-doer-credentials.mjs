#!/usr/bin/env node
// Guard for apra-fleet-eft.48.2 (verifies apra-fleet-eft.48.1's fix): after
// integ-test-playbook.md's `## Setup` + `## Test scenario` step 3
// (credential-provisioning step) run against a fresh sandbox `toy-doer`
// member, this asserts the member's dispatch env actually carries the
// provisioned LLM credential -- catching the pre-fix (unprovisioned) state
// BEFORE the smoke test burns 5 wasted Planner dispatch retries and fails
// with 'Authentication failed on toy-doer ... run provision_llm_auth'
// (typed AgentDispatchError, code AGENT_DISPATCH_FAILED, apra-fleet-eft.48).
//
// Two independent ways a member's dispatch env can carry the credential
// (either is sufficient -- see src/utils/auth-env.ts and
// src/os/linux.ts#getCleanEnv):
//
//   1. registry.json ENV-VAR PATH: the member record's own
//      `encryptedEnvVars.CLAUDE_CODE_OAUTH_TOKEN` is populated (e.g. via
//      the `provision_llm_auth` MCP tool / src/tools/provision-auth.ts).
//      `buildAuthEnvPrefix()` (src/utils/auth-env.ts) exports this
//      directly into the dispatch shell.
//   2. CLEAN-ENV CREDENTIALS-FILE PATH: the one integ-test-playbook.md's
//      `## Test scenario` step 3 actually uses (`apra-fleet auth --oauth`,
//      documented apra-fleet-eft.48.1) -- it never touches
//      encryptedEnvVars at all, it only writes
//      `$SANDBOX/.claude/.credentials.json`. `LocalStrategy` dispatches
//      for local members run that member's command through
//      `getCleanEnv()`'s `env -i <seed> bash -l -c '...'` exec path
//      (src/os/linux.ts), which seeds the clean shell's `HOME` from
//      whatever `HOME` the fleet server process itself was started with
//      (the sandboxed `$SANDBOX`, never the runner's real home) before
//      sourcing login profiles under it. The `claude` CLI then reads
//      `$HOME/.claude/.credentials.json` directly inside that clean
//      shell. This check reproduces that exact exec path as a read-only
//      probe and asserts a non-empty `claudeAiOauth.accessToken` comes
//      back.
//
// Run from `<repo-root>`, after `## Test scenario` step 3 (credential
// provisioning) and before step 4 (the real Planner dispatch):
//   node scripts/check-toy-doer-credentials.mjs [member-name] [fleet-home]
//
// Defaults: member-name='toy-doer', fleet-home=$HOME (the sandboxed HOME
// the fleet server / this shell is currently running under).
//
// Exit codes:
//   0 = credential provisioned (either path above resolves it)
//   1 = NOT provisioned -- actionable message printed to stderr
//
// Sandbox-only / read-only: this script only reads registry.json and the
// `.claude/.credentials.json` file, and runs read-only `env -i ... bash -l
// -c 'cat ...'` inside the given fleet home. It never writes/mutates
// anything and never touches network or git/Dolt remotes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

export const CREDENTIAL_ENV_VAR = 'CLAUDE_CODE_OAUTH_TOKEN';

/** Fleet home this script (and the fleet server / dispatch clean-env) is running under, by default. */
export function defaultFleetHome() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

/** registry.json path, respecting APRA_FLEET_DATA_DIR the same way src/paths.ts's FLEET_DIR does. */
export function defaultRegistryPath(fleetHome = defaultFleetHome()) {
  const dataDir = process.env.APRA_FLEET_DATA_DIR ?? path.join(fleetHome, '.apra-fleet', 'data');
  return path.join(dataDir, 'registry.json');
}

/** Path LocalStrategy's clean-env dispatch (and the claude CLI) reads OAuth credentials from. */
export function defaultCredentialsPath(fleetHome = defaultFleetHome()) {
  return path.join(fleetHome, '.claude', '.credentials.json');
}

/**
 * Find a registered member by its `friendlyName` (the `--name` passed to
 * `register-member`, e.g. 'toy-doer').
 *
 * @param {{agents?: Array<Record<string, unknown>>}} registry
 * @param {string} memberName
 * @returns {Record<string, unknown> | null}
 */
export function findAgentByName(registry, memberName) {
  if (!registry || !Array.isArray(registry.agents)) return null;
  return registry.agents.find((a) => a && a.friendlyName === memberName) ?? null;
}

/**
 * Does this agent record carry a non-empty encryptedEnvVars.CLAUDE_CODE_OAUTH_TOKEN?
 *
 * @param {Record<string, unknown> | null} agent
 * @returns {boolean}
 */
export function hasProvisionedEnvVar(agent) {
  if (!agent || typeof agent !== 'object') return false;
  const vars = /** @type {Record<string, unknown> | undefined} */ (agent.encryptedEnvVars);
  if (!vars || typeof vars !== 'object') return false;
  const value = vars[CREDENTIAL_ENV_VAR];
  return typeof value === 'string' && value.length > 0;
}

/**
 * Path 1: does registry.json's member record for memberName carry a
 * provisioned encryptedEnvVars.CLAUDE_CODE_OAUTH_TOKEN?
 *
 * @param {string} registryPath
 * @param {string} memberName
 * @returns {{ok: boolean, message: string}}
 */
export function checkMemberEnvVarProvisioned(registryPath, memberName) {
  if (!fs.existsSync(registryPath)) {
    return {
      ok: false,
      message: `NOT-PROVISIONED (env-var path): no registry.json at '${registryPath}' -- has '${memberName}' been registered yet ('register-member')?`,
    };
  }
  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
  } catch (err) {
    return {
      ok: false,
      message: `NOT-PROVISIONED (env-var path): could not parse '${registryPath}': ${err.message}`,
    };
  }
  const agent = findAgentByName(registry, memberName);
  if (!agent) {
    return {
      ok: false,
      message: `NOT-PROVISIONED (env-var path): member '${memberName}' not found in '${registryPath}'.`,
    };
  }
  if (hasProvisionedEnvVar(agent)) {
    return {
      ok: true,
      message: `OK (env-var path): member '${memberName}' has encryptedEnvVars.${CREDENTIAL_ENV_VAR} populated.`,
    };
  }
  return {
    ok: false,
    message: `NOT-PROVISIONED (env-var path): member '${memberName}' has no encryptedEnvVars.${CREDENTIAL_ENV_VAR} in '${registryPath}'.`,
  };
}

/**
 * Extract claudeAiOauth.accessToken out of a `.credentials.json` file's
 * text, or '' if absent/unparseable/empty input.
 *
 * @param {string} credentialsJsonText
 * @returns {string}
 */
export function extractAccessToken(credentialsJsonText) {
  if (!credentialsJsonText || !credentialsJsonText.trim()) return '';
  try {
    const parsed = JSON.parse(credentialsJsonText);
    const token = parsed && parsed.claudeAiOauth && parsed.claudeAiOauth.accessToken;
    return typeof token === 'string' ? token : '';
  } catch {
    return '';
  }
}

/** Shell-quote a value for safe interpolation inside a single-quoted-context 'env VAR=<this>' assignment. */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Mirrors getCleanEnv()'s seed set (HOME, USER, LOGNAME, SHELL), with HOME
 * pinned to the given fleetHome rather than the ambient process env, so
 * probes built on top of this are deterministic under test fixtures too.
 * Shared by checkCleanEnvCredentialsFile and checkCleanEnvRealClaudeAuth so
 * both reproduce the exact same 'env -i <seed>' prefix LocalStrategy's
 * dispatch exec path uses.
 *
 * @param {string} fleetHome
 * @returns {string[]}
 */
function cleanEnvSeedParts(fleetHome) {
  const seedParts = [`HOME=${shellQuote(fleetHome)}`];
  // apra-fleet-eft.48.7 (reopened): HOME alone does NOT sandbox the spawned
  // CLI on Windows -- profile resolution there goes through USERPROFILE (and
  // the Win32 API when unset), so an env-i probe seeding only HOME ran the
  // real CLI against the OPERATOR'S real ~/.claude, and its OAuth refreshes
  // rotated the operator's live refresh token (observed 2026-07-21: two
  // consecutive login expiries in the operator's interactive session). Pin
  // USERPROFILE to the same sandboxed home on every platform (harmless under
  // POSIX bash, load-bearing under Git Bash/Windows).
  seedParts.push(`USERPROFILE=${shellQuote(fleetHome)}`);
  for (const key of ['USER', 'LOGNAME', 'SHELL']) {
    if (process.env[key]) seedParts.push(`${key}=${shellQuote(process.env[key])}`);
  }
  return seedParts;
}

/**
 * Path 2: does a clean-env probe -- reproducing LocalStrategy's dispatch
 * exec path (src/os/linux.ts#getCleanEnv: 'env -i <seed> bash -l -c ...',
 * HOME seeded from the fleet server's own process.env.HOME) -- resolve a
 * non-empty claudeAiOauth.accessToken from fleetHome/.claude/.credentials.json?
 *
 * @param {string} [fleetHome]
 * @param {{execSync: typeof execSync}} [deps] injectable for tests
 * @returns {{ok: boolean, message: string}}
 */
export function checkCleanEnvCredentialsFile(fleetHome = defaultFleetHome(), deps = {}) {
  const run = deps.execSync ?? execSync;
  const credPath = defaultCredentialsPath(fleetHome);
  const seedParts = cleanEnvSeedParts(fleetHome);
  // '|| true' keeps the probe's own exit code 0 when the credentials file
  // is simply absent (the expected pre-fix state) -- 'cat' on a missing
  // file exits non-zero even with stderr redirected, and that is a
  // NOT-PROVISIONED result, not an infra failure of the probe itself.
  const script = `env -i ${seedParts.join(' ')} bash -l -c 'cat "$HOME/.claude/.credentials.json" 2>/dev/null || true'`;

  let output;
  try {
    output = run(script, { encoding: 'utf-8' });
  } catch (err) {
    return {
      ok: false,
      message: `NOT-PROVISIONED (clean-env path): probe failed to run against fleet home '${fleetHome}': ${err.message}`,
    };
  }

  const token = extractAccessToken(output);
  if (!token) {
    return {
      ok: false,
      message: `NOT-PROVISIONED (clean-env path): clean-env probe (matching LocalStrategy's 'env -i ... bash -l -c' exec path) found no claudeAiOauth.accessToken at '${credPath}' with HOME resolving to '${fleetHome}'.`,
    };
  }
  // Stabilization Issue 43 / apra-fleet-eft.48.4: an accessToken alone is
  // NOT a usable credential -- the Claude CLI requires at least one of
  // claudeAiOauth.expiresAt/refreshToken/scopes/subscriptionType to treat
  // the session as valid, and rejects a token-only file with "Not logged
  // in". This exact gap slipped past the original token-only check: the
  // file landed where dispatch looks, but Claude refused it and every
  // dispatch failed auth anyway. hasSufficientSessionShape() generalizes
  // the original expiresAt-only check to any of the four fields the
  // installed CLI accepts, matching what apra-fleet-eft.48.3's write path
  // (bare-token synthetic expiresAt, or full-object passthrough) produces.
  if (!hasSufficientSessionShape(output)) {
    return {
      ok: false,
      message: `NOT-PROVISIONED (clean-env path): '${credPath}' has an accessToken but no additional session field (claudeAiOauth.expiresAt/refreshToken/scopes/subscriptionType) -- the Claude CLI rejects such a file as "Not logged in". Seed the FULL claudeAiOauth object (see integ-test-playbook.md's credential-provisioning step), or provision via 'apra-fleet auth --oauth' (apra-fleet-eft.48.3), which always adds at least a synthetic expiresAt for bare tokens.`,
    };
  }
  return {
    ok: true,
    message: `OK (clean-env path): clean-env probe resolved a claudeAiOauth object with accessToken and a sufficient session shape (expiresAt/refreshToken/scopes/subscriptionType) at '${credPath}'.`,
  };
}

// A bogus, never-real model id. checkCleanEnvRealClaudeAuth() intentionally
// passes this so the real CLI fails fast on model resolution (~1s, $0 cost,
// no real generation call) rather than actually generating a response.
// Reaching THIS specific failure (instead of "Not logged in") is itself the
// "authenticated" signal -- it mirrors the passing ambient-env-var control
// case recorded in apra-fleet-eft.48's notes ("gets past auth straight to a
// model-not-found error").
export const AUTH_PROBE_MODEL_ID = 'apra-fleet-eft-48-7-nonexistent-auth-probe-model';

/**
 * Does a claude CLI `--output-format json` result payload (the raw stdout
 * text captured by checkCleanEnvRealClaudeAuth) indicate the CLI
 * authenticated (reached past auth), as opposed to rejecting the session as
 * "Not logged in"?
 *
 * @param {string} output
 * @returns {boolean}
 */
export function isAuthenticatedClaudeCliResult(output) {
  if (!output || !output.trim()) return false;
  const lower = output.toLowerCase();
  if (lower.includes('not logged in') || lower.includes('please run /login') || lower.includes('please run \\/login')) {
    return false;
  }
  try {
    const parsed = JSON.parse(output.trim());
    // A parseable {"type":"result",...} payload that did not match the
    // not-logged-in text above reached the CLI's actual request handling
    // (e.g. the deliberately-bogus probe model's resolution error) --
    // that is what "authenticated" means here.
    return !!(parsed && parsed.type === 'result');
  } catch {
    return false;
  }
}

/**
 * REAL, non-mocked probe: runs the actual installed `claude` CLI through
 * LocalStrategy's exact clean-env exec path ('env -i <seed> bash -l -c
 * "claude -p ... --model <bogus-probe-model> --output-format json"')
 * against fleetHome/.claude/.credentials.json, and classifies whether the
 * CLI authenticated or was rejected as "Not logged in".
 *
 * Unlike checkCleanEnvCredentialsFile (a presence/shape-only probe --
 * hasSufficientSessionShape() treats a bare `expiresAt` as already
 * "sufficient"), this exercises the real CLI's actual login decision. That
 * distinction matters: apra-fleet-eft.48's verification-pass-#2 notes found
 * the installed CLI (2.1.212) still rejects an accessToken+expiresAt-only
 * file as "Not logged in" even though the shape probe reports OK for it --
 * the CLI's real deciding field is `claudeAiOauth.scopes` containing
 * `user:inference` (apra-fleet-eft.48.6). Only an actual CLI invocation can
 * pin that regression and prove the fix.
 *
 * Requires a REAL, currently-valid OAuth access token in `accessToken`
 * (write one via parseClaudeOAuthSecret/runAuth first) -- an invalid token
 * fails auth regardless of session shape, so callers must gate on a real
 * credential being available (see tests/toy-doer-bare-token-real-cli-
 * integ.test.ts's CLAUDE_REAL_TOKEN/CLAUDE_CLI_AVAILABLE guards) rather than
 * running this unconditionally.
 *
 * @param {string} [fleetHome]
 * @param {{execSync: typeof execSync}} [deps] injectable for tests
 * @returns {{ok: boolean, authenticated: boolean, message: string, raw: string}}
 */
export function checkCleanEnvRealClaudeAuth(fleetHome = defaultFleetHome(), deps = {}) {
  const run = deps.execSync ?? execSync;
  const credPath = defaultCredentialsPath(fleetHome);
  // apra-fleet-eft.48.7 (reopened): probes must be REFRESH-INCAPABLE by
  // construction. A sandboxed credentials file carrying a refreshToken lets
  // the spawned real CLI rotate that token server-side, which invalidates
  // the ORIGINAL holder of the same refresh token (the operator's live
  // session or fleet host) even though the probe never touched their file.
  // Auth classification only ever needs the access token + session shape,
  // so a refresh-capable probe file is always a caller bug -- fail closed.
  try {
    const parsed = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    if (parsed?.claudeAiOauth?.refreshToken) {
      return {
        ok: false,
        authenticated: false,
        raw: '',
        message: `REFUSED (refresh-capable probe): '${credPath}' contains claudeAiOauth.refreshToken -- a probe CLI run could rotate it server-side and invalidate the credential's original holder. Strip refreshToken/refreshTokenExpiresAt from probe credential files before calling checkCleanEnvRealClaudeAuth.`,
      };
    }
  } catch { /* absent/unparseable file: fall through -- the probe itself classifies that as NOT-AUTHENTICATED */ }
  const seedParts = cleanEnvSeedParts(fleetHome);
  // stdin explicitly from /dev/null (avoids the CLI's "no stdin data
  // received" wait); stderr discarded (only carries an unrelated
  // workspace-trust warning); '|| true' keeps this probe's own exit code 0
  // even though the CLI itself exits 1 on BOTH a "Not logged in" rejection
  // and the deliberate bogus-model resolution error, so a real failure is
  // reported as a structured {ok:false} result rather than a thrown probe
  // error.
  const script = `env -i ${seedParts.join(' ')} bash -l -c 'claude -p "hi" --model ${shellQuote(AUTH_PROBE_MODEL_ID)} --output-format json </dev/null 2>/dev/null || true'`;

  let output;
  try {
    output = run(script, { encoding: 'utf-8' });
  } catch (err) {
    return {
      ok: false,
      authenticated: false,
      raw: '',
      message: `PROBE-ERROR: real-CLI clean-env probe failed to run against fleet home '${fleetHome}': ${err.message}`,
    };
  }

  const authenticated = isAuthenticatedClaudeCliResult(output);
  return {
    ok: authenticated,
    authenticated,
    raw: output,
    message: authenticated
      ? `AUTHENTICATED (real-CLI clean-env probe): the installed claude CLI accepted '${credPath}' as a valid logged-in session and reached past auth (deliberate bogus probe model '${AUTH_PROBE_MODEL_ID}' resolution error).`
      : `NOT-AUTHENTICATED (real-CLI clean-env probe): the installed claude CLI rejected '${credPath}' -- "Not logged in" (or an unparseable/empty response). Raw: ${output.trim().slice(0, 500)}`,
  };
}

/**
 * Extract claudeAiOauth.expiresAt out of a `.credentials.json` file's text,
 * or 0 if absent/unparseable (stabilization Issue 43).
 *
 * @param {string} credentialsJsonText
 * @returns {number}
 */
export function extractExpiresAt(credentialsJsonText) {
  if (!credentialsJsonText || !credentialsJsonText.trim()) return 0;
  try {
    const parsed = JSON.parse(credentialsJsonText);
    const expiresAt = parsed && parsed.claudeAiOauth && parsed.claudeAiOauth.expiresAt;
    return typeof expiresAt === 'number' && expiresAt > 0 ? expiresAt : 0;
  } catch {
    return 0;
  }
}

/**
 * apra-fleet-eft.48.4 (regression follow-up to apra-fleet-eft.48 /
 * stabilization Issue 43): does a `.credentials.json` file's claudeAiOauth
 * object carry at least one of the additional session fields the installed
 * Claude CLI requires beyond a bare accessToken -- expiresAt, refreshToken,
 * scopes, or subscriptionType -- to accept the file as a valid logged-in
 * session? The eft.48.2 guard originally asserted only a non-empty
 * accessToken, which reported OK even though the real CLI (2.1.212)
 * rejected that exact shape as "Not logged in - Please run /login"; this
 * check is what makes that regression actually fail loud. It is
 * presence-only (a read-only shape probe, not a network auth check) --
 * apra-fleet-eft.48.3's `apra-fleet auth --oauth` always writes at least a
 * (possibly synthetic) expiresAt, and a full-object seed
 * (integ-test-playbook.md's documented provisioning step) carries all four.
 *
 * @param {string} credentialsJsonText
 * @returns {boolean}
 */
export function hasSufficientSessionShape(credentialsJsonText) {
  if (!credentialsJsonText || !credentialsJsonText.trim()) return false;
  let oauth;
  try {
    const parsed = JSON.parse(credentialsJsonText);
    oauth = parsed && parsed.claudeAiOauth;
  } catch {
    return false;
  }
  if (!oauth || typeof oauth !== 'object') return false;

  const hasExpiresAt = typeof oauth.expiresAt === 'number' && oauth.expiresAt > 0;
  const hasRefreshToken = typeof oauth.refreshToken === 'string' && oauth.refreshToken.length > 0;
  const hasScopes = Array.isArray(oauth.scopes)
    ? oauth.scopes.length > 0
    : typeof oauth.scopes === 'string' && oauth.scopes.length > 0;
  const hasSubscriptionType = typeof oauth.subscriptionType === 'string' && oauth.subscriptionType.length > 0;

  return hasExpiresAt || hasRefreshToken || hasScopes || hasSubscriptionType;
}

/**
 * Combined guard: PASS if either the registry.json env-var path or the
 * clean-env credentials-file path resolves the credential.
 *
 * @param {{memberName?: string, fleetHome?: string, registryPath?: string, deps?: {execSync: typeof execSync}}} [opts]
 * @returns {{ok: boolean, message: string, envVarCheck: {ok: boolean, message: string}, cleanEnvCheck: {ok: boolean, message: string}}}
 */
export function checkToyDoerCredentialsProvisioned(opts = {}) {
  const memberName = opts.memberName ?? 'toy-doer';
  const fleetHome = opts.fleetHome ?? defaultFleetHome();
  const registryPath = opts.registryPath ?? defaultRegistryPath(fleetHome);
  const deps = opts.deps ?? {};

  const envVarCheck = checkMemberEnvVarProvisioned(registryPath, memberName);
  const cleanEnvCheck = checkCleanEnvCredentialsFile(fleetHome, deps);
  const ok = envVarCheck.ok || cleanEnvCheck.ok;

  return {
    ok,
    message: ok
      ? (envVarCheck.ok ? envVarCheck.message : cleanEnvCheck.message)
      : `FAIL: member '${memberName}' has no provisioned LLM credential -- neither encryptedEnvVars.${CREDENTIAL_ENV_VAR} nor a clean-env-resolvable '.claude/.credentials.json' was found. Run integ-test-playbook.md's '## Test scenario' step 3 (apra-fleet-eft.48.1's credential-provisioning step) before dispatching -- an unprovisioned member fails every real Planner dispatch with 'Authentication failed' (AGENT_DISPATCH_FAILED, apra-fleet-eft.48).`,
    envVarCheck,
    cleanEnvCheck,
  };
}

function main() {
  const memberName = process.argv[2] || 'toy-doer';
  const fleetHome = process.argv[3] || defaultFleetHome();
  console.log(`[check-toy-doer-credentials] checking member '${memberName}' against fleet home '${fleetHome}'.`);

  const result = checkToyDoerCredentialsProvisioned({ memberName, fleetHome });
  console.log(`[check-toy-doer-credentials] ${result.envVarCheck.message}`);
  console.log(`[check-toy-doer-credentials] ${result.cleanEnvCheck.message}`);

  if (!result.ok) {
    console.error(`[check-toy-doer-credentials] ${result.message}`);
    process.exit(1);
  }
  console.log(`[check-toy-doer-credentials] OK: member '${memberName}' credential is provisioned.`);
}

// Only run when invoked directly (not when imported for tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
