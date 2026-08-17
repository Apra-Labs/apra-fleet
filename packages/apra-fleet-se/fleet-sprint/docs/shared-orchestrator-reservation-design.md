# Design: Pinned Shared Orchestrator (supervisor-held orchestrator-role pin)

Status: DESIGN PROPOSAL (no beads filed yet; matured from the 2026-08 stale-beads incidents)
Author: design session, 2026-08-11
Source doc path: `packages/apra-fleet-se/fleet-sprint/docs/shared-orchestrator-reservation-design.md`

## Problem recap

Every fleet-sprint launch resolves an `orchestrator` pseudo-role (runner.js:73
`ROLE_ORCHESTRATOR`, runner.js:4938 `orchestratorMember = getMemberForRole(ROLE_ORCHESTRATOR)`)
whose beads clone is the sprint's ground truth for all scope reads and bd mutations. Absent an
explicit `--role-map '{"orchestrator":[...]}'`, this silently defaults to
`unmappedRoleFallbackPool[0]` (runner.js:4915-4920) -- for a single-member sprint, the dispatch
member itself. Two production incidents followed: beads created on the interactive operator
machine's clone were invisible to sprints whose accidental orchestrator was a different,
never-synced member.

The naive fix (role-map a hub member as orchestrator on every launch) deadlocks concurrency:
the launch overlap guard unions `--members` with every roleMap value INCLUDING orchestrator
(api.mjs:103-117 `memberUnion`, api.mjs:133-141), so a shared orchestrator member would 409
every second concurrent launch (api.mjs:202-207). The operator's proposal: the supervisor holds
a standing, shared, orchestrator-role-only reservation on one designated member and injects it
as the default orchestrator into every launch.

---

## Part A -- Research findings (evidence, not assumption)

### A1. The concurrency-safety premise is PARTLY FALSE: the orchestrator role DOES mutate git working-tree state

The working assumption ("orchestrator commands are dolt/bd-only and never touch git
branch/working-tree state") does not survive a read of runner.js. The orchestrator-role command
sites split into two classes:

**Beads/dolt-only sites (the majority, as assumed).** `bd list/show/update/close/dep/defer`
against `member_name: orchestratorMember` -- e.g. runner.js:5123 (all-beads read), 5210
(scope filter), 5315 (status reopen), 7036 (claim), 7511 (bd show), 7577/8284/8677 (reopen per
verdict), 8073-8083 (bug triage), 9066 (target close), 5925 (bd dep remove), 2247-2249
(verifyDoerStreakClosed). Plus the D-pull/D-push brackets: `DoltSync.syncBefore(orchestratorMember, ...)`
at runner.js:2247, 5545 (readinessGate), 5836, 8124; `DoltSync.syncAfter(orchestratorMember, ...)`
at 6502, 6769, 7689, 8345, 9078 and `doltPushAfter` at 8691. All of these are `bd`/`bd dolt`
commands routed through dolt-sync.mjs (the single `bd dolt` chokepoint, dolt-sync.mjs:6-8;
actual commands are `bd dolt pull` at dolt-sync.mjs:365/675 and `bd dolt push` at 620/695).
None of these touch the git working tree.

**Git working-tree sites (the premise-breakers), with file:line evidence:**

1. **Branch ensure includes the orchestrator.** `branchEnsureMembers` is explicitly the union
   of `orchestratorMember` + doer pool + reviewer pool (runner.js:5517-5521). The ensure loop
   (runner.js:5557-5726) runs, on the orchestrator's clone: `git fetch origin <base>` (5566),
   `git fetch origin <branch>` (5582), local-branch probe (5598), two `git merge-base
   --is-ancestor` checks (5616, 5625), then a **`git checkout <branch>` or `git checkout -B
   <branch> <startPoint>`** (5689, decision built by `decideEnsureBranchAction`,
   runner.js:4553-4634), with a **`git stash push -u`** fallback on a dirty tree (5709-5716).
2. **Per-cycle re-ensure.** `reEnsureBranchOnMembers()` re-runs `git checkout <branch>` on
   every branchEnsureMembers entry -- orchestrator included -- each cycle (runner.js:5745-5756).
3. **Requirements-file probe reads the orchestrator's working tree.** `probeFileExists()`
   dispatches a `node -e fs.existsSync(...)` to `orchestratorMember` (runner.js:5819-5829);
   what it sees depends on which branch that clone has checked out.
4. **Publish PR pushes from the orchestrator's clone.** `git push -u origin <branch>` with
   `member_name: orchestratorMember` (runner.js:9000-9008), `git remote get-url origin`
   (9046-9051), and the VCSModule create-PR curl dispatched on the orchestrator (9132-9142).
   The push publishes the orchestrator's LOCAL `refs/heads/<branch>` -- it assumes that clone's
   branch ref is current (true today only because orchestrator == doer in single-member
   practice; already latent-fragile for true multi-member synced-mode sprints).
5. **Abort finalization does git on the orchestrator.** `finalizeAbort()` runs `git fetch`,
   `git rev-list --count origin/<base>..<branch>` (against the LOCAL branch ref) and `git push
   -u origin <branch>` on the member resolved at runner.js:9392-9394 -- i.e. the orchestrator
   (finalizeAbort body: runner.js:4358-4398).

**Consequence:** N concurrent sprints sharing ONE pinned orchestrator member would fight over a
single working tree: each sprint's ensure/re-ensure flips HEAD to its own branch, the
requirements probe can read another sprint's branch content, a stash from sprint A can be
popped into confusion, and publish/abort pushes read local refs whose state interleaves with
other sprints' checkouts. **The pin is NOT safe as-is.** It becomes safe only after the
orchestrator role is made genuinely beads-only (see D0 below) -- a bounded, well-localized
refactor, because every git site above is either relocatable to a dispatch member or
unnecessary for a non-dispatch orchestrator.

### A2. The dolt push mutex: what it does and does not already cover

The supervisor owns ONE global mutex serializing every cross-sprint `bd dolt push`
(dolt-mutex.mjs:6-18, motivated by PoC constraints C.2 "any concurrent write to the same row
hard-conflicts" and C.3 "one unresolved conflict wedges the entire clone"). It is FIFO, leased,
pid-probed, and exposed over HTTP to the detached children (dolt-mutex.mjs:267-331). runner.js
threads it plus a per-sprint id into every D-push: `mutex: doltPushMutex, sprintId:
sprintMutexId` at runner.js:6502/6769/7689/8345/9078/8691 (fatal-path variant at 1143), where
`sprintMutexId` is the sprint branch (runner.js:4674-4676). Holder identity is logged on grant,
reclaim, and release (dolt-mutex.mjs:139, 181).

So: **cross-sprint push windows are already serialized today, for any pair of clones.** The
mutex was designed for pushes from DIFFERENT clones racing at the shared dolt remote -- exactly
the accidental-shared-orchestrator case the prompt describes. To that extent, reservation
exclusivity was never what protected orchestrator-role dolt writes; the mutex was.

**What the mutex does NOT cover, and the pin makes load-bearing:**

- `DoltSync.syncBefore` (D-pull) is never mutex-guarded -- no `mutex:` at runner.js:2247,
  5026, 5545, 5836, 8124. Two sprints pulling different clones concurrently is fine; two
  sprints concurrently running `bd dolt pull` against the SAME pinned clone is a new, untested
  interleaving (including pull racing an in-flight push-reconcile, dolt-sync.mjs:675).
- Plain local bd mutations (`bd update/close/dep/defer/create`) are not serialized at all.
  Today each sprint mutates its own orchestrator clone; under the pin, three sprints issue
  concurrent bd writes against ONE embedded-dolt clone (`.beads/embeddeddolt`). Whether bd
  1.1.x embedded mode tolerates concurrent same-clone processes (vs. erroring "database
  locked" or corrupting) is **empirically unknown in this repo** -- nothing in
  dolt-sync.mjs/dolt-mutex.mjs speaks to same-clone process concurrency. This must be spiked,
  and the safe default design is to serialize (D3 below).
- `execute_command` (the transport under every orchestrator `command()`) enforces neither
  reservations nor per-member mutual exclusion -- src/tools/execute-command.ts only marks the
  statusline busy (execute-command.ts:238, 264-265); the `reservedBy` dispatch rejection
  exists only in execute_prompt (execute-prompt.ts:536-543). So nothing at the transport layer
  will accidentally serialize (or reject) the shared traffic either.

### A3. Reservation model today (ledger + server-side reservedBy)

- **Supervisor ledger** (src/supervisor/ledger.mjs): per-sprint entries
  `{ members, issueRoots, childPid, reservedAt, branch, base, goal, exit*, logPath }`
  (ledger.mjs:65-108), claimed and released in exact lockstep with the sprint lifecycle
  (ledger.mjs:21-29, claim at 461-477, release at 485-499), atomically persisted, PID-probe
  reconciled on restart. Everything about it is sprint-lifecycle-scoped.
- **Launch overlap guard** (api.mjs:162-209): all-or-nothing 409 on any member of the incoming
  union (members + every roleMap value, orchestrator included) overlapping any live ledger
  entry, merged with the fleet server's own per-member `reservedBy` record via `listMembers`
  (api.mjs:185-200).
- **Server-side reservation authority**: `member_reservation` (src/tools/member-reservation.ts)
  sets `agent.reservedBy`; reserve fails if held by a different id (member-reservation.ts:42-44),
  refresh by the same id succeeds (49-51), release is owner-checked (61-63), force_release is
  unconditional (71-79). `sprint_id` is an opaque string -- nothing requires it to be a real
  sprint. Enforcement is at execute_prompt only (execute-prompt.ts:536-543), keyed on per-call
  `sprint_id` falling back to `APRA_FLEET_SPRINT_ID` (execute-prompt.ts:106-114, 254-259).
- **Who actually reserves**: supervisor-spawned children run bin/cli.mjs, which reserves
  `validMembers` only -- roleMap values are NOT in its reserveAll set (cli.mjs:723-729). The
  supervisor ledger union DOES fold roleMap values in (api.mjs:442). So today a role-mapped
  orchestrator outside `--members` is overlap-guarded at the supervisor but never server-side
  reserved by the child -- an existing asymmetry the pin design can exploit cleanly (the pinned
  member simply never enters either per-sprint set).

### A4. Interaction with in-flight work (pause/resume `apra-fleet-p2to`, sprint-doctor `apra-fleet-iiny`)

Pause/resume's reservation logic (escalate-to-llm-design.md:520-533) releases each member via
owner-checked `member_reservation release` on pause and re-reserves on resume, failing resume
cleanly when a member was taken. This operates on the sprint's OWN per-sprint reservation set.
Under this design the pinned member is deliberately NOT in that set (D1), so pause/resume never
touches it -- and even a buggy release attempt would be refused by the owner check
(member-reservation.ts:61-63), because the pin's owner is a supervisor sentinel, not the sprint
id. So the mechanisms are structurally orthogonal, **with two real (non-hand-waved) contact
points**:

1. **Sprint-doctor's wedged-reservation remedy is NOT orthogonal.** The doctor's remedy table
   allows `member_reservation force_release` when a member is "reserved by a sprint id whose
   pid/ledger entry is dead" (escalate-to-llm-design.md:679). The pin sentinel has no pid and
   no ledger entry -- to that heuristic it looks exactly like a wedged dead reservation, and a
   doctor run would strip the pin. The doctor rule must learn: a reservation whose owner
   matches the supervisor pin sentinel prefix is never force-releasable (and the supervisor
   should self-heal the pin regardless -- D2).
2. **Explicit orchestrator override** (D4's escape hatch) puts the overriding member back in
   the per-sprint reservation set, where pause/resume handles it under existing semantics --
   intentionally unchanged.

---

## Part B -- Design

### D0 (prerequisite). Make the orchestrator role beads-only

Because of A1, the pin requires relocating the orchestrator's git surface first. All four
sites are bounded:

- **Branch ensure / re-ensure**: drop `orchestratorMember` from `branchEnsureMembers`
  (runner.js:5517-5521) whenever the orchestrator is not also a dispatch member (compute:
  member appears in doer/reviewer pools). A beads-only orchestrator has no need for the sprint
  branch; its clone's git checkout becomes irrelevant to the sprint.
- **Requirements probe/read** (runner.js:5819-5829 and the up-front read near 5523): dispatch
  to `getMemberForRole('planner')` -- the planner is the consumer of the requirements content
  and its member is already branch-ensured.
- **Publish PR** (runner.js:9000-9152): run the branch push, origin-URL probe, and PR curl on a
  dispatch member -- recommend `getMemberForRole('harvester')` (the last code-writing role;
  its clone G-pushed most recently, so its local ref is current -- runner.js:8913-8923). This
  also fixes the latent multi-member staleness noted in A1 point 4.
- **finalizeAbort** (runner.js:9390-9400 member resolution): resolve the same dispatch member
  instead of the orchestrator.

After D0, the orchestrator's entire command surface is `bd`/`bd dolt` via execute_command, and
"sharing" reduces to the beads-clone concurrency question handled in D3.

### D1. Data model: a supervisor "pinned roles" config + server-side sentinel -- NOT a ledger reservation type

**Recommended:** model the pin as supervisor configuration plus a standing server-side
`reservedBy` sentinel, with the ledger kept completely ignorant of it:

- Supervisor config: `pinnedRoles: { orchestrator: ["<member>", ...] }` (ordered fallback
  list, D5). Product-generic -- no member name in code.
- At startup (and on a periodic self-heal sweep), the supervisor reserves the active pinned
  member server-side via the EXISTING `member_reservation` tool with a sentinel owner id, e.g.
  `sprint_id: "supervisor-pin:orchestrator"`. No tool/schema change: `sprint_id` is already an
  opaque string (member-reservation.ts:24-27), refresh-by-same-owner already succeeds
  (member-reservation.ts:49-51), and `list_members`/dashboards already display `reservedBy`
  (api.mjs:399-426).
- Per-sprint reservations EXCLUDE the pinned member: the injected orchestrator roleMap entry is
  subtracted before `memberUnion` feeds the overlap guard and `ledger.claim` (api.mjs:442,
  487, 539), and the child's `reserveAll` set (cli.mjs:723-729) already never contained roleMap
  values, so no child-side change is needed for the supervisor path.

**Why not a shared/`exclusive:false` reservation TYPE in the ledger:** every ledger invariant
is sprint-lifecycle-shaped -- claim/release in lockstep with one sprint's launch/terminal
events (ledger.mjs:21-29), a `childPid` for restart PID-probe reconciliation (ledger.mjs:70-71),
release driven by watchdog/reconcile/Stop (`POST /api/reservations/:sprintId/force-release`,
dashboard.mjs:279-282 per escalate-to-llm-design.md:521). A permanent, sprint-less, shared
entry violates all of it: it has no pid to probe, must survive every reconciliation pass, must
be skipped by the overlap guard, and must never be force-released by the Stop path. That is
not a reservation with a flag -- it is a different object with a different lifecycle, and
encoding it as a ledger row means special-casing every ledger consumer (watchdog, reconcile,
readopt, dashboard, overlap guard, history). Config + sentinel touches exactly two seams
instead: launch-time injection/validation (api.mjs) and the server-side `reservedBy` record
that execute_prompt already enforces. The sentinel also gives cross-process reach the ledger
cannot: it protects against dispatches from CLI-launched sprints and manual sessions that never
consult this supervisor's ledger at all (the eft.26.1 hole, api.mjs:143-153).

### D2. Enforcement: how the pinned member is kept out of other roles

Three layers, cheapest first:

1. **Launch-time validation (authoritative, clear message).** In `launch()` (api.mjs:436),
   after `roleMapResolver` (api.mjs:441): reject 400 if the pinned member appears in the
   request's `members` list or in any roleMap value other than `orchestrator`, with an error
   naming the member, the pin, and the fix ("member '<m>' is pinned as the shared orchestrator
   and cannot be used as doer/reviewer/...; remove it from members/roleMap or change the pin").
   This runs before `beforeLaunch`/`ledger.claim`, preserving the no-partial-claim contract
   (api.mjs:35-36).
2. **Dispatch-time, for free.** The sentinel `reservedBy` makes execute_prompt reject ANY agent
   dispatch to the pinned member from any sprint (owner `supervisor-pin:orchestrator` never
   equals a caller `sprint_id`, execute-prompt.ts:536-543) -- while execute_command (the
   orchestrator's entire post-D0 traffic) is unaffected because it performs no reservedBy check
   (A2). This is exactly the asymmetry the proposal needs, and it already exists.
3. **Self-heal + doctor guard.** The supervisor periodically re-asserts the sentinel
   (idempotent refresh, member-reservation.ts:49-51) so an accidental/manual force_release
   cannot silently de-protect the member; the sprint-doctor remedy table gains the rule from
   A4.1 (sentinel-prefixed owners are never force-releasable).

### D3. Serializing the shared beads clone (the genuinely new mechanism)

Generalize the supervisor's global dolt-push mutex into keyed mutexes: key = member name (the
current global push mutex becomes, or wraps, key `"<dolt-remote>"` -- unchanged behavior), and
a new per-member clone lock for the pinned orchestrator. The runner acquires the clone lock
around (a) `DoltSync.syncBefore(orchestratorMember, ...)` and (b) each orchestrator bd-mutation
bracket, whenever the orchestrator member is supervisor-pinned (the child knows via a flag the
supervisor injects alongside the roleMap, or simply: whenever `--service-url` is present it
asks). The existing lease/pid-reclaim/FIFO machinery (dolt-mutex.mjs:31-42) is reused verbatim;
only the keying changes. Pure reads (`bd list/show`) can stay unlocked initially -- reads
racing a writer are the same exposure the operator's interactive session already creates today
against its own clone.

Precondition spike: empirically test bd embedded-dolt behavior under concurrent same-clone
processes (two parallel `bd update`, `bd dolt pull` racing `bd update`). If bd's own locking
proves robust, the clone lock can be narrowed to the pull/push brackets only.

### D4. Auto-injection and the override question

Injection point: `launch()` in api.mjs, server-side, after `roleMapResolver` (api.mjs:441) and
before `memberUnion`/`beforeLaunch`/`spawnSprint` -- if the resolved roleMap has no
`orchestrator` key, inject `roleMap.orchestrator = [activePinnedMember]`; the spawner already
forwards roleMap into child argv untouched (spawner.mjs:223-225), and runner.js resolution
(4915-4920) then never falls back to `unmappedRoleFallbackPool[0]`. Because the pinned member
arrives only via roleMap (never `--members`), it is also structurally excluded from the
doer/reviewer fallback pools (runner.js:4910-4913 builds those from `physicalMembers`).

**Recommendation: soft pin -- an explicit `roleMap.orchestrator` from the caller WINS,** loudly
logged and echoed in the launch response (e.g. `orchestratorPinOverridden: true`). Reasons:
the incidents were caused by a silent implicit default, not by explicit choices -- injection
plus validation eliminates the silent path entirely; a hard pin would leave no way to launch
sprints during maintenance of the pinned member (defeating D6's fallback story); and an
explicitly-mapped override member flows into the NORMAL exclusive reservation path (union +
ledger + reserveAll), so it is safe under existing rules with zero new semantics. The escape
hatch is an explicit, logged, per-launch act -- precisely the property the implicit default
lacked.

CLI-direct launches (bin/cli.mjs without the supervisor) keep today's behavior; when
`--service-url` is provided the CLI SHOULD fetch the pin (D5's GET endpoint) and apply the same
default+validation. This deployment's practice is supervisor-API-only launches, so the CLI gap
is a documented follow-up, not a blocker.

### D5. Configuration surface (product-generic)

- **File**: `pinnedRoles` object in a supervisor config file in the existing data dir
  (`FLEET_SE_DATA_DIR`, default `~/.apra-fleet-se`, ledger.mjs:177-181), e.g.
  `supervisor-config.json`: `{ "pinnedRoles": { "orchestrator": ["memberA", "memberB"] } }`.
  Generic shape (role -> ordered member list); only `orchestrator` is honored initially.
- **Flag**: `fleet-se serve --pin-orchestrator <member[,member...]>` overriding the file
  (serve.mjs currently takes only `--port`, serve.mjs:52-62 -- room to grow).
- **API**: `GET /api/config/pinned-roles` (consumed by dashboard, launch form, and the CLI
  follow-up) and `PUT` for runtime changes (re-runs sentinel reserve/release accordingly).
  Dashboard shows the pin and its health.
- No member name appears anywhere in code; `fleet-dev` is purely this deployment's config value.

### D6. Single point of failure -- honest assessment and mitigation

Real regression risk: today, sprints accidentally spread orchestrator duty across their own
first members, so no single dead machine blocks ALL launches; a pin concentrates every launch
AND every in-flight sprint's bd reads/writes on one member. Mitigations, in order:

1. **Ordered fallback list** (D5): at launch, the supervisor health-probes the first pinned
   member (cheap `execute_command` echo plus optionally a `bd dolt pull` probe, the same probe
   shape `checkMemberTopology`'s synced mode already uses, cli.mjs:645) with a short timeout;
   on failure it advances to the next configured member, re-pointing the sentinel. All
   candidates failing => the launch is rejected 503 with an explicit message naming every
   probed member and failure -- **fail loud at launch, never a silent mid-sprint hang**.
2. **In-flight sprints**: a pin dying mid-sprint is the same failure mode as any member dying
   mid-sprint today (orchestrator included) -- not made worse, but concentrated. The
   supervisor watchdog/dashboard should surface pin health continuously so the operator learns
   about it from the dashboard, not from three simultaneously wedged sprints. Fits naturally
   into sprint-doctor's diagnosis table later.
3. Accept the residual coupling consciously: the accidental-spread status quo bought
   "availability" at the price of the exact correctness incidents that motivated this design.
   Note the deployment guidance: pin the hub/local member (the machine the supervisor itself
   runs on), which removes most network/SSH failure modes from the orchestrator path.

### D7. Audit/attribution

Push attribution already exists and survives: every D-push acquires the supervisor mutex with a
per-sprint id (runner.js:6502 et al., `sprintId: sprintMutexId` = the sprint branch,
runner.js:4674-4676), and the mutex logs holder identity on grant/reclaim/release
(dolt-mutex.mjs:139, 181). Each sprint's own log labels every orchestrator command it issued.
What IS lost: today, concurrent sprints' bd mutations land on different clones, so dolt-level
history is separable by machine; under the pin, one clone's dolt history interleaves all
sprints. The D3 clone lock plus per-sprint runner logs (every mutation is issued and logged by
exactly one sprint process) is sufficient traceability for v1 -- no new mechanism proposed. If
finer attribution is ever needed, it belongs in bd (an actor/annotation flag), not here.

### D8. Would this have prevented today's two incidents?

Both incidents (fleet-mac/k4sc, fleet-win-dev1/ot2z) had the same shape: single-member sprint,
orchestrator collapsed onto the dispatch target, and beads created/updated on the interactive
operator machine's clone were invisible because the resolved orchestrator's clone had never
pulled them -- and could not, since the operator clone had also never pushed them.

- **With the pin set to the member whose clone the interactive orchestrator session itself
  uses** (this deployment: the hub/local member): both incidents are prevented at the source --
  the sprint's scope reads run against the very clone where the beads were created; no push or
  pull needs to have happened. This is the honest core of the fix for THIS deployment.
- **Product-generically, the gap relocates rather than vanishes**: if the operator's
  interactive clone is NOT the pinned member, unpushed operator mutations are exactly as
  invisible as before -- `DoltSync.syncBefore(pin)` at launch (runner.js:5545, readinessGate)
  pulls the pin's clone, but a pull cannot fetch what was never pushed. So the previously
  discussed launch-time pre-sync/freshness gate (verify the pin's clone is current against the
  dolt remote, and surface staleness loudly) remains **complementary, not superseded** -- it is
  the guard for the "discipline burden" now concentrated on one well-known member, which is
  itself an improvement: one clone to keep honest instead of N accidental ones.
- **Dispatch-member sync is unaffected**: doers/reviewers keep their own per-dispatch D-pull
  (runner.js:5026 inside the withGitSync bracket) and D-push; nothing in this design touches
  the dispatch-side sync lattice.

---

## Recommendation

The idea is **sound in intent and correctly identifies that reservation exclusivity was never
the real safety mechanism for orchestrator-role dolt writes (the supervisor dolt-push mutex
was)** -- but it is **not implementable as stated**, for one hard reason found in the code: the
orchestrator role is not beads-only today. Branch-ensure checks the orchestrator's clone onto
the sprint branch every cycle, the requirements probe reads its working tree, and publish/abort
push from its local refs (A1). A shared pinned orchestrator without D0 would corrupt exactly
the cross-sprint isolation the reservation system exists to protect. With three modifications
the design is solid:

1. D0: make the orchestrator role beads-only (relocate the four git sites).
2. D1/D2: model the pin as supervisor config + `member_reservation` sentinel (no ledger type,
   no MCP schema change), enforce at launch validation + the existing execute_prompt check.
3. D3: serialize shared-clone bd access via a per-member generalization of the existing
   supervisor mutex, after a concurrency spike on bd embedded-dolt behavior.

Soft pin (explicit roleMap.orchestrator overrides, loudly) is recommended over hard pin. The
launch-time pre-sync/freshness gate stays on the roadmap as a complementary guard (D8).

### Bead sketches (NOT filed -- for operator decision)

1. **`refactor(fleet-sprint): make the orchestrator role beads-only`** -- Drop the orchestrator
   from `branchEnsureMembers` when it is not also a dispatch member; relocate the
   requirements-file probe/read to the planner member and the Publish-PR push/origin-probe/PR
   call plus finalizeAbort git steps to a dispatch member (harvester/doer). Prerequisite for
   any shared-orchestrator work; independently fixes the latent stale-local-ref publish push
   for multi-member sprints.
2. **`spike(beads): embedded-dolt same-clone concurrency behavior`** -- Empirically establish
   what bd 1.1.x embedded mode does under concurrent same-clone processes (parallel `bd
   update`, `bd dolt pull` racing a write): clean lock-wait, transient error, or corruption.
   Output decides whether bead 4's clone lock wraps all mutations or only the pull/push
   brackets.
3. **`feat(supervisor): pinned-orchestrator config, sentinel reservation, and launch
   injection`** -- `pinnedRoles` config file + `--pin-orchestrator` serve flag + GET/PUT API;
   sentinel reserve via `member_reservation` with self-heal refresh; launch-time injection of
   the default `roleMap.orchestrator` with health-probed fallback list and 503-on-all-dead;
   400-validation rejecting the pinned member in any non-orchestrator role; pin excluded from
   memberUnion/ledger claim; dashboard surfacing. Soft-pin override semantics per D4.
4. **`feat(supervisor+runner): per-member beads-clone lock for the shared orchestrator`** --
   Generalize the dolt-push mutex to keyed (per-member) locks over the same lease/FIFO/pid
   machinery; runner acquires the clone lock around orchestrator syncBefore and bd-mutation
   brackets when the orchestrator is supervisor-pinned. Scope narrowed or widened by bead 2's
   findings. Includes the sprint-doctor rule change: sentinel-owned reservations are never
   force-releasable.
