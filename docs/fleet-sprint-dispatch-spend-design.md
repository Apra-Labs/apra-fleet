# fleet-sprint dispatch spend: wait budget, reviewer rounds, resume tier

Three engine behaviours that control how much a sprint's dispatches cost and how
predictable they are. All live in the generic fleet-sprint engine.

## 1. Long-run wait budget

Roles that run long suites (doer, reviewer, integ-test-runner, regression-test-runner)
used to be told to check progress every minute or two. That made them burn turns
polling. Now:

- `fleet-sprint/long-run-wait.mjs` exports `resolveLongRunWaitS(timeout_s)` =
  `min(600, floor(timeout_s / 2))`. The limit is always strictly below the dispatch's own
  inactivity timeout, so a single wait can never trip the timeout.
- `dispatchRole` appends the stated limit to the end of those four roles' prompts, using
  the same `timeout_s` the dispatch sends. The default inactivity timeout is unchanged.
- Role markdown no longer prescribes a fixed polling cadence and tells the role not to
  poll in a tight loop.

Constraint: the 600s cap equals a typical host shell tool's per-call maximum, so a wait
using the full cap can slightly exceed it. Keep wait helpers' own overhead in mind.

## 2. Reviewer rounds start fresh

The reviewer policy uses `resumeArg FRESH_SESSION_RESUME`: each review round starts a new
session instead of resuming the previous round's, which grew context and cost every round.
Continuity is carried explicitly: `buildReviewerPrompt` accepts an optional
`priorRoundFindings` summary of the previous round in the same cycle, capped at 3000
characters and wrapped as an untrusted block. A failed or degraded round is never passed on.

Unchanged: a reviewer that runs out of turns resumes its own session by explicit id, and the
planner still resumes its round session.

## 3. Resume tier follows the model that actually ran

Resume dispatches (max-turns resume, usage-limit retry, unmappable-refusal resume) must be
priced and tiered at what the main dispatch actually ran at, not at a nominal policy value.

- `resolveModelTier` resolves an inherited tier to `pricedTier` (the tier the main dispatch
  ran at), falling back to the main policy's model. The usage-limit path uses `pricedTier`.
- `execute_prompt` returns the resolved `structuredContent.model` on success and on typed
  failures. The workflow forwards it via `onModelId`, `details.model` and the session-id
  callback's `meta.model`. The `apra-fleet-client` typedef documents the field.
- The engine logs one line per settled dispatch with the requested tier and the actual
  model, or the literal `unknown` when none was reported.

Known gaps: a dispatch cut off by the client watchdog whose promise never settles writes no
model line; the `clear-round-session` degrade step is registered but no policy uses it.
