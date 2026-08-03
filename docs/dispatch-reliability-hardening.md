<!-- llm-context: Design notes for a cluster of dispatch/orchestration reliability fixes -- self-heal-and-retry coverage at git-operation boundaries, watchdog tick reentrancy, the doer VERIFY-only-next-action contract, and the undici/Node toolchain pin. Read alongside architecture.md's "Terminal-Signal and Dead-Session Detection Invariants", stall-detector-resilience.md, and runner-error-classification.md, which cover the rest of the same reliability cluster. -->
<!-- keywords: self-heal, retry, watchdog, reentrancy, VERIFY, doer contract, undici, toolchain pin, finalizeAbort, git auth -->
<!-- see-also: architecture.md, stall-detector-resilience.md, runner-error-classification.md, design-git-auth.md -->

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
