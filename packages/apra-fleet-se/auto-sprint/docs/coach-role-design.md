# Coach Role: Just-in-Time Error Resolution (design note)

Status: IN DESIGN (user idea 2026-07-20; scope and consent model refined
same day; explicitly NOT being operationalized yet -- "let's design more
before we operationalize"). Recorded here so the design survives context
loss. Update in place as design decisions land.

## The idea (user's own framing)

Insert a "coach" role INSIDE the auto-sprint workflow -- an LLM agent that
knows the fleet -> workflow -> auto-sprint technology stack and can address
classes of errors that are UNFORESEEN by the deterministic engine, just in
time. Every time it intervenes it (a) collects the important aspects of the
sprint context and (b) produces a bug report describing the problem AND how
it was resolved -- feeding field telemetry, future releases, and giving
users a way to progress instead of wedging. It institutionalizes, inside
the workflow, the stabilization-observer role a human+agent pair played
from outside during the eft dogfood runs.

## Scope (REFINED): any red state, not just sync failures

The coach's jurisdiction is ANY event that leaves the sprint in a red
state, strictly AFTER existing deterministic handling has been exhausted.
The error-handling hierarchy is three layers, in order:

1. **Typed handlers and ladders (deterministic, free).** errors.mjs typed
   errors, turn-exhaustion resume ladders, Tier-2 conflict resolution,
   busy-lock retries. The coach NEVER preempts these.
2. **Coach (JIT judgment, tokens).** Invoked only when layer 1 has no
   match or its handling failed -- the unforeseen complement.
3. **Fail loudly (existing behavior).** If the coach cannot resolve (or
   its per-class/per-run caps are hit), the normal failure path proceeds
   unchanged. The coach never suppresses a failure it could not fix.

Red-state interception points (initial taxonomy, extend as discovered):
- Streak failure after doer dispatch/resume ladder exhaustion
- Dispatch errors with unrecognized reason (api_error, empty_response,
  transport failures) after existing retries
- Sync bracket failures (G-push/G-pull/D-push/D-pull) after Tier-2
- Phase-level failures: deploy failed, integ runner crashed, harvester
  failed
- Reviewer/planner contract violations after their built-in retry
- Stall detection firing; state corruption detected; member unreachable;
  auth expiry mid-run
- Workflow-level abort paths (as evidence collector even when
  unresolvable)

## Guardrails: coach.md carries them ALL (REFINED)

The contract file (agents/coach.md, upstream in apra-pm) is the single
home of every guardrail -- not scattered through engine code -- so the
guardrails ship with the role definition, version together, and appear in
every dispatch. Engine-side caps are enforcement backstops of the same
rules, never the only statement of them.

Guardrail set (all load-bearing):
- ACTION ALLOWLIST only: stash/commit WIP to a rescue branch, clear a
  leaked lock, retry a push, restart a dead session, re-run an idempotent
  step. Hard prohibitions: never force-push, never delete branches/files,
  never mutate bead verdicts or close beads, never edit code content,
  never act outside the member's working tree, never install software.
- SINGLE-SHOT: one intervention attempt per red event; then report and
  fall back. The coach is never coached (no recursion).
- SAME-CLASS-TWICE POLICY: an error class (by fingerprint) may be coached
  at most N times per run (N=2 initial); after that it must fail loudly
  and demand an engine fix. Healing is a bridge, never a home.
- EVERY INTERVENTION FILES A REPORT -- no silent saves. Interventions are
  first-class events in sprint state and appear in final-review evidence
  (a PASS with 12 coach saves reads differently from a clean PASS).
- TARGET-AGNOSTIC: the coach knows the fleet/workflow/auto-sprint STACK,
  never the target repo's specifics (product-vs-dogfood rule).
- TOKEN DISCIPLINE: invoked only at layer 2 (rare by construction);
  per-run invocation cap; premium tier acceptable given rarity.
- REPRODUCIBILITY: interventions recorded in replayable form; mock/golden
  tests stub coach outcomes deterministically.

## Bug reports and consent (REFINED): sanitize, then ask -- or standing consent

The coach always produces a SANITIZED, ANONYMIZED report locally. Whether
it leaves the machine is a separate, consent-gated step:

- Modes (fleet config, e.g. coach.telemetry): "never" | "ask" (default) |
  "always".
- **ask (default)**: report saved under sprint-logs/coach-reports/; the
  user is asked to consent AFTER THE FACT -- at sprint end (PR body /
  dashboard / CLI summary), with the exact sanitized text shown. The
  zero-auth mechanism: a pre-filled GitHub new-issue URL
  (github.com/Apra-Labs/apra-fleet/issues/new?title=...&body=...) -- one
  click, human-in-the-loop by construction, nothing uploads silently,
  no token handling at all.
- **always (standing consent, mainly internal/trusting users)**: approved
  once and for all via explicit config; reports auto-filed via gh CLI
  using the user's own gh auth, or a scoped token stored in the fleet
  credential store (referenced as a {{secure.*}} handle, never plaintext).
  Standing consent is per-install, revocable, and recorded in the report
  footer ("filed under standing consent").
- **never**: local reports only; nothing asks, nothing uploads.

Sanitization spec (applies BEFORE the report is even saved locally):
- Absolute paths -> stable placeholders (<work-folder>/..., <home>/...)
- Hostnames, usernames, IPs, emails -> redacted tokens
- Anything matching secret patterns (keys, tokens, {{secure.*}} values,
  env dumps) -> stripped outright, never placeholdered
- Target-repo identifiers (repo name, branch names, bead titles) ->
  optional redaction tier: internal users may keep them; the default
  anonymizes to <target-repo>, <sprint-branch>
- Code snippets: not included by default; error text is truncated to the
  minimal reproducing lines
- A stable ANONYMOUS install id (random UUID, no derivation from machine
  identity) enables cross-report dedup without identifying the user

Report content (schema sketch):
- fingerprint: normalized error-class hash (for dedup and the
  same-class-twice cap)
- context: engine version, OS, provider, phase, role being dispatched
- narrative: what failed, diagnosis, actionsTaken[], resolved: bool,
  time lost
- issueDraft: { title, redactedBody, labels: [coach-report, <class>] }
- Dedup behavior upstream: same fingerprint appends an occurrence
  comment to the existing issue rather than opening a duplicate.

## Implementation sketch (unchanged mechanics, wider trigger)

- Contract: agents/coach.md upstream in apra-pm (UPSTREAM DEPENDENCY like
  eft.11: needs an apra-pm PR + submodule pointer bump). Inputs: error
  text, phase, member, recent command history, sprint-state excerpt.
  Tools: Read + tightly-scoped Bash. Output: the report schema above.
- Engine: a single coachOnRedState() boundary called from every red-state
  interception point listed above (one choke point, not N copies), after
  layer-1 handling. Interventions ledger in sprint state; caps enforced
  engine-side as backstop; telemetry mode read from fleet config.
- Relation to the outside stabilization loop: coach handles in-run JIT
  recovery; the outside loop remains for engine-level fixes; coach
  reports feed both.

## Open design questions (to resolve before operationalizing)

1. Consent surface for "ask" mode: sprint-end CLI summary, PR body
   section, dashboard card, or all three? (Recommend: PR body section +
   dashboard card; the PR is where humans already look.)
2. Does the coach run on the ORCHESTRATOR member or the affected member?
   (Recommend: orchestrator-side dispatch that may execute allowlisted
   commands ON the affected member -- keeps one contract, avoids
   provisioning coach agents everywhere.)
3. N values: per-class cap (initial 2) and per-run cap (initial 5) --
   validate against real red-state frequency from run logs.
4. Should coach reports also feed a LOCAL knowledge base consulted on
   later invocations within the same install (self-priming), or is that
   scope creep for v1? (Bias: v2.)
5. Fingerprint algorithm: normalize paths/ids out of the error text, hash
   the remainder -- needs a worked spec with collision examples.
