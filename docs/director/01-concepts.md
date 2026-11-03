# Director: concepts and invariants

Status: DRAFT spec, v0.5. Normative words MUST / SHOULD / MAY follow RFC 2119.
Read `README.md` first for the why; this file defines the vocabulary every other
director spec uses. If two specs disagree, this file wins.

---

## 1. The problem in one paragraph

fleet-sprint automates everything INSIDE a sprint. Almost nothing BETWEEN sprints
is automated: a human chooses scope, launches, reads the PR, merges, reacts to
red CI, decides what is next. The operator is the scheduler, the event router,
the merge gate and the CI fixer. Members idle and token allowance goes unused
not because capacity is missing but because the ready queue runs dry and every
transition waits for one person. The director closes that loop by acting on the
operator's behalf, inside limits the operator writes down.

## 2. Inputs the operator provides

### 2.1 Vision (per project)

What matters and why. Drives JUDGMENT: ranking, trade-offs, what to groom next.

- **Objectives**: named outcomes with a weight (weights sum to 1.0), an outcome
  statement and the measures that show progress.
- **Trade-offs**: ordered, explicit rules for foreseeable conflicts
  ("reliability over features: never start a feature sprint while the
  integration branch is red"). Trade-offs are the part that encodes taste;
  objectives alone do not steer an LLM.
- **Non-goals**: work the director MUST NOT propose.
- **Precedents**: a pointer to the decision log (section 2.5) for this project.

Vision is read by LLM roles only. Vision never grants authority.

### 2.2 Policy (per project)

What the director may do without asking. Drives AUTHORITY. Evaluated by code,
never by an LLM.

- **Hard constraints**: never overridable (tenant isolation, customer release).
- **Authority matrix**: for each action class, the authority mode (2.3), its
  conditions and caps.
- **Spend limits**: per week, per sprint.
- **Risk budget**: section 2.4.
- **Phase table**: section 3; most policy values are keyed by phase.

Policy is a versioned file in git. The director MAY propose a policy change; only
the operator merges it (I6).

### 2.3 Authority modes

Every action the director can take has exactly one mode at evaluation time:

| mode | meaning |
|---|---|
| `do` | execute; record a decision |
| `do_notify` | execute; record; include in the next digest |
| `propose` | create a gate (2.6) with a recommended default; execute only when answered or when the gate's expiry fires the default |
| `propose_blocking` | create a gate with NO default; execute only on an explicit answer |
| `forbid` | never execute; record the refusal |

### 2.4 Risk budget

"Measured risk" made explicit, after the SRE error budget. Per project, per
week, a set of counters the director spends when an autonomous action goes
wrong:

| counter | debited when |
|---|---|
| `wasted_sprints` | a director-launched sprint ends NOT MET or aborted |
| `reverted_merges` | an auto-merged PR is reverted within N days |
| `defaults_fired` | a gate resolves by expiry instead of an answer |
| `usd` | spend attributed to director-initiated work |

When any counter is exhausted the project drops to `exhausted` mode: every `do`
and `do_notify` rule is evaluated as `propose` until the budget replenishes (or
the operator resets it). Budgets replenish on a fixed weekly boundary and MAY
grow by a configured factor after N clean weeks ("earned autonomy").

### 2.5 Decision record

Every evaluated action produces one append-only record:
`{id, at, project, phase, event, action, proposedBy, rationale, objectiveRefs,
ruleMatched, mode, outcome, riskDebit}`. Records are the audit trail, the input
to agreement metrics and, for gate answers, the precedent corpus.

### 2.6 Gate

A human decision represented as data. A gate is a beads issue of type `gate`
(beads supports the type; nothing in the engine used it before this work)
carrying: question, 2-4 options, recommended option with evidence, `firesAt`
(absent for `propose_blocking`), and dependency edges that block the work
waiting on it. Answering or expiring a gate is an event (section 4).

## 3. Phase

Risk tolerance is not a per-project constant; it depends on where the project is
in its release cycle. Each project has exactly one current phase:

```
released --> open_window --> stabilizing --> release_candidate --> released
```

- `open_window`: users have a release to work with; higher risk is acceptable.
- `stabilizing`: risk tapers; feature work finishes, little new starts.
- `release_candidate`: fixes only; dogfood hours accrue (section 5).
- `released`: transient; immediately moves to `open_window`.

A project MAY declare a single phase `steady` (client delivery work with a fixed
conservative policy). Phase transitions are events emitted ONLY by the operator
or by the project's release playbook; the director never changes phase (I5).

## 4. Event

Anything the director reacts to. Events are produced by deterministic code
(supervisor watchdog, scheduler, CI gate, timers, gate store, intake adapters)
and consumed by the policy engine. The catalog is in `03-events-and-playbooks.md`.
LLM roles never emit events directly; they emit PROPOSALS that the policy engine
turns into actions.

## 5. Dogfood

A release gate, not a habit: for a project with `dogfood` enabled, a release
candidate MUST NOT be promoted until it has accumulated the configured
dogfood sprint-hours with zero regressions attributed to the candidate. The
counter is computed from run history, not asserted by anyone.

Production vs dogfood instance (the sprint engine runs on the SUPERVISOR host,
spawned by the supervisor, so a member's version alone does not exercise the
engine):
- **production supervisor instance**: pinned to the last promoted release;
  hosts the director for every project not opted into dogfood; upgraded only
  by promotion.
- **dogfood supervisor instance**: a second supervisor (own data dir and port)
  running the candidate build of supervisor + engine, serving the projects
  opted into dogfood (apra-fleet itself first), with its members on the same
  candidate build. Canary = which projects and members are moved onto the
  dogfood instance; rollback = move them back and reinstall the previous exact
  build.

## 6. OS rotation

For projects that declare multi-OS support, the scheduler picks the doer from
the project's static member pool with a bias toward the OS that exercised the
touched area least recently, and SHOULD place the reviewer or tester on a
different OS from the doer. The OS used is recorded on every bead and run so
failures can be correlated. Hardware-bound work (pinned capability) is never
rotated.

## 7. Members and projects

Which members serve which project is a one-time operator decision (static pool
in project config). The director never assigns members to projects. Whether a
member is busy, including busy in ANOTHER project's sprint, is answered by the
shared fleet server's reservation state; all supervisors on a machine MUST talk
to one fleet server.

## 8. Roles

| role | kind | does |
|---|---|---|
| policy engine | code | evaluates every proposed action against hard constraints, phase policy, spend, risk budget; returns a mode |
| event router | code | maps events to playbooks; deterministic |
| scheduler | code | launches ready work onto free eligible members (v0.5 S22, amended) |
| merge steward | code + classifier | merges low-risk PRs, keeps the integration branch moving, parallel-PR policy |
| director | LLM role | proposes: next sprint sets, ordering, abort diagnosis, gate recommendations, weekly rebalance, digest text |
| groomer | LLM role (existing `backlog-groomer`) | keeps the backlog ready: dedupe, refine, decompose, mark ready |
| operator | human | writes vision and policy, answers gates, changes phase, promotes releases |

## 9. Invariants

These hold in every spec, every phase, every project. A change that breaks one is
a design change, not an implementation detail.

- **I1 LLM proposes, code disposes.** No LLM output is executed without a policy
  engine decision. An LLM can never argue itself into authority. LLM output is
  never executed as a command string: it is parsed into a closed set of typed
  actions; anything that does not parse is refused and recorded. Every action
  the system can take belongs to a declared action class (`02` section 3.1).
- **I2 Hard constraints first.** Tenant isolation and customer-release rules are
  evaluated before anything else and cannot be relaxed by phase, budget or
  precedent.
- **I3 Every action is recorded** with the rule that authorized it.
- **I4 Bounded blast radius.** Every autonomous loop has a cap (retries, chain
  depth, open PRs, spend). A tripped cap stops the loop and notifies; it never
  silently continues.
- **I5 Operator owns phase, policy and promotion.** The director may propose
  changes to any of them; only the operator applies them. Operator-only
  actions require a dedicated operator credential, distinct from the
  supervisor bearer token that members and agents can reach (`02` section 7).
- **I6 Policy is code-reviewed.** Policy and vision files live in git, change
  through PRs that a human merges, and are read only from the REMOTE
  integration branch ref (`02` section 1).
- **I7 Intake never launches.** Anything entering from outside (GitHub, Slack,
  email, scouts) lands as a triage bead; only groomed, ready work can be
  scheduled.
- **I8 No default on customer-visible decisions.** Gates on work tagged
  customer-visible are `propose_blocking`.
- **I9 Fail closed and loud.** If policy cannot be evaluated (file invalid,
  store unreadable, fleet unreachable) the result is `propose`, and the
  operator is notified. Never `do`.
- **I10 Generic engine.** Director role prompts live under `apra-pm/agents/`
  and are bound by the generic engine boundary
  (`docs/generic-engine-boundary.md`): project-specific content comes from the
  project's vision and policy files, never from prompt text.
