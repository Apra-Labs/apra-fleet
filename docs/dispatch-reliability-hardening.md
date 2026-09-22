<!-- llm-context: Design notes for a cluster of dispatch/orchestration reliability fixes -- self-heal-and-retry coverage at git-operation boundaries, permission-scope vs auth-expiry git failure classification, missing-remote-ref sync handling, watchdog tick reentrancy, the doer VERIFY-only-next-action contract, the undici/Node toolchain pin, and the CLI overwrite-install stop/confirm sequence. Read alongside architecture.md's "Terminal-Signal and Dead-Session Detection Invariants", stall-detector-resilience.md, runner-error-classification.md, design-git-auth.md, and install.md, which cover the rest of the same reliability cluster. -->
<!-- keywords: self-heal, retry, watchdog, reentrancy, VERIFY, doer contract, undici, toolchain pin, finalizeAbort, git auth, permission-scope, workflows permission, missing remote ref, publish blocked, install --force, ETXTBSY, poll, escalation -->
<!-- see-also: architecture.md, stall-detector-resilience.md, runner-error-classification.md, design-git-auth.md, install.md -->

# Dispatch and orchestration reliability hardening

This document captures durable design decisions from a cluster of reliability
fixes to the dispatch layer and the fleet-sprint orchestrator that don't have
a single natural home elsewhere. See also `architecture.md`'s "Terminal-Signal
and Dead-Session Detection Invariants" section, `stall-detector-resilience.md`,
and `runner-error-classification.md` for the rest of the same cluster.

## Self-heal-and-retry-once must cover every git operation, not just the main dispatch bracket

The fleet-sprint orchestrator's main dispatch bracket (`withGitSync`) already
self-heals a mid-run VCS/git auth failure once (re-provision credentials,
retry the failed git operation exactly once) before giving up. That pattern
needs to be applied at *every* point the orchestrator shells out to git, not
just the primary bracket -- a stale credential can just as easily surface
during cleanup/abort handling as during the main flow, and an abort path that
silently drops a git-dependent step (e.g. a PR lookup written into the
terminal history record) degrades observability exactly when an operator
most needs an accurate record of what happened. Any new orchestrator code
path that shells out to git should reuse the same self-heal-and-retry-once
wrapper (the same `onAuthFailure` shape already used elsewhere) rather than
inventing a bespoke retry, and should fail soft (log and continue with
reduced fidelity) rather than aborting the cleanup path entirely if the retry
also fails -- cleanup-time git failures should never mask the original abort
reason.

## A permission-scope git rejection is not an auth failure, and must not be treated as one

The orchestrator's git-failure classifier distinguishes credential expiry
(re-mintable: the same principal, refreshed, will likely succeed) from a
permission-scope refusal (the principal is understood but was never granted
the specific permission the operation needs -- re-minting the *same*
permission set reproduces the *same* rejection). Conflating the two has two
independent failure modes, and a fix needs to close both:

- **Self-heal must not fire for a permission-scope refusal.** The generic
  self-heal-and-retry-once wrapper exists to recover from a stale/expired
  credential; running it against a permission-scope refusal just re-mints and
  re-sends the identical doomed request, burning a retry for no chance of
  success. A permission-scope match must be classified as its own axis,
  checked *ahead of* whatever generic precedence table the provider normally
  uses -- a host's permission refusal commonly arrives wrapped inside the
  same generic rejection tail an unrelated failure class also matches (e.g.
  git's "failed to push some refs", which a divergence-detection pattern also
  matches and which would otherwise win by outranking the permission-scope
  signal). The failure must be returned immediately with no self-heal attempt
  and no retry.
- **A permission-scope push rejection discovered *after* a dispatch has
  already completed and committed real work must not fail that dispatch's
  beads.** If the doer's work is done and committed locally but the
  post-dispatch push is refused for a permission reason no retry can fix, the
  correct outcome is "work done, publish blocked" -- not "dispatch failed,
  re-open and re-dispatch the same beads next cycle." Re-dispatching
  identical beads against an unfixable permission gap wastes a full dispatch
  every remaining cycle for zero chance of a different outcome, and worse,
  strands the doer's already-committed local work while repeatedly
  re-attempting it. The fix records which beads were blocked this way and
  excludes them from the next cycle's ready-work set for the rest of the
  sprint, while surfacing the operator referral prominently (a named,
  greppable log line) so a human can act on it -- transient, auth-expired,
  and divergence failure handling are all left completely unchanged; this is
  strictly a new, narrower classification carved out of what used to fall
  through to the generic failure path.

A provider that grants a scoped credential (e.g. a GitHub App installation
token minted per member, scoped to a specific permission set rather than the
App's full permission set) needs one additional invariant to keep this
classification correct at the source: the mint-time permission grant itself
must include every fine-grained permission the intended operations need for
every access level meant to support those operations. A push-capable access
level that omits a fine-grained permission some pushes need (e.g. a
permission gating one specific path prefix under the repo) produces the
exact permission-scope rejection above on every affected push, regardless of
which git identity holds the token -- the fix belongs in the mint-time
permission-request table, not in the classifier that reacts to the
resulting rejection after the fact. When the credential backend itself
rejects the mint request because the broader identity (e.g. the App
installation, as opposed to the per-member token) was never granted that
permission, that rejection must become an actionable operator referral
(naming exactly which permission and which identity needs it granted) rather
than surfacing the backend's raw error text or silently minting a reduced
permission set -- a silent reduction hides the misconfiguration instead of
surfacing it, and both a raw-text and a silent-downgrade response leave an
operator with strictly less signal than a named referral would.

## A git sync bracket must not assume the remote branch already exists

A sync step that runs a pull/rebase before its own first successful push
cannot assume the remote already has the branch: on a brand-new sprint
branch created only locally (not yet pushed), the remote genuinely has
nothing to fetch or rebase against, and git's own error text for this case
("couldn't find remote ref ...") is easy to misclassify as a real conflict
that needs the full conflict-resolution ladder. The durable fix factors a
single predicate that recognizes this exact, unambiguous git message and
shares it between the pre-dispatch and post-dispatch sync steps (rather than
each carrying its own copy of the same regex), and treats a match as "there
is nothing to rebase against" -- skip the conflict-resolution machinery
entirely and retry the push directly, which creates the branch on the
remote. If that direct retry is itself rejected because a concurrent writer
published the branch first, that is a genuine divergence and is raised as
such, exactly as any other divergence would be -- the missing-ref case is a
narrow bypass of the conflict ladder for one unambiguous precondition, not a
general relaxation of divergence handling.

## Watchdog ticks need a reentrancy guard when their own work can outlast the tick interval

A periodic watchdog loop that does blocking, potentially slow work per tick
(e.g. a process-liveness check that shells out per tracked session, plus a
network liveness probe per session) must guard against overlapping
invocations once the number of tracked sessions or the per-session latency
grows large enough that a single tick can take longer than the tick interval.
Without an in-flight guard, two overlapping ticks race on the same shared
state (recorded-crash sets, persisted state-file writes), and the outcome
depends on which tick's write lands last -- not on which one observed the
more current reality. The fix is a simple in-flight flag: a tick that fires
while the previous tick is still running skips its own work entirely rather
than running concurrently. This is strictly better than a locking/queueing
scheme here, because a skipped tick is caught by the next one a few seconds
later -- there is no need to ever run two ticks' worth of the same
idempotent classification work back to back.

## The doer's post-close contract: VERIFY is a stop instruction, not a checkpoint

A recurring failure mode: after a doer closes every bead it was assigned, it
would continue working past that point -- an unrequested sanity check, an
extra verification pass, an advisor call -- and burn its remaining turn
budget on that unrequested work instead of stopping. When the turn ceiling
then hit before the doer ever emitted its VERIFY result, the orchestrator had
no way to distinguish "doer never actually finished the work" from "doer
finished the work cleanly and then kept going anyway" -- both looked
identical (max_turns exhausted, no VERIFY seen), and the orchestrator's only
safe default was to treat it as a failure and trigger a full, wasted resume
dispatch.

The fix is a contract-level one, not a code-level one: the doer's own
instructions state explicitly that the moment its last assigned bead is
closed, its ONLY next action is emitting the VERIFY result -- no further
verification passes, no advisor calls, no additional sanity checks, however
well-intentioned. This is paired with an orchestrator-side defense-in-depth
check (see `runner-error-classification.md`'s "A max_turns/timeout streak is
not automatically a failure" section) that inspects bead-close state directly
rather than trusting the doer to have followed its own contract -- the two
mechanisms are independent and neither should be relied on to make the other
unnecessary.

## An overwrite-install's "stop the old process" step needs confirmation, not a timer

A CLI install/update path that stops a running singleton before overwriting
its own binary cannot rely on "send a termination signal, then sleep a fixed
duration, then proceed" -- a process that is mid-request can outlive an
arbitrary fixed delay, and copying over a binary that is still mapped into a
still-running process fails at the OS level (the copy is rejected outright,
not silently corrupted). The durable pattern is a bounded poll on actual
process liveness after the signal, with an escalation to a harder kill signal
and a second, shorter poll window if the process hasn't exited by the end of
the first window -- and the binary copy is gated on that poll confirming the
process is gone, not on the signal having been sent.

The same confirmation has to gate any user-facing "stopped" success message
too. A message that's printed unconditionally right after the signal (rather
than after confirming termination) can tell an operator the server stopped
when it didn't -- which is worse than a copy failure, because it actively
asserts a false state instead of surfacing the real one. When termination
can't be confirmed even after escalation, the correct behavior is to report a
clear, actionable error (including the manual command to finish the job) and
exit non-zero, rather than either asserting success or silently proceeding
into a copy attempt that's guaranteed to fail.

## A schema-repair retry must reattach the original request, not trust session memory

When a dispatched agent's output fails schema validation and the caller
re-asks for a corrected response, the repair prompt cannot rely on the
agent's own conversation memory to still contain the original request --
it must explicitly reattach the original prompt and schema as clearly
delimited reference text (e.g. bracketed by an explicit
begin/end-original-request marker) alongside the validation errors. Two
follow-on invariants keep this from degrading over multiple repair rounds:

- The reattached prompt/schema must always be re-derived from the one true
  original on every round, not built by appending onto the previous round's
  repair prompt. Without this, each additional repair round compounds the
  prompt (the original request text grows a duplicate copy every round)
  instead of staying constant in size and content.
- The retry must resume the *exact session* that produced the failed
  attempt, addressed by that session's own id, rather than a bare
  "continue the most recent session" flag -- the two are not equivalent
  once more than one session might be in flight for the same member, and a
  bare "resume most recent" can silently target the wrong conversation.
  When no session id was actually captured from the failed attempt, the
  retry must degrade to an explicit "start fresh" disposition with a loud,
  visible log line -- an unlogged silent fallback hides exactly the
  condition an operator would want to know about.

Because resuming a named session by explicit id is a terminal operation
(the dispatch layer does not silently reinterpret an unresolvable explicit
id as "start fresh"), the repair loop needs its own one-shot recovery: if
the explicit-id resume comes back as session-not-found, re-dispatch once
more as a fresh (non-resumed) attempt, still inside the same overall repair
budget, rather than treating a stale/missing session id as a hard failure
of the whole repair flow.

## Toolchain compatibility is a tracked invariant, not an incidental detail

A transitive dependency version can silently break child-process-spawn
behavior on a specific Node major version while working fine on others (an
HTTP client library changing its Web IDL internals in a way an older Node
runtime's built-ins don't support, for example). Because this kind of
incompatibility reproduces independently of any application-level change --
it is present on a clean checkout of the base branch too -- it is easy to
misdiagnose as caused by whatever unrelated change happens to be in flight
when it is first noticed. The durable fix is to pin the dependency to a
known-compatible major version range at the workspace root via package
manager overrides, so every package in the monorepo resolves the same
compatible version regardless of what any individual package.json declares,
and to add a regression test that actually imports the dependency in a
freshly spawned child process (not just the parent test process) against the
supported Node version -- a version pin with no test guarding it can drift
right back to an incompatible version the next time a transitive dependency
is bumped elsewhere in the tree.

**A root-level override pin is necessary but not sufficient.** Two failure
modes can leave a package manager override silently inert even though the
pin is present in the workspace root's `package.json`:

- The override never propagates to a non-root install. A package manager's
  `overrides`/`resolutions` field constrains dependency resolution for the
  workspace root's own install; it says nothing about what version a
  downstream consumer resolves when *they* install the published package
  into their own tree. If the published package's own `dependencies` still
  names the unconstrained (broken) version range, an npm-installed consumer
  gets that broken version regardless of what the source repo's root
  override says. The override must be paired with actually publishing the
  corrected version range in the published package's own dependency
  manifest, not just in the monorepo root used to build it.
- The lockfile can fall out of sync with the override. Adding or changing an
  `overrides` entry without regenerating the lockfile leaves the lockfile's
  recorded resolution unchanged; a clean, reproducible install (`npm ci`,
  which trusts the lockfile rather than re-resolving) can then install the
  pre-override version even though `package.json` says otherwise. Whenever
  an override is added or changed, the lockfile must be regenerated in the
  same change and the regenerated lockfile must be the one asserted against
  in tests and CI.

Because of both gaps, a regression test that only imports the dependency
from the source workspace's own `node_modules` is not sufficient evidence
that the pin holds -- it can pass purely because the workspace root's
override was honored, while every downstream npm-installed consumer still
gets the broken version. The regression coverage needs a second leg that
builds the actual publishable artifact (e.g. `npm pack`), installs it into a
clean, non-workspace target, and imports the dependency from *that*
installed copy before the pin can be trusted end to end.
