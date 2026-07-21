import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runAuth } from '../src/cli/auth.js';
import { checkCleanEnvRealClaudeAuth } from '../scripts/check-toy-doer-credentials.mjs';

// apra-fleet-eft.48.7: regression pin for bug eft.48 / impl eft.48.6.
//
// eft.48.5 (tests/auth-oauth-secret.test.ts) already proved the FULL-shape
// credential path is accepted by checkCleanEnvCredentialsFile, a presence/
// shape-only stub documented there as "standing in for a real claude-CLI
// probe which is not reliable to run in CI". That stub cannot pin THIS
// task's regression: hasSufficientSessionShape() already reports "OK" for
// an accessToken+expiresAt-only file (no scopes) -- exactly the pre-
// eft.48.6 bare-token shape -- so the shape probe passes identically before
// and after eft.48.6 and can never fail on the bug it is meant to catch.
// apra-fleet-eft.48's verification-pass-#2 notes found the installed CLI
// (2.1.212) rejects that exact shape as "Not logged in" regardless; the real
// deciding field is claudeAiOauth.scopes containing 'user:inference'
// (apra-fleet-eft.48.6's fix). Only an actual CLI invocation can prove that.
//
// This suite therefore drives scripts/check-toy-doer-credentials.mjs's
// checkCleanEnvRealClaudeAuth() -- a REAL (non-mocked) invocation of the
// installed `claude` CLI through LocalStrategy's exact clean-env exec path
// ('env -i HOME=<sandbox> ... bash -l -c claude ...'), classifying the
// structured {ok, authenticated, message} result the same way
// checkCleanEnvCredentialsFile's sibling tests already treat that shape as
// the guard's typed pass/fail signal. The probe uses a deliberately-bogus,
// never-real model id so it fails fast on model resolution (~1s, $0 cost,
// no real generation call) -- reaching that failure (instead of "Not logged
// in") IS "reaches past auth", mirroring the passing ambient-env-var control
// case recorded in eft.48's notes.
//
// Requires a REAL, currently-valid OAuth access token (an invalid token
// fails auth regardless of session shape, so a fake token cannot exercise
// this regression either way) -- exactly the credential-less CI-runner
// fallback path this task targets: either an ambient
// CLAUDE_CODE_OAUTH_TOKEN env var, or (dev-runner fallback) the operator's
// own real ~/.claude/.credentials.json accessToken. Neither the token value
// nor any derived credentials file is ever logged. Gracefully skips the
// entire suite (never fails) when neither the `claude` CLI nor a real token
// is available -- mirrors tests/smoke-test-flow-e2e-integ.test.ts's
// BD_AVAILABLE pattern for the same "degrade to a clean skip rather than
// flake machines/CI lanes without the real dependency" reason.
//
// Hermetic write path: HOME is pointed at a fresh temp dir per test (same
// pattern as tests/auth-oauth-secret.test.ts), so nothing here ever writes
// to the real ~/.claude/.credentials.json; only the real `claude` CLI's own
// read of that sandboxed file (and a network auth/model-resolution round
// trip) is not mocked.

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

describe.skipIf(!CLAUDE_CLI_AVAILABLE || !REAL_TOKEN)(
  'credential-less (bare-token) toy-doer authenticates through clean-env dispatch against the real claude CLI (apra-fleet-eft.48.7)',
  () => {
    let tmpHome: string;
    let savedHome: string | undefined;

    beforeEach(() => {
      savedHome = process.env.HOME;
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-eft-48-7-real-cli-'));
      process.env.HOME = tmpHome;
    });

    afterEach(() => {
      if (savedHome !== undefined) process.env.HOME = savedHome;
      else delete process.env.HOME;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    });

    function credPath(): string {
      return path.join(tmpHome, '.claude', '.credentials.json');
    }

    // REGRESSION PIN: reproduces the exact pre-eft.48.6 bare-token write
    // shape (accessToken + synthetic expiresAt, the eft.48.3 output, no
    // scopes) using a REAL token, and proves the real installed claude CLI
    // still rejects it as "Not logged in" -- this is the failure this test
    // must reproduce against pre-eft.48.6 code.
    it('FAILS against the pre-eft.48.6 bare-token shape (accessToken + expiresAt, no scopes): the real claude CLI rejects it as "Not logged in"', () => {
      fs.mkdirSync(path.dirname(credPath()), { recursive: true });
      fs.writeFileSync(
        credPath(),
        JSON.stringify({
          claudeAiOauth: { accessToken: REAL_TOKEN, expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000 },
        }),
      );

      const result = checkCleanEnvRealClaudeAuth(tmpHome);
      expect(result.authenticated).toBe(false);
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/NOT-AUTHENTICATED/);
      expect(result.raw.toLowerCase()).toMatch(/not logged in/);
    });

    // PASSES after eft.48.6: the real (non-mocked) bare-token write path --
    // `apra-fleet auth --oauth` given ONLY a bare token, the credential-less
    // CI-runner fallback -- writes a claudeAiOauth.scopes containing
    // 'user:inference', and the real claude CLI now authenticates through
    // the same clean-env exec path LocalStrategy's dispatch uses, reaching
    // PAST auth to the deliberate probe model's resolution error rather
    // than a "Not logged in" rejection.
    it('PASSES after eft.48.6: runAuth --oauth with a bare REAL token authenticates through clean-env dispatch against the real claude CLI', async () => {
      await runAuth(['--oauth', '--llm', 'claude', REAL_TOKEN as string]);

      const parsed = JSON.parse(fs.readFileSync(credPath(), 'utf-8'));
      expect(parsed.claudeAiOauth.accessToken).toBe(REAL_TOKEN);
      expect(parsed.claudeAiOauth.scopes).toContain('user:inference');

      const result = checkCleanEnvRealClaudeAuth(tmpHome);
      expect(result.authenticated).toBe(true);
      expect(result.ok).toBe(true);
      expect(result.message).toMatch(/AUTHENTICATED/);
      // Reaches PAST auth -- never the "Not logged in" rejection text.
      expect(result.raw.toLowerCase()).not.toMatch(/not logged in/);
    });
  },
);
