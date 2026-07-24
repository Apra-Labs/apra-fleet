import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runAuth } from '../src/cli/auth.js';
import { addAgent, getAllAgents } from '../src/services/registry.js';
import { buildAuthEnvPrefix } from '../src/utils/auth-env.js';
import { getAgentOS } from '../src/utils/agent-helpers.js';
import {
  checkCleanEnvRealClaudeAuthViaEnvVar,
  defaultCredentialsPath,
} from '../scripts/check-toy-doer-credentials.mjs';
import { backupAndResetRegistry, restoreRegistry, makeTestLocalAgent } from './test-helpers.js';

// apra-fleet-eft.48.9: regression pin for eft.48 / impl eft.48.8 (the
// env-var provisioning path).
//
// eft.48.8's ORCHESTRATOR STEER made a member's own registry.json
// `encryptedEnvVars.CLAUDE_CODE_OAUTH_TOKEN` (populated via
// `apra-fleet auth --oauth --member <name>`, the register_member/
// update_member path) the PRIMARY smoke-test credential-provisioning
// mechanism -- NOT a synthesized `.claude/.credentials.json` file. Neither
// eft.48.5's shape-only checkCleanEnvCredentialsFile probe nor eft.48.7's
// checkCleanEnvRealClaudeAuth (tests/toy-doer-bare-token-real-cli-
// integ.test.ts) exercises this: both are entirely about the
// credentials-FILE branch. This suite pins the DISTINCT env-var branch:
// LocalStrategy's clean-env dispatch (`env -i HOME=$SANDBOX ... bash -l -c
// ...`) exports a member's encryptedEnvVars straight into the child shell
// via buildAuthEnvPrefix() (src/utils/auth-env.ts) -- an inline
// `export CLAUDE_CODE_OAUTH_TOKEN="<token>" && ...` prefix -- and the real
// claude CLI must authenticate off of that alone, with no credentials file
// involved at all.
//
// scripts/check-toy-doer-credentials.mjs's new
// checkCleanEnvRealClaudeAuthViaEnvVar() reproduces that exact exec path
// (same deliberately-bogus AUTH_PROBE_MODEL_ID technique as eft.48.7's
// checkCleanEnvRealClaudeAuth, so it fails fast (~1s, $0 cost) on model
// resolution rather than generating a response) and classifies the result
// the same {ok, authenticated, message, raw} way. Reaching that failure
// (instead of "Not logged in") IS "reaches past auth", mirroring the
// passing ambient-env-var control case recorded in eft.48's notes.
//
// "Fails pre-eft.48.8, passes after": before eft.48.8, there was no CLI
// path to populate a member's encryptedEnvVars.CLAUDE_CODE_OAUTH_TOKEN at
// all -- runAuth had no --member flag, and an unprovisioned member's
// buildAuthEnvPrefix() returns '' (no export at all). The first test below
// reproduces exactly that pre-fix state (an unprovisioned member, no
// credentials file either) and proves clean-env dispatch has nothing to
// authenticate with. The second test drives the real (post-eft.48.8)
// `runAuth(['--oauth', '--member', ...])` write path end to end and proves
// the resulting encryptedEnvVars is what actually authenticates the real
// CLI through the clean-env dispatch exec path -- never via a credentials
// file (asserted absent throughout).
//
// Requires a REAL, currently-valid OAuth access token (an invalid token
// fails auth regardless of provisioning path, so a fake token cannot
// exercise this regression either way) -- same
// CLAUDE_CODE_OAUTH_TOKEN-env-var-or-operator's-real-credentials-file
// fallback as eft.48.7. Neither the token value nor any derived state is
// ever logged. Gracefully skips the entire suite (never fails) when
// neither the `claude` CLI nor a real token is available, matching the
// BD_AVAILABLE/CLAUDE_CLI_AVAILABLE skip pattern used elsewhere in this
// suite.
//
// apra-fleet-eft.48.7 (reopened) precedent: this suite must NEVER arm
// itself off ambient credentials alone -- it additionally requires
// APRA_FLEET_ALLOW_REAL_CLI_AUTH_PROBE=1 to actually run (see
// REAL_CLI_PROBE_OPTED_IN below), so a member's routine `npm test` on a
// machine that happens to carry a real token never silently burns a live
// auth round trip.
//
// Hermetic: registry.json is backed up/reset per test (test-helpers.ts,
// APRA_FLEET_DATA_DIR-scoped -- never the operator's real registry), and
// HOME/USERPROFILE/HOMEDRIVE/HOMEPATH are pointed at a fresh temp dir per
// test (same pattern as eft.48.7's suite) so nothing here ever writes to,
// or even reads, the real ~/.claude/.credentials.json.

const CLAUDE_CLI_AVAILABLE = (() => {
  try {
    execFileSync('claude', ['--version'], { encoding: 'utf-8' });
    return true;
  } catch {
    return false;
  }
})();

// Captured before any test (in this file or, since vitest.config.ts sets
// fileParallelism: false, any other serially-run test file) reassigns
// process.env.HOME -- this must resolve the REAL operator home, never a
// test's sandboxed tmp HOME.
const REAL_HOME = os.homedir();

function resolveRealToken(): string | null {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    const raw = fs.readFileSync(path.join(REAL_HOME, '.claude', '.credentials.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    const token = parsed && parsed.claudeAiOauth && parsed.claudeAiOauth.accessToken;
    return typeof token === 'string' && token.length > 0 && !token.trim().startsWith('{') ? token : null;
  } catch {
    return null;
  }
}
const REAL_TOKEN = resolveRealToken();

// apra-fleet-eft.48.7 (reopened): this suite must NEVER arm itself off
// ambient credentials. A real-CLI auth probe on a machine whose host
// credential is file-based (or, here, whose ambient CLAUDE_CODE_OAUTH_TOKEN
// is a real live token) runs against a live token; on an unattended runner
// (member doing `npm test` mid-sprint) nobody is watching when that goes
// wrong. Opt-in is explicit: a runner sets
// APRA_FLEET_ALLOW_REAL_CLI_AUTH_PROBE=1 only when it has been deliberately
// configured for this test (throwaway/CI-scoped auth) -- the default suite
// on ANY machine, credentials present or not, skips it. Same gate as
// tests/toy-doer-bare-token-real-cli-integ.test.ts's sibling suite.
const REAL_CLI_PROBE_OPTED_IN = process.env.APRA_FLEET_ALLOW_REAL_CLI_AUTH_PROBE === '1';

describe.skipIf(!REAL_CLI_PROBE_OPTED_IN || !CLAUDE_CLI_AVAILABLE || !REAL_TOKEN)(
  'env-var-provisioned (encryptedEnvVars) toy-doer authenticates through clean-env dispatch against the real claude CLI (apra-fleet-eft.48.9)',
  () => {
    let tmpHome: string;
    // apra-fleet-eft.48.7 (reopened) precedent: override every profile-
    // resolution variable together, and restore all -- HOME alone does not
    // sandbox the spawned CLI on every platform.
    const PROFILE_ENV_KEYS = ['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH'] as const;
    let savedProfileEnv: Record<string, string | undefined>;

    beforeEach(() => {
      backupAndResetRegistry();
      savedProfileEnv = {};
      for (const key of PROFILE_ENV_KEYS) savedProfileEnv[key] = process.env[key];
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-eft-48-9-envvar-real-cli-'));
      process.env.HOME = tmpHome;
      process.env.USERPROFILE = tmpHome;
      process.env.HOMEDRIVE = path.parse(tmpHome).root.replace(/[\\/]+$/, '');
      process.env.HOMEPATH = tmpHome.slice(path.parse(tmpHome).root.length - 1);
    });

    afterEach(() => {
      restoreRegistry();
      for (const key of PROFILE_ENV_KEYS) {
        if (savedProfileEnv[key] !== undefined) process.env[key] = savedProfileEnv[key];
        else delete process.env[key];
      }
      fs.rmSync(tmpHome, { recursive: true, force: true });
    });

    function credPath(): string {
      return defaultCredentialsPath(tmpHome);
    }

    // REGRESSION PIN: reproduces the pre-eft.48.8 state -- a registered
    // member with no encryptedEnvVars.CLAUDE_CODE_OAUTH_TOKEN at all (the
    // only state reachable before eft.48.8 added the --member CLI path) and
    // no credentials file either -- and proves buildAuthEnvPrefix() exports
    // nothing, so clean-env dispatch has no credential to authenticate
    // with and the real claude CLI rejects it as "Not logged in". This is
    // the failure this task's fix (eft.48.8) must resolve.
    it('FAILS against the pre-eft.48.8 state: an unprovisioned member exports no env var, and the real claude CLI rejects the clean-env dispatch as "Not logged in"', () => {
      const member = makeTestLocalAgent({ friendlyName: 'toy-doer-envvar-unprovisioned' });
      addAgent(member);
      const stored = getAllAgents().find(a => a.friendlyName === member.friendlyName)!;

      const prefix = buildAuthEnvPrefix(stored, getAgentOS(stored));
      expect(prefix).toBe('');
      expect(fs.existsSync(credPath())).toBe(false);

      const result = checkCleanEnvRealClaudeAuthViaEnvVar('', tmpHome);
      expect(result.authenticated).toBe(false);
      expect(result.ok).toBe(false);
    });

    // PASSES after eft.48.8: the real (non-mocked) env-var write path --
    // `apra-fleet auth --oauth --member <name>` with a REAL token, the
    // PRIMARY smoke-test provisioning path -- populates the member's
    // registry.json encryptedEnvVars.CLAUDE_CODE_OAUTH_TOKEN, and the real
    // claude CLI now authenticates through the same clean-env dispatch exec
    // path LocalStrategy uses (an inline exported env var, reproducing
    // buildAuthEnvPrefix()'s exact output), reaching PAST auth to the
    // deliberate probe model's resolution error rather than a "Not logged
    // in" rejection -- and never via a credentials file.
    it('PASSES after eft.48.8: runAuth --oauth --member with a bare REAL token authenticates through clean-env dispatch against the real claude CLI, with no credentials file involved', async () => {
      const member = makeTestLocalAgent({ friendlyName: 'toy-doer-envvar-provisioned' });
      addAgent(member);

      await runAuth(['--oauth', '--llm', 'claude', '--member', member.friendlyName, REAL_TOKEN as string]);

      const updated = getAllAgents().find(a => a.friendlyName === member.friendlyName)!;
      expect(updated.encryptedEnvVars?.CLAUDE_CODE_OAUTH_TOKEN).toBeTruthy();

      // Never touches a credentials file -- registry-only (apra-fleet-eft.48.8).
      expect(fs.existsSync(credPath())).toBe(false);

      // buildAuthEnvPrefix() is what LocalStrategy's dispatch actually
      // prepends to every command for this member -- proves the real
      // wiring, not just the probe's own escaping.
      const prefix = buildAuthEnvPrefix(updated, getAgentOS(updated));
      expect(prefix).toContain('export CLAUDE_CODE_OAUTH_TOKEN="');
      expect(prefix).toContain(REAL_TOKEN as string);

      const result = checkCleanEnvRealClaudeAuthViaEnvVar(REAL_TOKEN as string, tmpHome);
      expect(result.authenticated).toBe(true);
      expect(result.ok).toBe(true);
      expect(result.message).toMatch(/AUTHENTICATED/);
      // Reaches PAST auth -- never the "Not logged in" rejection text.
      expect(result.raw.toLowerCase()).not.toMatch(/not logged in/);

      // Still no credentials file after the real dispatch probe ran.
      expect(fs.existsSync(credPath())).toBe(false);
    });
  },
);
