# fleet-bridge: a DevOps-platform bridge for fleet-sprint

**Status:** Proposed (design only -- no code written yet)
**Date:** 2026-09-18
**Author:** Akhil Kumar
**Scope:** A common bridge between work-item/pipeline platforms (Azure DevOps,
GitHub, Bitbucket) and apra-fleet's fleet-sprint engine. Designed once against a
platform-neutral contract; validated on Azure DevOps only in this phase.

---

## 1. What we are trying to demonstrate

A user should be able to:

1. Write requirements into **work items** on their DevOps platform, and evolve the
   plan there with Claude or any other assistant.
2. Select some work items, pick a **target branch** and a **sprint goal**
   (P1/P2/P3), and **trigger a pipeline**.
3. That pipeline runs on **this machine, registered as a self-hosted runner**,
   pre-provisioned to host fleet-sprints.
4. The sprint plans, develops, reviews, tests -- the whole nine yards -- and
   **raises a pull request against the target branch**.
5. During finalization, whatever remains as **carry-over becomes new backlog items**
   on the DevOps platform. Beads closed during the sprint are *not* reported back.
6. The user can **observe progress** from the platform they already live in.
7. Sprints may run for **up to two days**, and that must not be pathological for a
   fixed, paid pool of self-hosted runner slots.

The explicit constraint: **no substantial changes to apra-fleet**. The bridge is
additive. Everything below is built on seams that already exist.

---

## 2. What already exists (verified, not assumed)

This matters, because it determines how little needs building. Each claim was checked
against the code in this repo or the installed CLI.

### 2.1 The sprint launch seam is already an HTTP API

The supervisor (`fleet-se-serve`, default port 8787) is the supported entry point.
`POST /api/sprints` accepts `{issue, branch, base, members, goal?, maxCycles?,
budget?, requirementsFile?, roleMap?, allowMissingMembers?, overrideRelaunchGate?}`.

It validates before spawning, then starts the sprint as a **detached child process**
and returns `201 {sprintId, pid, port, logPath, issueRoots, members, goal}`.

The spawn is genuinely detached:

```js
spawn(command, args, { detached: true, stdio: ['ignore', logFd, logFd] });
child.unref();
```

No parent-child IPC; killing the supervisor never kills a running sprint.

**This is the single most important fact in the design: the sprint is already
detached from whoever launched it.** The launching process can exit immediately and
the sprint continues. That is what makes the runner-slot problem solvable.

The underlying engine arg contract (`sprint-args.mjs`, `validateArgs`) is strict and
rejects unknown keys loudly:

| Field | Required | Default | Validation |
|---|---|---|---|
| `target_issues` | **yes** | -- | `/^[A-Za-z0-9._-]+$/` per id |
| `members` | **yes** | -- | non-empty array |
| `branch` | **yes** | -- | `/^[A-Za-z0-9._/-]+$/` |
| `base_branch` | **yes** | -- | same pattern; also the PR target |
| `goal` | no | `P1/P2` | `/^P[1-3](\/P[1-3]){0,2}$/` |
| `max_cycles` | no | `5` | positive integer |
| `budget` | no | unlimited | non-negative USD |
| `requirementsFile` | no | -- | path; planner prompt only |
| `dispatch_timeout_s` | no | `9000` | integer >= 60 |
| `azdevops_pat_secret_name` | no | `azdevops_pat` | credential-store name |
| `run_id` | no | branch | the ledger's sprintId |

Note `azdevops_pat_secret_name`: a per-sprint credential-name override already
exists, so multi-tenant use needs no engine change. This is the ENGINE's own
internal arg key (`sprint-args.mjs`'s `KNOWN_ARG_KEYS`), left unrenamed as
engine-internal surface. The supervisor's public `POST /api/sprints` HTTP
field the bridge actually sends is `vcs_pat_secret_name` (provider-neutral;
the supervisor maps it onto this internal key -- see
`docs/cli-reference.md` and `src/supervisor/api.mjs`'s
`resolveVcsPatSecretName()`). The supervisor also still accepts the bridge's
prior `azdevops_pat_secret_name` spelling as a deprecated alias for one
release, so an unmigrated bridge keeps working.

Other routes the bridge uses:

| Route | Use |
|---|---|
| `GET /api/health` | preflight: supervisor up, seams wired (not `:stub`) |
| `GET /api/members` | preflight: member exists and free (`reserved`, `reservedBy`) |
| `GET /api/sprints/:id` | poll: live proxied child state, or terminal record |
| `POST /api/sprints/:id/stop` | cooperative stop (pipeline cancellation) |
| `GET /sprints/:id/log?tail=N` | raw child stdout/stderr -- works even after an early crash |
| `POST /api/reservations/:id/force-release` | operator escape hatch for a wedged reservation |

### 2.2 Concurrency is overlap-based, not slot-count-based

The reservation ledger claims two axes atomically: **members** and **issue roots**.
There is **no numeric concurrency limit**. A launch overlapping an active sprint on
either axis is rejected `409`, naming the conflicting sprint and the specific
overlapping member or bead. A rejected launch leaves the ledger byte-identical.

The member axis is checked against two sources -- the supervisor's ledger *and* the
fleet server's per-member `reservedBy` -- so reservations made outside the supervisor
are still honoured.

Consequence: **N concurrent sprints requires N registered members.** Documented
guidance is "one member per sprint; scale by adding sprints, not doers."
Multi-doer single-sprint is explicitly flagged experimental.

### 2.3 beads already speaks Azure DevOps and GitHub natively

The biggest find, and it removes most of what looked like bridge work. Verified
against the installed `bd`:

```
bd ado     projects | pull | push | status | sync
bd github  repos    | pull | push | status | sync
```

- `bd ado pull <refs...>` -- *"Accepts bead IDs or external references"*, so a
  pipeline can hand it raw work-item IDs. Equivalent to
  `bd ado sync --pull-only --issues <refs>`. Supports `--dry-run`.
- `bd ado push <bead-ids...>` -- equivalent to
  `bd ado sync --push-only --issues <ids>`. Supports `--dry-run`.
- Config via `bd config` or env: `AZURE_DEVOPS_ORG`, `AZURE_DEVOPS_PROJECT(S)`,
  `AZURE_DEVOPS_PAT`, `AZURE_DEVOPS_URL` (on-prem).
- GitHub mirrors this exactly, plus GitHub Enterprise via `GITHUB_API_URL`.

**There is no `bd bitbucket`.** Bitbucket goes through the generic `bd import`
(JSONL upsert; only `title` required; accepts `description`, `acceptance_criteria`,
`issue_type`, `priority`, `status`, `labels`, `external_ref`, `source_system`)
inbound, and a bridge-owned REST call outbound.

Because `push` is **explicitly ID-scoped**, we push exactly the carry-over set and
nothing else. That satisfies "closed beads do not get reported to devops" by
construction rather than by filtering after the fact.

> **Guardrail:** never invoke bare `bd ado sync` / `bd github sync` from the bridge.
> They are bidirectional by default and would push the entire local beads DB into the
> customer's backlog. The bridge only ever calls the ID-scoped `pull` and `push`.

### 2.4 fleet-sprint already opens PRs per platform

`vcs-providers/` is a validated provider registry whose header states the extension
contract plainly: *"ADDING A PROVIDER IS: write one file next to this one exporting a
descriptor ... NO OTHER FILE under fleet-sprint/ changes."*

| Provider | Host match | `parseRepoRef` | `buildProvisionArgs` | PR create | PR comment |
|---|---|---|---|---|---|
| azure-devops | `dev.azure.com`, `*.visualstudio.com` | yes | yes (`azdevops_pat`) | **yes** | **yes** |
| github | `github.com` | -- | shared GitHub App args | **yes** | **yes** |
| bitbucket | `bitbucket.org` | no | no | **no (`builders: null`)** | **no** |
| generic-git | catch-all | -- | -- | no | no |

The publish phase pushes the branch, classifies the remote via
`vcsCapabilities(originUrl)`, and raises a PR titled `Auto-sprint [PASS|FAIL]:
<branch>` against `base: validated.baseBranch`. The PR is raised on **both** PASS and
FAIL; the body carries a fixed "Do NOT auto-merge -- a human must review and merge
this PR" line. A `422 already exists` is swallowed as idempotent.

So for Azure DevOps and GitHub, requirement (4) is **already met** once the sprint is
launched with the right `branch`/`base`. Bitbucket is a genuine gap, named as a
workstream below rather than hand-waved.

### 2.5 Crucially: there are no events to subscribe to

There is **no webhook, no EventEmitter, no `.on()`/`.emit()`, and no callback
registry anywhere under `fleet-sprint/`**. The only machine-readable state push is
`publishState('beads', payload)`, which feeds the workflow engine's own dashboard,
not anything outward.

The supervisor's `/events` SSE is not a real event stream either: every message is a
generic `{type: "update"}` on a timer, and the client's only reaction is to re-poll
`/state`. The per-sprint `/sprints/:id/live/events` *is* a genuine SSE passthrough.

**Therefore the bridge polls. It does not subscribe.** This is a feature, not a
concession: polling an existing read API requires zero apra-fleet changes, which is
the stated constraint.

### 2.6 Carry-over already has a machine-readable marker

Two mechanisms produce carry-over today:

1. **Regression failures.** The regression phase instructs its agent: file every
   failure as a STANDALONE bead -- `bd create` WITHOUT `--parent`, no `bd dep add` --
   titled `[regression][carry-over] <description>`, searching for `[carry-over]`
   first to update rather than duplicate. Being parent-less keeps them out of the
   completion gate.
2. **Harvester defers.** The harvester defers low-priority issues (status
   `deferred`) per its agent contract.

And `bd list` supports exactly the filters needed:
`--status open,in_progress,blocked,deferred`, `--created-after`, `--json`, `--label`.

### 2.7 A sprint cannot bootstrap itself from prose

This constrains `ingest` more than anything else, so it is called out separately.

- `target_issues` is **required**; no code path creates a root epic from a file.
- Pre-sprint validation runs **before the planner** and refuses a childless target
  with `NOTHING_TO_DO`: *"No open/in-progress/blocked/deferred beads found for scope
  ... Nothing to do."*
- Scope resolution is a **parent-child BFS** from each target id over every
  descendant at any depth. A bead attached only by `blocked-by` is invisible to it.
- `requirementsFile` is supplementary only -- pasted verbatim into the **planner's**
  prompt. It reaches neither the doer nor the reviewer.

**So `ingest` must deliver an epic with at least one properly `--parent`-ed child.**
The planner refines an existing DAG; it never creates the first level of it.

### 2.8 What the sprint leaves behind, and where

- A pushed branch with reviewed commits and an open PR.
- `docs/sprint-analysis-<branchSlug>.md` -- **Markdown, committed to the branch**.
  `branchSlug` is `<slug>-<sha256[:8]>`, deterministic, so reruns overwrite rather
  than accumulate.
- A CHANGELOG entry with a cost-analysis block.
- Run state: `~/.apra-fleet/data/running/<runId>.json` while live, moved to
  `old_runs/<runId>.json` at terminal.
- Raw child log: `~/.apra-fleet-se/logs/<runId>.log`.
- Crash-safety snapshots under `sprint-logs/`.

There is **no JSON sprint-report artifact**. Structured results come from
`GET /api/sprints/:id` and the beads DB.

Journal-based replay resume exists in the workflow engine but is **off by default**
and not wired by the sprint CLI. Practical continuation is: relaunch on the same
`--branch` (reused as-is if it exists) and let beads state plus existing commits
carry the work forward.

---

## 3. The hard constraint: two-day sprints vs paid runner slots

This requirement actually shapes the architecture, so it gets its own section.

A self-hosted runner has a fixed number of concurrently-executing job slots, and they
are paid for. A pipeline job babysitting a two-day sprint holds one slot for two
days. With a handful of slots, two or three long sprints starve every other pipeline
in the org -- CI, releases, everything.

There is also a hard platform ceiling that rules out the naive approach outright:

| Platform | Max job duration (self-hosted) |
|---|---|
| Azure DevOps | effectively unbounded (`timeoutInMinutes: 0`) |
| GitHub Actions | bounded, but days-scale |
| **Bitbucket Pipelines** | **hard 2-hour cap, self-hosted included** |

A two-day sprint inside one pipeline job is **impossible on Bitbucket**, at any
price. Since the brief is one common approach for all three, the attached-job model
cannot be the canonical one.

### 3.1 Decision: detached dispatch is the canonical mode

The pipeline job is **short-lived** -- target under two minutes:

```
preflight -> ingest -> launch -> record handle -> exit 0
```

It posts to `POST /api/sprints`, receives the `sprintId`, writes a handle artifact,
and **releases the runner slot immediately**. The sprint continues as the detached
child it already is. Sprint duration is fully decoupled from slot occupancy: a
two-day sprint and a two-minute one cost the same slot time.

This works identically on all three platforms, including Bitbucket, and it is the
only model that does.

Observation happens out-of-band (Section 7): a long-lived bridge daemon on the same
box polls the supervisor and mirrors progress back onto the platform the user already
watches -- work-item comments, PR comments, build status.

### 3.2 The attached mode stays available, as an opt-in

Some teams genuinely want live logs in the pipeline UI. `mode: attached` runs the
same verbs but keeps `fleet-bridge watch` in the foreground until the sprint
terminates.

It ships with its cost stated plainly: **it holds a runner slot for the sprint's full
duration**, and it is unavailable on Bitbucket. Recommended only on a dedicated agent
pool whose slots are budgeted for it, and only for short sprints.

### 3.3 Slot pressure is a pool problem, not a bridge problem

Two operational recommendations that cost nothing:

- Put fleet-sprint dispatch on its **own agent pool** (e.g. `fleet-sprints`) with its
  own demand, so a burst of launches cannot starve CI. In detached mode each job is
  two minutes, so a very small pool suffices.
- Size **sprint** concurrency by **registered members**, not runner slots. The ledger
  enforces one sprint per member. Three concurrent sprints means three registered
  members -- and still three two-minute pipeline jobs.

---

## 4. Architecture

```
  Work items          Pipeline               THIS MACHINE (self-hosted runner)
 +-----------+     +-------------+     +---------------------------------------+
 | AzDO      |     | azure-      |     |  fleet-bridge CLI (short-lived)       |
 | Boards    |---->| pipelines   |---->|   preflight -> ingest -> launch       |
 | GH Issues |     | .yml /      |     |            |                          |
 | BB Issues |     | workflow /  |     |            v  POST /api/sprints       |
 +-----------+     | bitbucket-  |     |  supervisor (8787) --> detached child |
       ^           | pipelines   |     |            |                          |
       |           +-------------+     |            v                          |
       |                               | fleet-sprint: plan/dev/review/test     |
       |  carry-over items,            |            |                          |
       |  progress comments            |            v                          |
       |                               |  fleet-bridge daemon (long-lived)     |
       +-------------------------------|   poll -> mirror -> finalize          |
                                       +---------------------------------------+
                                                     |
                                                     v  PR (existing vcs-providers)
                                              target branch
```

### 4.1 Where the code lives

A new sibling package: **`packages/apra-fleet-bridge`**, alongside the existing
`apra-fleet-client`, `apra-fleet-se`, `apra-fleet-workflow`, `fleet-api-contract`.

Purely additive. It **consumes** apra-fleet over HTTP and `bd` over the CLI; it does
not modify the sprint engine.

```
packages/apra-fleet-bridge/
  src/
    contracts.mjs        # the neutral shapes in Section 5
    verbs/               # preflight, ingest, launch, watch, finalize, status
    adapters/
      index.mjs          # registry, selection by explicit platform id
      azure-devops.mjs
      github.mjs
      bitbucket.mjs
    supervisor-client.mjs   # bearer-aware (Section 10)
    beads-client.mjs
    viewer-proxy.mjs        # LAN control+view proxy (Section 7.2)
    sinks/                  # web-pubsub, append-blob, appinsights, azdo-wiki (7.3)
  templates/
    azure-pipelines.yml
    github-workflow.yml
    bitbucket-pipelines.yml
  bin/fleet-bridge.mjs
```

### 4.2 The adapter interface

Deliberately modelled on the `vcs-providers` descriptor pattern that already works
here -- a plain object, validated at registration, with optional axes a platform may
omit:

```js
{
  name: 'azure-devops',                  // required; explicit, never sniffed

  // --- inbound -------------------------------------------------------------
  resolveRequest(env):  SprintRequest,   // platform env/params -> neutral request
  ingest(refs, ctx):    IngestResult,    // tracker work items -> beads

  // --- outbound ------------------------------------------------------------
  publishCarryOver(items, ctx): CarryOverResult,  // beads -> new backlog items
  comment(target, markdown, ctx),                 // work item / PR comment
  setBuildStatus(state, url, ctx),                // optional

  // --- observability -------------------------------------------------------
  emitProgress(snapshot, ctx),           // platform-native log / annotation
  capabilities(): {
    nativeBeadsSync:   boolean,          // true for azdo + github
    canCreateWorkItem: boolean,
    canComment:        boolean,
    maxJobMinutes:     number|null,      // null = unbounded
    supportsAttached:  boolean,
  },
}
```

`nativeBeadsSync` is what makes one design cover three platforms honestly: Azure
DevOps and GitHub set it `true`, and their `ingest`/`publishCarryOver` are thin
wrappers over `bd ado` / `bd github`. Bitbucket sets it `false` and supplies its own
REST implementations behind the same two method names. Every caller above the adapter
layer is identical.

Selection is **explicit** (`--platform`, or hard-coded by the pipeline template). No
host sniffing at this layer -- the tracker and the git host are not necessarily the
same vendor, and guessing would be wrong exactly when it matters.

### 4.3 Why go through the supervisor rather than spawn sprints directly?

A fair challenge, and the answer is **not** "the CLI cannot be launched directly" --
it can. `bin/cli.mjs` is a real non-interactive entry point, and the fleet-sprint-cli
skill documents detached launch via `Start-Process -WindowStyle Hidden` / `nohup ...
& disown`.

It is also **not** that concurrent sprints would corrupt shared state without a
supervisor. The engine explicitly supports a supervisor-less topology. `runner.js`
resolves the dolt push mutex and the child-id allocator from four sources in
precedence:

1. an injected client (tests);
2. `args.serviceUrl` -- HTTP against the supervisor's mutex/allocator routes;
3. **`args.callTool` -- the SUPERVISOR-LESS path**: the fleet server's own
   `dolt_push_mutex` and `child_id_allocator` MCP tools, over the MCP connection
   every standalone launch already holds;
4. no-op, logged loudly as `DEGRADED`.

Because `cli.mjs` always attaches to the fleet HTTP singleton, a directly-spawned
sprint lands on **path 3, not path 4**. Cross-sprint dolt push serialization and
collision-free child-id minting are therefore intact without a supervisor.

What the supervisor genuinely adds, and what a direct-spawn bridge would have to
re-implement:

- **The issue-scope overlap guard.** `cli.mjs` reserves *members* server-side, so
  that axis is covered standalone -- but the **issue-root** axis and the pre-spawn
  `409` exist only in the supervisor's `launch()`. Without it, two pipeline runs on
  two different members can be pointed at overlapping bead scopes.
- **The relaunch gate.** Refusing relaunch after a deterministic failure
  (`BEADS_SYNC_CONFLICT`, `launch-failed`) is supervisor history. It exists precisely
  to stop burning a second two-day run on a failure that will recur.
- **Crash cleanup.** The watchdog auto-releases reservations on crash/finish with a
  PID-reuse guard. A hard-crashed standalone sprint can leave its member reserved.
- **A ready-made observability API** (`/api/sprints/:id`, `/sprints/:id/log`, the
  dashboard, the live proxy). Otherwise the bridge parses
  `~/.apra-fleet/data/running/<runId>.json` and `old_runs/` itself -- feasible, but
  re-implementation.

**The decisive reason is specific to pipelines: process-tree ownership.** A directly
spawned sprint is a child of the pipeline job's process tree. Section 3.1 has the job
exit after ~2 minutes while the sprint runs for up to two days. CI agents commonly
reap orphaned processes at job completion -- GitHub's self-hosted runner does, and
Azure Pipelines performs comparable cleanup -- and the fleet-sprint-cli skill already
warns about exactly this hazard class: a harness-owned background task "can be
silently killed when its tool call's process group ends."

With the supervisor, the sprint's parent is a long-lived service **outside the job's
process tree**, so job teardown cannot reach it. Direct spawn puts the two-minute-job
design and the two-day sprint in direct tension.

> **Verify, do not assume.** The mechanism is certain; Azure DevOps' exact cleanup
> behaviour and any opt-out knob are not. Confirm empirically in Phase 2 by exiting a
> job immediately after a direct spawn and checking whether the child survives. If it
> reliably does, direct spawn becomes a genuine option and this section should be
> revised.

The one consideration that previously argued *for* direct spawn -- avoiding an
unauthenticated always-on HTTP service -- is moot as of the 2026-09-18 decision in
Section 10 to accept that risk pending #493.

**Decision:** the supervisor is the default for pipeline-triggered sprints. It costs
one small local service we are standing up anyway and resolves process-tree ownership
for free. A `--spawn direct` escape hatch is supported for local and manual use,
where the caller owns detachment; in that mode `preflight` warns that the scope
guard, relaunch gate and crash cleanup are unavailable.

---

## 5. Neutral contracts

```jsonc
// SprintRequest -- what a trigger means, platform-independently
{
  "platform":    "azure-devops",
  "repo":        { "remoteUrl": "...", "localPath": "..." },
  "workItems":   ["12345", "12346"],       // native tracker ids, as selected
  "targetBranch":"feature/checkout-v2",    // branch the sprint develops on
  "baseBranch":  "develop",                // fork point AND PR target
  "goal":        "P1/P2",                  // must match /^P[1-3](\/P[1-3]){0,2}$/
  "member":      "dev1",
  "maxCycles":   5,
  "budget":      25,
  "requirementsFile": "docs/checkout-v2.md",
  "mode":        "detached",               // detached | attached
  "triggeredBy": "user@org.com",
  "runUrl":      "https://dev.azure.com/.../_build/results?buildId=987"
}

// SprintHandle -- pipeline artifact; the join key for everything afterwards
{
  "sprintId": "...", "pid": 1234, "port": 41000,
  "logPath": "...", "issueRoots": ["mem-1a2"],
  "request": { /* SprintRequest */ },
  "startedAt": "2026-09-18T10:00:00Z"
}

// ProgressSnapshot -- one poll result, mirrored onto the platform
{
  "sprintId": "...", "phase": "Develop", "cycle": 2,
  "health": "running-healthy",   // one of the watchdog's six states
  "closed": 7, "required": 12, "fraction": 0.58,
  "spendUsd": 4.12, "verdict": null,
  "updatedAt": "..."
}

// CarryOverItem -- one bead that becomes one new backlog item
{
  "beadId": "mem-9f1",
  "title": "[regression][carry-over] checkout total wrong for zero-qty",
  "body": "...", "acceptanceCriteria": "...",
  "issueType": "bug", "priority": 2,
  "reason": "regression" | "deferred" | "unfinished",
  "sprintId": "...", "prUrl": "...", "branch": "..."
}
```

---

## 6. The CLI verbs

One binary, six verbs, identical on every platform. The pipeline templates are thin
wrappers -- all platform variation lives in the adapter, never in YAML.

### `fleet-bridge preflight`
Fails fast, before anything mutates, one actionable message per failure:
- `GET /api/health` -- supervisor up, seams wired (not `:stub`).
- `GET /api/members` -- requested member exists and `reserved === false`.
- Member's registered `vcsProvider` is set (`resolveProvider` hard-errors on a member
  without one -- no default, no guess).
- Credentials present **by name only** via `credential_store_list` (e.g.
  `azdevops_pat`). Never reads a value.
- Repo clone present, `base` branch resolvable, remote recognised by
  `vcsCapabilities()` -- warn loudly if `canOpenPullRequest === false`, because the
  sprint will otherwise run for two days and then decline to open a PR.
- Beads DB health: a `bd dolt pull` probe, mirroring the engine's own gate, so a
  diverged DB fails here rather than after launch.
- `deploy.md` / `integ-test-playbook.md` presence -- **warn, do not fail**; their
  absence cleanly skips those phases by design.

### `fleet-bridge ingest`
Tracker work items -> a sprint-ready beads scope. Governed by Section 2.7.
1. Pull: `bd ado pull <ids>` (or `bd github pull`, or Bitbucket REST -> `bd import`).
2. **Guarantee a root epic with at least one child.** Scope resolves by parent-child
   BFS from the root, so a flat set of work items is not launchable as-is, and a
   childless epic aborts with `NOTHING_TO_DO` before the planner. If the selection
   has exactly one natural parent, use it and parent the rest under it; otherwise
   create a synthetic epic titled after the pipeline run and `--parent` every pulled
   item beneath it. The synthetic root is local-only and **never pushed back**.
   Assert child count >= 1 before proceeding, and fail here if not -- this is the
   cheapest possible place to catch it.
   Note that `--parent` links are what count; a `blocked-by` edge alone is invisible
   to scope resolution.
3. Emit an **acceptance-criteria audit**: every pulled bead with no acceptance
   criteria. This is the single biggest predictor of a wasted sprint -- the doer is
   contractually instructed to *skip* beads lacking criteria rather than guess.
   Default `--require-criteria` fails the pipeline here, cheaply, instead of two days
   later. `--allow-missing-criteria` overrides for exploratory runs.
4. Output the root bead id for `launch`.

### `fleet-bridge launch`
`POST /api/sprints` with the mapped request; write `SprintHandle` as a pipeline
artifact. Maps supervisor failures onto pipeline outcomes, reason preserved verbatim:
- `400` -> fail, naming the offending field.
- `409` member/scope overlap -> fail, naming the conflicting sprint. Do **not**
  auto-retry; the conflict is real and silent retry would mask it.
- `409` relaunch gate (prior run failed deterministically, e.g.
  `BEADS_SYNC_CONFLICT`) -> fail with the explicit remedy: fix the cause, or re-run
  with `overrideRelaunchGate`. This guard exists to stop us burning another two-day
  run on a known-deterministic failure; **the bridge must never set the override
  implicitly.**

In `detached` mode, `--await-plan` (default on) holds the job open until planning
resolves, then exits. See Section 7.1 -- this is what turns a green pipeline run from
"we launched something" into "this sprint is viable".

### `fleet-bridge watch`
Poll `GET /api/sprints/:id` on a backoff (5s early, widening to 60s). Build a
`ProgressSnapshot` per tick and hand it to `adapter.emitProgress()`. Post a throttled
comment on the root work item at **phase transitions only** -- not per tick -- so a
two-day sprint yields a readable dozen updates rather than thousands. Falls back to
`GET /sprints/:id/log?tail=N`, the one surface that still works if the sprint died
before writing run state.

### `fleet-bridge finalize`
Runs once the sprint reaches terminal state. Requirement-critical; see Section 8.

### `fleet-bridge status`
Operator convenience: resolve a handle, print current state, exit.

### The daemon
`fleet-bridge daemon` supervises `watch` + `finalize` for every handle in its spool
directory, so detached sprints are still mirrored and finalized with no pipeline job
held open. A plain long-lived process on the same box as the supervisor,
restart-safe because the spool is on disk and every verb is idempotent.

---

## 7. Observability

The hard part is not watching a running sprint -- the supervisor dashboard already
does that well. It is that **the pipeline job exits after two minutes and the sprint
runs for two days**, so every feedback channel has to work with nothing of ours
running inside the job. Three mechanisms, in order of how much they are relied on.

### 7.1 Gate the pipeline on planning, not on launch

A job that exits green after posting to `/api/sprints` only reports "we launched
something", which is close to no signal at all. `--await-plan` (default on) holds the
job open until planning resolves, and only then detaches:

- **Plan approved** -> exit **green**. The sprint is viable; the remaining failure
  modes are work failures, which is what the two days are for.
- **Terminal state before plan** -> exit **red**, reporting the engine's reason
  verbatim. Nearly free to implement: these failures already terminate the child, so
  the bridge only has to observe it.
- **`--await-timeout` reached** (default 20 min) -> exit **green**, noting "still
  planning, now detached". **The timeout never stops the sprint** -- it is a
  statement about the pipeline's patience, not about the run.

Two details that decide whether this works:

- **The gate is the plan-reviewer verdict, not the Plan phase boundary.** A
  `CHANGES_NEEDED` verdict drives the `replan` phase, so planning legitimately loops.
  Gating on the phase ending would fail a perfectly normal iteration.
- **Why plan is the right gate:** the cheap, deterministic failures cluster at or
  before it -- `NOTHING_TO_DO`, `TARGET_NOT_VISIBLE`, dependency cycles/deadlock, the
  beads-DB divergence gate, LLM auth expiry, an unreachable member, and acceptance
  criteria too thin to decompose.

Slot cost is bounded at ~20 minutes against a two-day run (under 1%), and stays
inside Bitbucket's 2h ceiling.

### 7.2 A full-control LAN viewer (and its collision with #493)

The obvious move is to return `http://<runner-host>:8787/sprints/<id>/live` from the
pipeline. It works today -- and **#493 breaks it**, by binding the supervisor to
127.0.0.1 only and requiring a bearer token.

The per-sprint child viewer calls `server.listen(port)` with no host argument, so it
binds all interfaces and *may* stay LAN-reachable after #493. That looks like an
oversight a later hardening pass closes, not a contract; do not build the durable
story on it.

Resolution: **`fleet-bridge viewer`**, a small reverse proxy on the runner. Binds
`0.0.0.0`, forwards to `127.0.0.1:8787`, injects the bearer token. The pipeline
returns this URL, never the supervisor's, so the link survives #493.

**It is a control surface, not a read-only window.** Watching a sprint is only half
of what a person needs; the other half is acting on what they see. The proxy
forwards the sprint control routes in full:

- `POST /sprints/:id/live/pause` and `/live/resume` -- the cooperative pause the
  engine already implements (members are released on pause and re-reserved with a
  re-sync barrier on resume).
- `POST /sprints/:id/live/stop` and `POST /api/sprints/:id/stop` -- cooperative stop.
- `POST /sprints/:id/live/save_logs`.
- `POST /api/sprints` -- launching from the dashboard form.
- `POST /api/reservations/:id/force-release` -- the operator escape hatch for a
  wedged reservation.

The one route deliberately **not** forwarded is `POST /api/shutdown`: that kills the
supervisor itself, taking down every other sprint's visibility with it. It is not
sprint control, and nobody should reach it from a browser on the LAN. One line to
change if that judgement is wrong.

**Being straight about what this means:** a full-control proxy bound to `0.0.0.0`
deliberately re-opens on the LAN what #493 closes. That is a conscious trade, and it
is consistent with the Section 10 decision -- the difference is that afterwards the
exposure is *ours*, scoped to sprint control, and has somewhere to put access control
when it is wanted. That hook is `--viewer-token`: a shared token the proxy requires,
default off, so the control surface can be closed without redesigning anything.

### 7.3 Remote progress after the job exits

For watchers who are not on the LAN, or who look a day later. The requirement is a
cheap, read-only, durable log of sprint progress -- an equivalent of App Service's
Log Stream, without an App Service.

**The recommended pair.** These solve different halves and are complementary:

| Need | Service | Why |
|---|---|---|
| "What is happening right now" | **Azure Web PubSub** (free tier) | Managed WebSocket fan-out, **zero compute**. The daemon mints client access tokens straight from the connection string, so -- unlike SignalR Service in serverless mode -- no Function is needed just to run `negotiate`. |
| "What happened while I was away" | **Azure Storage append blob** | Append blobs exist for exactly this (`Append Block`). Durable, replayable, cents per month, no compute. A `$web` static container serves the HTML viewer. |

**Web PubSub retains no backlog**, so a viewer joining an hour in sees nothing until
the next message. That single fact is why both are needed: the page loads history
from the blob, then subscribes to the socket for live updates.

#### Does append blob actually support streaming appends? Yes -- with one hard limit

Verified against the `Append Block` REST reference (2026-07-23). The behaviour is
exactly what a JSONL progress stream needs:

- **Append semantics are first-class.** `PUT ...?comp=appendblock` commits a block to
  the end of an existing append blob. Blocks may be different sizes, and *"the block
  of data is immediately available after the call succeeds on the server"* -- so a
  reader tails it with no publish step and no finalize.
- **The binding limit is append COUNT, not bytes:** *"A maximum of 50,000 appends are
  permitted for each append blob."* Exceeding it returns **409 Conflict**.
- **Size is a non-issue.** 4 MiB per block (~195 GiB per blob) on service versions
  before 2022-11-02; 100 MiB per block (~4.75 TiB) on 2022-11-02 and later, where
  that larger block size is still marked Preview. Oversized block -> **413**.

**The design rule that follows: batch, never append per line.** 50,000 appends across
a 48-hour sprint is one every ~3.5 seconds sustained. A naive "append each log line"
sink would hit 409 and silently stop mid-sprint. So the sink buffers and flushes on a
timer -- **a 10 s flush yields ~17,300 appends over 48 h, roughly a third of the
budget** -- flushing early on phase transitions so the interesting events are never
delayed behind a timer.

Three mechanics that make the sink robust, all free:

- **Exactly-once on retry.** `x-ms-blob-condition-appendpos` takes the byte offset the
  client expects to append at and fails with **412** if it does not match. The docs
  are explicit that this is for our exact case: *"Clients that use a single writer can
  use this header to determine whether an Append Block operation succeeded, despite a
  network failure."* The daemon is a single writer per sprint, so this makes the
  daemon-restart no-duplicate requirement (test 5c) a property of the protocol rather
  than something to hand-roll.
- **Headroom is observable.** Every response returns
  `x-ms-blob-committed-block-count` -- *"you can use this to control how many more
  appends can be done"* -- plus `x-ms-blob-append-offset`. The sink watches the count
  and **rolls to `<sprintId>-part2.jsonl` at ~45,000**, well before 409, listing parts
  in a small manifest blob the viewer reads first. A two-day sprint should never reach
  this, but a runaway one must degrade rather than truncate.
- **A ceiling, if wanted.** `x-ms-blob-condition-maxsize` fails the append with 412
  rather than letting a pathological sprint grow the blob without bound.

**Reading is pull, not push.** There is no server-side push from Blob Storage, so the
viewer tails by tracking content length and issuing Range GETs. Latency equals the
poll interval -- which is precisely the gap Web PubSub closes, and precisely why the
blob alone is enough for Phase 3.

Two things to confirm against your storage account rather than assume: whether
hierarchical namespace (ADLS Gen2) is enabled, since append-blob support differs
there, and that the account is standard general-purpose v2. Note also that append
blobs *"do not support object level tiering but infer their access tier from the
default account access tier setting"*, so tiering is an account-level decision.

**Alternatives, by what they are actually good for:**

- **Application Insights** -- hosted store, KQL over `traces`, retention and
  alerting; it does not care that the sprint runs on-prem. The right choice when
  *operators* want to query across many sprints. Its Live Metrics tail rides the
  SDK's QuickPulse channel, so it needs the App Insights SDK rather than raw
  ingestion; KQL with a few minutes' latency is the dependable part.
- **Azure DevOps wiki page** -- provisions **nothing**. The wiki is a git repo; the
  daemon commits a progress page per sprint, throttled to phase transitions, secured
  by existing project permissions. The cheapest option if the answer to "which Azure
  resource" is "none".
- Skip Event Hubs / Service Bus (wrong shape, needs a consumer) and Functions /
  Container Apps (only needed for real auth on the viewer rather than a token).

**Security constraint that rules out the lazy version:** sprint logs carry agent
output, hence source and error text. Treat every one of these as confidential --
never a public blob container; time-boxed read-only SAS and Web PubSub tokens only.

**What feeds it.** No upstream change is needed for v1: the daemon is already
polling, so it writes its own `ProgressSnapshot` JSONL and can tail-and-upload the
existing raw child log at `~/.apra-fleet-se/logs/<runId>.log`.

A richer v2 is available cheaply if wanted: the workflow engine **already has an
append-only JSONL journal** (`.fleet-workflow/journal-<runId>.jsonl`), dormant only
because `cli.mjs` calls `executeFile(script, args)` without the third options
argument. Enabling it is close to a one-option change -- but it *is* an apra-fleet
change, so it is an **explicit upstream ask**, never something the bridge does
silently.

> Verify current free-tier limits and pricing before committing. The shape is
> "negligible at sprint volumes"; the exact numbers move.

### 7.4 The layers, cheapest first

1. **Work-item comments (primary).** At each phase transition the root work item gets
   a short markdown comment: phase, cycle, closed/required, spend, health. This lands
   where the requirements were written, needs no new UI, and works on all three
   platforms.
2. **Pipeline run log.** The job log ends with the `sprintId`, the plan-gate outcome
   (7.1), the LAN viewer URL (7.2), the remote stream URL (7.3) and the raw log path
   -- enough to reach everything else from a run someone opens later.
3. **Build status / checks.** `setBuildStatus()` where supported, so the target
   branch shows sprint state next to ordinary CI.
4. **The sprint dashboard via `fleet-bridge viewer`** (7.2) -- per-sprint activity
   tree, live cost in USD, beads graph, health badge, verdict, PR link. By far the
   richest view; the bridge links to it rather than reproducing it. Link the proxy,
   never `http://<runner>:8787` directly, so the URL survives #493.
5. **The remote stream** (7.3), for watchers off the LAN or arriving a day later.

Final comment, posted by `finalize`: verdict (PASS/FAIL), PR link, the committed
`docs/sprint-analysis-<branchSlug>.md` path, total spend, and the carry-over items
created with their new work-item ids.

---

## 8. Carry-over: the precise algorithm

The requirement is exact -- *carry-over becomes new backlog items; beads closed during
the sprint are not reported* -- so the rule must be exact too.

**Definition.** A bead is carry-over if and only if, at sprint end, all three hold:

1. **Not closed.** `status IN (open, in_progress, blocked, deferred)`. This excludes
   everything the sprint finished -- by construction, not by filtering.
2. **Did not come from the tracker.** No `external_ref`. Items pulled in by `ingest`
   already exist as work items; re-pushing them would duplicate the user's backlog.
   We report only what the sprint *created*.
3. **Attributable to this sprint.** Created after the sprint's `startedAt`, or within
   the sprint's scope, or titled `[carry-over]`.

Concretely:

```bash
bd list --status open,in_progress,blocked,deferred \
        --created-after "$SPRINT_STARTED_AT" --json
```

then drop any row with a non-empty `external_ref`, and drop the synthetic root epic
if `ingest` created one. The three `reason` classes fall out naturally:

- `regression` -- title matches `[regression][carry-over]`; standalone by design.
- `deferred` -- `status == deferred`; the harvester's low-priority defers.
- `unfinished` -- still open, inside the sprint scope, at terminal state.

**Publishing.**

- Azure DevOps / GitHub: `bd ado push <ids>` / `bd github push <ids>` -- ID-scoped,
  so nothing else can leak. The push stamps `external_ref` back onto the bead, which
  makes the whole operation **idempotent**: a second `finalize` finds those beads now
  carry an `external_ref` and skips them by rule 2. Run `--dry-run` first, log the
  plan.
- Bitbucket: adapter-owned REST `POST /issues`, then write `external_ref` back via
  `bd update` to preserve that same idempotence.

**Linkage.** Each new work item body carries the sprint id, branch, PR link, and
originating bead id, plus a typed "Related" link to the root work item where the
platform supports one. Without that, carry-over items arrive as orphans and nobody
actions them.

**Safety.** Default `--max-carry-over 25`. Exceeding it publishes nothing and fails
loudly: a sprint that produced fifty carry-over items has gone wrong in a way that
deserves a look, not a silent backlog dump.

---

## 9. Platform mapping

| Concern | Azure DevOps | GitHub | Bitbucket |
|---|---|---|---|
| Trigger | pipeline `parameters:` | `workflow_dispatch` inputs | `custom:` pipeline vars |
| Work-item selection | `workItems` csv param | `issues` csv input | `issues` csv var |
| Runner | self-hosted agent pool | self-hosted runner | self-hosted runner |
| Ingest | `bd ado pull` | `bd github pull` | REST -> `bd import` |
| Carry-over out | `bd ado push` | `bd github push` | REST `POST /issues` + `bd update` |
| PR creation | existing provider (REST) | existing provider (REST) | **gap: `builders: null`** |
| Comment target | work item + PR thread | issue + PR | issue + PR |
| Credentials | `azdevops_pat` in store | GitHub App token | app password (store) |
| Max job minutes | unbounded (`timeoutInMinutes: 0`) | days-scale | **120 (hard)** |
| Attached mode | supported | supported | **not possible** |

Two honest gaps, named rather than buried:

- **Bitbucket cannot open a PR today** (`builders: null`). Closing it means writing
  `parseRepoRef`, `buildProvisionArgs`, `capabilitiesForHost` and the two REST
  `builders` in that one file -- the registry's documented one-file extension. Real
  work, out of scope for the Azure DevOps demonstration, and the single blocker for
  genuine Bitbucket parity.
- **Bitbucket has no beads-native sync**, so its adapter carries the only substantial
  bridge-owned tracker code.

---

## 10. Security

- **The supervisor API has no authentication of any kind today**, and binds with
  `server.listen(port)` without a host argument -- it is not code-bound to loopback,
  so it is reachable from the LAN.

  **Decision (2026-09-18): accepted as a time-boxed risk.** The fix is already in
  flight as **apra-fleet PR #493, `fix/m0-s1-loopback-bearer`** (open, verdict PASS,
  awaiting the human merge gate). The bridge does not work around the gap, and
  Phase 0 does not block on it.

  What is being accepted, stated so this reads as a decision rather than an
  oversight: until #493 merges, anyone on the subnet can launch, stop or
  force-release a sprint on this box, and can read any sprint's raw log -- which
  carries agent output, and so potentially source and error text -- via
  `GET /sprints/:id/log`. Tolerable on a trusted internal network; not tolerable on
  an open one. Compensating controls meanwhile, both advisory: keep the runner off
  guest/untrusted VLANs, and optionally firewall inbound 8787 to the subnet that
  needs it.

- **Forward compatibility with #493 is a build requirement, not a follow-up.** That
  PR does two things, and the second one will break a naive client:
  1. binds the supervisor to **127.0.0.1 only** (harmless for us -- the bridge runs
     on the same box);
  2. adds **bearer-token authentication**: a service token at
     `<dataDir>/private/token` (0600 on POSIX), an `Authorization: Bearer <token>`
     header enforced on all `/api/*` routes and on POST routes under the sprint live
     views, `401` otherwise, timing-safe comparison, and an `se_token`
     `HttpOnly; SameSite=Strict` cookie for browser clients.

  So `supervisor-client.mjs` must, from day one, read the token file if present and
  send the Bearer header on every request. Doing so is **harmless before #493**
  (today's server ignores an unknown header) and is what stops every bridge call
  turning into a `401` the moment that PR merges. Treat a missing token file as
  "not yet on #493" and proceed unauthenticated rather than failing. The token is
  read from the local filesystem and sent only to loopback -- it is never logged,
  never passed as a CLI argument, and never written into a pipeline artifact.
- **Credentials are referenced, never read.** The bridge passes `{{secret.NAME}}`
  placeholders and uses `credential_store_list` (names and metadata only) at
  preflight. Azure DevOps PATs are flagged `serverSideReMintable: false` -- the fleet
  stores and redeploys them but cannot mint them, so an expired PAT needs a human at
  `https://dev.azure.com/ORG/_settings/tokens`. Surface expiry early rather than
  letting it appear two days in at the publish step.
- **Self-hosted runners execute untrusted input.** A trigger from a fork or an
  unprivileged contributor becomes agent execution on our hardware. Restrict the
  fleet-sprint pipeline to protected branches and an authorized trigger group from
  day one.
- The bridge logs only `logSafeCommand` forms; providers already construct redacted
  variants alongside real ones.

---

## 11. Delivery plan

Sequenced so the Azure DevOps demonstration lands first, with the neutral seams in
place from the start rather than retrofitted.

**Phase 0 -- runner preparation (no code).**
Register this box as a self-hosted agent in a dedicated `fleet-sprints` pool. Confirm
the fleet server and supervisor run as services and survive reboot. Register the
sprint member(s), one per intended concurrent sprint, each with `vcsProvider` set.
Deposit `azdevops_pat` in the credential store. Optionally firewall inbound 8787 to
the needed subnet (see Section 10 -- the unauthenticated-binding risk is accepted,
tracked under #493, and does not gate this phase).
*Exit:* a hand-run `curl POST /api/sprints` starts a sprint end to end.

**Phase 1 -- neutral core + Azure DevOps adapter.**
`contracts.mjs`, the six verbs, supervisor and beads clients, and
`adapters/azure-devops.mjs` over `bd ado pull/push`. Adapter registry with explicit
selection. `supervisor-client.mjs` sends `Authorization: Bearer` when
`<dataDir>/private/token` exists, per the #493 forward-compat requirement in
Section 10.
*Exit:* `preflight`, `ingest`, `launch` work from the CLI on this box.

**Phase 2 -- the pipeline.**
`templates/azure-pipelines.yml`: parameters for work items, target branch, base,
goal, member, mode; `pool: fleet-sprints`; detached dispatch; handle published as a
pipeline artifact. Includes `--await-plan` (7.1) and `fleet-bridge viewer` (7.2), so
the run returns a meaningful verdict and a URL a colleague can actually open.
*Exit:* a user triggers the pipeline from Azure DevOps, selects work items, a sprint
starts, the job goes green on an approved plan (or red with the engine's reason), and
the log carries a working LAN viewer URL.

**Phase 3 -- observability and finalization.**
`watch`, `finalize`, the daemon and its spool. Carry-over with `--dry-run` first,
`--max-carry-over`, and idempotence verified by running `finalize` twice. Remote
progress (7.3) starts with the **append-blob sink only** -- durable, replayable, no
compute -- since that alone covers "what happened while I was away".
*Exit:* the full loop -- trigger, sprint, PR on the target branch, carry-over work
items created, verdict comment on the root work item, and a replayable progress log
readable after the pipeline has long exited.

**Phase 3b -- live remote stream (optional, only if asked for).**
The Web PubSub sink plus the combined HTML viewer (blob for history, socket for
live). Deliberately separated: Phase 3 already answers the requirement, and this adds
a second Azure resource and a token-minting path for latency alone.
*Exit:* a watcher off the LAN opens one URL mid-sprint, sees the backlog, and then
sees updates arrive live.

**Phase 4 -- prove the neutrality claim.**
`adapters/github.mjs` over `bd github pull/push` plus the GitHub workflow template.
Cheap, because the beads verbs mirror Azure DevOps exactly -- and it is the *only*
thing that demonstrates the abstraction is real rather than an Azure DevOps script
with interfaces drawn around it. Do not skip it.
*Exit:* the same loop on a GitHub repo, with no change to any file outside
`adapters/` and `templates/`.

**Phase 5 -- Bitbucket (deferred, scoped).**
The Bitbucket tracker adapter (`bd import` + REST), and separately the
`bitbucket.mjs` VCS provider work needed for PR creation. Tracked as a known gap with
written scope, not silently assumed to work.

---

## 12. Test plan (Azure DevOps only, this phase)

1. **Preflight negatives** -- supervisor down; member busy; member with no
   `vcsProvider`; missing `azdevops_pat`; unrecognised remote; diverged beads DB.
   Each must fail with a distinct, actionable message.
1a. **#493 forward compatibility** -- run the supervisor client against a server
   with no token file (must work, unauthenticated) and against one requiring a
   bearer token (must read `<dataDir>/private/token` and succeed). Assert the token
   never appears in logs, argv, or the published pipeline artifact.
2. **Ingest** -- pull three real work items; assert parenting under one root; assert
   the child-count >= 1 guard fires for a single childless work item; assert the
   acceptance-criteria audit catches an item lacking them and that
   `--require-criteria` fails the run.
3. **Launch negatives** -- bad branch name (400 naming the field); a second launch
   against the same member (409 naming the conflict); relaunch after a deterministic
   failure (409 with the override remedy, and confirm the bridge does not
   self-override).
4. **Slot behaviour** -- assert the pipeline job exits under two minutes in detached
   mode while the sprint keeps running. This is the requirement-critical test.
4a. **Process-tree survival (Section 4.3).** Run the same check twice: once
   supervisor-launched, once with `--spawn direct`. Assert the supervisor-launched
   sprint survives job completion. Record whether the directly-spawned one does --
   that single observation decides whether direct spawn is ever viable for pipeline
   triggers.
5. **Carry-over** -- seed a `[regression][carry-over]` bead and a deferred bead; run
   `finalize --dry-run`; assert exactly those two are selected, that beads closed
   during the sprint are absent, and that beads carrying an `external_ref` are
   absent. Then run for real, and run again to prove idempotence creates no
   duplicates.
5a. **Plan gate (7.1)** -- three cases: a healthy sprint exits green on plan
   approval; a childless epic exits red carrying `NOTHING_TO_DO` verbatim; a
   `CHANGES_NEEDED` -> `replan` -> approved loop exits green, **not** red. Then force
   the timeout path and assert the job is green and **the sprint is still running**.
5b. **Viewer proxy (7.2)** -- from another LAN host: the live view renders, and
   `pause`, `resume` and `stop` all take effect on the sprint. `POST /api/shutdown`
   is refused. With `--viewer-token` set, every one of those is rejected without the
   token.
5c. **Progress sink (7.3)** -- kill and restart the daemon mid-sprint; assert the
   append blob has no gap and no duplicate lines (the restarted writer must re-read
   the offset and use `x-ms-blob-condition-appendpos`, so a replayed flush fails
   **412** rather than duplicating), and that a viewer loading it cold reconstructs
   the full history. Assert no token appears in the blob.
5d. **Append budget (7.3)** -- assert the sink batches rather than appending per
   line, and that `x-ms-blob-committed-block-count` drives a roll to `-part2` with a
   manifest update. Force the roll with a low threshold rather than waiting for
   45,000 real appends; the failure being guarded against is a silent **409** that
   truncates a two-day sprint's log.
6. **End to end** -- a small real sprint on a scratch repo: trigger from Azure
   DevOps, observe comments at phase transitions, confirm the PR targets the chosen
   branch, confirm carry-over items appear, confirm the analysis doc is committed.
7. **Crash path** -- kill the sprint child mid-run; assert the watchdog releases the
   reservation, the daemon notices terminal state, and `finalize` reports FAIL
   without inventing carry-over.

---

## 13. Risks

| Risk | Impact | Response |
|---|---|---|
| Work items lack acceptance criteria | Sprint burns two days producing little -- the doer skips criteria-less beads by contract | `ingest` audit + `--require-criteria` default; fail in minute one, not on day two |
| Flat work-item selection with no parent/child | `NOTHING_TO_DO` refusal after launch | `ingest` guarantees an epic with >= 1 `--parent`-ed child and asserts it |
| Unauthenticated supervisor reachable from the LAN | Arbitrary sprint launch/stop on our hardware; raw sprint logs (agent output, source) readable by anyone on the subnet | **Accepted 2026-09-18**, time-boxed: apra-fleet PR #493 (`fix/m0-s1-loopback-bearer`) is open with a PASS verdict. Advisory controls meanwhile: keep the runner off untrusted VLANs, optionally firewall 8787 |
| Sprint logs leak via a progress sink | Agent output carries source and error text; a public blob container or a non-expiring token exposes it | Never a public container; time-boxed read-only SAS / Web PubSub tokens only; tokens never logged or written into pipeline artifacts |
| Web PubSub backlog assumed to exist | A viewer joining mid-sprint sees an empty page and assumes the sprint is dead | The viewer always loads history from the append blob first, then subscribes. The blob sink ships in Phase 3; Web PubSub is optional Phase 3b |
| Append sink writes per line and hits the 50,000-append cap | **409 Conflict** mid-sprint; the log silently stops and nobody notices until they look | Batch on a 10 s flush (~17,300 appends / 48 h); watch `x-ms-blob-committed-block-count` and roll to `-partN` at ~45,000 via a manifest |
| Full-control proxy re-opens on the LAN what #493 closes | Anyone on the subnet can pause or stop a running sprint | Deliberate trade, consistent with Section 10. `/api/shutdown` is never forwarded; `--viewer-token` is the built-in hook for closing it when wanted |
| LAN viewer URL breaks when #493 merges | Every URL handed out in a pipeline log goes dead | Hand out the `fleet-bridge viewer` proxy URL, never `:8787` directly. Do not rely on the child viewer's all-interfaces bind |
| `--await-plan` timeout misread as failure | A slow but healthy sprint gets cancelled by a human | Timeout exits **green** with "still planning, now detached", and never stops the sprint |
| #493 merges and every bridge call starts returning 401 | Bridge breaks wholesale the day an unrelated PR lands | Send `Authorization: Bearer` from day one, reading `<dataDir>/private/token`; absent token = pre-#493, proceed unauthenticated. Harmless before, correct after |
| `bd ado sync` invoked instead of `push` | Entire local beads DB pushed into the customer backlog | Bridge only ever calls ID-scoped `pull`/`push`; add a test asserting bare `sync` appears nowhere |
| Runner slot starvation | CI and releases blocked by long sprints | Detached mode is the default; dedicated pool; attached documented as slot-expensive |
| PAT expiry mid-sprint | Branch pushed but no PR -- two days stranded behind a credential | Preflight checks presence; PATs are not server-side re-mintable, so surface expiry early and alert on the `[Publish PR Skipped]` log branch |
| Carry-over duplication across reruns | Backlog noise; erodes trust fast | `external_ref` stamped on push makes `finalize` idempotent; verified by a double-run test |
| Beads/Dolt sync conflict | `BEADS_SYNC_CONFLICT` is a deterministic terminal reason and trips the relaunch gate | Surface the gate message verbatim; never auto-override |
| The abstraction is Azure DevOps in disguise | Third platform costs a rewrite | Phase 4 (GitHub) is mandatory, constrained so only `adapters/` and `templates/` may change |

---

## 14. Open decisions

1. **Who runs the daemon?** A Windows service on the foreman alongside the supervisor
   is the obvious answer; confirm it fits the existing service posture.
2. **Sprint goal semantics.** `goal` is a priority ceiling matching
   `/^P[1-3](\/P[1-3]){0,2}$/`. Confirm the pipeline parameter exposes exactly that
   vocabulary rather than a free-text sprint goal, which is a different concept.
3. **Synthetic root epic.** Acceptable that `ingest` may create a local-only epic that
   never reaches the tracker, or should users always nominate a real parent work item?
   The latter is cleaner but pushes curation onto the user.
4. **Attached mode at all?** Genuinely useful for short sprints, genuinely dangerous
   for slot budgets. Ship it, or omit it to keep one story?
5. **Multi-repo sprints** are out of scope here: one sprint, one repo, one branch.

---

## Appendix: evidence index

| Claim | Source |
|---|---|
| Launch API, detached spawn + `unref()`, 201 shape | `src/supervisor/api.mjs` (`launch`), `src/supervisor/spawner.mjs` (`spawnSprint`) |
| Engine arg contract, goal pattern, unknown-key rejection | `fleet-sprint/sprint-args.mjs` (`validateArgs`, `KNOWN_ARG_KEYS`) |
| Supervisor-less coordination: four-source precedence, MCP fallback | `fleet-sprint/runner.js:930` (`doltPushMutex`), `:961` (`childIdAllocator`) |
| MCP mutex/allocator clients; "no supervisor to reach" rationale | `fleet-sprint/coordination.mjs:222-239` (`createMcpDoltPushMutexClient`) |
| Standalone detached-launch guidance and process-group warning | `fleet-sprint/skills/fleet-sprint-cli/SKILL.md` |
| Loopback bind + bearer token, `<dataDir>/private/token`, 401 on `/api/*` | apra-fleet PR #493 `fix/m0-s1-loopback-bearer` (open, PASS) -- https://github.com/Apra-Labs/apra-fleet/pull/493 |
| Child viewer binds all interfaces (`server.listen(port)`, no host) | `packages/apra-fleet-workflow/src/viewer/index.mjs:1597` |
| Sprint live control routes: pause / resume / stop / save_logs | `src/supervisor/proxy.mjs` `registerLiveRoutes` |
| Append blob: 50,000-append cap, 409 on exceed, 4 MiB / 100 MiB blocks, `appendpos` single-writer idempotency, `committed-block-count` | Azure `Append Block` REST reference, retrieved 2026-09-18 -- https://learn.microsoft.com/en-us/rest/api/storageservices/append-block |
| Two-axis ledger, 409 overlap, no numeric limit | `src/supervisor/ledger.mjs`, `api.mjs` member-overlap guard, `scope-overlap.mjs` |
| No supervisor auth; listen without host | `src/supervisor/server.mjs` |
| Watchdog six states; auto-release on terminal | `src/supervisor/watchdog.mjs` |
| Restart re-adoption via PID probe + cmdline port recovery | `src/supervisor/readopt.mjs`, `reconcile.mjs` |
| CLI preconditions: members, `bd show`, topology, dolt gate | `packages/apra-fleet-se/bin/cli.mjs` `main()`, `dolt-sync.mjs` health gate |
| `NOTHING_TO_DO` childless-epic refusal; parent-child BFS scope | `fleet-sprint/runner.js`, `fleet-sprint/beads-scope.mjs`, `errors.mjs` |
| Run-state and log paths; journal resume off by default | `apra-fleet-workflow/src/viewer/run-state-paths.mjs`, `spawner.mjs`, `workflow/journal.mjs` |
| `bd ado`/`bd github` pull/push/sync verbs and flags | `bd ado --help`, `bd ado push --help`, `bd ado pull --help`, `bd github --help` (run live) |
| No `bd bitbucket`; `bd import` JSONL fields | `bd bitbucket --help` (unknown command), `bd import --help` |
| `bd list` status/created-after/json filters | `bd list --help` |
| Provider descriptor contract; one-file extension rule | `fleet-sprint/vcs-providers/index.mjs` header, `registerVcsProvider` |
| Bitbucket `builders: null`; AzDO/GitHub builders present | `vcs-providers/bitbucket.mjs`, `azure-devops.mjs`, `github.mjs` |
| PR title/body/base; PR on PASS and FAIL; 422 idempotent | `fleet-sprint/phases/publish-pr.mjs` |
| `[regression][carry-over]` standalone beads | `fleet-sprint/phases/regression-test.mjs` |
| Analysis doc path/format; no JSON report | `fleet-sprint/sprint-report.mjs`, `phases/harvest.mjs` |
| No webhook/EventEmitter; `publishState` only | repo-wide grep under `fleet-sprint/`; `runner.js` `updateDashboard` |
| Member `vcsProvider` required, hard error | `fleet-sprint/vcs-module.mjs` `resolveProvider` |
| AzDO PAT not server-side re-mintable; `azdevops_pat` default | `vcs-providers/azure-devops.mjs` `authRemedy`, `buildProvisionArgs` |
