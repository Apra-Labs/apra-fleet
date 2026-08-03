# ADR: Server Never Acts on a Repository; Just-in-Time Credential Scoping

**Status:** Accepted
**Date:** 2026-08-02
**Related:** revert of server-side `create_pull_request` (added 2026-08-01, commit c5e66566)

## Context

On 2026-08-01 a `create_pull_request` MCP tool was added that ran inside the fleet
server process, minted its own GitHub App installation token, and called
`POST https://api.github.com/repos/{repo}/pulls` directly from the server. That
change crossed an architectural boundary that had never been written down
anywhere in `docs/` -- checked `architecture.md`, `design-git-auth.md`,
`design-vcs-auth-onboarding.md`, `threat-model-workspace-iron-wall.md`,
`SECURITY-REVIEW.md`, `vocabulary.md`, and `README.md`. The rule existed only
as an unstated habit in the code, which is exactly why an agent was able to
cross it without any doc telling it not to. This ADR states the invariant
that was missing, plus a companion credential-scoping pattern surfaced during
the same review, so future features can be checked against both rather than
rediscovering them the same way.

## Decision 1: The server never acts on a repository or a hosted third-party service

The fleet server's role is to orchestrate members and to mint and distribute
credentials so that MEMBERS can act. The server itself must never be the
actor that mutates a repository or calls a hosted third-party service's
action API (e.g. raising a PR, pushing a commit, posting a comment).

### The pre-existing carve-out (not new, and not a contradiction)

The server has always held the GitHub App private key and always called
`api.github.com` to MINT installation tokens (`src/services/github-app.ts`,
`src/services/vcs/github.ts`, `docs/design-git-auth.md`). That is credential
authority -- proving the server is allowed to hand out a scoped credential --
and it is unchanged by this ADR. No new secret class is introduced by this
decision.

What the reverted tool did differently is that it used the minted token
itself, server-side, to perform the repo-mutating action
(`POST /repos/{repo}/pulls`). That is repo action, not credential authority,
and it is the boundary this ADR draws: minting and distributing a credential
is a server responsibility; using that credential to act on a repository or
third-party service is always a member responsibility.

### Why this distinction matters

Collapsing "mints credentials" and "acts with credentials" into one role
turns the orchestrating hub into a repo actor. That concentrates action
authority (and the blast radius of any bug or injection in that code path)
into the one process that every sprint depends on, instead of keeping it
scoped to the member session that the deterministic workflow already
controls. Any future feature that needs to touch a repository or a hosted
service must build the command server-side (or orchestrator-side) if
provider-specific logic is needed, mint the credential, and dispatch both to
a member to execute -- never perform the call itself.

## Decision 2: Credential provisioning is just-in-time and call-site-scoped

`fleet-sprint` credential provisioning for a given access level must be
requested immediately before the specific, deterministic workflow step that
needs it -- never granted ambiently at sprint setup or at a broader phase
boundary "in case a later phase needs it."

### The rogue-dispatch blast-radius rationale

The sprint workflow (`runner.js`) is deterministic code, not LLM judgment: it
knows in advance exactly which call site is about to need an elevated
credential (e.g. a PR-capable token immediately before a Publish-PR
dispatch). Two provisioning shapes are possible for that same need, and they
have very different blast radii if any in-sprint dispatch is compromised,
misbehaving, or driven by a prompt-injected model:

- **Standing high-privilege** (granted once, held for the whole sprint or
  phase): the elevated credential is reachable by ANY in-sprint dispatch --
  doer, reviewer, or otherwise -- for the entire window it is held, whether
  or not the deterministic workflow ever actually uses it that run. The
  blast radius is the full sprint (or phase) duration.
- **Just-in-time, call-site-scoped** (minted immediately before the one
  call that needs it, used once): the elevated credential exists only in the
  seconds around that single code-controlled call. It is never carried as a
  member's ambient/standing access, so it is never material a rogue or
  misbehaving dispatch could reach for mid-sprint. The blast radius is one
  code-controlled call, not model discretion.

The just-in-time, call-site-scoped shape is the required default. A future
feature that needs a new or elevated credential should mint it at the
specific call site that uses it, not at setup or at a coarser phase
boundary, even when the need is known in advance.

### Relation to existing patterns

This mirrors the reasoning already applied to fleet's mutex and ID-allocator
tools, which were judged sound because their capability is scoped to the
smallest code-controlled window that actually needs it, never granted
broadly on the chance it might be needed later. Least-privilege-by-default,
scoped to a deterministic call site, is the pattern this ADR asks future
credential-needing features to follow.
