# Design: supervisor-owned orchestrator worktree (one throwaway local member per sprint)

Status: design walkthrough / proposal. Nothing here is implemented.
Scope: `packages/apra-fleet-se/src/supervisor/*`, `packages/apra-fleet-se/fleet-sprint/runner.js`,
`packages/apra-fleet-se/bin/cli.mjs`, `src/tools/register-member.ts`, `src/tools/member-reservation.ts`,
`src/tools/remove-member.ts`, `src/services/registry.ts`.

## 1. The problem this solves

`orchestrator` is an application-level pseudo-role (runner.js:59-75). It is never dispatched as an
agent; it names the physical fleet member whose shell the orchestrating PROCESS itself uses for every
`bd`, `git`, and PR-raise command it issues directly. It is resolved by:

```js
// runner.js:6331-6337
const getMemberForRole = (role) => {
    if (validated.roleMap && validated.roleMap[role] && validated.roleMap[role].length > 0) {
        return validated.roleMap[role][0];
    }
    return unmappedRoleFallbackPool[0];
};
// runner.js:6354
const orchestratorMember = getMemberForRole(ROLE_ORCHESTRATOR);
```

`unmappedRoleFallbackPool` is derived from `physicalMembers` (runner.js:6325-6329). So when the
launcher does not set `roleMap.orchestrator`, the orchestrator silently becomes whichever member
happens to sort first in the `--members` list -- which may be a REMOTE machine whose Dolt clone is
stale, or whose checkout is not the one the sprint is developing on. Commit `df7be92c`
(`fix/sprint-scope-empty-leaf-beads`) is a live instance of the resulting class of bug: the
orchestrator's pre-sprint scope read ran against the wrong beads clone.

The same fallback is duplicated in the abort path:

```js
// runner.js:10998-11001
const member = (validatedForLock.roleMap && validatedForLock.roleMap[ROLE_ORCHESTRATOR] && ...)
    ? validatedForLock.roleMap[ROLE_ORCHESTRATOR][0]
    : validatedForLock.members[0];
```

The proposed model removes the choice from the launcher entirely: the supervisor mints a dedicated,
disposable orchestrator member per sprint, backed by a git worktree it creates and destroys itself.

## 2. The proposed model in one paragraph

On `POST /api/sprints`, the supervisor (a) creates a git worktree of a supervisor-owned repo clone,
checked out on the sprint's `branch` (created off `base` if new), (b) registers that worktree as a
new local fleet member with an auto-generated name, (c) reserves that member to the new `sprintId`,
(d) verifies the worktree can actually run `bd`, (e) injects `roleMap.orchestrator = [<that member>]`
into the spawn options, and (f) on every terminal path -- success, failure, crash, force-release --
releases the reservation, unregisters the member, and removes the worktree. The user launching the
sprint supplies only the other roles, exactly as today.

## 3. What exists today that we can reuse

| Need | Existing mechanism | Location |
| --- | --- | --- |
| Sprint launch validation + roleMap resolution | `validateLaunchRequest()`, `resolveRoleMap()` | `src/supervisor/api.mjs:356-397`, `api.mjs:441`; `bin/cli.mjs:236` |
| Passing roleMap to the engine | `buildSprintArgv()` -> `--role-map <json>` | `src/supervisor/spawner.mjs:201-246` |
| Per-sprint durable state | `createLedger()`, atomic write to `<dataDir>/reservations.json` | `src/supervisor/ledger.mjs:313-609` |
| Fleet-side member reservation from the supervisor | `driveServerReservation()` (ledger calls the `member_reservation` MCP tool on claim/release) | `ledger.mjs:290-342, 472-498` |
| Terminal detection + auto-release | `createWatchdog()` / `releaseTerminalReservation()` | `src/supervisor/watchdog.mjs:580-987, 722-758` |
| Restart-time orphan reconciliation | `createReconciler().reconcile()` (PID probe, `ABORTED_BY_RESTART`) | `src/supervisor/reconcile.mjs:154-184` |
| Operator escape hatch | `POST /api/reservations/:sprintId/force-release` | `reconcile.mjs:186-227, 244-263` |
| Duplicate-engine guard with dead-pid reclaim | `acquireSprintLock()` | `fleet-sprint/sprint-lock.mjs:87-140` |
| Local-member registration with no LLM at all | `register_member` with `llm_provider: 'none'` | `src/tools/register-member.ts:53, 334-344` |
| Reserve / release / force_release semantics | `member_reservation` | `src/tools/member-reservation.ts:17-87` |
| Worktree add/remove invocation pattern (and its known Windows failure modes) | apra-pm parallel-doers fan-out | `packages/apra-fleet-se/apra-pm/.claude/workflows/auto-sprint.js:3111-3205` |

Genuinely new plumbing: a worktree lifecycle module in `src/supervisor/`, a "which repo do we cut the
worktree from" configuration concept, a `register_member`/`remove_member` client path in the
supervisor (it has never called `register_member` -- confirmed by grep over
`packages/apra-fleet-se/src`), and a beads-readiness probe at worktree creation time.

## 4. Supervisor-level launch, step by step

### 4.1 Where the code goes

`createSprintController().launch(body)` (`api.mjs:436-559`) currently runs, in order:
`validateLaunchRequest` -> `resolveRoleMap` -> `memberUnion()` (`api.mjs:104-117`) -> relaunch gate
(`api.mjs:463-484`) -> `beforeLaunch()` overlap guard (`api.mjs:162-209`) -> `generateSprintId()`
(`api.mjs:340`) -> `spawner.spawnSprint()` -> `ledger.claim()`.

The orchestrator-worktree provisioning has to slot in **after `generateSprintId()`** (the member name
should embed the sprint id) and **before `spawnSprint()`** (the argv needs the injected roleMap).
`ledger.claim()` must then be extended to record the worktree path + member name so teardown and
restart-reconciliation can find them.

Ordering problem: today `ledger.claim()` runs only *after* a successful spawn. If we provision the
worktree/member before the spawn and the spawn then throws, nothing has been written to the ledger
and the worktree/member leak. **Decision: write a provisional ledger entry (or a separate
`orchestrator-worktrees.json` sidecar) BEFORE provisioning the worktree**, so a crash at any point
between "we are about to create a worktree" and "the child is running" still leaves a durable record
for the reconciler. This is a real change to the claim-after-spawn invariant and is the first thing
to get right.

### 4.2 Which repo does the worktree come from? (open question, blocking)

There is no existing concept of "the sprint's target repo path". `spawnSprint()` inherits `deps.cwd`
(`spawner.mjs`), unset by default; the engine never learns a repo path -- it only ever talks to
members, and each member's own `workFolder` is its cwd (`src/tools/execute-command.ts:239`:
`const rawFolder = input.run_from ?? agent.workFolder;`).

Three candidate sources for the worktree's parent repo:

1. **A supervisor-owned dedicated clone**, configured once (e.g. `FLEET_SE_ORCH_REPO`, or a per-sprint
   `repo` field on `POST /api/sprints`). Recommended -- see 4.3 for why.
2. **Derive it from a member's `workFolder`** (e.g. the first doer's). Rejected: it re-creates the
   branch-collision failure in 4.3, and a remote doer's `workFolder` is not a path on the supervisor
   host at all.
3. **The supervisor process's own cwd.** Fragile and undocumented; the supervisor is a long-lived
   service and its cwd is not a contract.

**Open question:** multi-repo fleets. If one supervisor serves sprints against several repos, a single
`FLEET_SE_ORCH_REPO` is wrong and the repo must become part of the launch request. This design does
not pick an answer; it flags that option 1 needs a per-sprint override before it can serve more than
one repo.

### 4.3 The branch-pinning constraint -- the central risk

Git enforces **one branch, one worktree**: a branch checked out in worktree A cannot be checked out
in worktree B of the same repository. `git worktree add` fails with
`fatal: '<branch>' is already used by worktree at <path>`, and `git checkout <branch>` in a sibling
worktree fails with `fatal: '<branch>' is already checked out at <path>`.

The orchestrator worktree **must** be pinned to the sprint's `branch`, not to a detached HEAD:

- `Publish PR` runs `git push -u origin ${validated.branch}` on `orchestratorMember`
  (runner.js:10712-10719). An upstream-tracking push of the current branch is the only shape that
  works without a bespoke refspec.
- `finalizeAbort()` (runner.js:5463+) does the same push plus `git rev-list` against `baseBranch`.
- `Ensure Sprint Branch` (runner.js:7058-7245) unconditionally includes the orchestrator in
  `branchEnsureMembers` (runner.js:7015-7025) and runs `git checkout -B <branch> <startPoint>` or
  `git checkout <branch>` on it.

Now the collision. `Ensure Sprint Branch` dispatches that same checkout **to every member in
`branchEnsureMembers`**. If any registered member's `workFolder` is another checkout *of the same
repository* as the orchestrator worktree -- the overwhelmingly common local-dev case, where the
"local" member is `C:\...\apra-fleet` and the supervisor would naturally cut worktrees under
`C:\...\apra-fleet\.claude\worktrees\` -- then that member's `git checkout <branch>` **fails hard**,
because the orchestrator worktree holds the branch. runner.js:7203-7209 only tolerates a
`would be overwritten` (dirty-tree) failure; anything else is a hard `throw` that aborts the sprint at
Sprint Setup.

**This is the single most important consequence of the model.** It means:

- The supervisor's orchestrator worktree MUST be cut from a repository clone that no registered
  member shares. Option 1 in 4.2 is therefore not a preference, it is a requirement.
- A launch-time precondition check is needed: for every member in the union, if the member is local
  and its `workFolder` resolves into the same git repository (same `git rev-parse --git-common-dir`)
  as the orchestrator worktree's parent, refuse the launch with a named error rather than dying at
  Sprint Setup. `registry.ts`'s `hasDuplicateFolder()` (registry.ts:158-183) is a same-path guard
  only; same-*repository* is a different and new check.
- **Open question:** should the orchestrator instead be excluded from `branchEnsureMembers`? It cannot
  be -- it is the member that pushes the branch, so it must be on it. The exclusion has to go the
  other way: refuse the topology.

### 4.4 `git worktree add`: base/branch interaction, and why not `-B`

The apra-pm precedent uses `git worktree add -b "<branch>" "<path>" "<start>"`
(auto-sprint.js:3120). For the sprint orchestrator we cannot use a fixed form, because the sprint
branch may or may not already exist locally and/or on origin (relaunch, resume after crash, a human
having pushed to it).

`-B` must NOT be used blindly: `git worktree add -B <branch> <path> origin/<base>` force-resets
`<branch>` to `origin/<base>`, destroying every commit an earlier run of this sprint pushed. That is
exactly the failure `decideEnsureBranchAction()` (runner.js:5733-5786) was written to prevent, whose
contract is: abort on a non-"missing ref" fetch failure, abort on divergence, reuse (plain checkout,
never reset) when the local branch is ahead or the remote ref is missing, and only otherwise
`checkout -B`.

**Decision: the supervisor's worktree creation must run the same decision, from the same helper.**
`decideEnsureBranchAction()` is already exported from `runner.js` and is pure (no I/O). The supervisor
should:

1. `git fetch origin <base> --quiet` and `git fetch origin <branch>` (soft) in the parent clone.
2. Probe local branch existence and the two `git merge-base --is-ancestor` directions, mirroring
   runner.js:7130-7148.
3. Feed those into `decideEnsureBranchAction({ branch, baseBranch, branchFetchOk, branchFetchError,
   localBranchExists, localTipStatus })`.
4. Translate its verdict into a worktree-add form:
   - `action: 'abort'` -> refuse the launch with a 409/422 naming the message. Aborting at launch is
     strictly better than aborting at Sprint Setup.
   - `reused: true` -> `git worktree add <path> <branch>` (attach the existing local branch; no `-b`,
     no reset).
   - `reused: false` -> `git worktree add -b <branch> <path> <startPoint>` where `startPoint` is
     `origin/<branch>` or `origin/<base>` per the helper.
   - if the local branch already exists AND `reused: false` (a safe reset case), `-b` will fail with
     "already exists"; use `git worktree add <path> <branch>` then, inside the worktree,
     `git reset --hard <startPoint>`. **Open question:** whether the reset-to-origin case is worth
     supporting at launch at all, versus just attaching and letting `Ensure Sprint Branch` do its own
     `checkout -B` inside the worktree a few seconds later (which is idempotent there). The simpler
     answer is to always attach and let the engine reconcile; the cost is that a genuinely-diverged
     branch is then caught at Sprint Setup instead of at launch.

Note also the apra-pm precedent's own scar tissue: auto-sprint.js:307 documents that on win32 the
worktree fan-out hit *"worktree 'already exists' leak on re-create, and worktree-branch merges landing
nothing"*, and that path is still non-default because of it. Worktree creation must therefore be
preceded by `git worktree prune` and an idempotent `git worktree remove --force <path>` of any leaked
same-named directory, exactly as auto-sprint.js:3118 does.

### 4.5 Registering the worktree as a member

`register_member` (`src/tools/register-member.ts:29-72`) with:

- `member_type: 'local'` -- host/username/auth_type are then all forced `undefined`
  (register-member.ts:122, 263-268), and no SSH probe is involved.
- `work_folder: <worktree path>` -- **must be passed fully qualified anyway.** The
  `isFullyQualifiedPath` guard at register-member.ts:140 is applied only when `!isLocal`, so a local
  member with a relative path is silently accepted and later resolved against whatever cwd the fleet
  server has. The supervisor must resolve to an absolute path itself.
- `llm_provider: 'none'` -- this is the key reuse. The schema documents it as *"a plain command
  executor with no LLM at all -- execute_prompt is rejected for these members; use execute_command
  instead"* (register-member.ts:53), and `isNoLlm` (register-member.ts:334) skips both the LLM CLI
  version probe (line 336) and the auth probe (line 344). That is a precise match for a member that
  is never passed to `agent()` and only ever runs `bd`/`git` via `execute_command`. It also makes
  registration fast and removes any dependency on the worktree having a Claude/Codex login.
- `friendly_name`: auto-generated, matching `^[a-zA-Z0-9._-]+$`, 1-64 chars, e.g.
  `orch-<sanitized-sprintId-suffix>`. `sprintId` defaults to `${issue}-${randomUUID()}`
  (`api.mjs:340`) -- too long and contains characters that need sanitizing; a short hash plus a
  collision retry against `findAgentByName()` is needed.

Registration side effects worth knowing about, all confirmed in `register-member.ts`:

- `mkdirSync(work_folder, { recursive: true })` for local members (line 352). Harmless here (the
  worktree already exists) but it means registration will happily succeed against a path that is not
  a git repo at all -- there is **no git-repo validation anywhere in `register_member`**. The
  supervisor must do its own post-condition check.
- `provisionAgents(tempAgent)` (line 363) writes the role-agent `.md` definitions into the work
  folder, and `seedWorkspaceTrust()` (line 370) writes Claude workspace-trust state. **These pollute
  the fresh worktree with untracked files.** Consequence: `Ensure Sprint Branch`'s dirty-tree
  self-heal (runner.js:7211-7230) may sweep them into a `fleet-sprint[...] auto-stash`, and the
  harvester/reviewer diff hygiene checks may notice them. **Open question:** should the supervisor add
  the provisioned agent-definition paths to the worktree's `.git/info/exclude`? auto-sprint.js:2413
  already establishes that precedent ("local git exclude so the state file and any worktree roots
  never leak into a doer's [diff]"). Probably yes, and it is cheap.
- `composePermissions(...)` (lines 432-439) is a **hard gate**: a non-`OK` result makes the tool report
  `ERROR: member not provisioned` -- but `addAgent()` (line 393-397) has already persisted the member.
  So a failed registration can leave a half-registered member in `registry.json` with nothing rolling
  it back. The supervisor's provisioning step must treat a `register_member` error as "assume a
  member row may exist; run the full teardown before failing the launch".

### 4.6 Reserving the member

`member_reservation` (`src/tools/member-reservation.ts:17-87`) actions are `reserve | release |
force_release`; the reservation is just `Agent.reservedBy: string | null` on the registry row
(`src/services/types.ts:51`). There is **no TTL and no auto-expiry** -- a wedged reservation is only
clearable by `force_release`.

The supervisor already drives this: `ledger.claim()`/`release()` optionally call the fleet server's
reserve/release per member via `driveServerReservation()` (`ledger.mjs:290-342, 472-498`), best-effort
and never rolled back. So reserving the new orchestrator member is *free* if it is included in the
ledger entry's member list.

Two consequences of including it:

- `defaultMemberOverlapGuard()` (`api.mjs:162-209`) checks the union of members against both the local
  ledger and the fleet server's `reservedBy`. A per-sprint-unique member can never collide, so this is
  a no-op for it -- good.
- `memberUnion()` (`api.mjs:104-117`) folds roleMap values into the member set. If the injected
  orchestrator lands in the roleMap before `memberUnion()` is computed, it flows into `--members`
  too. **That matters a lot** -- see 5.1.

### 4.7 Beads access in the worktree (verify, do not assume)

Verified in this repo: `.beads/` is gitignored (`.gitignore:29`) EXCEPT `.beads/issues.jsonl`, which is
tracked (`git ls-files .beads` -> `.beads/issues.jsonl`). So a fresh worktree contains a `.beads/`
directory holding only `issues.jsonl` -- **no `config.yaml`, no `embeddeddolt/`**. The parent checkout
has all of them.

`bd` walks up the directory tree and merges the parent checkout's `.beads/config.yaml`, so a worktree
nested under a provisioned checkout gets DB access "for free" (independently observed: running
`bd list` from such a worktree prints `Debug: merged config from <parent>\.beads\config.yaml`).

This is load-bearing and fragile. Three concrete risks:

1. **Placement is a hard requirement, not a convenience.** If the supervisor puts the worktree in
   `os.tmpdir()` or any directory not nested under a checkout with a provisioned `.beads/`, the walk-up
   finds nothing and *every* orchestrator `bd` command fails. Combined with 4.3 (the parent clone must
   not be shared with any member), this pins the layout precisely: a **dedicated supervisor-owned
   clone that has itself been `bd`-provisioned**, with worktrees nested underneath it.
2. **It was verified for a Claude Code session, not for the supervisor process.** The walk-up is `bd`'s
   own behavior and should not depend on the caller -- but the command runs through
   `execute_command` with `cwd = agent.workFolder` (execute-command.ts:239), under the fleet server's
   environment, not the operator's shell. Environment-sensitive `bd` config (`BEADS_*` vars, a
   different `HOME`) could change the outcome. **This must be probed at provisioning time, not
   assumed.**
3. **Shared embedded Dolt.** The orchestrator worktree and the parent clone resolve to the *same*
   `embeddeddolt/` directory. If two concurrent sprints each get a worktree under the same parent,
   all their `bd` writes land on one embedded Dolt instance. That is already the situation in today's
   legacy shared-workspace topology, and the runner already serializes the dangerous half via
   `doltPushMutex` / `sprintMutexId` (runner.js:8026, 9246, 10288) and the `dolt_push_mutex` tool --
   but pulls and local writes are not serialized. **Open question:** is one embedded Dolt safe under N
   concurrent orchestrators, or does each sprint need its own beads clone (which would mean
   `bd clone`/`bd bootstrap` per sprint, a much heavier provisioning step)?

**Proposed provisioning post-condition (all three, in order):**

```
git -C <worktree> rev-parse --is-inside-work-tree   # it really is a worktree
bd list --limit 1                                    # bd resolves a DB from here at all
bd dolt pull                                         # the clone is reachable AND current
```

Run the last one explicitly at creation time regardless of the walk-up question. The engine's own
pre-flight gate (`DoltSync.syncBefore(orchestratorMember, { readinessGate: true })`,
runner.js:7050) will run one anyway, but failing at launch with "the orchestrator worktree cannot
reach the beads remote" is a far better operator experience than an engine abort 30 seconds later,
and it is the exact failure class this whole design exists to eliminate.

### 4.8 Injecting the roleMap

After `resolveRoleMap()` (`api.mjs:441`), set `roleMap.orchestrator = [<generated name>]`.

Rules:

- If the caller already supplied `roleMap.orchestrator`, **reject the launch** (400) rather than
  silently overriding. The whole point is that the user does not configure this; a caller who did is
  either testing something or confused, and a silent override would hide it. (Alternative: honor the
  caller's value and skip worktree provisioning entirely, as an escape hatch. That is probably the
  kinder behavior for the existing `fleet-sprint-cli` path and for tests. **Open question**, but an
  explicit `orchestrator_worktree: false` opt-out is cleaner than inferring intent.)
- Key casing does not matter: runner.js:3251-3275 is the single normalization point (`normalizeRole()`
  trim+lowercase), and it *rejects* two keys that normalize to the same value. So the supervisor must
  inject the already-normalized lowercase `orchestrator` key, and must check for a caller-supplied
  variant before injecting or the launch dies on the collision error.
- The value reaches the engine as `--role-map <json>` (`spawner.mjs:201-246`) and is parsed by
  `resolveRoleMap()` in `bin/cli.mjs:530`. No engine change is needed for the injection itself.

## 5. Walking the sprint, phase by phase

### 5.1 `bin/cli.mjs` preflight: `checkMemberTopology()` -- second-order breakage

`bin/cli.mjs:673-680` runs `checkMemberTopology({ members: validMembers, mode, getIdentity: 'git
rev-parse HEAD', getOriginUrl: 'git remote get-url origin', doltProbe: 'bd dolt pull' })`.

- A single member passes trivially (runner.js:441-449).
- **legacy mode** requires every member to report the SAME `git rev-parse HEAD` (runner.js:398-404).
- **synced mode** requires the same `git remote get-url origin` and a passing `bd dolt pull`
  (runner.js:408-411).

Whether the new orchestrator member is subject to this depends entirely on whether it ends up in
`--members`:

- If the supervisor injects it into `roleMap` only, and `memberUnion()` is computed **before** the
  injection, it stays out of `--members`. `validMembers` never sees it, topology is unchanged.
  But then `physicalMembers` inside the runner may not contain it either -- **must be checked**:
  anything that iterates `validated.members` (member reservation via `createMemberReservationClient`,
  the `resyncReacquiredMember` path, `sprintLockKey()`) would skip the orchestrator. That is mostly
  fine and arguably correct, but it means the orchestrator member is *not* reserved by the engine's
  own reservation client -- the supervisor's ledger must own that reservation.
- If it lands in `--members`, then a previously single-member sprint (`--members local`) becomes a
  **two-member** sprint, and `checkMemberTopology()` stops being trivially satisfied. In legacy mode
  it would then demand that the orchestrator worktree and the doer's checkout be on the same commit --
  which they are not, by construction, since 4.3 forces them into different repositories. **Legacy
  mode is structurally incompatible with this design.** In synced mode it demands the same `origin`
  URL (true, if the supervisor clone is a clone of the same remote) plus a `bd dolt pull` probe (true,
  per 4.7).

**Decision: keep the orchestrator OUT of `--members`, and make synced mode the only supported mode for
supervisor-launched sprints.** Then also audit every `validated.members` consumer in runner.js for a
place that silently needs the orchestrator and would now miss it. `sprintLockKey(branch, members)`
(sprint-lock.mjs:53-57) in particular: excluding the per-sprint-unique orchestrator keeps the lock key
stable across relaunches of the same sprint, which is what we want -- including it would make the key
unique per launch and **silently disable the duplicate-engine guard entirely.** That is a subtle,
high-severity trap and is on its own a sufficient reason to keep the orchestrator out of `--members`.

### 5.2 Sprint Setup / `Ensure Sprint Branch`

Order in the engine: `DoltSync.syncBefore(orchestratorMember, { readinessGate: true })`
(runner.js:7050) -> `group('Sprint Setup')` / `phase('Ensure Sprint Branch')` (runner.js:7057-7058) ->
the per-member loop over `branchEnsureMembers` (runner.js:7015-7025, 7062+).

- `branchEnsureMembers` is `[orchestratorMember, ...doers, ...reviewers, ...planner, ...]` deduped
  (runner.js:7015-7025). It picks up the injected orchestrator via `getMemberForRole`, so **no engine
  change is needed for the orchestrator to be branch-ensured** -- it happens automatically.
- On the orchestrator worktree, the loop runs `git fetch origin <base>`, then the
  `decideEnsureBranchAction()` verdict. Since the supervisor created the worktree already on
  `<branch>`, the expected verdicts are `reused: true` (plain `git checkout <branch>` -- a no-op) or
  `checkout -B <branch> origin/<branch>` (a fast-forward to a tip the worktree already has). Both are
  benign. This is the redundancy that lets 4.4 stay simple.
- The dirty-tree self-heal at runner.js:7203-7230 will fire on the untracked files
  `provisionAgents()`/`seedWorkspaceTrust()` wrote (4.5) only if they collide with tracked paths;
  `git checkout` does not complain about unrelated untracked files, so in practice this is fine. Add
  `.git/info/exclude` entries anyway to keep diffs clean.
- `reEnsureBranchOnMembers()` (runner.js:7250+) re-asserts `git checkout <branch>` on the same set
  between cycles, `failSoft`. On the orchestrator worktree this is a no-op.

**Change needed: none in the engine.** The work is all supervisor-side.

### 5.3 Pre-sprint scope resolution

runner.js:6574 (`allBeadsInFlight`), 6661 (the filter read), 6766 (`bd update ... --status open`), and
7344 (`probeFileExists()`) all run on `orchestratorMember`. Two observations:

- These are pure `bd` reads/writes plus a `node -e "require('fs').existsSync(...)"` probe. The `node -e`
  probe needs `node` on PATH in the worktree -- it does **not** need `node_modules` or a build. Same
  for `createDeployPermissionsProvisioner()`'s `loadRequiredPrefixes()` (runner.js:2794-2799), which
  does `node -e "... readFileSync('deploy.md') ..."` on `orchestratorMember` to read the repo's
  `deploy.md`. A bare worktree of the repo has `deploy.md`; it does not need `npm install`.
- This is exactly the code path `df7be92c` fixed. Under this model it now runs against a clone the
  supervisor just `bd dolt pull`ed -- the whole point.

### 5.4 Plan phase

Planner and plan-reviewer are dispatched to `getMemberForRole('planner')` / `'plan-reviewer'`
(runner.js:7677-7902). The orchestrator's involvement:

- runner.js:7758: `const plannerSharesOrchestratorClone = getMemberForRole('planner') === orchestratorMember;`
  drives a skip of a redundant D-pull. Under this model the planner is **never** the orchestrator, so
  this is always `false` and the optimization simply stops applying -- one extra `bd dolt pull` per
  plan dispatch. Correct, marginally slower. No change needed.
- runner.js:7832 reads the planner's output back via `command(..., { member_name: orchestratorMember })`.
  `bd` read -- fine.
- Plan-cap exhaustion (runner.js:8008-8026) defers beads and attaches findings on the orchestrator,
  then `DoltSync.syncAfter(orchestratorMember, { pushBeads: true, mutex: doltPushMutex })`. `bd` writes
  plus a mutexed `bd dolt push` -- fine.

### 5.5 Develop: doer/review loop

- Streak claims: `bd update <id> --claim` on the orchestrator (runner.js:8561).
- `verifyDoerStreakClosed({ command, orchestratorMember, beadIds })` (runner.js:3163-3172) D-pulls the
  orchestrator's clone then `bd show`s. Its doc comment (runner.js:3151-3159) explicitly reasons about
  the orchestrator's clone being a *different* clone from the doer's -- which under this model is now
  always true, rather than sometimes true. The code is already written for that case (runner.js:8932-8944
  spells it out). **No change needed; this design makes the already-handled case the only case.**
- Reviewer-applied transitions: `bd update ... --status open` reopens (runner.js:9133, 9854, 10274) and
  `newTask` creation via `computeChildFloor`/`childIdAllocator` (runner.js:9202-9226, 9876-9899,
  10193-10208) all run `command(..., orchestratorMember)`. `bd` only.
- `DoltSync.syncAfter(orchestratorMember, { pushBeads: true, ... })` at runner.js:9246, 9916.

All `bd`. Nothing here builds or tests.

### 5.6 Test: deploy / integ-test / regression

This is where the "no builds on the orchestrator" constraint has to be checked, and the answer is
**it is already true today, with one caveat**:

- `deployer`, `integ-test-runner`, and `regression-test-runner` are dispatched to
  `getMemberForRole(<that role>)` (runner.js:9291-9345, 9375-9577, 10324-10380). They are *never*
  dispatched to `orchestratorMember`.
- `ensureUnattendedAuto(...)` and `ensureDeployPermissions(...)` are called with those roles' members,
  not the orchestrator (runner.js:9291-9292, 9375-9376, 10324-10325).
- **Caveat:** `createDeployPermissionsProvisioner()` is constructed with
  `orchestratorMember` (runner.js:6365) and its `loadRequiredPrefixes()` reads `deploy.md` **from the
  orchestrator's folder** (runner.js:2794-2799) before granting those prefixes to the *target*
  member. So the orchestrator's checkout must contain the repo's `deploy.md` -- it does, being a
  worktree of the repo -- but this is a real coupling: if the deploy playbook ever moves outside the
  repo or is generated by a build, the orchestrator worktree would need it too. Worth a comment, not a
  change.
- Integ-test bug triage reads `bd show <bugId> --json` on the orchestrator (runner.js:9634-9644). `bd`
  only.

**Conclusion: no routing change is needed.** Nothing non-git/non-`bd` currently runs on
`orchestratorMember` except two `node -e` one-liners (a file-existence probe and a `deploy.md` read),
both of which need only a `node` binary on PATH. The model's "git and beads operations only"
constraint holds against today's code. What is missing is anything that *pins* it: a future phase
could route a build to the orchestrator and nothing would catch it. **Recommendation: add an assertion
or lint-style test that the only `member_name: orchestratorMember` commands are in a `bd `/`git `/
`node -e` allowlist.**

### 5.7 Harvest / Publish PR / final verdict

- Final-review counts: `DoltSync.syncBefore(orchestratorMember, { fatal: true })` (runner.js:9976).
- Harvester runs on `getMemberForRole('harvester')` and **does push code** (`pushCode: true`,
  runner.js:10519) -- on the harvester's own member, not the orchestrator.
- Publish PR (runner.js:10704-10770), all on `orchestratorMember`:
  - `git push -u origin <branch>` with retries (10712-10719).
  - `git remote get-url origin` (10651-10656), classified by `vcsCapabilities()`.
  - Non-hosted remote: `bd close <id>` per target issue (10673-10680) + a `pushBeads` sync.
  - Hosted remote: `raiseVcsPrForMember({ fleetApi, command, member: orchestratorMember, ... })`
    (10742-10751), which mints a just-in-time push+pr credential via
    `provisionPrCapableAuthForMember` and dispatches a VCSModule-built `curl` through
    `execute_command` on the orchestrator.

**Credential implication:** the orchestrator member must be VCS-credential-mintable. `register_member`
does not provision VCS auth for local members, and `raiseVcsPrForMember` mints just-in-time -- so a
brand-new local member should work, provided the credential-minting path (`provision_vcs_auth` /
`setup_git_app` machinery) is not gated on prior member setup. **Open question, and the second-most
important one to resolve before implementing:** does minting a push+pr credential for a *freshly
registered* local member succeed, or does it depend on state (a git app install, a stored token keyed
to the member) that a throwaway member has never accumulated? If it depends on per-member stored
state, every sprint pays a credential-provisioning round trip at PR time, and a failure there fails
the sprint at the very last step. This needs a targeted test, not an assumption.

**`curl` implication:** the PR is raised by dispatching a `curl` command to the orchestrator. `curl`
must exist on the supervisor host. Windows 10+ ships `curl.exe`; this is fine but is a new host
requirement on a member that is otherwise "git and bd only".

### 5.8 Abort path

`finalizeAbort({ error, branch, baseBranch, member, command, ... })` (runner.js:5463) is called from
runner.js:11002 with the member resolved by the duplicated fallback at runner.js:10998-11001. Under
this model `roleMap.orchestrator` is always populated, so the `validatedForLock.members[0]` fallback
becomes dead -- but it should still be **changed to throw or log loudly** rather than silently pick
`members[0]`, because that silent fallback is the original bug.

`finalizeAbort` pushes the branch and raises an `[ABORTED]` PR (skipping at zero commits beyond base,
runner.js:5533). It runs on the orchestrator worktree, so the same credential question as 5.7 applies.

## 6. Teardown

### 6.1 Where it hooks in

Three distinct layers already exist and all three need a worktree-teardown hook:

1. **Watchdog auto-release** -- `releaseTerminalReservation()` (`watchdog.mjs:722-758`) already calls
   `ledger.release(sprintId)` the moment a sprint classifies as `crashed` / `finished` /
   `launch-failed`, idempotently, on every tick, recording `HISTORY_EVENTS.AUTO_RELEASED`. **This is
   the right hook for the normal path** -- it already covers success, failure, and crash uniformly,
   which is exactly the "all three paths" requirement. It currently does no filesystem work at all.
2. **Restart reconciliation** -- `createReconciler().reconcile()` (`reconcile.mjs:154-184`) PID-probes
   reloaded ledger entries at supervisor startup and releases dead ones with `ABORTED_BY_RESTART`.
   This is the hook that cleans up worktrees orphaned by a supervisor crash.
3. **Operator force-release** -- `forceRelease()` (`reconcile.mjs:186-227`) kills the child and
   releases. Must also tear the worktree down.

Note what this implies: teardown is **not** the engine's job. `runner.js`'s own `finally`
(runner.js:11044-11053, `sprintLock.release()`) is the wrong place -- the engine may be SIGKILLed and
never reach it, and the engine does not know it is running under a supervisor-provisioned worktree.
Putting teardown in the supervisor's watchdog gets crash coverage for free. `finalizeAbort` needs no
hook.

### 6.2 Ordering

Proposed sequence, with each step independently idempotent:

1. **Confirm the child is dead.** Never remove a worktree out from under a live engine. The watchdog
   already PID-probes with a `--viewer-port` cmdline reuse-guard (`watchdog.mjs:262-272`); reuse it.
2. **`git worktree remove --force <path>` then `git worktree prune`**, run in the parent clone.
   `--force` because `provisionAgents()` left untracked files and git refuses to remove a dirty
   worktree without it. **Do this while the member record still exists**, so that if it fails, the
   registry row still names the leaked directory and a sweeper can find it. Critically:
   `git worktree remove` does **not** delete the branch, and must not -- the branch holds the sprint's
   commits and backs the PR.
3. **`member_reservation release`** with the sprint id (or the ledger's own `release()`, which drives
   it). `release` is a no-op-success when unreserved and refuses when held by a *different* sprint id
   (`member-reservation.ts:63-77`), so it is safe to re-run. If it refuses, escalate to
   `force_release`.
4. **`remove_member`.** Confirmed safe to run on a reserved member: `remove-member.ts` never reads
   `reservedBy` -- the only guard is a `busy` status check bypassable with `force: true`
   (remove-member.ts:41-44). For a local member its cleanup work is minimal (no SSH, no credential
   revocation). Still, releasing first (step 3) keeps the fleet-side state coherent for anything
   watching `reservedBy`.
5. **Drop the sidecar/ledger record.**

Why worktree-before-unregister: the directory is the only artifact that cannot be reconstructed from
the ledger, and the registry row is the breadcrumb that lets a later sweep find it. The opposite order
(unregister first) creates a window where a leaked directory has no owner record anywhere.

Why release-before-unregister: `remove_member` drops the row and with it `reservedBy`, so unregistering
first makes step 3 a 404. The ledger's `driveServerReservation()` treats a failed server-side release
as best-effort and logs rather than throwing (`ledger.mjs:494-498`), so the wrong order degrades rather
than breaks -- but it produces a confusing error line on every single sprint.

### 6.3 If teardown itself fails

Each step must record its outcome durably before moving on, so partial teardown is resumable:

- Keep the ledger/sidecar entry until **all** steps succeed. Mark it `teardown-pending` with the list
  of remaining steps.
- Have the watchdog retry `teardown-pending` entries on subsequent ticks (it already runs on a 5s
  interval and `releaseTerminalReservation()` is already written to be idempotent per tick).
- Have `reconcile()` at startup sweep `teardown-pending` entries.
- Add an operator surface: extend `POST /api/reservations/:sprintId/force-release` to also force the
  worktree teardown, and/or add a `GET /api/orchestrator-worktrees` listing leaked entries.
- Belt-and-braces: a startup sweep that runs `git worktree list --porcelain` in the parent clone and
  removes any worktree under the managed root whose path is not in the ledger. This mirrors the
  dead-pid reclaim in `acquireSprintLock()` (sprint-lock.mjs:105-133) -- reclaim rather than block.
  `git worktree prune` alone is not enough: it only removes *administrative* records for directories
  that have already vanished, not the directories themselves.

**Open question:** what if the sprint branch is still checked out in the worktree and a human has
`cd`'d into it (Windows will refuse to delete a directory that is a process's cwd)? On Windows
`git worktree remove --force` will fail with a locked-file error. The retry loop covers the transient
case; a permanently-stuck worktree needs the operator surface above.

## 7. Concurrency

- **Two simultaneous launches.** Each gets its own `sprintId` (`generateSprintId()`, `api.mjs:340`,
  `${issue}-${randomUUID()}`), its own generated member name, its own worktree path, and its own
  branch. No collision on any of those. The overlap guard (`api.mjs:162-209`) still protects the
  *user-supplied* members from being double-booked.
- **Registry write races.** `src/services/registry.ts` has **no locking and no atomic rename**:
  `loadRegistry()` is a full read, `saveRegistry()` is a full `writeFileSync` overwrite, and
  `addAgent()`/`updateAgent()` are unguarded read-modify-write (registry.ts:105-118). Two concurrent
  `register_member` calls -- exactly what two simultaneous sprint launches would produce -- can
  **clobber each other, losing one of the two new members**. This is a pre-existing defect, but this
  design turns it from "rare, human-paced" into "happens whenever two sprints launch together". It is
  the third thing that needs fixing before this ships: either serialize provisioning supervisor-side
  (a simple in-process async mutex, since one supervisor is the only writer in practice) or make
  `saveRegistry()` atomic + retrying. The supervisor-side mutex does not help if a human runs
  `register_member` concurrently; the registry fix is the real one.
- **Shared embedded Dolt** across concurrent orchestrator worktrees under one parent -- see 4.7 risk 3.
- **`sprintLockKey`** stability -- see 5.1. Keeping the orchestrator out of `--members` is required.
- **Port allocation** is already per-sprint (`allocateFreePort()`, `spawner.mjs:169-186`); unaffected.

## 8. Summary of required changes

Supervisor (`packages/apra-fleet-se/src/supervisor/`):

- New `orchestrator-worktree.mjs`: create (fetch + `decideEnsureBranchAction` + `worktree add`),
  probe (`rev-parse`, `bd list`, `bd dolt pull`), register (`register_member`, local,
  `llm_provider: 'none'`), and tear down (remove worktree, release, `remove_member`).
- `api.mjs`: provision between `generateSprintId()` and `spawnSprint()`; inject
  `roleMap.orchestrator`; reject or opt-out on a caller-supplied `orchestrator`; add the
  same-repository precondition check against every local member's `workFolder`.
- `ledger.mjs`: persist `orchestratorWorktree { path, memberName, parentRepo, state }`; write the
  record **before** provisioning, not after spawn.
- `watchdog.mjs`: extend `releaseTerminalReservation()` to run teardown; retry `teardown-pending`.
- `reconcile.mjs`: sweep `teardown-pending` at startup; extend `forceRelease()`; add the
  `git worktree list` orphan sweep.
- New config: the supervisor-owned parent repo path (and, for multi-repo, a per-sprint override).

Engine (`packages/apra-fleet-se/fleet-sprint/runner.js`, `bin/cli.mjs`):

- runner.js:10998-11001: stop silently falling back to `validatedForLock.members[0]` for the abort
  path's orchestrator.
- Optionally runner.js:6331-6337: make an unmapped `orchestrator` a loud failure for
  supervisor-launched runs rather than a `unmappedRoleFallbackPool[0]` fallback.
- New guard/test: assert every `member_name: orchestratorMember` command matches a
  `bd `/`git `/`node -e ` allowlist, so no future phase routes a build there.
- No changes needed to `branchEnsureMembers`, `verifyDoerStreakClosed`, the deploy/test routing, or
  `Ensure Sprint Branch` -- all already behave correctly with a distinct orchestrator clone.

Server (`src/`):

- `src/services/registry.ts`: atomic + serialized writes (see 7).
- `src/tools/register-member.ts`: consider rolling back `addAgent()` when the `composePermissions`
  gate fails (lines 393-397 vs 432-439), so a failed registration cannot leave a half-registered row.
- `packages/apra-fleet-client`: any new/changed tool surface must be mirrored there in the same change,
  per this repo's convention.

## 9. Open questions, ranked

1. **Same-repository collision (4.3).** Confirmed by git's one-branch-one-worktree rule and by
   `Ensure Sprint Branch`'s hard throw at runner.js:7203-7209. The orchestrator worktree's parent
   clone must not be shared with any registered member. Needs a launch-time precondition check.
2. **Can a freshly registered throwaway local member mint a push+pr credential?** (5.7) If not, PR
   creation fails at the last step of every sprint.
3. **Registry write race under concurrent launches** (7). Pre-existing, newly load-bearing.
4. **Is one embedded Dolt safe under N concurrent orchestrator worktrees?** (4.7 risk 3) The
   alternative -- a per-sprint beads clone -- is much heavier provisioning.
5. **Does `bd`'s directory walk-up hold when the command is issued through `execute_command` under the
   fleet server's environment**, rather than from an interactive shell? (4.7 risk 2) Must be probed,
   never assumed.
6. **Multi-repo supervisors** (4.2): does `POST /api/sprints` need a `repo` field?
7. **Caller-supplied `roleMap.orchestrator`** (4.8): reject, or honor as an opt-out?
8. **Reset-to-origin at worktree-add time** (4.4): support it, or always attach and let
   `Ensure Sprint Branch` reconcile?
9. **Windows worktree fragility.** auto-sprint.js:307 documents that the existing worktree fan-out is
   still non-default because of win32 "already exists" leaks. The same failure mode applies here and
   needs the prune + force-remove preamble at minimum.
