# Director: vision and policy files, policy engine, decision store

Status: DRAFT spec, v0.5. Vocabulary: `01-concepts.md`.

---

## 1. Where the files live and how they are read

Vision and policy belong to the TARGET project, not to apra-fleet:

```
<target repo>/.fleet/vision.yaml
<target repo>/.fleet/policy.yaml
```

Reading rules (I6):
- The supervisor keeps its OWN bare mirror of the project's remote
  (`<supervisor data dir>/mirrors/<project>.git`), never a member checkout.
  Agents cannot write to it.
- Refresh: `git fetch` into the mirror, then read
  `git show refs/remotes/origin/<integration-branch>:.fleet/policy.yaml` (and
  `vision.yaml`). The integration branch name comes from project config.
- A sprint diff touching `.fleet/**` is classified HIGH by the merge steward's
  pre-rules unconditionally and can never be auto-merged; changing these files
  therefore always needs a human merge.
- Refresh on every supervisor tick where the cached blob is older than 10
  minutes, and on `pr.merged` for the integration branch. The cache key is the
  blob hash; `policy.changed` is emitted when it changes.
- Missing files: the built-in conservative default policy applies (section
  4.4) and the director role is disabled for that project (scheduler, gates,
  notifications still work).
- Invalid files or fetch failure: I9 (every class evaluates to `propose`, one
  notification per distinct error).

Parsing: the `yaml` package (currently only a root devDependency) MUST be
added as a runtime dependency of `packages/apra-fleet-se` and included in the
installed tree and SEA bundle. Validation: `ajv` against
`packages/apra-fleet-se/src/director/schemas/{vision,policy}.schema.json`.
The schema rejects unknown keys so typos fail loudly.

## 2. vision.yaml

```yaml
version: 1
project: apra-fleet                 # MUST equal the supervisor project id
objectives:                         # weights MUST sum to 1.0 (+/- 0.001)
  - id: fleet-autonomy
    weight: 0.4
    outcome: "Fleet runs weekends unattended; operator answers < 5 gates/day"
    measures: [member_utilization, gates_per_day, gap_latency_hours]
    epics: ["label:objective:fleet-autonomy"]   # how beads map to this objective
    meta: true                      # optional: marks work that improves the system itself
  - id: v05-console
    weight: 0.6
    outcome: "v0.5 console ships on all three OSes"
    measures: [open_p1_in_scope, regression_pass]
    epics: ["label:objective:v05-console"]
tradeoffs:                          # ordered; earlier wins on conflict
  - "Reliability over features: never start a feature sprint while the integration branch is red."
  - "Prefer work on objectives marked meta when weights are equal: it compounds."
  - "Finish an epic before starting a new one at equal weight."
non_goals:
  - "No new LLM provider integrations this quarter."
precedents: decisions               # name of the decision-log scope (section 6)
```

Rules:
- `objectives[].epics` selectors are `label:<name>` or `id:<bead-id>`; a bead
  belongs to the first objective whose selector matches it or an ancestor.
- Beads matching no objective have weight 0 (schedulable only under
  `launch_sprint.other`).
- `tradeoffs` and `non_goals` are free text passed verbatim to LLM roles.

## 3. policy.yaml

The complete example is `examples/apra-fleet.policy.yaml`. Structure:

```yaml
version: 1
project: <id>
tenant: <isolation key>
customer_visible_labels: [...]
phase_default: open_window | steady
phases:
  <phase>:
    risk_budget: {wasted_sprints, reverted_merges, defaults_fired, usd}
    authority: { <action class>: <mode> | {mode, caps...} }
    promotion: {dogfood_sprint_hours, max_regressions}     # release_candidate only
base:
  hard: {tenant_isolation, customer_release, policy_file_change}
  spend: {per_week_usd, per_sprint_usd}
  authority: { <action class>: <mode> | {mode, caps...} }
  gates: {default_expiry_hours}
  backpressure: {max_prs_awaiting_human, max_chain_depth, breaker_consecutive_failures}
  queue: {min_ready, max_ready}
  risk_budget: {replenish, grow_if_clean_weeks, grow_factor, max_factor}
  merge: {stage, protected_targets, high_paths, max_files, max_lines, risk_guide}
  director: {enforce, max_usd_per_call, max_turns_per_call, max_usd_per_day}
  groomer: {max_runs_per_day}
  dogfood: {enabled, canary_members, canary_hours}
  os_rotation: {mode, cross_os_review, pinned_labels}
  intake: {github: {repos, labels}}
  report_engine_bugs: {tracker: <owner/repo or "none">}
  notify: {email, digest_at, quiet_hours, imap?}
  delegates: [{email, classes: [...]}]
```

### 3.1 Action classes (closed set for v0.5)

Every action the system can take on its own belongs to exactly one class. An
action with no class cannot be executed (I1).

| class | emitted by | caps (in the class object) |
|---|---|---|
| `launch_sprint.autoqueue` | scheduler | -- |
| `launch_sprint.feature` | scheduler | -- |
| `launch_sprint.other` | scheduler | -- |
| `retry_after_abort` | event router | `max_per_root` |
| `ci_fix_sprint` | event router | `max_per_pr`, `max_per_branch_red` |
| `merge_pr.low` / `merge_pr.high` | merge steward | -- |
| `parallel_prs_when_merge_blocked` | scheduler | `when_blocked_by`, `require`, `max_open_prs` |
| `groom_mutation` | groomer (parsed actions) | -- |
| `mark_ready` | groomer | -- |
| `resume_run` | router (gate answer for a paused run) | -- |
| `file_bead` | router (triage, bug, investigation beads) | `max_per_day` |
| `kb_reconcile` | router after merge | -- |
| `filler_job` | filler dispatcher | `max_concurrent` |
| `member_upgrade` | dogfood canary | -- |
| `promote_release` | operator only | always `propose_blocking` |
| `phase_change` | operator only | director may only propose |
| `policy_file_change` | director weekly review | always `propose_blocking`; effect opens a PR, never commits |

Adding a class is a spec change (schema + this table).

### 3.2 Phase overrides merge rule

Effective authority = `base.authority` deep-merged with
`phases[current].authority`:
- A scalar phase value (e.g. `merge_pr.low: do_notify`) replaces only `mode`;
  caps are kept from `base`.
- An object phase value merges key by key; caps it omits are kept from `base`.
- The schema rejects a phase value that sets a cap to null or removes it.
- Phases may make a cap tighter or looser only by giving an explicit number.

## 4. Policy engine

Module: `packages/apra-fleet-se/src/director/policy-engine.mjs`. Pure function
plus a thin store adapter; no network, no LLM.

### 4.1 Evaluation order

```
evaluate(action, ctx) -> { mode, rule, reasons[] }

0. class     : action.class not in the closed set                   -> forbid
1. load      : policy invalid/missing/stale-fetch                   -> I9 (propose, reason=policy-unavailable)
2. hard      : tenant(action) != policy.tenant                      -> forbid
               action touches .fleet/**                             -> propose_blocking
               action.labels intersects customer_visible_labels     -> at least propose_blocking (I8)
               class in {promote_release, phase_change, policy_file_change} -> propose_blocking
3. phase     : effective authority per section 3.2
4. caps      : any class cap exceeded                               -> propose, reason=cap:<name>
               chain depth > backpressure.max_chain_depth (launch_*) -> propose
5. spend     : week spend + estimate > per_week_usd, or estimate > per_sprint_usd -> propose
6. backpressure: launch_* while prs_awaiting_human > max            -> propose (reason=backpressure)
                 breaker tripped -> propose for every launch_* and retry_after_abort
7. budget    : project exhausted -> do|do_notify downgraded to propose
8. enforce   : director.enforce == false -> outcome recorded as `logged`; caller keeps pre-director behaviour
9. result    : effective mode; `rule` = dotted path of the deciding rule
```

Downgrades only move toward caution
(`do -> do_notify -> propose -> propose_blocking -> forbid`); no later step
can upgrade a mode set by an earlier step.

### 4.2 Context (`ctx`)

`{project, tenant, phase, now, weekSpendUsd, estimateUsd, prsAwaitingHuman,
openPrs, chainDepth(root), retries(root|pr|branch), breakerTripped,
budgetState}` - computed by deterministic code from the supervisor store,
ledger, history and fleet server. The builder takes only `(project, action)`;
there is no parameter through which an LLM value could enter.

`prsAwaitingHuman` and `openPrs` come from the forge watcher (D3a). Until it
lands they are 0 and the engine records `reason=pr-counts-unavailable` on every
launch decision.

### 4.3 Estimates

`estimateUsd` for a sprint = median `costUsd` of the project's last 10
finished runs with a known cost (runner result field added in D1a); with fewer
than 3 such runs, `per_sprint_usd` (pessimistic). A run whose `costUsd` is null
is debited as `per_sprint_usd`.

### 4.4 Built-in default policy

Used when `policy.yaml` is absent: every class `propose`, except
`promote_release`, `phase_change`, `policy_file_change` (`propose_blocking`);
`filler_job` and `parallel_prs_when_merge_blocked` `forbid`; spend caps 0 for
autonomous work; `director.enforce: false`.

## 5. Risk ledger

Store: `supervisor.sqlite`, table `risk_week` (created by migration 002, D1a):

```
risk_week(project, week_start, wasted_sprints, reverted_merges,
          defaults_fired, usd, factor, exhausted_at)
```

- Debits are written by the event router when an outcome is known.
- `exhausted` = any counter >= its phase limit x factor. Entering it sends one
  urgent notification; leaving it at replenish is recorded.
- `factor` starts at 1.0. At replenish, after `grow_if_clean_weeks`
  consecutive weeks with zero `reverted_merges` and zero breaker trips,
  `factor *= grow_factor` (capped at `max_factor`). Any revert resets it to 1.0.
- Operator reset: section 7 (operator credential).

## 6. Decision store

Table `decision` (migration 002):

```
decision(id, at, project, phase, event_id, action_class, action_json,
         proposed_by, rationale, objective_refs, rule, mode, gate_id,
         outcome, outcome_at, risk_debit_json)
```

- Append-only; `outcome` filled once: `executed`, `refused`, `gated`,
  `logged`, `answered:<option>`, `expired:<option>`, `failed:<reason>`,
  `reevaluated-refused:<reason>`.
- Gate answers are also exported as plain-text precedent entries via
  `kb_capture` in the project's own KB scope (never another tenant's).

## 7. API and credentials

Two credentials:
- **supervisor bearer** (`fleet.key`, existing): read routes and routine
  writes. Reachable by local members and agents, so it never authorizes
  operator-only actions.
- **operator credential**: a separate secret `director_operator_token` in the
  fleet credential store with `network_policy: confirm`. Required on every
  route marked (op). The dashboard and `/fleet-status` obtain it through the
  existing out-of-band confirmation flow; it is never written to transcripts,
  logs or files.

| route | auth | purpose |
|---|---|---|
| `GET  /api/director/:project/policy` | bearer | effective policy, validation status, blob hash |
| `POST /api/director/:project/evaluate` | bearer | dry-run an action |
| `GET  /api/director/:project/decisions?since=` | bearer | decision log page |
| `GET  /api/director/:project/risk` | bearer | counters, factor, exhausted |
| `POST /api/director/:project/risk/reset` | op | reset the week |
| `POST /api/director/:project/phase` | op | set phase (D7) |
| `POST /api/director/:project/gates/:id/answer` | op (or delegate token for listed classes) | answer a gate (D4a) |

## 8. Acceptance (D2a)

- Table-driven tests: one case per evaluation step in 4.1 including step 0 and
  every downgrade path, and the "no upgrade" rule.
- Merge-rule tests (3.2): scalar phase override keeps base caps; null cap rejected.
- Schema tests: all files in `examples/` validate; documented errors (weights
  not summing, unknown class, unknown key, unknown phase) fail with a field path.
- I9 tests: corrupt file, fetch failure -> every class `propose`, one notification.
- Mirror test: a commit on a local member checkout that is not on the remote
  ref has no effect on the loaded policy.
- Ledger tests: exhausted transition, replenish, growth, reset-on-revert.
- Auth tests: op routes refuse the supervisor bearer alone.
