# Coach Role (superseded -- see escalate-to-llm-design.md)

Status: SUPERSEDED 2026-08-10 by the sprint-doctor design in
[`escalate-to-llm-design.md`](escalate-to-llm-design.md). Kept as a pointer so
links and history resolve; the full original text is in git history
(this file, prior to this commit).

The coach idea (2026-07-20): an in-workflow LLM role for error classes the
deterministic engine did not foresee -- invoked strictly after typed
handlers/ladders, single-shot, capped per error class, filing a sanitized
bug report for every intervention, failing loudly when it cannot fix.

sprint-doctor is that idea carried forward under a new name, with a stricter
decision/action split (zero-tool consult; the runner executes a bounded
action enum), an explicit environment-vs-engine-vs-task-shape triage, a
data-driven symptom/remedy registry, stagnation triggers on top of coach's
red-state events, and a generic engine-level pause/resume for human
hand-off. Every load-bearing coach idea was folded in and is credited
inline in the doctor doc: the three-layer error-handling hierarchy and
red-state taxonomy (its section 1), same-class-twice fingerprint cap,
no-recursion, interventions-as-review-evidence and deterministic test
stubbing (section 6), rescue-WIP-to-branch salvage (section 2.5), and the
consent-gated sanitized telemetry flow (section 4.4).
