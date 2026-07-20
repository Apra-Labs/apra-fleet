# Coach Role: Just-in-Time Error Resolution (design note)

Status: PROPOSED (user idea, 2026-07-20; pros/cons discussed; decision on
when to file as a feature bead pending -- recommendation was to hold until
the current sprint run concludes, then lead the next epic with it).
Recorded here so the design survives context loss.

## The idea (user's own framing)

Insert a "coach" role INSIDE the auto-sprint workflow -- an LLM agent that
knows the fleet -> workflow -> auto-sprint technology stack and can address
classes of errors that are UNFORESEEN by the deterministic engine, just in
time. Every time it intervenes it (a) collects the important aspects of the
sprint context and (b) creates an issue on the public apra-fleet GitHub
repo describing the problem AND how it was resolved. This yields field
telemetry (what users actually hit), roadmap input for future releases, and
an unblocking mechanism so users can progress instead of wedging. It
institutionalizes, inside the workflow, the stabilization-observer role a
human+agent pair played from outside during the eft dogfood runs.

Motivating example (observed live, run 15 C4): G-push rejected as
non-fast-forward -> pull --rebase failed with "cannot pull with rebase:
You have unstaged changes" -> streak failed. One minute of contextual
judgment (whose changes? stash / commit to rescue branch / discard
submodule noise?) would have healed it. The engine's scripted Tier-2
conflict resolution is already a hard-coded mini-coach; this generalizes.

## Why it fits the product thesis

The deterministic engine handles the KNOWN; execute_prompt handles PLANNED
judgment; unforeseen errors currently have no home -- they fail a streak
and waste a develop/review round. The coach is the designed home for
nondeterminism at the error boundary. Each coached class eventually
becomes typed handling (errors.mjs) in a later release -- coaching is how
unknowns migrate into determinism. Marketing tie-in: "the fleet coaches
itself in the field and reports what it learned."

## Pros

1. Completes the explore/operate model (see docs/marketing/plan.md token-
   economics section): LLM only where genuine judgment is needed, and the
   error boundary is exactly such a place.
2. Field telemetry WITH resolutions -- the best roadmap input an infra
   product can have; public-issues surface doubles as community proof.
3. User unblocking: a wedged 2am sprint becomes a healed sprint with an
   audit trail.
4. Compounding: every coach save is a candidate engine fix; the issue
   format mirrors the stabilization-log workflow that produced Issues 1-29.

## Cons and the guardrail each demands (all load-bearing)

1. ROGUE-AGENT RISK: constrained action ALLOWLIST only (stash/commit WIP
   to a rescue branch, clear a leaked lock, retry a push). Hard
   prohibitions: never force-push, never delete, never mutate bead
   verdicts, never edit code content, never act outside the member's
   working tree. Single-shot: try once, report, fall back to the normal
   failure path (no recursion; the coach is never coached).
2. MASKING BUGS (biggest risk): silent healing removes the pressure that
   produces engine fixes. Mitigations, all required: (a) EVERY
   intervention files a report -- no silent saves; (b) same-class-twice
   policy: an error class may be coached at most N times per run, then it
   must fail loudly and demand an engine fix -- healing is a bridge,
   never a home; (c) interventions appear in final-review evidence so a
   PASS with 12 coach saves reads differently from a clean PASS.
3. PUBLIC EXFILTRATION: auto-filed issues can leak repo names, paths,
   code, credential fragments inside error text. Public filing is OPT-IN
   with redaction/sanitization; default writes a sanitized report to
   sprint-logs/coach-reports/ and invites submission. Enterprise default
   must be local-only.
4. RUNTIME TOKEN COST: must not contradict operate-cheaply. Trigger ONLY
   on errors unmatched by the typed-error registry (errors.mjs defines
   "foreseen"; coach owns the complement). Cap invocations per run.
   Premium tier acceptable because invocation is rare by construction.
5. REPRODUCIBILITY: coached runs diverge from replay. Interventions are
   first-class recorded events in sprint state; mock/golden tests stub
   them deterministically.

## Implementation sketch

- Contract: agents/coach.md upstream in apra-pm (UPSTREAM DEPENDENCY,
  like eft.11 -- needs an apra-pm PR + submodule pointer bump). Inputs:
  error text, phase, member, recent command history, allowed-actions
  allowlist. Tools: Read + tightly-scoped Bash. Output schema:
  { diagnosis, actionsTaken[], resolved: bool,
    issueDraft { title, redactedBody, labels } }.
- Engine: coachDispatch() wrapper at the failure boundaries (withGitSync
  sync failures, dispatch errors not matched by errors.mjs). Interventions
  ledger persisted in sprint state; per-run cap; issueDraft gated by an
  explicit config flag for public filing (default off -> local report).
- Relation to the outside stabilization loop: coach handles in-run JIT
  recovery; the outside loop remains for engine-level fixes; coach
  reports feed both.
- Keep TARGET-AGNOSTIC: the coach knows the fleet/workflow/auto-sprint
  STACK, never the target repo's specifics (see the product-vs-dogfood
  rule in the stabilization log history).
