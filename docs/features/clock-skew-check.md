# Clock Skew Check (Sprint Setup phase)

## Problem this solves

The session-log stall detector (see `stall-detector.md`) seeds
`lastActivityAt` with the **hub's** `Date.now()` but advances it by
comparing that value against **member-produced** timestamps read from the
member's session log (mtime, or an in-content `timestamp`/`lastUpdated`
field). That comparison implicitly assumes the hub and member system
clocks agree to within a small tolerance.

When a member's clock has drifted from the hub -- for example a machine
whose time sync service has never run and is free-running on the CMOS
clock -- that assumption breaks silently. A large enough skew means the
member-produced timestamp can never satisfy "activity advanced" from the
hub's point of view, so `lastActivityAt` never advances and the stall
detector kills the dispatch as "stalled" even though the member is doing
real, healthy work. This is indistinguishable from a genuine stall by
looking at the poll data alone -- the failure mode only becomes legible
once you compare hub time to member time directly.

Nothing in the sprint runner detected this class of failure before a
sprint burned its dispatch retries against it.

## What it does

`fleet-sprint`'s Sprint Setup group runs a `Clock Skew Check` phase once
per dispatched member, immediately after the `Ensure Sprint Branch` phase
and before any real work is dispatched to that member. For each member it:

1. Captures `hubT0 = Date.now()`.
2. Runs a member-side epoch-milliseconds probe (POSIX `date`, with a
   PowerShell fallback for Windows members) through the same command
   dispatch path used elsewhere in the runner.
3. Captures `hubT1 = Date.now()`.
4. Computes skew by bracketing: if the member's reported epoch falls
   inside `[hubT0, hubT1]`, skew is zero (a round trip cannot distinguish
   a perfectly-synced clock from a small drift within the round-trip
   window, so zero is the honest answer for anything the bracket can't
   resolve). Otherwise skew is the signed distance outside whichever
   bracket edge was closest.
5. Compares `|skew|` against a threshold and logs a WARNING naming the
   member and the measured skew (direction and magnitude) if it's
   exceeded. A member whose probe could not be read at all (both the POSIX
   and Windows probe attempts failed or returned unparsable output) gets a
   distinct advisory line saying skew could not be measured, rather than
   being silently treated as in-sync.

## Design decisions and why

**Advisory only, never a hard abort.** A skewed clock does not stop a
member from doing real, correct work on everything except stall-detection
timing math -- it is purely a false-positive risk for the stall detector,
not a correctness problem for the member's actual output. Aborting the
sprint over a clock problem would trade a real, silent failure mode
(false stall kills) for a different, louder one (sprints that can't start
on a member with a merely inconvenient clock). Both probe attempts run
with soft-fail semantics and the evaluation helper never throws, so a
failed or unparsable probe degrades to an advisory line, never a sprint
abort.

**Threshold is derived from the stall detector's own threshold, not a
separate hardcoded constant.** The check exists specifically to warn about
skew large enough to break the stall detector's timing assumption, so its
threshold is defined as a fraction of the stall detector's own
configurable threshold (env-overridable, with the same default the stall
detector uses) rather than an independent magic number. If an operator
retunes the stall threshold, the clock-skew warning threshold moves with
it automatically.

**Bracket measurement, not a single round-trip estimate.** Capturing
`hub_t0`/`hub_t1` around the member probe and checking whether the
member's reported time falls inside that window (rather than computing a
single point estimate and comparing to a fixed tolerance) means the
measurement's own uncertainty -- network/dispatch round-trip time -- is
absorbed into the bracket instead of being conflated with actual clock
skew. This avoids false warnings caused by dispatch latency alone.

**Cross-shell probe with fallback, not a member-OS lookup.** The check
runs a POSIX epoch probe first and falls back to a PowerShell probe if the
first attempt fails or its output is unparsable, rather than branching on
a stored member-OS field or the hub's own platform. The hub's OS says
nothing about a remote member's OS, and the runner does not otherwise
maintain a reliable per-member OS registry, so a try/fallback probe is the
robust option that matches an existing convention already used elsewhere
in the runner for member command dispatch.

**No MCP tool schema change.** This is currently a log-only, orchestration
-internal check: it appears in the sprint log/dashboard, not in any tool's
return payload. Because no MCP tool schema changed, the thin client
package that mirrors tool schemas for other consumers was correctly left
untouched. If skew is later surfaced in a tool's output (e.g.
`member_detail`/`register_member`, so it's visible outside a running
sprint's log), that is new schema surface and must update the thin client
in the same change -- it is not a retroactive gap in this feature.

## Known deferred follow-ups (design boundary, not oversight)

- Surfacing skew outside of an active sprint's log (e.g. in
  `member_detail`/`register_member` output so an operator can check a
  member's clock health before ever launching a sprint) is explicitly out
  of scope for this phase. It would add MCP tool schema surface and needs
  its own design pass, including the thin-client update that comes with
  any schema change.
- A skew-immune redesign of the stall detector itself (removing the
  hub/member timestamp comparison's sensitivity to clock skew entirely,
  rather than warning about it) is a separate, deeper fix and is not
  bundled into this advisory check.

## Invariants for future contributors

- The probe helpers must never throw. Any failure mode (probe command
  fails, output is unparsable, both POSIX and Windows attempts fail) must
  resolve to an advisory log line or silence, never an exception that
  propagates into the sprint's control flow.
- The skew-evaluation helper is a pure function: it takes the two hub
  timestamps, the parsed member timestamp, and the threshold as inputs,
  and returns a result describing whether skew was measurable, its
  magnitude/direction, and whether it exceeded the threshold. It performs
  no I/O and calls no clock itself -- callers supply both hub timestamps so
  the function stays trivially testable and has no hidden timing
  dependency.
- A healthy (in-bracket) member must produce no log output from this phase
  beyond normal phase bookkeeping -- silence is the expected, correct
  outcome for the overwhelmingly common case.
- The warning threshold must always be derived from the stall detector's
  configured/default threshold at evaluation time, never hardcoded to a
  fixed millisecond value, so the two stay coupled if either is retuned.
