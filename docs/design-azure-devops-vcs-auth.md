<!-- llm-context: How the Azure DevOps VCS provider assembles credentials, classifies auth failures, builds PR/comment REST commands, and manages PAT lifetime. Read when a user asks about Azure DevOps auth, PAT provisioning/expiry, or why an Azure DevOps failure surfaced a particular error. -->
<!-- keywords: Azure DevOps, ADO, PAT, personal access token, provision_vcs_auth, credential assembly, TF401019, TF401179, TF400813, pull request, org_url, scope_url -->
<!-- see-also: design-vcs-auth-onboarding.md (original multi-provider tool design), design-git-auth.md (broader git-auth design), packages/apra-fleet-se/docs/architecture.md (VCSModule provider-abstraction overview), skills/fleet/auth-azdevops.md (user-facing PAT creation guide) -->

# Design: Azure DevOps VCS Auth

## Status

Azure DevOps is a registered VCSModule provider with its own host/URL
parsing, credential assembly, failure classification, and pull-request/
comment REST builders. What is documented here reflects the current, real
state of the implementation -- some pieces described in the older
`design-vcs-auth-onboarding.md` and `design-git-auth.md` documents predate
this work and are superseded by this file where they conflict. As of this
writing, end-to-end PR publishing through the fleet-sprint runner is wired
and consumes the provider-owned PR response mapping, with mock-sprint
coverage exercising that publish path against canned Azure DevOps
responses, plus an opt-in, env-gated real end-to-end harness for
provision/verify/publish against a live Azure DevOps org. None of this has
been verified against an installed build -- treat it as landed-but-not-yet-
proven-stable rather than a finished, load-bearing guarantee until it has
been exercised end-to-end post-install.

## Why a provider-owned abstraction, not ad hoc if/else

Azure DevOps differs from GitHub along several axes that would otherwise leak
into shared runner/tool code as `if (provider === 'azure-devops')`
conditionals. Instead, every difference is hidden behind provider-descriptor
fields or hooks that shared code (the tool handlers, the runner, the sync
layer) dispatches into generically:

- **Token model.** GitHub can mint a short-lived, server-side re-mintable
  token via a GitHub App. An Azure DevOps PAT is long-lived and user-created
  -- it cannot be re-minted by the fleet. Self-heal semantics differ
  accordingly: on an auth failure, the GitHub path can attempt automatic
  re-provisioning, while the Azure DevOps path can only print actionable
  remedy text telling the user to create a new PAT and re-supply it as a
  fleet secret. This distinction is a provider-descriptor property, not a
  special case in the self-heal call site.
- **Remote URL shape.** `https://dev.azure.com/<org>/<project>/_git/<repo>`
  (plus `ssh.dev.azure.com:v3/...` and legacy `*.visualstudio.com` forms) vs
  GitHub's `owner/repo`. Azure DevOps repo references are three-part
  (org/project/repo), not two-part, which flows through to PR REST paths and
  provisioning scope.
- **PR REST dialect.** GitHub: `POST /repos/{owner}/{repo}/pulls` with
  `head`/`base`, returning `.number`/`.html_url`. Azure DevOps: `POST
  .../{project}/_apis/git/repositories/{repo}/pullrequests?api-version=7.1`
  with `sourceRefName`/`targetRefName` as full refs
  (`refs/heads/<branch>`, never a bare branch name -- the REST endpoint
  rejects a bare name), returning `.pullRequestId` and no web URL field at
  all.
- **Auth header.** Bearer token (GitHub) vs HTTP Basic with an EMPTY username
  and the PAT as the password (`curl -u :PAT`), matching Azure DevOps'
  documented auth pattern.
- **Already-exists signal.** GitHub: 422 + "already exists". Azure DevOps:
  409 + the `TF401179` error code -- treated as the idempotent re-run case
  (success), not a failure.
- **Error vocabulary.** GitHub uses plain-English literals ("Bad
  credentials"). Azure DevOps uses TF-numbered codes:
  - `TF401019` -- repo not found *or* no permission (deliberately ambiguous
    by Azure DevOps' own design) -- classified `AUTH_DENIED`, since
    re-minting the identical PAT cannot fix either underlying case.
  - REST `401` or `TF400813` -- the PAT itself is expired or revoked --
    classified `AUTH_EXPIRED` (the fix is minting a new PAT).
  - REST `403` -- the PAT is valid but lacks a required scope -- classified
    `AUTH_DENIED` (the fix is widening the PAT's scopes).
  - A bare git-over-HTTPS auth failure still carries git's own generic
    "fatal: Authentication failed for '<url>'" tail line, which the shared
    generic-git classifier already resolves to `AUTH_EXPIRED` without an
    Azure-specific pattern being needed for that path.

## Credential assembly

Azure DevOps credentials are assembled through the same `VcsProviderService`
seam every provider implements (`buildCredentials`, `missingCredential`,
`deploy`, `revoke`, `testConnectivity`):

- **Two credential-input names, one prompt.** A caller can supply the PAT as
  either `pat` or `token`; the credential is only considered missing when
  BOTH are absent. The assembled credential always lands in `pat`.
- **Expiry is optional but validated at assembly time.** `pat_expires_at`, if
  present, must parse as a date. An unparseable value is rejected outright
  at `buildCredentials` time rather than silently becoming `NaN` -- an
  `NaN` expiry would silence every downstream expiry comparison and would
  make the cleanup scheduler fall back to its short default TTL, effectively
  auto-revoking the credential that was just deployed. This check is
  deliberately defence-in-depth: the tool registry casts the MCP payload with
  `as any` before validation, so a caller can bypass the schema-level zod
  refine, and the provider-level check is the last guard.
- **Repo-URL validation gates connectivity testing and command
  interpolation.** A candidate Azure DevOps repo URL must match
  `https://dev.azure.com/<org>/<project>/_git/<repo>` (each segment
  restricted to characters that can never be shell metacharacters) before it
  is used. This closes two risks at once: a host-agnostic "known remote URL"
  helper could otherwise report a connectivity result against the wrong VCS
  host entirely (e.g. a GitHub URL misreported as an Azure DevOps result),
  and an unvalidated URL is interpolated into a command string executed on
  the member, which would otherwise be a command-injection vector. A bare
  org/project scope URL (the provisioning default) deliberately fails this
  validation -- it is a valid provisioning scope but not a clonable repo.
- **`scope_url` is preferred over a host-agnostic "known remote" guess.**
  Credential deployment scopes the git credential helper to a specific URL
  (`credential.<scope_url>.helper`). Connectivity testing prefers that exact
  `scope_url` when it is itself a valid Azure DevOps repo URL, and only falls
  back to a host-agnostic access-list-derived URL when `scope_url` isn't
  usable -- both candidates go through the same validation before use.
- **Connectivity testing uses `git ls-remote` against a concrete repo**, not
  an unauthenticated call to the org root (which would report success even
  against an unreachable or misconfigured host). `git ls-remote` reads the
  PAT through the git credential helper already written by `deploy()`, so
  the PAT never appears in the command string or a log line. When no
  concrete, validated repo is known, the check is skipped with an explicit
  message rather than reporting a false success.

## PAT lifetime and the setTimeout overflow guard

`scheduleCredentialCleanup` sets a timer to auto-revoke a deployed credential
near its expiry (or after a short default TTL when no expiry is known).
`setTimeout`'s delay argument is a signed 32-bit integer internally; Node
silently clamps an overflowing delay to fire almost immediately rather than
after the requested duration. A long-lived Azure DevOps PAT (the onboarding
guide recommends up to 90 days, well past the ~24.8-day ceiling a 32-bit
signed millisecond count can express) would therefore have been
auto-revoked by the fleet almost immediately after being deployed --
exactly the opposite of the intended "warn, never delete for a token this
long-lived" behavior. The fix: when the time until expiry exceeds the
`setTimeout` ceiling, no cleanup timer is scheduled at all; the day-scale
expiry warning (surfaced on the next provision/preflight check) and reactive
`AUTH_EXPIRED` classification on actual use are the backstop for that
horizon instead of a timer.

## Pull-request response mapping is provider-owned

Each provider exports its own mapping from PR-creation REST response fields
to a canonical shape, rather than the runner/tool layer assuming GitHub's
field names (`.number`, `.html_url`). Azure DevOps' create-pull-request
builder declares its own interpretation contract (success status range,
already-exists status/pattern) and its response is read through
`.pullRequestId`, with no web-URL field to map (Azure DevOps' REST response
does not include one). Consumers read the canonical mapping, never a
provider-specific response shape directly.

## A harness quirk that looks like a production bug but isn't

A previous investigation traced an Azure DevOps publish-path test failure
(a curl command resolving to a mangled host) to what looked like a
production defect: unquoted header word-splitting in the command that
issues the create-pull-request REST call. The actual builder
(`buildAzureDevOpsCreatePrCommand`) quotes every header value through a
shared shell-quoting helper keyed on target OS, so there is no unquoted-value
defect in the command it builds. The real cause was in the *test harness*:
its curl-interception logic matches on URL shape, and an Azure DevOps REST
endpoint URL didn't match the pattern the interceptor expected, so the
command fell through to a real shell instead of being intercepted -- a test
double gap, not a runtime bug. When an Azure DevOps-shaped test failure
looks like a shell-quoting problem, check whether the harness's own request
interception is matching the URL shape before assuming the builder is at
fault.
