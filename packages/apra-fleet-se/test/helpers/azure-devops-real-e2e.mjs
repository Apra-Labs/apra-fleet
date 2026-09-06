/**
 * Opt-in gate for the real Azure DevOps end-to-end lane (apra-fleet-5co8.6.1).
 *
 * This module contains NO network calls and NEVER reads a secret's value --
 * it only decides whether a real-ADO test is allowed to run at all, and if
 * so, which configuration (secret name / org URL / remote URL) to use. The
 * actual provisioning, `git ls-remote` verification and PR creation live in
 * the opt-in scenario itself (apra-fleet-5co8.6.2), which imports this
 * module rather than re-implementing the gate.
 *
 * DEFAULT BEHAVIOR: no default (non-opt-in) test suite may depend on a live
 * external org (apra-fleet-5co8.6.1's own acceptance criteria). Both the
 * enable flag AND the secret name must be explicitly set via the
 * environment before `resolveRealAdoE2eConfig()` reports `skip: false` --
 * there is no default secret name here (unlike
 * skills/fleet/auth-azdevops.md's `azdevops_pat` convention for ordinary
 * sprint use) specifically so a machine that happens to have some unrelated
 * Azure DevOps credential lying around in its fleet credential store can
 * never accidentally arm this lane.
 *
 * See azure-devops-real-e2e-runbook.md (same directory) for target org/
 * project/repo, PAT scopes, secret entry, rotation, and the two negative
 * passes.
 */

/** Boolean opt-in flag. Must be exactly '1'. */
export const REAL_ADO_E2E_ENABLE_FLAG = 'APRA_FLEET_ALLOW_REAL_ADO_E2E';

/** Names the fleet credential-store secret already holding the ADO PAT
 *  (entered out-of-band via `credential_store_set` -- see the runbook).
 *  This module never reads the secret's value, only its name. */
export const REAL_ADO_E2E_SECRET_ENV = 'APRA_FLEET_ADO_E2E_SECRET_NAME';

/** Optional overrides -- default to the E4 CONCRETE TARGET recorded on
 *  apra-fleet-5co8's own notes (org apralabs, project e2e-fleet-testing,
 *  repo fleet-e2e-toy) and the runbook below, so a scenario need not repeat
 *  them unless it is deliberately targeting a different org/repo. */
export const REAL_ADO_E2E_ORG_URL_ENV = 'APRA_FLEET_ADO_E2E_ORG_URL';
export const REAL_ADO_E2E_REMOTE_URL_ENV = 'APRA_FLEET_ADO_E2E_REMOTE_URL';

/** Default org/remote -- see "E4 CONCRETE TARGET" on apra-fleet-5co8 and
 *  the runbook's TARGET section. Never a secret; org_url is always a plain
 *  provision_vcs_auth argument, never `{{secure.*}}`. */
const DEFAULT_ORG_URL = 'https://dev.azure.com/apralabs';
const DEFAULT_REMOTE_URL = 'https://dev.azure.com/apralabs/e2e-fleet-testing/_git/fleet-e2e-toy';
const DEFAULT_BASE_BRANCH = 'main';

/**
 * Resolve whether the real Azure DevOps E2E lane is enabled, and if so, its
 * configuration.
 *
 * @returns {{ skip: false, secretName: string, orgUrl: string, remoteUrl: string, baseBranch: string }
 *          | { skip: string }}
 *   `skip` is `false` when both the enable flag and the secret name are
 *   present; otherwise it is a human-readable message naming every missing
 *   piece (the flag, the secret-name env var, or both) -- suitable to pass
 *   straight through as node:test's `{ skip }` option.
 */
export function resolveRealAdoE2eConfig() {
    const enabled = process.env[REAL_ADO_E2E_ENABLE_FLAG] === '1';
    const secretName = String(process.env[REAL_ADO_E2E_SECRET_ENV] || '').trim();

    const missing = [];
    if (!enabled) missing.push(`${REAL_ADO_E2E_ENABLE_FLAG}=1`);
    if (!secretName) missing.push(`${REAL_ADO_E2E_SECRET_ENV}=<fleet credential-store secret name, e.g. fleet-e2e-ado>`);

    if (missing.length > 0) {
        return {
            skip: `Real Azure DevOps E2E lane is opt-in and OFF by default -- set ${missing.join(' and ')} to enable it ` +
                `(see azure-devops-real-e2e-runbook.md next to this file). The named secret must already exist in the ` +
                `fleet credential store via credential_store_set -- this harness never mints, reads, or logs its value.`,
        };
    }

    return {
        skip: false,
        secretName,
        orgUrl: String(process.env[REAL_ADO_E2E_ORG_URL_ENV] || DEFAULT_ORG_URL).trim(),
        remoteUrl: String(process.env[REAL_ADO_E2E_REMOTE_URL_ENV] || DEFAULT_REMOTE_URL).trim(),
        baseBranch: DEFAULT_BASE_BRANCH,
    };
}

/**
 * Convenience for node:test's `test(name, { skip }, fn)` third-argument
 * shape: `false` when opted in, otherwise the skip message.
 * @returns {false | string}
 */
export function realAdoE2eSkip() {
    return resolveRealAdoE2eConfig().skip;
}
