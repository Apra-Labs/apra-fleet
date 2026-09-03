# Real Azure DevOps E2E lane -- runbook

Companion doc for `azure-devops-real-e2e.mjs` (same directory). That module
is the opt-in GATE only -- it never provisions anything or touches the
network. This runbook covers everything a human needs to arm the lane: the
target, PAT scopes, how the secret gets into the fleet, rotation, and the
two required negative passes. It restates (does not replace) the canonical
recall copy kept in apra-fleet-5co8's own notes ("E4 INTEGRATION-TEST
RUNBOOK") -- if the two ever disagree, apra-fleet-5co8's notes are the
source of truth; update this file to match.

No token value is ever recorded here or anywhere else in this repo. Every
reference below is either a secure placeholder (`{{secure.<name>}}`) or a
fleet credential-store *name* -- never a literal secret.

## Why this lane is opt-in

No default (non-opt-in) test suite may depend on a live external Azure
DevOps org. `resolveRealAdoE2eConfig()` in `azure-devops-real-e2e.mjs`
requires BOTH of the following to be explicitly set before it reports
`skip: false`:

| Env var | Meaning |
|---|---|
| `APRA_FLEET_ALLOW_REAL_ADO_E2E` | Must be exactly `1`. The boolean "yes, I mean it" switch. |
| `APRA_FLEET_ADO_E2E_SECRET_NAME` | The fleet credential-store *name* already holding a working ADO PAT (see "Secret entry" below). No default -- an unset value always skips, even with the flag on, so a stale/unrelated credential can never be picked up by accident. |

Optional overrides (default to the target below when unset):

| Env var | Default |
|---|---|
| `APRA_FLEET_ADO_E2E_ORG_URL` | `https://dev.azure.com/apralabs` |
| `APRA_FLEET_ADO_E2E_REMOTE_URL` | `https://dev.azure.com/apralabs/e2e-fleet-testing/_git/fleet-e2e-toy` |

A scenario that wants a clean skip message should call `realAdoE2eSkip()`
and pass its return value straight into node:test's `{ skip }` test option
-- see the module's own doc comment for the exact contract.

## Target

- **Org / project / repo:** `apralabs` / `e2e-fleet-testing` / `fleet-e2e-toy`
- **HTTPS remote:** `https://dev.azure.com/apralabs/e2e-fleet-testing/_git/fleet-e2e-toy`
- **SSH remote (parseRepoRef fixture form):** `git@ssh.dev.azure.com:v3/apralabs/e2e-fleet-testing/fleet-e2e-toy`
- **PR list (where a passing run's PR must appear):** `https://dev.azure.com/apralabs/e2e-fleet-testing/_git/fleet-e2e-toy/pullrequests`

This is a private project under the real `apralabs` Azure DevOps org, not a
throwaway org -- see "Identity" below for why PATs are still minted from a
dedicated bot/test identity where possible.

## PAT scopes

Mint from **a dedicated bot/test Microsoft identity where possible** --
never a personal identity, because the revoked-PAT negative pass (below)
requires deliberately killing the credential mid-test.

| Pass | Scopes | Notes |
|---|---|---|
| Positive (standing) | Code: Read & Write (+ Pull Request Threads: Read & Write, if offered separately) | This is `skills/fleet/auth-azdevops.md`'s "development" role row. Scoped to org `apralabs` **only** -- never all-orgs. No Build/Release/Full. |
| Negative: scope-limited | Code: Read-only | Minted at test time, not kept standing. Exercises `provision_vcs_auth`'s 403/AUTH_DENIED path. |
| Negative: revoked | Same as positive, then revoked before use | Minted at test time, then explicitly revoked in the Azure DevOps UI before the negative-pass assertion runs. Exercises the 401/AUTH_EXPIRED path. |

Mint at: `https://dev.azure.com/apralabs/_usersSettings/tokens`.
Recommended expiration: 90 days for the standing positive-pass PAT (note the
date -- feeds the fleet's day-scale expiry-warning path, see
`skills/fleet/auth-azdevops.md`'s "Expiry Capture" section). The two
negative-pass PATs are throwaway and need no long expiration.

## Secret entry (out-of-band prompt only)

The PAT is **never** pasted into a prompt, a file, a commit, or any
LLM-visible text. It is entered exactly once, via the out-of-band
credential prompt that `credential_store_set` / `provision_vcs_auth`
triggers:

```
credential_store_set name=<APRA_FLEET_ADO_E2E_SECRET_NAME value, e.g. fleet-e2e-ado>
```

From then on, every reference is a secure placeholder:

```
provision_vcs_auth(member, provider: 'azure-devops',
                    org_url: 'https://dev.azure.com/apralabs',
                    pat: '{{secure.<secret name>}}')
```

Remote members have no secret store of their own -- the placeholder
resolves **hub-side**; the plaintext reaches a remote member only inside the
one executed command (deploy / verify), never in a log, prompt, or LLM
transcript. See design note C3 (secret-transport paragraph) on apra-fleet-5co8
for the full rationale.

## Verify (after provisioning)

```
execute_command  command="git ls-remote https://dev.azure.com/apralabs/e2e-fleet-testing/_git/fleet-e2e-toy HEAD"
execute_command  command="curl -sf -u :{{secure.<secret name>}} 'https://dev.azure.com/apralabs/_apis/projects?api-version=7.1'"
```

The placeholder is substituted already-escaped -- reference it bare, not
wrapped in an extra layer of quotes.

## E2E pass criterion

Run the toy sprint against the target repo above; success is a real,
visible pull request at
`https://dev.azure.com/apralabs/e2e-fleet-testing/_git/fleet-e2e-toy/pullrequests`
(apra-fleet-5co8.6.2's job, blocked by this task).

## Rotation (any time, no code change)

1. Mint a new PAT (same scopes, same org).
2. `credential_store_set name=<secret name>` again, entering the new value
   only via the out-of-band prompt.
3. Re-provision affected members / restart any long-running task that
   cached the old credential -- secure placeholders resolve at launch time,
   so a running process holding a stale deployed credential is not
   automatically refreshed.

## Notes

- The store-side `expiresAt` for the standing secret is deliberately left
  unset today: current credential-store semantics delete an expired entry
  on resolve, which is not the desired "warn, don't delete" behavior for
  this lane -- revisit once that lands (see design item C6 on apra-fleet-5co8).
- An older credential-store entry from before this runbook existed may
  still be lying around under a different name; it is not canonical for
  this lane. Only the name recorded in `APRA_FLEET_ADO_E2E_SECRET_NAME` at
  invocation time is used -- there is no implicit fallback.
