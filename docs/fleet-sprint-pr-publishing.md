# Fleet-sprint PR publishing: invariants

How the sprint engine opens and updates the sprint pull request, and the
rules that keep it from damaging human work or failing silently.

## Credential judged per channel

A member needs two independent channels to publish a PR:

- **git channel**: can it push? Probed with `git ls-remote` through only the
  fleet-labelled credential helper. The probe resets the helper list with
  `-c credential.helper=` (this also clears URL-scoped helpers injected via
  `GIT_CONFIG_PARAMETERS`) and passes the helper path resolved in JavaScript
  for posix, git-bash and PowerShell members.
- **PR channel**: can it call the host REST API? Probed with a REST read.
  Azure DevOps has a `credentialProbe` (GET of the repository); an HTTP 203
  sign-in page counts as a refusal, not a success.

A credential is judged by whether it works, not by whether its stored
username matches. A different helper username is a single WARN. The run
predicts "no PR" only when the PR channel fails, including after a
re-provision. The skipped-provision line is logged once per member per run.

The git probe goes through only the fleet-written helper; git through the host's own credential chain is not checked. The ERROR text says exactly that, so it never claims git is broken when it works through the host chain.

## No re-provision on the push+pr path for non-mintable providers

Providers whose credential cannot be re-minted server-side
(`serverSideReMintable === false`: Bitbucket, Azure DevOps) are skipped by
`provision_vcs_auth` on the push+pr path. Re-provisioning would overwrite the
operator's own credential files. Provider build-args answer "skip" for push+pr.
The acceptance proof for this on a real Azure DevOps project needs an
environment with a fleet-store PAT different from the operator's helper; it
cannot be run in the sandbox.

## Provider/repo match is checked at setup

Sprint Setup asserts that the PR-raising member's VCS provider matches the
repo's host and throws `vcs_provider_mismatch` naming both. A mismatched
sprint stops at setup rather than running to completion and silently skipping
the PR.

## Existing PR descriptions: fleet owns only its block

The fleet-written description text lives between `PR_BLOCK_START` and
`PR_BLOCK_END` markers (`pr-body.mjs`).

- Text outside the block is preserved byte-for-byte; a human-edited title is
  kept. This holds on both the Publish PR and abort-finalize paths.
- Fleet never truncates human text to make room. If the human text is long it
  writes a compact block, or leaves the description unchanged when nothing fits.
- Sections that do not fit go whole into PR comments and the description links
  to them.
- Azure DevOps list responses carry a truncated description, so
  get-pull-request reads the full PR by id before rebuilding. If that read
  fails, the PR is left unchanged rather than rebuilt from the truncated copy.

The provider guides state what fleet changes on an existing PR.

## Typed failure for unrecognised PR responses

A 2xx response that maps to no PR id, or whose body is HTML or non-JSON (for
example a sign-in page), is a typed failure (`unmappedPrResponseFailure`), never
a success. The logged excerpt is redacted.

## Truthful abort and stall reporting

- `stallSettlementSummary` decides when a stall message may say the cause is
  "not in the work itself".
- The `[ABORTED]` PR body adds open/deferred, closed-this-run and last-review
  sections.
- `normalizeRecommendationForVerdict` runs after the post-gate verdict so the
  final-review recommendation never contradicts the verdict.

## Visibility of unopened PRs

`pr-not-opened.mjs` adds `verdict` and `prNotOpened` fields to the dashboard
and to `GET /api/sprints` list rows (additive; no contract package defines
these rows), so a sprint that finished without a PR is visible in listings.
