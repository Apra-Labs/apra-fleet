# Real Bitbucket E2E lane -- runbook

Companion doc for `bitbucket-real-e2e.mjs` (same directory). That module is
the opt-in GATE only -- it never provisions anything or touches the network.
This runbook covers everything a human needs to arm the lane: the target,
app password scopes, how the secret gets into the fleet, rotation, and the
two required negative passes. This file is the source of truth for the lane.

No token value is ever recorded here or anywhere else in this repo. Every
reference below is either a secure placeholder (`{{secure.<name>}}`) or a
fleet credential-store *name* -- never a literal secret.

## Why this lane is opt-in

No default (non-opt-in) test suite may depend on a live external Bitbucket
workspace. `resolveRealBitbucketE2eConfig()` in `bitbucket-real-e2e.mjs`
requires ALL of the following to be explicitly set before it reports
`skip: false`:

| Env var | Meaning |
|---|---|
| `APRA_FLEET_ALLOW_REAL_BITBUCKET_E2E` | Must be exactly `1`. The boolean "yes, I mean it" switch. |
| `APRA_FLEET_BITBUCKET_E2E_SECRET_NAME` | The fleet credential-store *name* already holding a working Bitbucket app password (see "Secret entry" below). No default -- an unset value always skips, even with the flag on, so a stale/unrelated credential can never be picked up by accident. |
| `APRA_FLEET_BITBUCKET_E2E_EMAIL` | The Atlassian account email that owns the app password (`provision_vcs_auth`'s Bitbucket path requires `email`, `api_token` and `workspace` -- see `src/services/vcs/bitbucket.ts`). Not a secret, but no safe default either -- an unset value always skips, so a wrong identity is never guessed. |

Optional override (defaults to the target below when unset):

| Env var | Default |
|---|---|
| `APRA_FLEET_BITBUCKET_E2E_REMOTE_URL` | `git@bitbucket.org:kumaakh/apra-analytics.git` |

A scenario that wants a clean skip message should call `realBitbucketE2eSkip()`
and pass its return value straight into node:test's `{ skip }` test option --
see the module's own doc comment for the exact contract.

## Target

- **Workspace / repo:** `kumaakh` / `apra-analytics`
- **SSH remote:** `git@bitbucket.org:kumaakh/apra-analytics.git`
- **HTTPS remote:** `https://bitbucket.org/kumaakh/apra-analytics.git`
- **PR list (where a passing run's PR must appear):** `https://bitbucket.org/kumaakh/apra-analytics/pull-requests/`

## App password scopes

Mint from **a dedicated bot/test Atlassian identity where possible** --
never a personal identity, because the revoked-credential negative pass
(below) requires deliberately killing the credential mid-test.

| Pass | Scopes | Notes |
|---|---|---|
| Positive (standing) | Repositories: Read & Write, Pull requests: Read & Write | Scoped to the `kumaakh` workspace's `apra-analytics` repo only where the Bitbucket UI allows repo-level scoping; otherwise the narrowest workspace-level scope that still covers pull requests. |
| Negative: scope-limited | Repositories: Read-only | Minted at test time, not kept standing. Exercises `provision_vcs_auth`'s 403-shaped auth-denied path. |
| Negative: revoked | Same as positive, then revoked before use | Minted at test time, then explicitly revoked in the Bitbucket UI before the negative-pass assertion runs. Exercises the "Invalid or expired app password" AUTH_EXPIRED path (see `vcs-providers/bitbucket.mjs`'s `AUTH_EXPIRED` pattern). |

Mint at: Bitbucket workspace settings -> Personal Bitbucket settings -> App
passwords (`https://bitbucket.org/account/settings/app-passwords/`).
App passwords have no expiration date in Bitbucket Cloud; rotate on the same
cadence documented for other providers' standing credentials regardless.

## Secret entry (out-of-band prompt only)

The app password is **never** pasted into a prompt, a file, a commit, or any
LLM-visible text. It is entered exactly once, via the out-of-band credential
prompt that `credential_store_set` / `provision_vcs_auth` triggers:

```
credential_store_set name=<APRA_FLEET_BITBUCKET_E2E_SECRET_NAME value, e.g. fleet-e2e-bitbucket>
```

From then on, every reference is a secure placeholder:

```
provision_vcs_auth(member, provider: 'bitbucket',
                    email: '<the app password's owning Atlassian account email>',
                    workspace: 'kumaakh',
                    api_token: '{{secure.<secret name>}}')
```

Remote members have no secret store of their own -- the placeholder resolves
**hub-side**; the plaintext reaches a remote member only inside the one
executed command (deploy / verify), never in a log, prompt, or LLM
transcript.

## Verify (after provisioning)

```
execute_command  command="git ls-remote git@bitbucket.org:kumaakh/apra-analytics.git HEAD"
```

## E2E pass criterion

Run the toy sprint against the target repo above; success is a real,
visible pull request at
`https://bitbucket.org/kumaakh/apra-analytics/pull-requests/`.

The gated scenario itself -- provision, `git ls-remote` verify, then the
publish path that opens the real pull request above -- lives in
`../bitbucket-real-e2e.test.mjs` (same `test/` directory as this file's
parent), enable it exactly as described in "Why this lane is opt-in" above.

## Rotation (any time, no code change)

1. Mint a new app password (same scopes, same workspace).
2. `credential_store_set name=<secret name>` again, entering the new value
   only via the out-of-band prompt.
3. Re-provision affected members / restart any long-running task that
   cached the old credential -- secure placeholders resolve at launch time,
   so a running process holding a stale deployed credential is not
   automatically refreshed.

## Notes

- Bitbucket's create-pull-request REST call has no confirmed "already
  exists" dialect in this codebase (see `vcs-providers/bitbucket.mjs`'s
  `interpret.successStatusRange` comment) -- a duplicate source/destination
  pull request during a live run degrades to a generic error rather than an
  idempotent success. Re-running the E2E scenario after a failed prior run
  may require closing or deleting the leftover branch/PR first.
- There is no implicit fallback secret name. Only the credential-store entry
  named by `APRA_FLEET_BITBUCKET_E2E_SECRET_NAME` at invocation time is
  used, so an unrelated Bitbucket entry sitting in the store under some
  other name is never picked up by this lane.
