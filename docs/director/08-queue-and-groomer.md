# Director: persistent queue and autonomous grooming (issues #410 and #22)

Status: DRAFT spec, v0.5. Vocabulary: `01-concepts.md`.

Issues #410 (persistent sprint queue) and #22 (autonomous grooming -> queueing)
have been open since 2026-08 and 2026-03. Most of #410's mechanism is already
planned inside v0.5 (S13 sprint definitions, S19 sqlite ledger, S22 scheduler,
S21 runs/history UI, S24 groomer page). This spec does NOT add a parallel
queue: it amends those sprints and adds two director-lane sprints so that,
together, they ARE #410 (S13, S21, S22 + D9) and #22 (S24 + D10).

---

## 1. Mapping

| #410 / #22 requirement | v0.5 home | status in plan | amendment |
|---|---|---|---|
| 410.1 sprint exists before it runs, persisted, survives restart | S13 `sprints` table, states `open -> ready` | planned | none beyond 2.1 |
| 410.1 zero members at creation | S13 refuses `ready` with an empty roleMap (`no-members-assigned`) | conflicts | 2.1: project default role map |
| 410.2 busy member -> waiting, start on release, no pre-reservation | S22 `waiting` + `waitingReason` + launch on release | planned | D9 (2.2): immediate re-evaluation on `member.freed`; policy check |
| 410.2 whole member union free, anti-starvation documented | S22 launch guard | partly | D9 (2.2 rule) |
| 410.2 legacy fail-fast callers unchanged | `POST /api/sprints` | exists | keep; the queue path is the projects API |
| 410.3 visible, mutable, deterministic, audited order | S13 hold/release/order + `transitions` | planned | 2.3 order key and audit fields |
| 410.4 pause releases resources; resume elsewhere | engine pause/resume shipped (p2to); S22 per-run pause route | partly | D9 (2.4) |
| 410.5 history, relaunch, clone-and-amend; running not editable | S21 history/stats pages | partly | 2.5 |
| 22 grooming on a cadence, queues its own conclusions | S24 manual review page | not planned | D10 (section 3) |
| 22 capacity-aware sprint sets | -- | not planned | S24 schema (3.2), D10 |
| 22 idempotent, quality bar, human override | -- | not planned | D10 (3.3) |
| 22 delivery tracking, close the loop | -- | not planned | D10 (3.4) |

## 2. Amendments to S13 / S21 and the D9 scheduler integration

S22 is built as planned (12 h). Everything in 2.2 and 2.4 is built by D9 on top
of S22 in the following wave, so S22 stays within its estimate.

### 2.1 Project default role map (S13)

Member-to-project assignment is a one-time operator decision. S13 gains
`projects.default_role_map` (JSON, same shape as a sprint roleMap, members must
carry the project's owner tag). A sprint definition with no explicit roles
inherits it at `ready` time. `no-members-assigned` remains the refusal only
when both the sprint and the project have none. The director never edits
either.

### 2.2 Launch and waiting (D9, on S22)

Order of checks for each candidate on a tick or on `member.freed`:

1. Candidate selection by queue order (2.3).
2. Policy engine: `launch_sprint.<class>` (autoqueue / feature / other).
   `propose` -> create or refresh a gate and skip; `forbid` -> skip with reason.
3. Merge-blocked check -> `parallel_prs_when_merge_blocked` rule
   (`05-merge-steward.md` section 4).
4. Member resolution: the role map's member union must be simultaneously free
   (fleet-server `reservedBy` empty, not held, not busy). OS rotation
   (`07` section 3) chooses among interchangeable pool members.
5. Launch through the existing launch path (guards, relaunch gate,
   topology checks run at execution time, not at queue time).

Anti-starvation rule (documented and tested): a waiting entry that has been
skipped because a lower-ordered entry with a smaller member set started
`k` times (default 3) becomes `reserved-next`: the scheduler stops starting
any other entry that needs any of its members until it starts. One
`reserved-next` per member at a time; never two entries holding partial sets.

`member.freed` triggers an immediate evaluation in addition to the tick.

### 2.3 Queue order (S13 store + D9 scheduler)

Consume order is a total order computed by code, shown verbatim in the UI and
the digest:

```
1. pinned (operator "run next"), by pin time
2. operator order (explicit position set via PUT .../order)
3. director rank (latest `rank` job), unpinned and unordered entries only
4. bead priority (P0 first)
5. ready_at (oldest first)
```

Operator actions always beat the director. Every order change writes a
`transitions` row with `{by: operator|director|system, reason, decisionId?}`.
The director writes level 3 only through S13's store API
`setDirectorRank(project, [definitionId...], decisionId)`; it never edits
`sprints.mjs` or the table directly.

### 2.4 Pause back to waiting (D9)

`POST /p/<id>/api/sprints/:id/pause` calls the live pause route; when the run
reports paused (watchdog PAUSED) and its reservation is released by the
engine's pause guard, the sprint definition returns to `waiting` with reason
`paused`. Resume = normal re-launch from waiting; the engine's pre-resume hook
re-syncs from the persisted branch and re-reserves (p2to.1). Resume on a
DIFFERENT member is allowed only when the run state says it is resumable
across members; otherwise the request is refused with the engine's reason.
Budget consumed carries across (the run's tracked spend persists).

### 2.5 History, relaunch, clone (S21)

S21's history page gains: last 5 terminal runs by default with "load more";
"relaunch" prefills a new sprint definition from the stored one (normal
validation applies); "clone and amend" for `open`/`ready`/`waiting`/`paused`
definitions creates an independent definition. Running definitions expose no
edit controls, and the API refuses edits on running definitions (server-side).

## 3. Groomer as producer (S24 schema amendment + D10, closes #22)

### 3.1 Triggers (event-driven, not a fixed clock)

- `queue.low` (ready entries < `policy.queue.min_ready`).
- `run.finished` (any verdict) for the project: re-groom the touched epics.
- `intake.received` batch (debounced 15 min).
- `timer.nightly` backstop.
- operator request (existing S24 page button).

Debounce: at most one groomer run per project per 30 minutes; at most
`policy.groomer.max_runs_per_day` (default 8).

### 3.2 Input additions (schema change, `backlog-groomer-input.json`)

- `capacity`: free members per OS now, waiting entries, average sprint hours,
  hours until the next digest.
- `queue`: current consume order (ids, objective, size).
- `vision`: parsed vision.yaml (objectives, trade-offs, non-goals).
- `autoqueueEpics`: epic ids labelled `autoqueue`.

### 3.3 Output handling (deterministic, via the policy engine)

The existing output fields (`sprintSets`, `duplicates`, `needsGrooming`,
`actions`, ...) are mapped to actions.

Parsing rule (I1): the groomer's `actions[].command` is free text written by an
LLM. It is NEVER executed. The router parses each entry into
`{verb, beadId, args}` against the beads client's allowlisted verbs
(close, defer, reprioritise, reparent, relabel, merge-duplicate, add/remove
dependency) with strict argument validation (bead ids must exist in this
project; labels and priorities from closed sets). Any entry that does not parse
is refused and recorded with the raw text; the raw string is never passed to a
shell.

| groomer output | action class | default policy |
|---|---|---|
| `actions[]` (merge/close/defer/reparent/relabel) | `groom_mutation` | `do_notify` |
| `sprintSets[]` under an `autoqueue` epic meeting the quality bar | `mark_ready` -> definition created + `ready` | `do_notify` |
| `sprintSets[]` elsewhere | `mark_ready` | `propose` (gate: "queue this set?") |
| `needsGrooming[]` P0/P1 | gate `propose_blocking` "clarify <bead>?" with the groomer's specific question | -- |

Quality bar (code-checked before `mark_ready`, not trusted from the LLM): every
bead in the set has acceptance criteria text, no open `blocks` edge from
outside the set, no `needsVerification` flag, size estimate present, and is
not under a non-goal objective.

Idempotency: a sprint set's key is the sorted root bead ids. If a definition
with the same key exists in any non-terminal state, the groomer output updates
its evidence and does not create another.

The groomer keeps `dry-run: true` semantics for its OWN direct mutations: in
producer mode it runs with `dry-run: true` and the router applies its proposed
`actions` through the policy engine. This keeps all mutations auditable in the
decision store.

### 3.4 Delivery tracking

On `run.finished`, the router records per objective: beads closed, verified
closures (closure + merged PR containing the change), sprint hours, spend. The
weekly review and the digest report velocity per objective over 4 weeks.
"Closed but not landed" (bead closed, PR not merged after 7 days) is listed in
the digest's "Went wrong" section.

### 3.5 Answers to #22's open questions

- **Autonomy**: two lanes. `autoqueue` epics queue directly (`do_notify`);
  everything else is proposed (gate with default). The operator widens the
  `autoqueue` scope as agreement and breaker history allow.
- **Cadence**: event-driven (3.1) with a nightly backstop.
- **Budget guardrails**: spend is checked at launch (policy engine step 5),
  queue depth capped by `policy.queue.max_ready` (default 10; the groomer stops
  marking ready above it), and review backpressure stops launches when PRs
  awaiting a human exceed the cap. The groomer may propose freely; caps decide
  what runs.

## 4. Acceptance

- S13: inherited role map at `ready`; refusal only when neither exists.
- S22: order key test (each of the five levels); anti-starvation test with two
  overlapping member sets; immediate launch on `member.freed`; policy
  `propose` produces a gate and no launch.
- Pause/resume test: pause releases members (visible via the members API),
  definition returns to `waiting`, resume relaunches.
- S24: trigger debounce; idempotent set key; quality-bar refusal with reasons;
  producer mode applies actions only through recorded decisions.
