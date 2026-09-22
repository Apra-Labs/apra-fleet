/**
 * Opt-in gate for the real Bitbucket end-to-end lane (apra-fleet-qeq1.6.1).
 *
 * This module contains NO network calls and NEVER reads a secret's value --
 * it only decides whether a real-Bitbucket test is allowed to run at all, and
 * if so, which configuration (secret name / remote URL) to use. The actual
 * provisioning, `git ls-remote` verification and PR creation live in
 * the opt-in scenario itself, which imports this module rather than
 * re-implementing the gate.
 *
 * DEFAULT BEHAVIOR: no default (non-opt-in) test suite may depend on a live
 * external Bitbucket workspace (apra-fleet-qeq1.6.1's own acceptance criteria).
 * Both the enable flag AND the secret name must be explicitly set via the
 * environment before `resolveRealBitbucketE2eConfig()` reports `skip: false`
 * -- there is no default secret name here specifically so a machine that
 * happens to have some unrelated Bitbucket credential lying around in its
 * fleet credential store can never accidentally arm this lane.
 *
 * See bitbucket-real-e2e-runbook.md (same directory) for target workspace/
 * repo, app password scopes, secret entry, rotation, and the two negative
 * passes.
 */

/** Boolean opt-in flag. Must be exactly '1'. */
export const REAL_BITBUCKET_E2E_ENABLE_FLAG = 'APRA_FLEET_ALLOW_REAL_BITBUCKET_E2E';

/** Names the fleet credential-store secret already holding the Bitbucket
 *  app password (entered out-of-band via `credential_store_set` -- see the
 *  runbook). This module never reads the secret's value, only its name. */
export const REAL_BITBUCKET_E2E_SECRET_ENV = 'APRA_FLEET_BITBUCKET_E2E_SECRET_NAME';

/** The Atlassian account email that owns the app password -- required by
 *  provision_vcs_auth's `buildCredentials` for Bitbucket (email, api_token,
 *  workspace all required -- see src/services/vcs/bitbucket.ts). Not a
 *  secret (an email address, not a credential value), but still has no safe
 *  default: guessing one wrong would silently provision against the wrong
 *  identity, so it is required exactly like the secret name above. */
export const REAL_BITBUCKET_E2E_EMAIL_ENV = 'APRA_FLEET_BITBUCKET_E2E_EMAIL';

/** Optional overrides -- default to the E2E CONCRETE TARGET recorded on
 *  the runbook (workspace kumaakh, repo apra-analytics) so a scenario need
 *  not repeat them unless it is deliberately targeting a different
 *  workspace/repo. */
export const REAL_BITBUCKET_E2E_REMOTE_URL_ENV = 'APRA_FLEET_BITBUCKET_E2E_REMOTE_URL';

/** Default workspace/repo remote -- see apra-fleet-qeq1's concrete target.
 *  Never a secret; remote_url is always a plain part of the git URL. */
const DEFAULT_REMOTE_URL = 'git@bitbucket.org:kumaakh/apra-analytics.git';
const DEFAULT_BASE_BRANCH = 'main';

/**
 * Resolve whether the real Bitbucket E2E lane is enabled, and if so, its
 * configuration.
 *
 * @returns {{ skip: false, secretName: string, email: string, remoteUrl: string, baseBranch: string }
 *          | { skip: string }}
 *   `skip` is `false` when the enable flag, the secret name AND the email
 *   are all present; otherwise it is a human-readable message naming every
 *   missing piece -- suitable to pass straight through as node:test's
 *   `{ skip }` option.
 */
export function resolveRealBitbucketE2eConfig() {
    const enabled = process.env[REAL_BITBUCKET_E2E_ENABLE_FLAG] === '1';
    const secretName = String(process.env[REAL_BITBUCKET_E2E_SECRET_ENV] || '').trim();
    const email = String(process.env[REAL_BITBUCKET_E2E_EMAIL_ENV] || '').trim();

    const missing = [];
    if (!enabled) missing.push(`${REAL_BITBUCKET_E2E_ENABLE_FLAG}=1`);
    if (!secretName) missing.push(`${REAL_BITBUCKET_E2E_SECRET_ENV}=<fleet credential-store secret name, e.g. fleet-e2e-bitbucket>`);
    if (!email) missing.push(`${REAL_BITBUCKET_E2E_EMAIL_ENV}=<Atlassian account email that owns the app password>`);

    if (missing.length > 0) {
        return {
            skip: `Real Bitbucket E2E lane is opt-in and OFF by default -- set ${missing.join(' and ')} to enable it ` +
                `(see bitbucket-real-e2e-runbook.md next to this file). The named secret must already exist in the ` +
                `fleet credential store via credential_store_set -- this harness never mints, reads, or logs its value.`,
        };
    }

    return {
        skip: false,
        secretName,
        email,
        remoteUrl: String(process.env[REAL_BITBUCKET_E2E_REMOTE_URL_ENV] || DEFAULT_REMOTE_URL).trim(),
        baseBranch: DEFAULT_BASE_BRANCH,
    };
}

/**
 * Convenience for node:test's `test(name, { skip }, fn)` third-argument
 * shape: `false` when opted in, otherwise the skip message.
 * @returns {false | string}
 */
export function realBitbucketE2eSkip() {
    return resolveRealBitbucketE2eConfig().skip;
}
