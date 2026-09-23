# Sprint Doctor: LLM escalation for stalled/wedged fleet-sprint runs

Sprint Doctor is a last-resort automated layer inside the fleet-sprint engine. It sits
between "the engine's own deterministic handlers and retry ladders" and "wake a human up."
Its job in one line: turn a sick sprint into either a healthy sprint (bounded auto-repair,
then resume) or a cleanly dead one (abort with a diagnosis and, where needed, a specific
human referral) -- never leave it wedged, silently burning tokens, or ambiguous.

For the full triage/registry/output-contract doctrine consumed by the doctor persona
itself, see the `sprint-doctor` skill (`packages/apra-fleet-se/fleet-sprint/skills/sprint-doctor/SKILL.md`)
and the agent persona file that mirrors it. This document is the durable "why is it built
this way" record for future contributors to the engine, not the doctrine itself.

## The one hard boundary: the doctor decides, the engine executes

The doctor is dispatched with **zero tools**. Every fact it needs -- the trigger that
fired, the failing bead(s), dispatch/stall history, log tails, the symptom/remedy
registry, its own prior verdicts this sprint -- is assembled into its dispatch prompt
ahead of time. It never runs a shell command, never calls `bd`, never touches git, never
calls an MCP tool. It reads the evidence, chooses one action (or one bounded probe
request) from a closed, schema-validated set, and returns a structured verdict. The engine
is the only thing that ever executes a consequence of that verdict -- the same posture
code review takes toward a reviewer's verdict.

This is a structural guarantee, not a policy: a tool-less dispatch cannot edit source or
run arbitrary shell no matter what text is in its evidence. Log tails and dispatch output
are attacker-influenceable text and are treated as data to diagnose, never as instructions
to follow.

The doctor's own consult is never itself a ledger-recorded dispatch outcome, so a failed or
garbled response from the doctor cannot trigger another doctor consult. If the doctor
cannot produce a schema-valid verdict, the engine falls back to exactly the behavior it had
before the doctor existed -- consulting the doctor can never make an outcome worse than not
consulting it.

## Four modules, one direction of data flow

The implementation is deliberately split into four small, independently testable modules
with a strict one-way dependency chain -- each one only the next needs the one before it:

1. **Dispatch-health ledger** (a pure, stateful recorder, no dependency on the engine's
   control flow) -- records what happened at the engine's existing dispatch catch/outcome
   sites. It imports nothing from the runner and performs no dispatching itself, so both
   the trigger layer and any later post-mortem tooling can share one recorder without
   depending on engine internals. The load-bearing piece here is error-signature
   normalization: a failure's reason plus the first line of its message, with everything
   that varies per-occurrence but not per-failure-class stripped (bead-shaped ids,
   timestamps, paths, hex blobs, bare numbers). "Identical signature repeated" vs
   "different failure each time" is the primary ENVIRONMENT-vs-ENGINE_FLAW discriminator
   both the trigger layer and the doctor's own triage rely on.
2. **Trigger layer** -- pure functions over ledger rows plus the handful of cycle counters
   the engine already keeps (stale-cycle count, high-water-mark progress, budget spend). No
   LLM call, no dispatching, no I/O, no env/config reads: every threshold is an explicit
   parameter with a documented default, overridable per-caller. Five trigger classes are
   evaluated in most-specific-first order (repeated infra failures on one bead-set;
   repeated infra failures on one member across distinct beads; cycle stagnation nearing
   the stall abort; spend without progress; an unforeseen red state after the deterministic
   ladder is exhausted) and only the first firing descriptor produces a consult per cycle
   evaluation -- a cycle that trips several triggers at once is one sick sprint described
   several ways, not several separate premium dispatches. A `(trigger, key)` pair that
   already produced a consult this sprint stays debounced unless the doctor's prescribed
   action was actually executed and a new failure occurred after it.
3. **Consult module** -- the zero-tool, premium-tier dispatch itself: bounded input
   assembly, schema validation of the returned verdict, and at most one bounded probe round
   when the doctor's evidence is genuinely too thin to classify.
4. **Executor** -- the only module of the four that ever mutates anything. It is shaped as
   a table from `action.kind` to an existing engine verb, specifically so that widening the
   action vocabulary later means adding table rows, not rewriting control flow. Three
   invariants hold the blast radius of a bad verdict to the blast radius of verbs the
   engine already trusted before the doctor existed:
   - **Existing verbs only.** Every mutation is a `bd update` (through an injected
     `command()`), the caller's own child-bead-creation verb, or the caller's own
     credential-provisioning verb -- the executor opens no transport, shells nothing
     itself, and knows nothing about members, allocators or providers; those arrive as
     injected callbacks.
   - **The doctor never edits a bead.** The verdict is data; the executor (invoked by the
     engine) is the only actor. Because the doctor is dispatched with zero tools, this
     boundary is structural rather than promised.
   - **No re-dispatch without a real content change.** A `changed` flag is set only when a
     content-mutating verb actually ran and succeeded, and re-dispatch implies `changed`.
     A verdict that restates a bead as it already reads cannot hand it back to a doer to
     fail the same way again.

A re-plan verdict's rewritten bead body is staged through the caller's own staging verb
(a member-local temp-file write, never interpolated into a shell command string) before
being applied -- the same discipline the rest of the engine uses for any LLM-authored text
that becomes a command argument.

## Two consult shapes, one contract

The doctor is dispatched from two different call sites with a shared verdict schema but
different intent:

- **Incident consult** (triage): fired by the trigger layer inside Cycle Evaluation, at the
  one serialized, fresh-state moment per cycle. The doctor classifies the incident
  (`ENVIRONMENT` / `ENGINE_FLAW` / `TASK_SHAPE` / `UNCLEAR`) and proposes a bounded action.
  This consult phase may only ask -- it assembles evidence, dispatches, validates and logs
  the verdict, and changes nothing itself. It cannot throw: a failed consult returns a null
  verdict on every failure path, so a caller that ignores the result behaves exactly as it
  did before the doctor existed.
- **Re-plan consult**: fired when a doer reports a BLOCKED verdict on a bead. A BLOCKED
  verdict means the doer finished its turn and is stating it cannot do the work from its
  seat -- retrying re-runs the same refusal, re-laning to another member runs it on another
  seat with the same bead shape, and leaving the bead in the ready pool re-dispatches it
  unchanged until the sprint stalls. The only answer is to change the bead itself, so this
  consult is the one case where a doctor phase both asks and, via the executor, applies.
  The doctor here classifies planning/design defects and returns one of a closed set of
  re-plan actions (rewrite / rescope / route / grant / defer-with-credit); the answer is
  executed through the same table-driven executor as any other action, never edited
  ad hoc. Re-plan runs at most one consult per bead per cycle, and every failure path --
  no verdict, a non-re-plan action kind, a refused application -- leaves the bead exactly
  as excluded from re-dispatch as it already was.

Each consult call is its own `phase()` boundary, so it is dashboard-visible for free like
every other step in the cycle, rather than happening invisibly inside another phase.

## Symptom/remedy registry

A small, reviewed, pure-data registry maps known failure signatures to remedies, injected
into the doctor's evidence as data (never as prompt engineering). Every detection signature
keys off the engine's own structured dispatch-failure reasons or a target-agnostic message
shape -- never a specific target repository's log text, build command, or tracker prefix --
because this engine and its doctor ship to any target project. Adding a new known failure
signature is a reviewed data change to this registry, not a code restructure. A remedy verb
named by a registry entry must already exist in the executor's verb vocabulary; the module
self-checks this at load time. One class of failure is deliberately excluded from the
registry on purpose: wedged Dolt/beads sync state is resolved by a separate, fully
deterministic conflict-settlement path with a guaranteed rollback story, and routing it
through an LLM consult instead would reintroduce the very failure class that deterministic
path was built to eliminate.

## Consent-gated engine-flaw telemetry

When the doctor classifies an incident as `ENGINE_FLAW`, the report that could be shared
upstream goes through a privacy-first pipeline, isolated from the consent-mode policy that
gates whether it is ever sent anywhere:

- **Sanitization is a hard strip, not a placeholder.** Secret-shaped substrings (templated
  secret references, common API-key shapes, etc.) are removed outright, with nothing left
  behind -- a placeholder would still prove a secret was present and roughly where, which is
  more than an external tracker needs or a user consented to. This is a deliberately
  different tool from the engine's existing secret-token redactor used for prompts (which
  keeps the secret's *name* readable because that text never leaves the trusted engine/LLM
  boundary) and from the PR-body character-allowlist sanitizer (which exists for shell/PR-
  body injection safety, not privacy).
- **Consent modes** (`never` / `ask` / `always`) gate whether a sanitized report is ever
  surfaced for upstreaming at all, with a config-supplied tracker and a pre-filled issue
  link when enabled. No tracker configured means telemetry is disabled, not defaulted to
  some default endpoint -- the module ships with zero network primitives of its own.
- An anonymous per-install id and a dedup fingerprint prevent the same signature from being
  reported (or asked about) repeatedly within one install.

## Known gap: BLOCKED beads that never actually change

The re-plan lane excludes a BLOCKED bead from re-dispatch only while it is unresolved, and
a bead leaves that excluded set only when the executor reports its content actually
changed. The engine's stall-blocker accounting (which beads count toward a
`SPRINT_STALLED` abort) currently excludes beads awaiting a re-plan's follow-on grant, but
does **not** exclude beads still sitting in the BLOCKED-excluded set. That means a BLOCKED
bead whose re-plan consult is refused, errors, or genuinely produces no content change is
permanently undispatchable (nothing will ever re-offer it to a doer) yet is still counted
as an open blocker for stall purposes -- reintroducing, inside the re-plan lane itself, the
same "counted as blocking, never actually dispatchable" wedge class this whole mechanism
exists to eliminate. Any future work on the BLOCKED re-plan lane should treat this as the
first thing to close: the stall-blocker set must be built from "beads a doer could still be
offered," not "beads open at goal priority," once the BLOCKED-excluded set is a durable,
persistent-across-cycles set that can legitimately be empty of realistic future dispatch.

## Design trade-off: iterative landing over one large change

The mechanism is deliberately built and landed in incremental, independently useful slices
rather than as one large change: first the passive dispatch-health ledger and trigger layer
(so triggers evaluate and log without changing any outcome), then the general verdict
contract, premium consult and action executor plus stall interposition, then the
symptom/remedy registry, human-pause wiring, and the operator-invocable post-mortem mode.
The BLOCKED-verdict re-plan lane was pulled forward into the first usable slice on the
reasoning that plumbing alone (a ledger and trigger layer that only log) is not a working
concept of a doctor -- what reaches a shared branch has to already be able to act on at
least one real failure mode, even before the general consult/executor pair exists for every
trigger class.

## Operating modes

The doctor exists in two modes sharing one persona and one skill doctrine:
- **In-sprint**: invoked automatically by the engine at the trigger points above, during a
  live sprint run.
- **Post-mortem**: the same triage doctrine, operator-invocable over a failed run's log and
  bead state after the fact, for a human or supervising session investigating what
  happened without needing to reproduce it live.

The skill and persona doctrine documents are written once and consumed by both modes; they
must never drift from each other -- whichever is updated first must be mirrored to the
other in the same change.
