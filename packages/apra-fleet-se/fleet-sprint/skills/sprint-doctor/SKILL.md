---
name: sprint-doctor
description: Diagnoses a sick sprint two ways -- in-sprint, where the engine consults the doctor persona zero-tool to decide one bounded repair action for the sprint currently running; and post-mortem, where an operator or supervising agent triages a BATCH of past sprint runs to find recurring engine flaws and propose registry/tracker follow-ups. Trigger phrases: "sprint stalled", "sprint burning tokens", "post-mortem sprint logs", "recurring sprint failure".
---

# sprint-doctor

sprint-doctor turns a sick sprint into either a healthy sprint (bounded auto-repair, then
resume) or a cleanly dead one (abort with a diagnosis and, where needed, a specific human
referral) -- never leave it wedged, silently burning tokens, or ambiguous. This skill packages
that doctrine for two audiences: the engine, which consults it automatically mid-sprint, and an
operator or supervising agent, who invokes it by hand over a batch of finished runs.

## 1. Triage doctrine (environment vs engine vs task-shape)

Every diagnosis classifies the incident before choosing an action. Four buckets:

1. **ENVIRONMENT** -- engine logic is fine; the execution environment is broken: stale/expired
   credentials, a wedged reservation, a dead or hung remote session, disk/network flakiness, a
   not-yet-synced branch, member CLI version drift.
2. **ENGINE_FLAW** -- a real bug or gap in the sprint engine itself: bad retry logic, a stage
   invariant violated, a threshold that is wrong for the situation it fired in.
3. **TASK_SHAPE** -- the unit of work itself is too large, ambiguous, or mis-specified for any
   doer to land, regardless of member or environment.
4. **UNCLEAR** -- the evidence does not yet discriminate the above; follow the policy below.

### Discriminating signals

| Signal | Points to | Rationale |
|---|---|---|
| Same failure signature across unrelated work items AND multiple members | ENVIRONMENT (shared substrate: credentials, network) -- unless the signature itself names an engine invariant, then ENGINE_FLAW | Content varies, member varies, failure doesn't => the cause is in what they share |
| Failures confined to ONE member across two or more distinct work items | ENVIRONMENT on that member specifically | Work varies, the host doesn't |
| A failure confined to ONE work item that reproduces on a second member | TASK_SHAPE, or ENGINE_FLAW if the failure is mechanical (e.g. killed mid-stream at a fixed time offset regardless of content) | Host varies, work doesn't |
| A work item with no real acceptance criteria, oversized scope, or a history of repeated reopens before it even started failing | TASK_SHAPE | It was already oscillating before it started stalling |
| Deaths at a suspiciously fixed time offset matching a known timeout value | ENGINE_FLAW or misconfiguration, not TASK_SHAPE | Content-caused failures land at varied offsets; timeouts kill at their configured value |

### Policy for UNCLEAR: cheap, reversible, environment-first

1. Attempt a matching registry remedy (section 2) -- at most one pass.
2. If no registry match, or the remedy verified-failed: request the one discriminating probe
   that re-dispatches the same work to a different member. It converts UNCLEAR into
   ENVIRONMENT-on-that-member vs TASK_SHAPE/ENGINE_FLAW with a single data point.
3. Still failing: treat as TASK_SHAPE or ENGINE_FLAW -- defer/reduce scope (or abort, when the
   failing item is the whole remaining scope) with a written reason; add an engine-flaw report
   when the evidence points engine-ward; add a human referral whenever the residual fix is
   beyond the doctor's own bounds.

## 2. Registry: the live symptom/remedy table

`doctor-registry.mjs` (beside this skill, in the `fleet-sprint` package) is the single source of
truth for known symptom-to-remedy mappings. This skill never inlines a copy of that table --
read the module directly for the current entries, their remedies, and their human-referral
templates.

Every entry carries exactly four mandatory fields:

- **detect** -- a mechanical matcher: dispatch-failure reasons, a message/signature regular
  expression, and a scope (`member` | `bead` | `fleet`). Detection never keys off target-project
  log text, only the engine's own structured reasons and neutral taxonomies.
- **remedy** -- an executor verb (from a closed, code-implemented vocabulary) plus a latch
  (how often it may fire, e.g. once per member per sprint).
- **verify** -- what must be true before the remedy counts as successful; an unverified remedy
  is treated as a failed one.
- **fallback** -- what happens when the remedy is unavailable or fails: retry once, hand off to
  a human, defer the work item, or fall through to the UNCLEAR policy.

Adding a new known symptom is a reviewed DATA change to that module, never prompt engineering or
a code restructure. New remedy *verbs* do require code (they must be implemented against real
executor actions); new *symptoms* using existing verbs are pure data.

### Proposal-review flow

When a diagnosis looks like a novel, recurring-looking symptom with no registry match, it MAY
propose a new entry (same four-field shape as above). The engine never applies a proposal
automatically -- it is captured to a per-run artifact and surfaced in downstream analysis. A
human reviews each proposal and lands it as a normal change to the registry module. This is the
same trust boundary the engine applies everywhere else it lets an automated role suggest new
work: propose in data, apply through the owner.

## 3. Output contract

A diagnosis (whether produced by the in-sprint zero-tool consult or synthesized by hand in
post-mortem mode) is a single JSON verdict with this shape:

```jsonc
{
  "classification": "ENVIRONMENT | ENGINE_FLAW | TASK_SHAPE | UNCLEAR",
  "confidence": "high | medium | low",
  "evidence": ["..."],                  // short factual bullets
  "matchedRegistryEntry": "id | null",  // which registry entry matched, if any

  "action": {
    "kind": "repair_environment_then_retry | retry_same | retry_different_member |
             swap_model_tier | defer_bead | reduce_scope_and_continue |
             abort_sprint | pause_for_human"
    // kind-specific params, each independently bounded (e.g. timeoutMultiplier capped at 2)
  },

  "probes": ["..."],                    // optional; mutually exclusive with `action`

  "engineFlawReport": { "...": "..." },  // required when classification == ENGINE_FLAW

  "proposedRegistryEntry": { "...": "..." }, // optional; see section 2, never auto-applied

  "humanActionRequired": {              // required whenever action is pause_for_human, or
    "summary": "...",                   // abort_sprint with classification ENGINE_FLAW/UNCLEAR
    "suggestedCommands": ["..."],
    "relevantFiles": ["..."], "relevantBeadIds": ["..."],
    "whyBeyondBounds": "..."
  },

  "notes": "..."
}
```

Exactly one of `action` / `probes` is present per response; a probe-round response is followed
by a second response that MUST contain `action`.

### The referral bar

Whenever the real fix is outside the doctor's own bounds -- an engine code change, a credential
type it cannot self-provision, host/OS-level intervention on a member, or a genuine judgment
call -- `humanActionRequired` must read the way a doctor writes a referral: specific, actionable,
and honest about why it is being handed off. A vague "escalate to a human" with no commands is
schema-legal but rejected -- it is treated exactly like an actionless review rejection elsewhere
in this engine: one re-ask, then the diagnosis fails and the engine falls back to its pre-doctor
behavior.

**Example A -- environment case beyond bounds (a member needs host-level attention):**

```jsonc
{
  "classification": "ENVIRONMENT", "confidence": "high",
  "evidence": [
    "5 infra failures on one member across 3 unrelated work items, signatures all 'stalled'",
    "a trivial CLI-version probe on that member timed out; a disk-free probe never returned",
    "the same work items dispatched to a different member completed normally this cycle"
  ],
  "matchedRegistryEntry": "hung-remote-session",
  "action": { "kind": "pause_for_human", "reason": "the member is unresponsive below the CLI layer; remaining work continues on other members" },
  "humanActionRequired": {
    "summary": "The member does not respond to even trivial probes; the fleet's own kill/stop verbs cannot reach whatever is wedged (likely the transport channel or the host itself).",
    "suggestedCommands": [
      "reach the member's host directly and check whether its provider CLI process is still alive",
      "confirm the transport channel recovers before resuming this sprint on that member"
    ],
    "relevantFiles": [], "relevantBeadIds": [],
    "whyBeyondBounds": "Repairs available are limited to the fleet's own verbs; all were attempted or unreachable. Host-level access requires an operator."
  },
  "notes": "Sprint can continue at reduced parallelism; nothing here suggests an engine or task-shape problem."
}
```

**Example B -- a real engine bug (mitigate, but never patch source):**

```jsonc
{
  "classification": "ENGINE_FLAW", "confidence": "medium",
  "evidence": [
    "3 stall-kills on one work item, all on the highest model tier, at the same fixed time offset",
    "member-side output shows steady streaming right up to each kill -- not silence",
    "reproduced the identical kill on a second member, ruling out a member-environment cause"
  ],
  "matchedRegistryEntry": null,
  "action": { "kind": "retry_same", "timeoutMultiplier": 2, "reason": "mitigation only; root cause is engine-side" },
  "engineFlawReport": {
    "symptom": "A stall detector kills healthy long-single-turn dispatches at a flat timeout regardless of model tier",
    "suspectedComponent": "the stall-timeout configuration vs per-tier dispatch budgets",
    "reproEvidence": ["three ledger rows: identical kill at the same streaming offset, two different members"],
    "proposedBeadTitle": "stall threshold is not tier-aware; long single-turn dispatches killed mid-stream"
  },
  "humanActionRequired": {
    "summary": "If the doubled-timeout retry also dies, this needs an engine change: make the stall threshold tier- or dispatch-aware. The doctor cannot and must not patch engine source itself.",
    "suggestedCommands": [
      "confirm the flat stall-timeout default in the engine's own stall-detection source",
      "file the proposed title above in the ENGINE's own tracker, never the target project's"
    ],
    "relevantFiles": [], "relevantBeadIds": [],
    "whyBeyondBounds": "Source modification of the sprint engine is outside the doctor's action set by design; only defer/mitigate/report are permitted."
  },
  "notes": "The work item itself looks healthy; do not defer it yet -- the mitigation may complete it."
}
```

Both examples name findings generically ("the member", "a stall detector") -- never a specific
target project's file paths, build commands, or identifiers. A diagnosis describes only what the
evidence in front of it actually shows; it never assumes which project is being diagnosed.

## 4. In-sprint mode

Trigger: the running sprint engine detects sustained no-progress or repeated infrastructure
failure (a stalled bead/member streak, cycle stagnation, spend-without-progress, or an
unforeseen failure that exhausted every typed handler and retry ladder first).

- **Input**: one incident, fully pre-assembled by the engine -- the trigger record and its
  evidence rows, the triggering work item(s), dispatch/stall history for the sprint so far, log
  tails (both capped in size), the doctor's own prior verdicts this sprint, and the registry
  (section 2), injected as data.
- **Tools**: none. The engine assembles every fact into the dispatch prompt; the doctor persona
  returns a schema-validated verdict (section 3) and nothing else. It never runs a command,
  never touches version control, never calls a tool -- the engine is the only thing that ever
  executes a consequence of the verdict, the same posture the engine's other review-style roles
  take toward their own verdicts.
- **Output**: the enum-bounded verdict from section 3, schema-enforced; a schema-invalid
  response after the engine's normal repair loop causes the diagnosis to fail and the engine to
  fall back to exactly the behavior it had before consulting the doctor at all -- a failed
  consult can never make the outcome worse than not having one.
- **Authority**: the engine executes every action through its own existing verbs (retry, defer,
  swap tier, re-lane to another member, pause, abort). The doctor persona itself changes nothing
  directly.

The doctor persona's own prompt file states this same doctrine so the two documents cannot drift
-- this skill is the canonical statement of doctrine and the persona points back to it rather
than duplicating it.

## 5. Post-mortem mode

Trigger: an operator or a supervising agent asks for a post-mortem or wants to understand a
recurring sprint failure pattern across MULTIPLE runs, not just the one in front of them.

- **Input**: a batch of finished runs -- their terminal run-state records (one per run, keyed by
  run id), the corresponding sprint logs, and each run's own health-ledger and proposals JSONL
  artifacts (the same per-run files the in-sprint mode writes as it goes, produced by the ledger
  and proposal-capture modules referenced in section 2).
- **Tools**: read-only file access via whatever harness invokes this mode. The recommended
  permission profile is the engine's existing read-mostly review profile -- no source writes, no
  version-control mutations, no execution of anything the analysis turns up.
- **Procedure**:
  1. Read every run's terminal state, log, and doctor artifacts in the batch.
  2. Normalize and cluster failures by signature across runs (the same normalization the
     in-sprint ledger already applies: strip ids/numbers/paths, keep the reason and the first
     line of the message).
  3. For each cluster, count recurrence (how many runs, how many members, how many distinct
     work items) and classify it (ENVIRONMENT / ENGINE_FLAW / TASK_SHAPE / UNCLEAR) using the
     same discriminating signals as section 1, now applied across runs instead of within one.
  4. For clusters that look like a genuinely new, recurring symptom with no existing registry
     match, draft a `proposedRegistryEntry` (section 2's four-field shape).
  5. For clusters that look like a real engine defect, draft a proposed tracker-issue title with
     the evidence quotes that justify it (never file it directly -- title and evidence only).
- **Output**: a free-form findings report -- signature clusters, recurrence counts, the
  per-cluster classification, proposed registry entries, and proposed engine-tracker issue
  titles with evidence quotes. This is advisory only: post-mortem mode executes nothing. It never
  mutates a work tracker, never edits the registry, never touches any run's git or branch state
  -- it only writes its findings back to the operator.

### How the two modes differ

| | In-sprint (engine-invoked) | Post-mortem (operator/agent-invoked) |
|---|---|---|
| Input | One incident, pre-assembled by the engine | Many runs: terminal states, logs, and the doctor JSONL artifacts across them |
| Tools | None (zero-tool dispatch) | Read-only, recommended under the read-mostly review permission profile |
| Output | Enum-bounded verdict, schema-enforced; the engine executes it | Free-form findings report: clusters, recurrence, classification, proposed registry entries, proposed tracker issue titles |
| Purpose | Unstick or cleanly kill THIS sprint | Mine real recurring engine flaws vs one-off operational noise; feed the registry and the engine's own backlog |
| Authority | The engine executes every action, bounded | Never executes anything -- purely advisory |

The JSONL artifacts the in-sprint mode writes are exactly the corpus post-mortem mode mines: the
two modes form a loop -- incidents become consults, consults become post-mortem clusters,
clusters become registry entries and engine backlog items, and a better-populated registry means
fewer future consults.
