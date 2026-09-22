<!-- llm-context: How the Bitbucket Cloud VCS provider resolves workspace/repo from a remote, provisions credentials, builds the create-pull-request REST call, and hands basic-auth username/token pairs through the server-side credential handoff. Read when a user asks about Bitbucket auth, why a Bitbucket PR failed, or how the username half of a basic-auth credential is threaded through. -->
<!-- keywords: Bitbucket, Bitbucket Cloud, app password, workspace, provision_vcs_auth, vcs_credential_exec, vcs_username, basic auth, pull request, capabilitiesForHost -->
<!-- see-also: design-azure-devops-vcs-auth.md (the closest sibling provider -- also non-GitHub, also REST-based), design-git-auth.md (broader git-auth design), packages/apra-fleet-se/docs/architecture.md (VCSModule provider-abstraction overview) -->

# Design: Bitbucket VCS Auth

## Status

Bitbucket Cloud is a registered VCSModule provider with its own host/URL
parsing, credential-provisioning hook, and pull-request REST builder plus
response mapping. `capabilitiesForHost` reports `canOpenPullRequest: true`,
so the Publish PR phase dispatches the builder the same way it does for
GitHub and Azure DevOps. Every layer is covered by mocked tests; the live
end-to-end lane (a real PR against a real `bitbucket.org` workspace) is
opt-in and env-gated and had not been run against a live workspace as of
this writing -- treat Bitbucket PR support as verified against mocks only
until that lane has been exercised once.

Two dialects are deliberately left unconfirmed rather than guessed:
Bitbucket's "pull request already exists" response shape, and a hardening
fix to the shared already-exists guard that only happens to be safe today
because of how `parseVcsCurlOutput` currently behaves (see "Known gaps"
below). Both are recorded as open follow-up work rather than implemented
speculatively, per this module's stated convention that an unconfirmed
dialect stays absent -- a wrong guess would silently swallow a real failure
as success, while an absent field only degrades to "treat as an error,"
which is recoverable.

## Why Bitbucket needed a provisioning hook, not just a builder

Every other provider's `provision_vcs_auth` argument shape is built by the
shared caller from `git_access` + a `repos` allowlist -- GitHub-App
vocabulary. Bitbucket has no App/installation model: its credential path
instead requires three fields the default shape never sends -- `email`,
`api_token`, and `workspace` (see `src/services/vcs/bitbucket.ts`'s
`buildCredentials`). Sending the default shape dispatches a call with no
`api_token` at all, which trips Bitbucket's `missingCredential` hook and
opens an out-of-band operator prompt in the middle of an unattended sprint.

The fix is a provider-owned `buildProvisionArgs(ctx)` hook (documented as an
OPTIONAL export in `vcs-providers/index.mjs`'s registry contract) that
assembles the fullest honest argument set:

- `workspace` -- always derivable for free from the member's own remote via
  `parseRepoRef`.
- `api_token` -- sent as a `{{secret.NAME}}` **placeholder**, never a value;
  `provision_vcs_auth` resolves it hub-side. The orchestrator process never
  holds, logs, or transports the plaintext token.
- `email` -- **cannot** be supplied. It is the Atlassian account identity
  that owns the app password (it becomes both the git-credential-helper
  username and the HTTP Basic username the REST builder sends), but it is
  not persisted on the member record, `credential_store_list` returns names
  only, and the `{{secret.NAME}}` placeholder is not resolved for `email` --
  it is passed through verbatim, so a placeholder there would be deployed as
  a literal username string and fail silently. This field must be deployed
  out of band once per member.

### The three-way `buildProvisionArgs` answer, and why a third "skip" case exists

`buildProvisionArgs` (called via `buildProvisionArgsForProvider` in
`vcs-auth.mjs`) can answer three ways, not two:

1. `{ args, note? }` -- dispatch `provision_vcs_auth` with these arguments.
2. `{ error }` -- refuse; the caller raises a typed error naming the field
   that could not be assembled.
3. `{ skip: true, note? }` -- **do nothing and proceed on the credential
   already deployed.**

The third case exists because of `git_access: 'push+pr'`: the shared PR call
sites run a just-in-time re-provision immediately before dispatching
create-pull-request, to WIDEN a GitHub App token's scope for the duration of
one call. A Bitbucket app password has no scope axis to widen -- it carries
whatever scopes it was minted with, and cannot be re-assembled from what the
orchestrator has on hand anyway. Forcing that re-provision to run anyway
would fail (no `email` available at that call site) and abort the very PR
call it is supposed to enable. Skipping it leaves the operator-deployed
credential in place, which is exactly what the PR dispatch goes on to read
through the server-side credential handoff.

For every *other* `git_access` level (the shared preflight and reactive
self-heal paths), the hook still sends the fullest argument set this side
can honestly build. That call still fails server-side when no `email` was
ever configured for the member, but it fails as a typed `[FAIL]` naming the
missing field, never as an out-of-band prompt -- and the provider's
`authRemedy` hint (below) tells the operator exactly how to deploy the
credential out of band.

A remote whose `workspace` cannot be derived (the git remote could not be
read, or wasn't a recognized Bitbucket URL) is a typed error on every path,
not something to guess past.

`{ skip: true }` is reported up through `buildProvisionArgsForProvider` as a
`null` return (no provider ever legitimately returns null `args`, so this is
unambiguous), and `provisionVcsAuthForMember` short-circuits on it: no
`provision_vcs_auth` call is dispatched, no new expiry is claimed, and the
derived repo coordinates are still handed back, since PR-raising call sites
need those regardless.

## Why Bitbucket's PR call needs a username, and how it is threaded through

Bitbucket's REST API authenticates pull-request creation with HTTP Basic
`username:token` -- a bare `:token` form is silently rejected. GitHub uses a
bearer token; Azure DevOps uses HTTP Basic with an **empty** username
(`-u :PAT`). Bitbucket is the only registered provider that needs a real,
non-empty username on the wire.

That username is already sitting, unused, in the deployed credential
helper's own stdout: `provision_vcs_auth`'s Bitbucket path writes the
provisioning email as the git-credential-helper's `username=` line (see
`src/services/vcs/bitbucket.ts`). Before this work, the server-side
credential handoff (`vcs_credential_exec`, `src/tools/vcs-credential-exec.ts`)
read that helper's stdout but only ever extracted the `password=` line.

The fix adds a second placeholder pair, `{{vcs_username}}` (bare) /
`{{vcs_username_inline}}` (inside the caller's own single quotes), mirroring
the existing `{{vcs_token}}` / `{{vcs_token_inline}}` pair exactly:

- Both are **optional** and may not appear alone -- a command must still
  carry a token placeholder, or it is refused as an unguarded
  `execute_command` (`placeholder_missing`). A username-only command is not
  a credential handoff.
- A command that references a username placeholder against a helper whose
  stdout carries no `username=` line fails with a typed `username_empty`
  result and **dispatches nothing** -- rather than silently sending
  `:<token>` and surfacing much later as a confusing 401.
- Only a command that actually references one of the username placeholders
  consults the `username=` line at all, so every pre-existing token-only
  call site (GitHub, Azure DevOps) is unaffected and cannot reach
  `username_empty`.
- The username is redacted from returned stdout/stderr under its own
  `[REDACTED:vcs_username]` marker, distinct from the token's
  `[REDACTED:vcs_token]` marker, so a reader of a redacted stream can tell
  which half of the credential pair was scrubbed.

`vcs-auth.mjs`'s PR-raising call site passes `username: '{{vcs_username_inline}}'`
alongside the existing `token: '{{vcs_token_inline}}'` into every provider's
`buildCreatePrCommand` call unconditionally; a provider that does not read
`username` (github.mjs, azure-devops.mjs) simply ignores the field, so
adding it is additive and required no per-provider branching at the call
site.

## Remote parsing and the REST dialect

`parseRepoRef` recognizes three Bitbucket Cloud remote shapes and never
partially guesses -- a lookalike host (`bitbucket.org.evil.example`), a
non-Bitbucket host, or a malformed path all return `null` so the caller
raises its own typed error naming the expected shape, rather than proceeding
with half-parsed coordinates:

- `git@bitbucket.org:WORKSPACE/REPO[.git]`
- `https://[user@]bitbucket.org/WORKSPACE/REPO[.git][/]`
- `ssh://git@altssh.bitbucket.org[:22]/WORKSPACE/REPO[.git]`

A self-hosted Bitbucket Data Center install has an arbitrary domain and is
deliberately left to the generic-git catch-all rather than guessed at.

The create-pull-request REST call: `POST
https://api.bitbucket.org/2.0/repositories/{workspace}/{repo}/pullrequests`
with `{title, description, source:{branch:{name}}, destination:{branch:{name}}}`.
The response speaks a third id/URL dialect, distinct from both siblings:
the numeric PR id is flat at `id` (like Azure DevOps' `pullRequestId` is
flat, but differently named), while the browsable web URL is **nested** at
`links.html.href` (contrast GitHub's flat `html_url`). The response mapper
walks that nested path and degrades to `null` on a missing or malformed
value rather than throwing, so a genuinely successful PR creation is never
turned into a crash by a response-shape surprise.

## Known gaps (tracked as open follow-up work, not implemented speculatively)

- **Already-exists dialect unconfirmed.** The create-pull-request builder's
  interpretation contract declares only a success status range (2xx); it
  deliberately omits an `alreadyExistsStatus`/`alreadyExistsPattern` mapping
  because Bitbucket's real response shape for "a PR between this
  source/destination already exists" was never captured against a live API
  response this round. Until it is, re-raising a PR for an already-open
  source/destination pair reports as a hard failure rather than the
  idempotent success every other provider's already-exists mapping produces.
- **The shared already-exists guard's `undefined` comparison is safe only by
  accident.** The guard compares a parsed status against
  `built.interpret.alreadyExistsStatus` and, in the paired branch, builds
  `new RegExp(built.interpret.alreadyExistsPattern, 'i')` -- for Bitbucket,
  both are `undefined`. `new RegExp(undefined, 'i')` compiles to `/(?:)/`,
  which matches **any** text. The guard nonetheless stays false today only
  because the upstream parse step returns `null`, never `undefined`, for a
  missing field -- a coincidence of the current parser's behavior, not a
  property the guard itself enforces. A future change to that parser (or a
  new provider that legitimately produces `undefined` here) could silently
  reactivate an always-true match. The guard should be hardened to check the
  field's presence explicitly before constructing the `RegExp`, independent
  of confirming Bitbucket's own dialect.
- **Bitbucket's `push+pr` skip makes the reactive PR-auth self-heal a
  no-op that still claims success.** When a PR-raising call fails on auth
  and the shared self-heal re-provisions before retrying once, Bitbucket's
  `buildProvisionArgs` answers `{ skip: true }` at the `push+pr` level (by
  design -- see above), so the "self-heal" step does nothing, yet the
  retry path still logs that a heal completed and retries a byte-identical
  command, which fails identically. The self-heal call site should either
  suppress the heal attempt for a provider whose hook skips at `push+pr`, or
  reword the log so it does not claim a heal occurred, so the one-shot retry
  isn't burned on a call that was never going to succeed.
