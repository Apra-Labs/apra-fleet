# Director: phases, dogfood, OS rotation, filler work

Status: DRAFT spec, v0.5. Vocabulary: `01-concepts.md`.

---

## 1. Phase state

- Stored per project in `supervisor.sqlite` table `project_phase` (created by
  migration 002, D1a) with history.
- Initial value: `policy.phase_default`; projects with only `phases.steady`
  have only `steady`.
- Set by `POST /api/director/:project/phase` with the OPERATOR credential
  (`02` section 7). A release playbook may call it only if the operator
  supplies the credential at run time; it is never stored in a playbook.
- Transition effects (emitted as `phase.changed`):
  - into `release_candidate`: `launch_sprint.feature` becomes whatever the RC
    phase says (the example forbids it); the dogfood counter starts for the
    candidate build.
  - into `released`: immediately -> `open_window`; risk factor kept; dogfood
    counter archived with the release tag.
  - into `stabilizing`: policy values switch; queue unchanged.
- The director may PROPOSE a phase change in `weekly_review` (gate,
  `propose_blocking`).

## 2. Dogfood

### 2.1 Where the code under test actually runs

The sprint engine (`fleet-sprint/runner.js`) is spawned by the supervisor on
the SUPERVISOR host, not on members. Members run the fleet server and the LLM
CLIs that execute dispatches. So "members on a new version" exercises only the
member-side code; the engine and supervisor are exercised only by a supervisor
running the candidate build.

### 2.2 Dogfood instance

- A second supervisor instance (own data dir, own port; the existing
  "one supervisor per data dir" model) runs the candidate build of supervisor
  + engine. It is the **dogfood instance**; the pinned one is the
  **production instance**.
- Projects opt in with `dogfood.enabled: true`; the operator moves a project
  between instances (a project is served by exactly one instance at a time).
  apra-fleet itself is the first dogfood project.
- Members of a dogfood project run the candidate fleet-server build.
- Both instances talk to the same fleet server for reservations (`01`
  section 7), so cross-project busy-ness stays correct. The fleet server used
  for reservations is the production one; version skew between it and
  dogfood members (N vs N+1) is a supported state for one minor version.

### 2.3 What counts

A dogfood sprint-hour is one wall-clock hour of a run executed by the dogfood
instance (candidate engine and supervisor) on candidate members. Runs on any
opted-in project count.

### 2.4 Regression attribution

Attributed to the candidate when a dogfood run ends with class `engine-bug`,
or with a transient/deterministic class whose rate on the dogfood instance over
the period exceeds the production instance's rate for the same class, or when
the operator labels a bead `regression:<version>`. Ambiguous cases are listed
in the digest; the operator can clear them.

### 2.5 Promotion gate

`promote_release` is always `propose_blocking`. Evidence is computed:
`dogfood hours = X / required`, `attributed regressions = N / allowed`,
`open P1 in release scope = M`. The answer API refuses "promote" while hours
are short or regressions exceed the limit; the operator may change the policy
instead (a reviewed act).

### 2.6 Canary and rollback

- `canary_members` members of the dogfood projects are upgraded first to each
  new integration-branch build that passed CI; after `canary_hours` with no
  attributed regression, the remaining members of dogfood projects upgrade.
- Upgrades use the existing member install path with an EXACT build (the
  exact-build prerelease channel exists, see #697). Each upgrade is a decision
  of class `member_upgrade`.
- Rollback = reinstall the previous exact build. The current installer only
  installs or upgrades "when missing or older"; D7 adds an explicit
  `allow_downgrade` path to the member install/update tool (with client
  wrapper parity) used only by rollback.
- An attributed regression on a canary rolls the canary back and opens an
  urgent `propose_blocking` gate.
- The `/fleet-status` mod currently has no version-skew logic; D7 adds a skew
  indicator that shows dogfood members as "dogfood canary" (info), not an error.

## 3. OS rotation

### 3.1 Inputs

- `policy.os_rotation.mode`: `off` | `random` | `weighted_least_recent`.
- The project's static member pool; each member's `os` from the fleet registry.
- `pinned_labels`: a bead in scope with one of these labels pins the sprint to
  members whose tags include that label (hardware-bound work).
- History: `os_exercise(project, area, os, last_run_at)` (created by migration
  002, D1a; written on `run.finished` by D8) where `area` is the depth-2
  directory of files changed by the run. Until D8 lands, rotation falls back
  to `random`.

### 3.2 Selection (implemented in D9 in the S22 scheduler)

1. Candidates = free, eligible (pool, tenant, pinned labels) members.
2. `random`: uniform over candidates' distinct OSes, then uniform member.
3. `weighted_least_recent`: weight each OS by hours since it last exercised
   the areas the planner expects to touch (planner file list when available,
   else the areas of the roots' previous runs); pick the OS by weight, then
   the least-loaded member of that OS.
4. If `cross_os_review` and more than one OS is available, reviewer and test
   roles go to a different OS from the doer.
5. Record `runs.os_doer`, `runs.os_reviewer` (columns added in S19's
   migration) and per-bead `metadata.os`.

### 3.3 Why this beats prompting

Prompts asking for OS-neutral code are advisory; running the work on a
different OS than last time is a test. Windows parity is the most common
regression class in this repo's history.

### 3.4 Failure correlation

The digest groups failures by OS over 14 days. Three or more failures on one
OS in one area produce a `weekly_review` item and, if policy allows, a triage
bead (`file_bead`).

## 4. Filler work (busy members without more review load)

On `member.idle` (emitted by the D9 scheduler), the filler dispatcher MAY run
one job per idle member (class `filler_job`, cap `max_concurrent`), lowest
priority, cancelled within one tick when a real launch needs the member:

| filler | output | PRs? |
|---|---|---|
| flaky-test detection: rerun the suite N times on this member's OS | report + triage beads per flaky test | no |
| dependency and advisory audit | report + triage beads | no |
| doc-vs-code drift scan | triage beads with file/line evidence | no |
| OS parity probe: build + `npm test` at integration HEAD on this OS | report; red raises a triage bead | no |
| KB harvest / reconcile | KB proposals | no |
| groomer pass (`08`) | groomer output | no |

Filler never opens a PR: the filler code path has no PR-publishing capability.
Filler spend counts toward weekly `usd` and is skipped first above 80% of
`per_week_usd`.

## 5. Acceptance

- Phase API (operator credential) tests: every transition and effect.
- Dogfood counter from fixture histories of two instances; promotion API
  refuses below threshold.
- Canary: canary first, widen after hold, rollback via exact-build downgrade.
- OS selection deterministic under a seeded RNG; pinned labels never rotate;
  cross-OS reviewer placement; recorded fields present; `random` fallback when
  `os_exercise` is empty.
- Filler pre-empted within one tick; never opens a PR.
