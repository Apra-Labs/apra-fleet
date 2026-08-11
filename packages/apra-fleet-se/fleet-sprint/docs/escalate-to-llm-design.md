# sprint-doctor: an escalateToLLM() mechanism for fleet-sprint

Design doc. Source path: `packages/apra-fleet-se/fleet-sprint/docs/escalate-to-llm-design.md`
Status: design -- not yet implemented. Last updated: 2026-08-10.

**sprint-doctor's job in one line:** turn a sick sprint into either a healthy sprint (bounded
auto-repair, then resume) or a cleanly dead one (abort with a diagnosis report and, where needed,
a specific human referral) -- never leave it wedged, silently burning tokens, or ambiguous.

> **Supersedes `coach-role-design.md`** (the 2026-07-20 "coach role: just-in-time error
> resolution" design note, now reduced to a pointer here). sprint-doctor is the same core idea --
> an in-workflow LLM layer for failures the deterministic engine did not foresee, positioned
> strictly AFTER typed handlers/ladders, failing loudly when it cannot fix -- carried further.
> Ideas incorporated directly from coach, credited inline where they appear: the three-layer
> error-handling hierarchy and red-state interception taxonomy (section 1), the
> same-class-twice fingerprint cap and single-shot/no-recursion rules (section 6), the
> rescue-WIP-to-branch salvage action (section 2.5), interventions as first-class final-review
> evidence and deterministic test stubbing (section 6), and the consent-gated, sanitized
> engine-flaw telemetry flow (section 4.4). Where the two designs differed, this doc's answer
> stands: decision/action separation with a zero-tool consult instead of a tool-bearing coach
> agent (section 2.1), an explicit environment-vs-engine-vs-task-shape classification coach did
> not have (section 3), a data-driven symptom/remedy registry resolving coach's open
> "self-priming knowledge base" question (section 4), and pattern-driven stagnation triggers on
> top of coach's event-driven ones (section 1).

---

## 0. Grounding: the two incidents and what the code does today

**Incident 1 (blunt sprint-wide kill).** `runner.js` stall detection: `STALL_CYCLE_LIMIT = 2`
(runner.js:5976), high-water-mark progress score = closed count + monotone verify-routed set
(runner.js:8180-8190), and at `staleCycles >= STALL_CYCLE_LIMIT` it throws `StalledSprintError`
(runner.js:8192-8227, class in errors.mjs:139-156). The throw is deliberately never caught inside
the cycle loop (errors.mjs:126-128); `isTypedAbortError()` (runner.js:4200-4210) routes it to
`finalizeAbort()`'s branch push + `[ABORTED]` PR. There is no diagnosis step between "no new
high-water mark twice" and "kill the whole sprint" -- no attempt to defer one bead, swap a member,
or distinguish a broken verifier from genuine out-of-work.

**Incident 2 (12 identical stalls on one bead).** Server-side, a confirmed stall kills the remote
pid and fails the dispatch with `details.reason: 'stalled'` (src/tools/execute-prompt.ts:1378-1385,
threshold in src/services/stall/stall-detector.ts:96, default `STALL_THRESHOLD_MS` 120s). Engine-side,
`'stalled'` is classified as an infra dispatch failure (`INFRA_DISPATCH_REASONS`, errors.mjs:427-438).
The doer catch path (runner.js:7217-7331) retries a generic throw exactly once in-cycle
(runner.js:7314-7330), attributes the failure per bead (7333-7377), and re-lanes the bead next
round/cycle -- where the identical dispatch is rebuilt and stalls again. Nothing counts *per-bead
failure streaks across cycles*, so as long as anything else in scope keeps setting new high-water
marks (or Plan/Review rounds churn), the same bead can burn premium dispatches indefinitely. A human
eventually ran `bd defer <bead> --reason ...` by hand -- `bd defer --reason` is a stock beads verb
(verified against `bd defer --help`), so the manual fix was always expressible in the orchestrator's
own vocabulary. ~15.8M output tokens were burned first.

**A caution the design must honor:** incident 2's root cause is NOT established.
"The bead was too big" (task shape) and "the member's remote Claude CLI session / environment was
wedged" (environment) are *competing hypotheses* the engine never tested -- e.g. by re-dispatching
the same bead on a different member. sprint-doctor's triage (section 3) exists precisely to
discriminate these instead of assuming either.

**Existing bounded-recovery precedents this design copies structurally:**

- *VCS-auth self-heal* (`runGitStep()`, runner.js:701-729; heal callback runner.js:1928-1937;
  provision runner.js:1616-1659): classify failure from tool output; a one-shot boolean latch
  (`authHealAttempted`) guarantees the heal fires at most once; heal must positively confirm
  success ("a failed provision must never... report success", runner.js:1654-1656); exactly one
  retry of the original operation; every transition logged with a distinguishing prefix.
- *Dolt conflict ladder* (dolt-recovery.mjs:198-344, dolt-recovery-path-b.mjs:230-339,
  dolt-recovery-tier2.mjs:76-268, composed at dolt-recovery-tier2.mjs:327-360): scripted rungs
  gated by deterministic predicates (`assessConflictGates`, dolt-recovery.mjs:118-150) that
  *return* rejection rather than throwing, so the ladder can escalate; a complete "wedged state"
  snapshot recorded before any agent is involved (`recordWedgedState`, dolt-recovery-tier2.mjs:76-95);
  exactly one agent dispatch armed with a written runbook (`docs/dolt-tier2-runbook.md`,
  dispatch at dolt-recovery-tier2.mjs:148-162), whose success is verified mechanically by the
  caller, never self-asserted.
- *LLM-auth self-heal* on non-retryable doer failures: one `provision_llm_auth`-backed heal + one
  bounded retry (runner.js:7290-7313).
- *Structured-verdict contracts*: every role dispatch passes an ajv schema from `contracts.mjs`
  (schemas vendored under `apra-pm/agents/schemas/<role>-output.json`, resolved at
  contracts.mjs:630-637, validated at 706-713), and the runner -- not the agent -- applies verdict
  side effects ("NEVER touch beads yourself... the orchestrator applies your newTasks and
  reopenIds", runner.js:3955-3957). sprint-doctor is a new role in exactly this mold.

**Engine integration surface** (packages/apra-fleet-workflow): phases are *imperative labels*, not
registered objects -- `phase(title)`/`group(title)` set async-local state and emit events
(index.mjs:510-550); the dashboard subscribes to those events (viewer/index.mjs:1052-1124), so a
new `phase('Sprint Doctor C3')` appears on the dashboard with zero viewer changes. There is no
middleware/phase-registry to extend; the correct integration is plain code at chosen points inside
`runSprintCycle()` (runner.js:4636) plus `publishState('sprint-doctor', ...)` for structured
dashboard data (index.mjs:553, viewer/index.mjs:1119).

---

## 1. Trigger / observation layer

### 1.1 What to record: a SprintHealthLedger

A small in-memory (plus JSONL-appended, for post-mortem) ledger owned by `runSprintCycle()`,
populated at the dispatch catch sites that already exist -- no new instrumentation planes:

```
recordDispatch({
  cycle, phaseLabel, role, member, beadIds[],        // position
  ok, reason,                                         // reason = err.details.reason when present
  errorSignature,                                     // normalized: reason + first line of message,
                                                      //   ids/numbers/paths stripped
  durationS, tier, costUsd,                           // from activity/pricing data already tracked
})
```

Record points (all existing catch/outcome sites):
- doer streak attribution (runner.js:7333-7377, `streakOutcomes`),
- planner retry ladder (runner.js:6244-6280),
- reviewer / plan-reviewer degraded rounds (runner.js:5468-5497, 6339-6420),
- deploy / integ-test infra failures (runner.js:7975-7999),
- the cycle-evaluation counters that already exist: `staleCycles`, `highWaterClosedCount`,
  `closedCountHistory` (runner.js:5976-5979), `reopenCounts` (5987), `verifyDispatchAttempts/
  Closures` (6014-6015), `verifyEverIds` (6002).

The `errorSignature` normalization is the load-bearing part: "identical signature repeated" vs
"different failures each time" is the primary environment-vs-engine discriminator (section 3).

### 1.2 Triggers (all must be cheap boolean checks over the ledger)

| id | Trigger | Default threshold | Catches | Why not lower/higher |
|----|---------|-------------------|---------|----------------------|
| T1 | Same bead(set) accumulates consecutive *infra-reason* dispatch failures (`INFRA_DISPATCH_REASONS` + `watchdog_timeout`) with zero closures, counted across cycles | 3 attempts | Incident 2 at attempt 3 instead of 12 | 1-2 would fire on transient blips the existing retry-once already absorbs; the existing in-cycle retry means 3 attempts ~= 2 cycles of failure |
| T2 | Same member accumulates consecutive infra failures across >= 2 *distinct* beads | 3 failures | A wedged member (hung CLI, dead session, disk) poisoning unrelated work | Requires bead diversity so a single hard bead can't impersonate a sick member |
| T3 | Cycle stagnation: `staleCycles` reaches `STALL_CYCLE_LIMIT` (runner.js:8192) | interpose once, before the throw | Incident 1: consult before killing the sprint | Reuses the tuned existing detector; doctor gets exactly one chance, then the original abort fires |
| T4 | Spend-without-progress backstop: `budget.spent()` delta since the last new high-water mark exceeds `doctor_spend_trigger_usd` | min(15% of `budget.total`, $25); $25 flat when budget unset | Token burn that outruns cycle counters (the 15.8M-token shape) | Uses the existing budget plumbing (`context.budget`, BudgetExceededError check in workflow index.mjs:760-765) |
| T5 | Unforeseen red state: a typed handler/retry ladder exhausted itself on a failure class with NO recognized signature and no registry match -- unrecognized dispatch reasons after existing retries, sync-bracket failures the dolt/git ladders could not close, deploy/integ/harvester phase crashes | single-shot: one consult per red event | The failures nobody predicted -- the deterministic engine's blind spots | Event-driven, not pattern-driven: firing once immediately is correct because layer-1 handling has already been exhausted by definition |

T1-T4 are pattern-driven (repetition/stagnation); T5 is event-driven and comes from the earlier
coach design, whose error-handling hierarchy this layer preserves verbatim: (1) typed handlers
and ladders -- deterministic, free, NEVER preempted by the doctor; (2) doctor -- JIT judgment,
tokens, invoked only when layer 1 has no match or its handling failed; (3) fail loudly --
if the doctor cannot resolve or its caps are hit, the normal failure path proceeds unchanged,
and the doctor never suppresses a failure it could not fix. Coach's red-state interception
taxonomy (streak failure after ladder exhaustion, unrecognized dispatch reasons, sync failures
after Tier-2, phase-level crashes, contract violations after built-in retry, member
unreachable, auth expiry mid-run, and workflow-level aborts -- the last as evidence collector
even when unresolvable) is the seed list of T5 interception points, wired through the same H1
record-only sites plus the terminal catch in `main()` for the evidence-collector case.

False-positive guards:
- No trigger except T1 may fire in a cycle whose `progressScore` set a new high-water mark
  (a slow-but-progressing sprint is left alone).
- T1 additionally requires all attempts in the streak be infra-reason failures OR share one
  `errorSignature` -- a bead failing three times with *different, substantive* errors (schema
  invalid, then review reopen, then test failure) is the develop/review loop working, not a stall.
- All four triggers are debounced by the consult ledger: a (trigger, bead-or-member) pair that
  already produced a consult this sprint cannot re-fire unless the doctor's prescribed action was
  executed and a new failure occurred *after* it.

### 1.3 Hook points (cheapest given the engine's shape)

Since phases are imperative (no registry -- workflow index.mjs:510-550), hooks are code:

- **H1 (record-only):** inside the existing catch/attribution sites listed in 1.1. No dispatching
  from inside `parallel()` branches -- H1 only sets a `pendingConsult` flag with its evidence.
  (Dispatching the doctor from inside a parallel doer branch would interleave with sibling
  streaks and violate the per-branch async-local phase store, index.mjs:1435-1471.)
- **H2 (consult point):** Cycle Evaluation (runner.js:8110-8238), immediately after the fresh
  `closedBeadsNow` read and progress-score update -- the one serialized, fresh-state point per
  cycle. Runs under `phase('Sprint Doctor C<n>')` so it is dashboard-visible for free.
- **H3 (abort interposition, T3):** replace the direct `throw new StalledSprintError(...)` at
  runner.js:8219 with: consult once -> apply action -> allow at most one further cycle; if the
  next evaluation still sets no new high-water mark, throw the original `StalledSprintError`
  *with the doctor's verdict attached in `details`* so the abort report explains what was tried.
- **H4 (mid-cycle fast path for T1/T2 only):** after Develop's streak outcomes are folded
  (post-`parallel()`, around runner.js:7498 before Review), so a bead on its 3rd consecutive
  infra failure does not wait for the cycle boundary while Review/Deploy/IntegTest burn more
  dispatches on a doomed cycle. Same consult machinery, same caps.

---

## 2. sprint-doctor phase contract

### 2.1 Decision architecture: doctor decides, orchestrator does

The single most important boundary decision: **the doctor's in-sprint decision call gets ZERO
tools.** The runner pre-assembles all evidence into the prompt; the doctor returns a
schema-validated verdict; the runner executes the chosen action through its own existing verbs.
This mirrors the reviewer contract (verdict data -> orchestrator applies, runner.js:3955-3957) and
the Tier-2 dolt posture (dispatch never self-judges success; the caller verifies mechanically,
dolt-recovery-tier2.mjs:148-162).

Why zero tools rather than a restricted toolset:
- It is the only enforcement that is structural rather than configurational. The fleet has a
  member-harness permission mechanism (`compose_permissions`, src/tools/compose-permissions.ts:15-22,
  writing profiles like `skills/fleet/profiles/base-reviewer.json` onto the member's own
  `.claude/settings.local.json`) -- but `execute_command` itself has **no allowlist** (arbitrary
  shell string, src/tools/execute-command.ts:26-34), and mutating a member's permission profile
  mid-sprint for one dispatch would leak into every subsequent dispatch on that member. A
  tool-less dispatch cannot edit fleet-sprint source, cannot edit the target project, cannot shell
  anything, no matter what its prompt is tricked into wanting.
- It converts the prompt-injection surface (member log tails are attacker-influenceable text) from
  "possible arbitrary action" into "possibly skewed choice among N enumerated actions", which the
  engine further bounds (section 6).

Mechanically: the doctor is dispatched like every other role -- `agent()` -> `execute_prompt` at
tier `'premium'` -- as a new persona (`sprint-doctor.md` vendored beside the other role personas
in `apra-pm/agents/`, schema beside them in `apra-pm/agents/schemas/sprint-doctor-output.json`,
re-exported through contracts.mjs's `resolveOutputSchema` pattern, contracts.mjs:630-637). The
persona's frontmatter declares NO tools; `max_turns` small; the engine's schema-repair loop
(index.mjs:759-1079, `schemaRetries` default 2) is the only retry it gets.

**Probe round (bounded):** some diagnoses need one more observation. Rather than granting tools,
the verdict schema includes an optional `probes[]` request drawn from a closed enum; the runner
executes them and re-dispatches the doctor once (max ONE probe round per consult) with results
appended. Probe enum (all runner-executed, all read-only except the last):

```
member_cli_version <member>      -> execute_command: provider CLI --version
member_workspace_state <member>  -> execute_command: git status --porcelain && git log -1
member_disk_free <member>        -> execute_command: platform-appropriate disk-free
member_session_state <member>    -> fleet_status / member_detail snapshot
bd_show <id...>                  -> orchestrator-side bd show --json
log_tail <which> <kb>            -> more of a log the runner already holds
cross_member_redispatch <beadId> -> NOT a probe; must be requested as the
                                    retry_different_member ACTION (it costs a full dispatch)
```

### 2.2 Inputs (assembled by the runner, schema-checked via the validateRoleInput pattern, contracts.mjs:818+)

- Sprint position: branch, base, goal, cycle/`max_cycles`, current phase label, members + roleMap,
  budget `{total, spent}` (runner.js:2356-2362 arg plumbing).
- Trigger record: which of T1-T5 fired, with its evidence rows from the health ledger.
- The triggering bead(s): full `bd show --json`, plus scope summary counts (open/in_progress/
  blocked/deferred/closed at goal priority -- same reads the Cycle Evaluation already does,
  runner.js:8134-8153).
- Dispatch/stall history for this sprint: the ledger rows for the bead and member involved, plus
  per-member aggregate failure counts and `errorSignature` frequency table across ALL members
  (this cross-member table is what makes environment-vs-engine triage possible).
- Log tails: last N KB of the runner's own sprint log; last N KB of the relevant member-side
  dispatch output the server already captured. Sizes capped (default 16KB each) to bound cost.
- Doctor's own consult history this sprint (verdicts + outcomes) -- required for the no-repeat
  circuit-breaker and so it never re-prescribes a failed remedy blind.
- The symptom/remedy registry (section 4) -- injected as data, not baked into the prompt text.

### 2.3 Output contract (ajv schema; enum-closed; engine logs `evidence` verbatim)

```jsonc
{
  "classification": "ENVIRONMENT | ENGINE_FLAW | TASK_SHAPE | UNCLEAR",
  "confidence": "high | medium | low",
  "evidence": ["..."],                 // short factual bullets; logged verbatim to sprint log
  "matchedRegistryEntry": "id | null", // which symptom entry (section 4) matched, if any

  "action": {
    "kind": "repair_environment_then_retry | retry_same | retry_different_member |
             swap_model_tier | defer_bead | reduce_scope_and_continue |
             abort_sprint | pause_for_human",
    // kind-specific params, each independently schema-bounded:
    "repairs": ["reprovision_llm_auth", ...],   // closed enum, section 4 registry ids
    "member": "name",                            // must be in the sprint's member list
    "tier": "cheap|standard|premium",
    "timeoutMultiplier": 1.5,                    // capped at 2 in schema
    "beadIds": ["..."], "reason": "...",
    "salvageWip": false                          // opt-in rescue-branch commit of uncommitted
  },                                              //   member WIP before defer/abort (section 2.5)

  "probes": ["member_session_state <m>", ...],   // optional; triggers the single probe round
                                                  // INSTEAD of an action (round 2 must act)

  "engineFlawReport": {                          // required when classification=ENGINE_FLAW
    "symptom": "...", "suspectedComponent": "...",
    "reproEvidence": ["..."], "proposedBeadTitle": "..."
  },

  "proposedRegistryEntry": { ... },               // optional, section 4.3 -- logged for human
                                                  // review, NEVER auto-applied

  "humanActionRequired": {                        // optional; REQUIRED when action is
    "summary": "...",                             //   pause_for_human or abort_sprint with
    "suggestedCommands": ["..."],                 //   classification ENGINE_FLAW/UNCLEAR
    "relevantFiles": ["..."], "relevantBeadIds": ["..."],
    "whyBeyondBounds": "..."
  },

  "notes": "..."
}
```

Contract rules the engine enforces (not the prompt):
- Exactly one of `action` / `probes` per response; a probe-round response must contain `action`.
- Every mutating consequence is executed by the runner from these fields. The doctor never runs
  `bd`, never touches git, never calls MCP tools -- it has none.
- A schema-invalid response after the repair loop => the consult FAILS and the engine falls back
  to pre-doctor behavior (section 6, strictly-additive rule).

### 2.4 The humanActionRequired referral block

Whenever the correct fix is outside sprint-doctor's own permission boundary -- an engine code fix,
a credential type it cannot self-provision (`AUTH_DENIED` in the VCS taxonomy is explicitly
"an operator must grant access", errors.mjs:29-32), OS/SSH-level intervention on a member, or a
genuine judgment call -- the verdict must carry a *referral*, written the way a doctor writes one:
specific, actionable, and honest about why it is being handed off. Vague "escalate to human" is a
schema-legal-but-rejected shape: the engine treats a `pause_for_human`/ENGINE_FLAW verdict with an
empty or command-free `humanActionRequired` the same way `isReviewerContractViolation()` treats an
actionless CHANGES_NEEDED (runner.js:3552-3557) -- one re-ask, then the consult fails.

**Example A -- environment case beyond bounds (member needs OS-level attention):**

```jsonc
{
  "classification": "ENVIRONMENT", "confidence": "high",
  "evidence": [
    "5 infra failures on member 'mac-01' across 3 unrelated beads (T2), signatures all 'stalled'",
    "probe member_cli_version timed out after 120s; member_disk_free never returned",
    "same beads dispatched to 'linux-02' completed normally this cycle"
  ],
  "matchedRegistryEntry": "hung-remote-session",
  "action": { "kind": "pause_for_human", "reason": "member 'mac-01' unresponsive below the CLI layer; remaining work continues on other members" },
  "humanActionRequired": {
    "summary": "Member 'mac-01' does not respond to even trivial execute_command probes; the fleet server's kill/stop verbs cannot reach whatever is wedged (likely the SSH channel or the host itself).",
    "suggestedCommands": [
      "ssh <mac-01 host> 'pkill -f <provider CLI binary>; uptime; df -h'",
      "apra-fleet exec --member mac-01 -- <provider CLI> --version   # after the ssh-side kill, to confirm the channel recovered"
    ],
    "relevantFiles": [], "relevantBeadIds": [],
    "whyBeyondBounds": "Doctor repairs are limited to fleet MCP verbs (stop_prompt, member_reservation force_release, provision_*); all were attempted or unreachable. Host-level access requires operator SSH."
  },
  "notes": "Sprint can continue at reduced parallelism; nothing suggests a bead or engine problem."
}
```

**Example B -- real engine bug (code fix needed; doctor must not touch source):**

```jsonc
{
  "classification": "ENGINE_FLAW", "confidence": "medium",
  "evidence": [
    "3 'stalled' kills (T1) on one bead, all on premium-tier dispatches; stall threshold is a flat 120s regardless of tier",
    "member-side output shows steady token streaming right up to each kill -- long single-turn reasoning, not silence",
    "cross-member retry reproduced the identical kill on a second member, ruling out a member-environment cause"
  ],
  "matchedRegistryEntry": null,
  "action": { "kind": "retry_same", "timeoutMultiplier": 2, "reason": "mitigation only; root cause is engine-side" },
  "engineFlawReport": {
    "symptom": "Confirmed-stall detector kills healthy premium-tier dispatches whose single-turn latency exceeds the flat stall threshold",
    "suspectedComponent": "stall threshold configuration (server-side stall detector) vs model-tier-aware dispatch budgets",
    "reproEvidence": ["ledger rows #14,#17,#21: identical kill at ~120s of streaming output"],
    "proposedBeadTitle": "sprint-doctor finding: stall threshold not tier-aware; premium dispatches killed mid-stream"
  },
  "humanActionRequired": {
    "summary": "If the doubled timeout retry also dies, this needs an engine change: make the stall threshold tier- or dispatch-aware. Doctor cannot and must not patch engine source.",
    "suggestedCommands": [
      "grep -n STALL_THRESHOLD <fleet server source>   # confirm the flat default",
      "file the proposedBeadTitle above in the ENGINE's own tracker (not this project's)"
    ],
    "relevantFiles": ["<engine stall-detector module>"],
    "relevantBeadIds": ["<the stalled bead id>"],
    "whyBeyondBounds": "Source modification of fleet-sprint/fleet server is outside the doctor's action set by design; only defer/mitigate/report are permitted."
  },
  "notes": "Bead itself looks healthy; do not defer it yet -- mitigation may complete it."
}
```

(Note example B's file references are deliberately generic in the *skill/prompt* -- the doctor
names components from evidence it was shown, not from hardcoded engine paths; see section 7.)

### 2.5 Action executor: what the runner does with each verdict

| action.kind | Executor mapping (existing verbs only) | Bound |
|---|---|---|
| repair_environment_then_retry | Registry remedies (section 4): `provision_llm_auth` / `provisionVcsAuthForMember()` (runner.js:1616-1659) / `stop_prompt` + `memberSessionGuard.killIfAlive` (used at runner.js:7260) / `member_reservation force_release` (src/tools/member-reservation.ts:17-27) / dolt Path A refresh (gated, dolt-recovery.mjs:118-150) / `git fetch` via `command()` | each remedy latched once per member per sprint (the `authHealAttempted` pattern, runner.js:703); exactly one post-repair retry of the failed dispatch |
| retry_same | one redispatch with `timeout_s` scaled by `timeoutMultiplier` (<= 2 -- matches the integ-test 2x ceiling precedent in the stabilization log, and open bead apra-fleet-aw8's escalate-timeout-on-retry recommendation) | once per bead per sprint |
| retry_different_member | re-lane the bead via existing streak re-lane, with a doctor-set member exclusion respected by streak assignment (member selection machinery runner.js:4890-4926) | once per bead; doubles as the environment-vs-task-shape probe |
| swap_model_tier | runner-side per-bead tier override map consulted where the bead's `metadata.model` tier is read (runner.js:2664-2665); no `bd update` of the bead's stored metadata (keeps the DB as the planner wrote it) | one swap per bead |
| defer_bead / reduce_scope_and_continue | `bd defer <id> --reason "<reason>"` via orchestrator `command()`. **Implementation trap, called out now:** `NOT_DONE_STATUSES` includes `deferred` (runner.js:284), so a deferred bead still counts as open-at-goal in the completion check (runner.js:8134-8138) and contributes nothing to `progressScore` -- a naive defer would wedge the sprint at "can never complete" and read as continued stagnation. The executor must (a) add doctor-deferred ids to an exclusion set filtered out of `openAtGoal` exactly as `decomposedParentIds` already is (runner.js:8138), and (b) credit them to the progress score via a monotone set, the `verifyEverIds` pattern (runner.js:6002, 8180) | max `doctor_max_defers` (default 3) beads per sprint; each defer's reason is the doctor's `evidence` + `reason`, appended to the bead's notes by `bd defer --reason` itself |
| abort_sprint | throw new `SprintDoctorAbortError` (extends WorkflowError, added to `isTypedAbortError()` runner.js:4200-4210) so the existing terminal machinery produces the record + `[ABORTED]` PR, with the doctor's full verdict in `details` and in the PR body | terminal by definition |
| pause_for_human | A THIN caller of the generic engine pause primitive (section 2.6): the runner calls `workflow.requestPause(reason)` at the consult point and the engine's own gate does the rest -- the consult point sits at Cycle Evaluation with all sync brackets closed, so the pause takes effect at the very next activity entry. The paused card carries the doctor's `humanActionRequired` block via `publishState('sprint-doctor', ...)` (dashboard sees it through the state event, viewer/index.mjs:1119). Member reservations are released while paused and re-acquired on resume (section 2.6.4). A human resumes via the viewer/supervisor Resume control | **No timeout, no auto-abort.** Paused is a safe, durable, indefinitely-holdable state (rationale in 2.6.4); "never wedged" means never *ambiguous* -- a paused sprint is loudly, visibly paused with a written referral, not silently dead |

Salvage pre-step (from coach's action allowlist): before executing `defer_bead`,
`reduce_scope_and_continue`, or `abort_sprint`, the executor MAY -- when the verdict sets
`salvageWip: true` and the failed member's tree has uncommitted changes -- commit that WIP to a
clearly-named rescue branch (`rescue/<sprint-branch>/<beadId>-<timestamp>`) and push it, never
touching the sprint branch itself. This upgrades the "failed-attempt debris is discarded by
design" status quo (section 2.6.3) to "discarded but recoverable" for exactly the cases where a
human may want to inspect what the stuck attempt actually did. Coach's hard prohibitions apply
verbatim to this executor path: never force-push, never delete branches/files, never mutate
bead verdicts, never edit code content.

### 2.6 Pause/resume as a workflow-engine primitive (generic; fleet-sprint is only a client)

Ownership decision: pause/resume is implemented ONCE, in `packages/apra-fleet-workflow`, usable
by any workflow script -- NOT as fleet-sprint checkpoint calls sprinkled through runner.js.
Because fleet-sprint's cycles and rounds are themselves just script loops over the engine's
`agent()`/`command()` activities under `phase()`/`group()` labels (runner.js registers nothing;
it merely calls the primitives -- see section 0), a single engine-level gate gives cycles,
rounds, and every future workflow script pause support with zero script cooperation.
sprint-doctor's `pause_for_human` is a thin caller of this primitive, not its owner.

Scope note: this is deliberately NOT open bead `apra-fleet-9ub`'s full journaled
`interrupt()` (LangGraph-style suspend-with-resume-value, `'paused'` as a resumable terminal
status, journal replay via `computeActivityKey`/`completedByKey`, journal.mjs:106-221, off by
default per journal.mjs:14-19). 9ub stays open for same-run resume across process restarts; the
gate designed here is the in-process mechanism it would later journal.

#### 2.6.1 The gate: engine-owned, at activity entry

New primitives on `FleetWorkflow`, siblings of `requestStop()` (index.mjs:499-503):

- `requestPause(reason)` -- sets a pause-pending flag + reason, emits `'pause:requested'`.
  Touches NO AbortController: nothing in flight is ever rejected by a pause.
- An internal `await this._pauseGate()` at the top of `agent()` (with the budget check,
  index.mjs:760-765) and at `command()`'s equivalent entry. Both methods are async and always
  awaited by callers -- that is precisely what makes them valid park points. When no pause is
  pending the gate is one flag read; when one is pending (and the guard permits, 2.6.3) it emits
  `'paused'`, flips run state, and parks until `requestResume(value?)` resolves it (emitting
  `'resumed'`). Events flow to dashboards exactly like the existing `'phase'`/`'state'`/`'log'`
  events (viewer/index.mjs:1052-1124).

Answering the "start of every phase AND every activity" framing precisely: `phase()`/`group()`
are *synchronous label-setters* (index.mjs:510-550) invoked unawaited at every runner.js call
site (e.g. 6133, 6804, 7733, 8973) -- making them awaitable gates would be an API break for
every existing script. But behaviorally the start of a phase IS its first activity: nothing a
phase does before its first `agent()`/`command()` call has side effects beyond labels/logs. So
one gate at activity entry, whose `'paused'` event reports the current phase/group from the
async-local run store (`_currentPhase()`/`_currentGroup()`, index.mjs:432-442), delivers full
"phase-start + activity-start" coverage from a single engine-owned function. `parallel()`
branches each park at their own next gated call (branch-forked stores, index.mjs:1435-1471);
the engine declares the run paused when a pause is pending and its in-flight activity count
(the `activity:start`/`activity:end` accounting it already emits) reaches zero.
`requestStop()` on a paused/pausing run still works: the parked gate promise also rejects on
the run's abort controller, so `CancelledError` unwinds normally.

#### 2.6.2 Why an await gate and not a thrown pause signal

The rejected alternative: throw a `PauseRequested` signal at request time (or inject it into the
next `agent()`/`command()` call), caught only by the engine. Any script-VISIBLE exception is
disqualified by runner.js's own error handling: its broad catch blocks swallow or misroute
anything not on their curated lists (doer generic retry arm runner.js:7314-7330, planner ladder
6244-6280, `runGitStep()` 701-729, dolt ladder composition dolt-recovery-tier2.mjs:223-268), and
the one exception that must pierce them today -- `CancelledError` -- survives only via explicit
guards at every layer (index.mjs:1100-1108, runner.js:4187-4189, 4201, 4227). A second
must-pierce exception type would mean auditing every broad catch in a 9400-line file forever.
The engine-internal await gate has no such problem: it throws nothing, so script catch blocks
cannot see an exception that never exists -- the script observes only a slow-returning
`agent()`/`command()` call.

One real hazard remains for the gate, arriving through timers instead of catches:
script-side deadlines racing composites that contain gated calls. Concretely,
`withDispatchWatchdog()` races an already-started dispatch promise against
`timeoutS + grace` with a deliberately non-unref'd timer (runner.js:4511-4548), and the planner
dispatch sites nest it around `agent()` inside `withGitSync` brackets (runner.js:6178, 6182,
6676). A gate that parked inside such a raced promise would burn paused wall-clock against the
timer, fire a spurious `watchdog_timeout`, and the generic retry arms would misroute the pause
as a dispatch failure -- the old failure mode through a different door. The clean-barrier guard
in 2.6.3 closes this structurally: the gate never parks while a sync bracket is open, and every
watchdog-raced composite in runner.js lives within a bracket. One mechanism resolves both the
timer race and the durable-state problem below.

#### 2.6.3 Clean-state invariant: member-agnostic resume by design

The subtle gap: "between activities" is not the same as "clean". Inside a
`withGitSync` bracket (runner.js:4999; ordered teardown in `syncMemberAfterOrdered`,
runner.js:1066), the member holds committed-but-unpushed git commits and unpushed dolt
mutations until the post-dispatch G-push/D-push teardown runs. An in-process, same-member
resume is safe anywhere (the parked call resumes and the bracket completes) -- but a
different-member or relaunch-grade resume from a mid-bracket pause would lose that unpublished
work outright. That is data loss, not a pull-the-branch inconvenience.

**Invariant adopted (brief's candidates (a)+(b) together):** a pause only *takes effect* at an
activity entry where no sync bracket is open -- i.e. every piece of member state the engine
considers real is committed AND pushed (git to origin, dolt to the shared remote). A pause
requested mid-bracket stays pending, with the UI showing "pausing...", until the first clean
activity entry -- the identical deferral UX already specified for the human-initiated case, now
serving both triggers.

Mechanism: the engine exposes `setPauseGuard(fn)` -- optional, one registration per run. With a
pause pending, each gated entry consults the guard and defers parking while it returns false.
fleet-sprint's ENTIRE pause awareness is registering a guard backed by an open-bracket counter
incremented/decremented at `withGitSync` entry/exit and around the orchestrator's own
`DoltSync.syncBefore/After` brackets (runner.js:8124). No checkpoint calls, no other runner.js
changes. Scripts that register no guard get pause-at-any-activity-entry -- correct for
single-member or stateless workflows.

Sweep for states the invariant cannot cover (brief's candidate (c)):
- *Uncommitted WIP during an agent turn:* unreachable by pause -- the gate never interrupts an
  in-flight activity; a member's tree only holds mid-turn WIP while its dispatch is running.
- *Uncommitted debris from failed attempts:* can exist between activities, but it is already
  discarded-by-design state -- retries run fresh `resume:false` sessions that redo the work
  (confirmed behavior recorded in bead apra-fleet-aw8), and pre-dispatch brackets re-sync the
  workspace. The invariant deliberately protects exactly the state the engine treats as real:
  committed+pushed. Nothing new is lost that today's retry path does not already discard.
- *Member-local runtime state after Deploy:* the one genuine partial-coverage case. A pause
  between Deploy and Integ Test (the old CP2 boundary, runner.js:7815) is git/dolt-clean, but
  the deployed instance lives on the deploy member. Verdict: NOT a non-pausable region --
  same-member in-process resume is fully safe there; a relaunch-grade or different-member
  resume simply re-runs Deploy (deploy.md-driven, re-runnable by its own phase contract, and
  the cycle re-derives from pushed state). Documented, not forbidden.

Comparison with the obvious simpler alternative -- a fixed list of hand-placed checkpoint calls
in runner.js (cycle top runner.js:6074, post-Deploy 7815, post-evaluation 8238,
pre-Finalization 8397, pre-Publish-PR 8973, the same boundary list bead 9ub sketched): every
one of those points is a zero-open-bracket boundary, so all of them remain reachable pause
points under the guard -- they are simply members of the guard's larger effective set, which
also includes between-round and between-streak activity entries. The guard therefore strictly
dominates the hand-placed list: better worst-case pause latency ("next clean activity entry"
instead of "end of cycle"), no script-author burden, and no risk of a forgotten checkpoint in a
future phase. The fixed list survives only as a *description* of where pauses typically land.

**Resume is member-agnostic by design, and re-sync is unconditional.** On resume -- same member
or different, in-process or relaunch -- the resume path re-syncs every re-acquired member as a
first-class step, not a defensive one: `git fetch` + the ensure-branch probe
(`decideEnsureBranchAction`, runner.js:4583-4634) + `bd dolt pull`. This is *sufficient*, not
merely prudent, precisely because the invariant guarantees there was never local-only state to
lose at a pause-effective point. v1's in-process resume still prefers and requires the SAME
member set (member identities are baked into in-flight closures and the roleMap
specialist/generalist math, runner.js:4890-4926) and fails cleanly back to "still paused",
naming the unavailable member(s), when one cannot be re-reserved. The invariant's payoff is
that the coarse escape hatch -- relaunching the sprint with ANY member set -- is now provably
lossless rather than best-effort, and 9ub's future same-run resume inherits the same guarantee.

#### 2.6.4 Paused is a safe, indefinite state -- what bounds it instead of a timeout

Deliberate decision: there is NO pause timeout and NO auto-abort. A pause that degrades to a
destructive action on human response time is a ticking bomb -- the human may be asleep, which is
the product's own value proposition. What actually needs bounding, and what doesn't:

- **Member reservations (the real starvation concern).** The supervisor reserves each member for
  the sprint at launch, and Stop = `POST /api/reservations/:sprintId/force-release` (kills child +
  releases, dashboard.mjs:279-282). A paused sprint holding reservations indefinitely would starve
  every other sprint wanting those members. So: on entering `'paused'`, the runner releases each
  member via `member_reservation action:'release'` (owner-checked, member-reservation.ts:54-68);
  on resume it re-reserves (action `'reserve'`). Reserve is idempotent for the same sprint id
  (member-reservation.ts:49-51) and fails CLEANLY when another sprint took the member in the
  interim ("already reserved by <owner>", member-reservation.ts:42-44) -- in that case **resume
  fails with a clear message naming the unavailable member(s) and the sprint STAYS paused**; it
  never silently proceeds on a substitute member (member identity carries work folders, sessions,
  and credentials). The operator retries resume later, or relaunches the sprint -- which the
  clean-state invariant (2.6.3) now makes provably lossless. Either way, every re-acquired
  member goes through the unconditional resume re-sync of 2.6.3 before any dispatch, since
  another sprint may have legitimately used the member meanwhile.
- **Cost: nothing to bound.** A paused run dispatches nothing and spends nothing --
  `budget.spent()` is flat while parked; the only footprint is the idle runner process and its
  viewer port. This is unlike the doctor's own consult loop, which does real premium dispatches
  and therefore does carry hard caps (section 6).
- **Visibility, not force.** The bound on an indefinite pause is that it is *loud*: the viewer
  and supervisor both show "paused since <time>" with the reason/referral card (2.6.5), and the
  supervisor watchdog must be taught that a live-pid paused run is `PAUSED`, not stall-suspect --
  it already only classifies and never remediates (watchdog.mjs:36-38), so this is a state label,
  not a behavior change. One genuinely useful *informational* indicator: the sprint branch ages
  against base while paused, so the paused card should show "base has moved N commits since
  pause" -- information for the human, never a trigger for automatic action.
- **Process death while paused.** Keeping the process alive while paused is cheap (a parked
  promise), and v1 relies on it: same-run in-place resume requires the live process. If the
  process dies anyway, this is NOT catastrophic and NOT new: 9ub's own investigation confirmed
  the system is already resumable at full-process-restart granularity -- beads and git are the
  durable source of truth, and relaunching the identical invocation skips closed work (at the
  cost of re-running Plan). True same-run resume across a process restart is exactly the
  journaled part of 9ub (journal.mjs replay is already scheduler-independent across `parallel()`
  interleavings, journal.mjs:60-100, but wiring `'paused'` as a resumable terminal status is the
  deferred design work) -- explicitly out of scope here, explicitly NOT foreclosed.

Net: an indefinitely-paused sprint with released reservations, zero spend, and a loud
"paused since <t>" card is a genuinely safe resting state. No forced resolution, full stop.

#### 2.6.5 Viewer / supervisor surfacing

- **Per-run viewer** (the natural sibling of Stop): a Pause button beside the existing Save/Stop
  buttons in `HTML_TEMPLATE` (viewer/index.mjs:186-187), backed by `POST /pause` and
  `POST /resume` routes beside `POST /stop` (viewer/index.mjs:1253-1288; the stop route calls
  `workflow.requestStop(...)` at 1278 -- pause calls `workflow.requestPause(...)`, resume calls
  `workflow.requestResume()`). Button state machine driven by the engine events the viewer
  already consumes: Pause -> (on `'pause:requested'`) disabled "Pausing... (at next clean point)"
  -> (on `'paused'`) "Paused since <t>" badge + Resume button + the reason/referral card rendered
  from the `sprint-doctor` state namespace when the pause was doctor-forced.
- **Supervisor Sprint Stack**: Pause/Resume buttons as siblings of the existing per-row
  Stop/Restart buttons (dashboard.mjs:128-137), implemented in the same
  source-string-script pattern as `SPRINT_STOP_SCRIPT`/`SPRINT_RESTART_SCRIPT`
  (dashboard.mjs:248-437). Crucially Pause does NOT reuse Stop's force-release route (which
  kills the child, dashboard.mjs:279-282): it proxies to the child run's own viewer `/pause`
  (the supervisor already tracks each sprint's viewer port for the live-view link) or an
  equivalent `POST /api/sprints/:id/pause` forwarding route. The row's status cell gains
  `pausing`/`paused since <t>` states; watchdog labels the run `PAUSED` per 2.6.4. These are
  viewer/supervisor HTTP routes, not MCP tool surface -- no `apra-fleet-client` sync is
  triggered (per the repo rule that client sync tracks `src/tools/*`).

---

## 3. Environment-vs-engine triage (first-class)

Every consult classifies the incident BEFORE choosing an action, and the classification is an
explicit output field. Buckets:

1. **ENVIRONMENT** -- engine logic fine; execution environment broken: stale/expired VCS or LLM
   credentials, wedged reservation, dead/hung remote session, stale dolt/beads clone, disk/network
   flakiness, missing not-yet-synced branch, member CLI version drift.
2. **ENGINE_FLAW** -- a real fleet-sprint bug/gap: bad retry logic, a mutex not wired on some
   path, stall threshold too aggressive for a tier, a phase invariant violated.
3. **TASK_SHAPE** -- the bead itself is too large/ambiguous/mis-specified for any doer to land
   (the hypothesis the incident-2 human acted on).
4. **UNCLEAR** -- evidence insufficient; handled by the cheap-first policy below.

### 3.1 Discriminating signals

| Signal | Points to | Rationale |
|---|---|---|
| Identical `errorSignature` across unrelated beads AND multiple members | ENVIRONMENT (shared substrate: credentials, dolt remote, network) -- unless the signature names an engine invariant (e.g. a sync-bracket or mutex error string), then ENGINE_FLAW | Bead content varies, member varies, failure doesn't => cause is in what they share |
| Failures confined to ONE member, across >= 2 distinct beads (T2) | ENVIRONMENT (that member): hung CLI session, disk, version drift | Work varies, host doesn't |
| Failures confined to ONE bead, reproduced on a SECOND member (`retry_different_member` probe) | TASK_SHAPE, or ENGINE_FLAW if the failure mode is mechanical (e.g. killed mid-stream at a fixed time offset) | Host varies, work doesn't |
| `details.reason` in {'auth'} or VCS kind in {AUTH_EXPIRED} | ENVIRONMENT with a known registry remedy | Already classified by errors.mjs:363-394 / the VCS taxonomy (errors.mjs:25-76) |
| 'stalled'/'watchdog_timeout' ONLY on premium-tier dispatches, member-independent, with output streaming up to the kill | ENGINE_FLAW (threshold vs tier mismatch) | The stall detector measures inactivity; a slow-but-streaming or long-single-turn premium call is a known blind spot (stabilization log Issue 32: `claude -p` prints nothing until turn completion) |
| Fixed-time-offset deaths (~300s, ~120s, ~3600s) matching known knobs | ENGINE_FLAW or config, not TASK_SHAPE | Timeouts kill at their configured value; content-caused failures land at varied offsets |
| `bd show` of the bead: no acceptance criteria, XL scope markers, prior reopen-thrash (`reopenCounts` > REOPEN_THRASH_LIMIT, runner.js:5986-5995) | TASK_SHAPE | The bead was already oscillating before it started stalling |

### 3.2 Policy for UNCLEAR: cheap, reversible, environment-first

Environment repairs are cheap, latched, and reversible-or-idempotent; defer/abort destroys sprint
momentum. So the doctrine, encoded in the skill and the registry ordering:

1. Attempt matching registry remedies (section 4) -- at most one pass, each remedy latched.
2. If no registry match or remedies verified-failed: ONE `retry_different_member` (the
   discriminating probe -- it converts UNCLEAR into ENVIRONMENT-on-that-member vs
   TASK_SHAPE/ENGINE_FLAW with a single data point).
3. Still failing: treat as bucket 2/3 -- `defer_bead` with a written reason (exactly the human's
   incident-2 remedy, now automatic and evidenced) and continue reduced scope; or `abort_sprint`
   when the bead IS the sprint's whole scope; plus `engineFlawReport` when mechanical evidence
   points engine-ward; plus `humanActionRequired` whenever the residual fix is beyond bounds.

### 3.3 Incident replays under this design

- *Incident 2:* T1 fires at attempt 3. Probe round: `member_session_state` + `member_cli_version`
  on the stalling member. If the member is wedged -> registry `hung-remote-session` remedy
  (stop_prompt/kill + one redispatch); if healthy -> `retry_different_member`; if reproduced ->
  `defer_bead` with the evidence trail as the reason + TASK_SHAPE (or ENGINE_FLAW if the kills are
  mechanical). Worst case ~5 dispatches and one premium consult instead of 12 stalls + manual
  archaeology.
- *Incident 1:* T3 interposes one consult before `StalledSprintError`. If the verify-routed-never-
  closed pattern is present (the detector already computes it, runner.js:8209-8217), the doctor
  can distinguish "verifier broken" (ENVIRONMENT/ENGINE_FLAW: check the integ playbook probe
  output, deploy failures list) from "genuinely out of work" and choose defer/reduce-scope/abort
  with a report instead of a bare kill.

---

## 4. Symptom/remedy registry (extensible by data, not redesign)

### 4.1 Shape

A data file, versioned with fleet-sprint, separate from all logic:
`packages/apra-fleet-se/fleet-sprint/doctor-registry.mjs` (a frozen exported array -- .mjs rather
than JSON so entries can carry regexes and doc comments, exactly like the taxonomy tables already
in errors.mjs; still pure data, no behavior). Each entry:

```js
{
  id: 'stale-vcs-credential',
  classification: 'ENVIRONMENT',
  detect: {                                   // ALL matchers are mechanical
    reasons: ['auth'],                        // err.details.reason values
    signatureRe: /authentication failed|not logged in/i,
    scope: 'member',                          // member | bead | fleet
  },
  remedy: {
    verb: 'reprovision_vcs_auth',             // executor enum, section 2.5
    latch: 'once-per-member-per-sprint',
  },
  verify: {                                   // MUST pass before resuming
    kind: 'redispatch-original',              // re-run the failed operation once
  },
  fallback: 'human',                          // 'retry-once' | 'human' | 'defer' | 'escalate-unclear'
  humanReferralTemplate: '...',               // seeds humanActionRequired when fallback=human
}
```

Four mandatory fields per entry -- detection signature, remedy, verification, fallback -- so
adding case #6 is a data change reviewed like any other, not prompt engineering or a code
restructure. The executor (section 2.5) is the only code that knows how to run each `remedy.verb`;
new verbs DO require code (they must be implemented against real MCP tools), but new *symptoms*
using existing verbs are pure data.

### 4.2 Seed entries (today's known cases)

| id | detect (signature/state) | remedy (verb) | verify | fallback |
|---|---|---|---|---|
| stale-llm-credential | reason 'auth'; `/authentication failed|not logged in/i` (AUTH_DISPATCH_RE, errors.mjs:382) | reprovision_llm_auth (existing heal, runner.js:7296-7308) | redispatch-original once | human (referral: run provider login on member; note local members use host OAuth and only interactive login fixes them) |
| stale-vcs-credential | VCS kind AUTH_EXPIRED (errors.mjs:25-28) | reprovision_vcs_auth (runner.js:1616-1659) | re-run failed git step once (runGitStep already does this) | human (AUTH_DENIED explicitly needs an operator grant, errors.mjs:29-32) |
| wedged-reservation | execute_prompt rejected: member reserved by a sprint id whose pid/ledger entry is dead (reservation enforcement in execute-prompt.ts; ledger liveness via supervisor watchdog states) | member_reservation force_release (src/tools/member-reservation.ts:17-27) | reserve succeeds for THIS sprint | human (never force-release a reservation whose owner is alive -- referral includes the owning sprint id and its watchdog status) |
| hung-remote-session | T2 pattern on one member; probes time out or `member_session_state` shows a stuck in-flight prompt | stop_prompt + kill session (memberSessionGuard.killIfAlive pattern, runner.js:7260), then redispatch | trivial probe (`CLI --version`) returns within timeout | human (example A referral: host-level ssh) |
| stale-dolt-clone | bd reads inconsistent with cross-member state; `bd dolt pull` conflict matching `isDoltPullConflict()` (dolt-recovery.mjs:96-116) | dolt Path A refresh (gated by assessConflictGates, dolt-recovery.mjs:118-150); NEVER Path B mid-sprint (enablePathB:false precedent, dolt-recovery-tier2.mjs:327-360) | `bd dolt status` clean + re-read matches | escalate-unclear -> existing Tier 2 ladder |
| branch-not-synced-false-alarm | git fetch fails with `/couldn't find remote ref/i` on a branch another member just pushed (the one benign fetch-failure signature, runner.js:4588) | refetch_branch: bounded wait (30s) + one `git fetch` retry | ref present | retry-once, then human |
| member-cli-version-drift | `member_cli_version` probe differs from fleet baseline / known-bad version | none in v1 (update_llm_cli exists as an MCP tool but mid-sprint CLI upgrades are riskier than the disease) | n/a | human (referral: run update_llm_cli between sprints) |

### 4.3 Growing the registry from real incidents

The doctor MAY return `proposedRegistryEntry` (same shape as 4.1) when it diagnoses a novel,
recurring-looking symptom. The engine NEVER applies it -- it is appended to a
`doctor-proposals.jsonl` artifact beside the run state and surfaced in the harvest analysis
(`buildAnalysisText`, runner.js:3971-4029, gains a doctor section) and in the post-mortem skill
output. A human reviews and lands it as a normal PR to the registry file. This is the same
trust boundary as reviewer `newTasks`: propose in data, apply through the owner. (The registry
also resolves the coach design's open question 4 -- "should reports feed a local knowledge base
consulted on later invocations?" -- affirmatively, as reviewed data rather than free-form
self-priming: consults read the registry, proposals feed it through a human.)

### 4.4 Consent-gated upstreaming of engine-flaw reports (from coach)

Section 2.3's `engineFlawReport` stays local by default (artifact + harvest analysis + PR-body
block, section 7). The coach design solved the next step -- getting real field telemetry to the
ENGINE's maintainers without silent uploads -- and its flow is adopted whole:

- **Sanitize FIRST, locally, always** -- before the report is even written to disk: absolute
  paths -> stable placeholders (`<work-folder>/...`, `<home>/...`); hostnames/usernames/IPs/
  emails -> redacted tokens; anything matching secret patterns (keys, tokens, `{{secure.*}}`
  values, env dumps) -> stripped outright, never placeholdered; target-repo identifiers (repo
  name, branch names, bead titles) -> anonymized to `<target-repo>`/`<sprint-branch>` by
  default, with an opt-in tier for internal users to keep them; code snippets excluded by
  default, error text truncated to the minimal reproducing lines. A stable ANONYMOUS install id
  (random UUID, never derived from machine identity) enables cross-report dedup without
  identifying the user.
- **Consent modes** (fleet config, e.g. `doctor.telemetry`): `never` | `ask` (default) |
  `always`. Under `ask`, reports sit in the run's artifacts and the sprint-end surfaces (PR
  body section + dashboard card) show the exact sanitized text with a pre-filled
  new-issue URL against the engine's configured upstream tracker -- one click, human-in-the-loop
  by construction, nothing uploads silently, zero token handling. Under `always` (standing
  consent: explicit config, per-install, revocable, recorded in the report footer), reports
  auto-file via the user's own `gh` auth or a credential-store handle. Under `never`, local
  only.
- **Dedup by fingerprint**: the report carries the normalized `errorSignature` hash; upstream,
  a matching fingerprint appends an occurrence comment instead of opening a duplicate issue.
- **Generalization fix over the original coach sketch**: coach hardcoded the apra-fleet GitHub
  issues URL as the upstream target. That is the dogfood leak this product must not ship --
  the upstream tracker (owner/repo or full new-issue URL template) MUST come from fleet/engine
  config with no default pointing anywhere; telemetry is simply disabled until it is set.

---

## 5. Model tier, frequency, and cost

**Tier: `premium`.** The consult is a low-frequency judgment call over ambiguous, mixed evidence --
exactly the class this engine already reserves premium for (planner / plan-reviewer / reviewer are
pinned `'premium'` with the vendor-contract note, runner.js:86-105; `FIXED_ROLE_TIER` at 102-116).
Add `'sprint-doctor': 'premium'` to that map. Tier resolution stays per-member via the registered
`model_tiers` / `resolveModelForTier()` (src/tools/execute-prompt.ts:236-243), so the design stays
mixed-provider-correct: `premium` means "this member's best reasoning model", never a hardcoded
model id.

**Frequency:** zero on a healthy sprint (all four triggers require sustained no-progress or
repeated infra failure). Expected 0-2 consults on a troubled sprint; hard cap
`doctor_max_consults` (default 3) + optional probe round each => at most 6 premium dispatches per
sprint, each single-turn with a capped (~16KB x 2 logs + ledger + bead JSON, roughly 30-60k input
tokens) context and a small JSON output. Order-of-magnitude: low single-digit USD per consult on
current premium pricing -- vs incident 2's ~15.8M output tokens burned by NOT having it. Doctor
spend flows through the existing `budget.spent()` accounting, so a user's `--budget` ceiling
bounds it like every other dispatch (`BudgetExceededError`, workflow index.mjs:760-765).

---

## 6. Failure modes of sprint-doctor itself, and its own circuit-breakers

| Failure | Bound |
|---|---|
| Doctor dispatch itself stalls/fails/returns garbage | **Strictly-additive rule:** any consult failure (dispatch error, schema-repair exhaustion, watchdog fire -- `withDispatchWatchdog` applies to it like everything, runner.js:4527-4549) causes the engine to behave exactly as it does today: T3 falls through to the original `StalledSprintError` throw; T1/T2/T4 log the failed consult and let existing re-lane/stall machinery proceed. The doctor can never make an outcome worse than the status quo. |
| Repeated bad calls | `doctor_max_consults` (3) per sprint; no-repeat rule enforced by the ENGINE (a (beadId, action.kind) pair executes at most once; a verdict prescribing an already-tried-and-failed action is overridden to the defer/abort path); the doctor's own consult history is in its input so a compliant model self-corrects first. |
| Cost runaway | Consult cap + probe cap (1) + capped input assembly + inclusion in `budget.spent()`. |
| Oscillation with the stall detector | Doctor actions never touch `staleCycles`/`highWaterClosedCount` directly; only genuine `progressScore` increases (and the doctor-deferred monotone credit set, section 2.5) reset staleness. T3 grants at most ONE extra cycle ever. |
| Environment repair loops | Every registry remedy latched once per member per sprint (the `authHealAttempted` pattern); every remedy has a mandatory `verify` step -- an unverified remedy counts as failed and consumes the latch (the "failed provision must never report success" rule, runner.js:1654-1656). |
| pause_for_human wedges | No timeout, no auto-abort -- by design, a pause must never degrade to a destructive action on human response time. What makes indefinite pause safe instead: reservations released on pause / cleanly re-acquired on resume, zero spend while parked, and loud "paused since <t>" surfacing in viewer + supervisor with the watchdog taught a PAUSED state (section 2.6.4). "Never wedged" is satisfied by *unambiguity*: paused is an explicit, visible, resumable state with a written referral -- the failure mode being designed away is a sprint that is silently dead, not one that is visibly waiting for its human. |
| Prompt injection via member logs | Zero-tool dispatch: injected text can at most skew a choice among enumerated actions, each of which is independently bounded above; `humanActionRequired.suggestedCommands` are DISPLAYED to the operator, never executed by the engine. |
| Doctor edits source (the forbidden move) | Structurally impossible in-sprint: no tools. In post-mortem skill mode (section 8) the invoking agent has whatever tools its harness grants -- the skill text states the boundary, and the recommended harness profile for post-mortem runs is the existing read-mostly reviewer profile (`skills/fleet/profiles/base-reviewer.json` via `compose_permissions role:'reviewer'`), which permits no source writes. |
| Same failure class healed over and over ("healing becomes a home") | Coach's same-class-twice policy, adopted: an error class (by `errorSignature` fingerprint) may be doctor-remedied at most `doctor_max_per_class` times per sprint (default 2, complementing the per-(bead, action) no-repeat rule); after that the class must fail loudly and demand an engine fix via the 4.4 report path. Healing is a bridge, never a home. |
| Recursive escalation (the doctor's own machinery fails and something tries to doctor THAT) | Coach's no-recursion rule, adopted and enforced by construction: doctor consults/repairs are engine-internal steps, not ledger-recorded dispatch outcomes, so they can never satisfy T1-T5; a failed consult routes ONLY to the strictly-additive fallback above. The doctor is never doctored. |
| Interventions hidden from quality signals | Every consult and every executed remedy is a first-class event in sprint state, threaded into the Final Review's evidence and the harvest analysis (the buildAnalysisText doctor section, runner.js:3971-4029) -- a PASS with 12 doctor saves must read differently from a clean PASS (coach's no-silent-saves rule). |
| Nondeterminism poisons the golden/mock test suites | Doctor outcomes are recorded in replayable form and the mock-sprint harness / golden-transcript suites stub them deterministically (same posture the suites already take toward every other dispatch), so adding the doctor cannot destabilize the regression baseline. |

---

## 7. Generalization audit (must work for ANY target project)

- **No bead-prefix assumptions:** all bead ids flow from the sprint's own scope reads
  (`bdListScoped`, `bd show`); signatures strip ids during normalization.
- **No apra-fleet paths:** doctor inputs are runner-owned artifacts (its own log, ledger, run
  state) plus member probes phrased against the member's registered work folder and provider CLI --
  the same abstractions every existing phase uses. The generic playbook filenames fleet-sprint
  already contracts on (`deploy.md`, `integ-test-playbook.md`, `regression-test-playbook.md`) are
  product contract, not apra-fleet specifics.
- **Provider/model agnostic:** tiers only ('cheap|standard|premium'), resolved per member
  (execute-prompt.ts:236-243, provider `modelForTier` implementations across all adapters).
- **Engine-flaw routing is the one real leak risk:** engine bugs belong in the ENGINE's tracker,
  not the target project's beads DB. Therefore `engineFlawReport` is emitted as an artifact +
  harvest-analysis section + PR-body block, and NEVER auto-filed as a bead anywhere. Upstreaming
  goes exclusively through the section 4.4 consent flow (default: sanitized report + one-click
  pre-filled issue against a config-supplied upstream tracker; no default target, no silent
  uploads). This keeps the [fleet-sprint-product-vs-dogfood] separation: nothing target-specific
  leaks into the engine, and nothing engine-specific pollutes a customer's DB.
- **Registry entries must stay generic:** detection signatures key off the engine's own structured
  reasons and neutral taxonomies (errors.mjs), never off a target project's log text. Review rule
  for new entries: if a signature quotes project-specific strings, it is rejected as a
  target-side concern.
- **All thresholds are args** (validated alongside the existing arg contract, runner.js:2264-2448):
  `doctor_enabled` (default true), `doctor_streak_limit`, `doctor_spend_trigger_usd`,
  `doctor_max_consults`, `doctor_max_defers`, `doctor_max_per_class`; the telemetry mode and
  upstream tracker live in fleet config (`doctor.telemetry`, section 4.4), not per-sprint args.
- **No MCP tool schema changes** are required for v1 (the doctor consumes existing verbs; the
  pause/resume surface is viewer/supervisor HTTP routes plus engine primitives, not `src/tools/*`),
  so no `packages/apra-fleet-client` sync is triggered.

---

## 8. Packaging as a skill: `sprint-doctor` (dual purpose)

**Location and distribution:** `packages/apra-fleet-se/fleet-sprint/skills/sprint-doctor/SKILL.md`,
beside `fleet-sprint-cli` (currently the only skill there, a single ~104-line SKILL.md with
name+description frontmatter). Vendored exactly like fleet-sprint-cli: add the directory to
`scripts/dist-pm.mjs` (:60-94, npm dist copy) and `scripts/gen-sea-config.mjs` (:104-110, SEA
binary asset) so npm-global and single-binary installs both ship it, provider-agnostic.

**Skill shape (SKILL.md sections):**
1. Frontmatter: `name: sprint-doctor`; description covering both invocation modes and the trigger
   phrases ("sprint stalled", "sprint burning tokens", "post-mortem sprint logs", "recurring
   sprint failure").
2. *Triage doctrine* -- the section-3 decision tree and signal table, written generically.
3. *Registry* -- points at `doctor-registry.mjs` as the live symptom/remedy table; documents the
   4-field entry contract and the proposal-review flow (section 4.3). The skill never inlines a
   copy of the table (single source of truth).
4. *Output contract* -- the section-2.3 schema, including classification, humanActionRequired
   referral rules, and the "referral must be actionable" bar with examples A/B.
5. *In-sprint mode* -- states that the engine assembles inputs and executes actions; the skill's
   doctrine text is what the runner embeds into the doctor persona's prompt (the same
   pattern as the Tier-2 dolt dispatch being armed with `docs/dolt-tier2-runbook.md`,
   dolt-recovery-tier2.mjs:148-162). The persona markdown references the skill doctrine so the
   two cannot drift.
6. *Post-mortem mode* -- operator/agent-invoked over a BATCH of runs.

**How the two modes differ:**

| | In-sprint (engine-invoked) | Post-mortem (operator/agent-invoked) |
|---|---|---|
| Input | One incident: ledger excerpt, log tails, bead JSON -- pre-assembled by the runner | Many runs: `old_runs/<runId>.json` terminal states, runner logs, `doctor-consults.jsonl` + `doctor-proposals.jsonl` artifacts across sprints |
| Tools | None (zero-tool dispatch) | Read-only file access via the invoking harness; recommended under the reviewer permission profile |
| Output | Enum-bounded verdict, schema-enforced; engine executes | Free-form findings report: signature clusters, recurrence counts across sprints, ENVIRONMENT-vs-ENGINE_FLAW classification per cluster, proposed registry entries, proposed ENGINE-tracker bead titles with evidence quotes |
| Purpose | Unstick or cleanly kill THIS sprint | Mine REAL recurring engine flaws ("mutex not wired on path X", "stall threshold not tier-aware") vs one-off operational noise; feed the registry and the engine backlog |
| Actions executed | Yes, by the runner, bounded | Never -- purely advisory |

The JSONL artifacts the in-sprint mode writes (`doctor-consults`, `doctor-proposals`) are exactly
the corpus the post-mortem mode mines -- the two modes form a loop: incidents -> consults ->
post-mortem clustering -> registry entries + engine beads -> fewer future consults.

---

## 9. Recommended beads to file (titles + scope only; not created here)

1. **sprint-doctor: dispatch-health ledger + trigger layer (T1-T5)** -- Add the SprintHealthLedger
   recording at the existing catch/outcome sites, errorSignature normalization, the five triggers
   (T1-T4 pattern-driven, T5 single-shot red-state events per the coach taxonomy) with
   arg-configurable thresholds, and the H1-H4 hook points. No LLM call yet; triggers just log.
   Includes the JSONL artifact for post-mortem use.
2. **sprint-doctor: verdict schema, premium consult dispatch, and action executor** -- New role
   persona + `sprint-doctor-output.json` schema through the contracts.mjs pattern; zero-tool
   premium dispatch with one probe round; executor mapping each action.kind to existing verbs,
   including the doctor-deferred exclusion/credit fix for `NOT_DONE_STATUSES` containing
   `deferred` (runner.js:284, 8134-8138). Depends on 1.
3. **sprint-doctor: symptom/remedy registry with seed entries** -- `doctor-registry.mjs` with the
   seven seed entries (section 4.2), the 4-field entry contract, per-remedy latches + mandatory
   verify steps, and the `proposedRegistryEntry` capture-to-artifact flow. Depends on 2.
4. **sprint-doctor: cycle-stall interposition + SprintDoctorAbortError** -- T3 wiring: consult once
   before the runner.js:8219 throw, one doctored extra cycle, then the original abort with doctor
   details attached; new typed error added to `isTypedAbortError()` so abort reports/PR bodies
   carry the diagnosis. Depends on 2.

*Framework beads (generic pause/resume, packages/apra-fleet-workflow -- usable by any workflow
script, independent of sprint-doctor):*

5. **workflow engine: pause/resume primitive with activity-entry gate + pause guard hook** --
   `requestPause`/`requestResume` on FleetWorkflow as siblings of `requestStop()`
   (index.mjs:499-503); the internal gate at `agent()`/`command()` entry (beside the budget
   check, index.mjs:760-765); `'pause:requested'`/`'paused'`/`'resumed'` events carrying
   phase/group labels from the run store; `setPauseGuard(fn)` deferral; paused-state declaration
   at zero in-flight activities; gate promise rejects on `requestStop()`. Deliberately NOT
   apra-fleet-9ub's journaled interrupt(); note on 9ub that this gate is its future journal
   point.
6. **workflow viewer: Pause/Pausing/Paused/Resume UX** -- `POST /pause` / `POST /resume` routes
   beside `POST /stop` (viewer/index.mjs:1253-1288), buttons beside Save/Stop
   (viewer/index.mjs:186-187), button state machine driven by the new events, "paused since <t>"
   badge + reason card. Generic to every workflow run, not fleet-sprint-specific. Depends on 5.
7. **supervisor: Pause/Resume controls + PAUSED watchdog state** -- Sprint Stack row buttons as
   siblings of Stop/Restart (dashboard.mjs:128-137) in the same script pattern
   (dashboard.mjs:248-437), proxying to the child viewer's pause/resume rather than the
   kill+force-release route Stop uses; watchdog classifies a live-pid paused run as PAUSED;
   base-drift indicator in the row. Depends on 6.
8. **fleet-sprint: clean-state pause guard + reservation handling + unconditional resume
   re-sync** -- Register the open-bracket pause guard (counter at `withGitSync` entry/exit,
   runner.js:4999, and around `DoltSync.syncBefore/After`, runner.js:8124); reservation
   release-on-pause / owner-checked re-reserve-on-resume with clean resume failure naming
   unavailable members (member-reservation.ts:38-68); the unconditional resume re-sync (git
   fetch + `decideEnsureBranchAction` probe + `bd dolt pull`) on every re-acquired member.
   Depends on 5. This is runner.js's ONLY pause-awareness.

*sprint-doctor beads (continued):*

9. **sprint-doctor: wire pause_for_human to the engine pause primitive** -- The thin caller:
   `requestPause(reason)` at the consult point plus the referral card published via
   `publishState('sprint-doctor', ...)` for the paused-state UI. Depends on 2 and 5 (and
   benefits from 8's reservation handling, but does not own it).
10. **sprint-doctor skill (dual-mode) + dist wiring** -- SKILL.md per section 8, persona
    references doctrine, additions to `scripts/dist-pm.mjs` and `scripts/gen-sea-config.mjs`;
    post-mortem procedure over old_runs + doctor JSONL artifacts. Depends on 3 (registry exists
    to reference).
11. **sprint-doctor: consent-gated engine-flaw telemetry** -- The section 4.4 flow: local
    sanitization spec, anonymous install id, `doctor.telemetry` config (`never`/`ask`/`always`)
    with a config-supplied upstream tracker and no default target, pre-filled new-issue URL in
    the PR body + dashboard card, fingerprint dedup. Depends on 2 (report schema exists).
12. **docs: sprint-doctor phase + pause/resume semantics in fleet-sprint README + diagram** --
    Document the new phase, the triage buckets, the registry contract, the clean-state pause
    invariant and member-agnostic resume, and the never-wedged invariant in
    `fleet-sprint/docs/README.md` and `fleet-sprint-diagram.md`. Depends on 4.
