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

  // Mirrors getCleanEnv()'s seed set (HOME, USER, LOGNAME, SHELL), with HOME
  // pinned to the fleetHome under test rather than the ambient process env,
  // so this probe is deterministic under test fixtures too.
  const seedParts = [`HOME=${shellQuote(fleetHome)}`];
  for (const key of ['USER', 'LOGNAME', 'SHELL']) {
    if (process.env[key]) seedParts.push(`${key}=${shellQuote(process.env[key])}`);
  }
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
  return {
    ok: true,
    message: `OK (clean-env path): clean-env probe resolved a non-empty claudeAiOauth.accessToken at '${credPath}'.`,
  };
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
