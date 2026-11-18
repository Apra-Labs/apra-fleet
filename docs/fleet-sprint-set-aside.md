# fleet-sprint: set-aside and immediate stall

How the sprint engine handles work that cannot proceed, without retrying it
forever or burning cycles on it.

## Rules

1. **A BLOCKED bead is set aside, with its dependents.** When a doer reports
   BLOCKED, the engine records the blocked bead ids and every bead that
   transitively depends on them via open `blocks` edges. Set-aside beads are not
   handed to doers again this run. Other beads in the same streak return to the
   ready pool.
1a. **A VERIFY reply with no change sets the bead aside.** When a doer streak
   returns VERIFY, its report claims no close of its own beads, and the
   engine's read-back shows it closed none of them, and the dispatch made no
   change (the member's branch tip is the same before and after, with a clean
   work tree; an unreadable state counts as changed), re-dispatching it would
   only repeat the same answer. After that one round the streak's first
   still-open bead is set aside (kind `verify-no-change`) and carried over
   like a BLOCKED bead; its later lane-mates are held by lane order. A
   streak that closed any of its beads, that committed or left a diff, or
   whose report claims a close the read-back disproves, keeps the ordinary left-open retry.
2. **A deploy Permissions failure sets the deploy aside.** Only a deployer
   result whose `failedStep` is `permissions` does this. Later cycles skip the
   deployer, but the last deploy failure is still reported so the deploy
   verdict gate keeps working.
3. **Immediate stop: carry-over or stall.** If nothing is left that can make
   progress because of set-aside work, the sprint stops at once, rather than
   after the usual two no-progress cycles. How it stops depends on whether
   this run already closed work (a bead it dispatched or routed to verify):
   - **Work closed this run: carry-over.** The run is not aborted. At Cycle
     Evaluation the cycle loop exits to Finalization (Final Review,
     Regression, Harvest, Publish PR) with every set-aside bead, bead stuck
     behind one, and `deploy` named as a carry-over with its reason. The
     verdict is forced FAIL while any at/above-goal bead is carried over; the
     carry-over list leads the verdict notes (and so the PR body), and the
     run result carries `exitReason: "set-aside-carry-over"` and
     `carryOver: [{id, reason}]`. At the start of a Develop round the same
     condition only ends the Develop loop, so Deploy and Integration Test
     still run for work closed earlier in the cycle; Cycle Evaluation then
     takes the exit.
   - **Zero beads closed this run: stall.** The run ends SPRINT_STALLED; the
     stall error names every set-aside bead and `deploy` (blocker ids and
     reasons).

   A bead held (by lane order or an open `blocks` prerequisite, transitively)
   behind a bead that cannot close this run counts as stuck for this check.
   "Cannot close this run" means set aside (doer BLOCKED, a dependent of one,
   a doer VERIFY with no change, or awaiting a decision), publish blocked by a permission-scope push
   failure, or deferred (status `deferred`, e.g. a plan-cap deferral). A
   publish-blocked bead is itself counted as set aside. The stuck bead's
   reason names that prerequisite and why, e.g.
   `held on X (deferred), which cannot close in this run`. A bead whose
   prerequisites can all still close is not stuck and keeps the run going.

   A parent whose children are all
   closed is not set aside: while Integration Test can still run (deploy.md
   and the playbook present, deploy not set aside), it keeps the run going
   through Deploy and Integration Test. When the deploy is set aside and
   all work is closed, the run goes straight to the finish phases (no
   deploy-retry cycles); the verdict is FAIL and names the deploy reason.
4. **Report.** A "Set aside this run" section appears in the PR body (publish
   and abort paths) and in the sprint analysis. It is omitted when nothing was
   set aside.
5. **A NEEDS-DECISION bead is set aside and filed for a human.** A doer
   (status) or reviewer (verdict) that needs an operator to choose returns
   `NEEDS-DECISION` with a `decision` (bead id, full question, at least two
   options, recommendation). The engine files a separate decision bead
   (type `decision`, label `human`, status `deferred`, linked to the work
   bead by a `discovered-from` edge), appends the request to the work bead's
   notes, and sets the work bead and its `blocks` dependents aside (kind
   `needs-decision`). The work bead itself is never labelled `human`:
   `bd human respond` closes the bead it answers. Nothing on this path is
   truncated (fleet-sprint/decisions.mjs).
   Filing is idempotent: an open decision bead with the exact same title is
   reused rather than duplicated, and its id is validated before it is placed
   in a `bd` command.
6. **A pending decision pauses the run instead of stalling it.** When rule 3
   would stall the run and any decision is still pending -- even if other
   beads are set aside for other reasons, since the answer may unblock work --
   the run parks ONCE through the engine's cooperative pause (source
   `needs_decision`, state `paused-awaiting-decision`, published under the
   `decisions` state namespace) instead of throwing StalledSprintError. An
   answer is appended to the work bead's notes, the bead and its dependents
   are released and re-enter through the ready set, and the run continues
   without a relaunch. A stall with no pending decision is unchanged
   (fleet-sprint/decision-wait.mjs). A decision whose decision bead could not
   be filed (the best-effort `bd create` failed) has no answer path, so it
   never holds a pause: a stop on it follows rule 3 (a carry-over when work
   closed this run, otherwise StalledSprintError), its set-aside reason names
   it with its full question, the run log says the decision bead could not be
   filed, and `recordDecisionAnswer` refuses it.

   While parked, NO command runs on any sprint member and the members stay
   reserved by the sprint (the CLI skips the usage-limit pause's reservation
   hand-back for this pause source, so no other sprint can take a member);
   the sprint lock is held. Once per interval (60s, or
   `APRA_FLEET_DECISION_POLL_MS`) the wait checks its in-process answer
   queue, which the dashboard's decision banner and the supervisor's
   `POST /api/sprints/:id/decisions/:decisionId` (both reaching
   `recordDecisionAnswer`) feed: such an answer resumes the run at once,
   exactly once. Once per read interval (5 minutes, or
   `APRA_FLEET_DECISION_READ_POLL_MS`, in milliseconds) the wait reads the
   holding decision beads with one `bd show --json` on the backlog member
   (the supervisor-owned, unreservable member on the project beads folder).
   That read uses the workflow engine's pause-exempt `command()` option, so
   it runs while the run is paused without counting as in-flight work; it
   does no beads pull, no resync, no member release and no pause/resume. When
   a decision bead reads closed -- an operator ran
   `bd human respond <decision bead> "<answer>"` -- the run resumes once on
   its own, reads the answer from the bead's comments and applies it: no
   dashboard Resume is needed. A failed read is logged once per distinct
   error and the wait keeps going. An operator Resume still works: a resume
   with nothing answered pulls the beads clone, reads once more, and if still
   unanswered logs one line and parks the run again after one interval.
   Logging is one line per state change, never one per poll. The fleet
   server's 30-minute cloud idle timeout only stops an idle cloud member's VM
   (restarted by its next dispatch); it never aborts the wait, and the wait
   has no total budget. An operator stop during the pause ends the run at
   once, cancelling any read in flight.

   `recordDecisionAnswer` only queues the answer and returns `recorded`. The
   runner applies queued answers at the top of each cycle, inside the
   open-sync bracket and after a fatal pull, so the bead is released with the
   beads state in a consistent position.

## Design points

- Blocked ids come from the doer's structured `blockedIds` field. An explicit
  empty list sets nothing aside. With the field omitted, only a single-bead
  dispatch whose bead is still open sets that bead aside; in a larger
  dispatch a bead the doer did not name is never set aside. Notes text is
  never parsed.
- Dependent traversal follows only `blocks` edges. `parent-child` edges are
  grouping, not ordering, and closed beads are skipped (see
  [GRAPH-SEMANTICS.md](../packages/apra-fleet-se/apra-pm/agents/_shared/GRAPH-SEMANTICS.md)).
  The traversal relies on `bd list --all --json` returning dependency edges.
- The stall evaluation is a pure function (no I/O) so it is unit-testable; the
  runner calls it at the start of each round and at Cycle Evaluation, before the
  two-cycle stall check.
- The code is plain JS with no shell, path or process assumptions, so it is
  OS-neutral.

## Notifying the operator of a pending decision

Each pending decision sends one message and one email, configured per sprint
with `--decision-notify <json>`:

    {"message_member": "orchestrator",
     "email": {"provider": "sendgrid", "from": "a@x.io", "to": ["b@x.io"]},
     "dashboard_url": "http://localhost:8787", "timeout_s": 30}

`email.provider` is `sendgrid` (default) or `smtp` (smtp also needs `host` and
`user`; `port`, `secure` optional). Credentials are never part of it; the fleet
credential store holds them, and unknown keys are rejected. If `--decision-notify`
is absent, the `FLEET_SPRINT_DECISION_NOTIFY` environment variable (same JSON)
is used.

The message target is resolved once at launch. An explicit `message_member` is
used as given. Without one, the default is `orchestrator`: the fleet server
registers every session that has no member identity and declares the
`claude/channel` capability (the operator's own Claude Code session that
launches or orchestrates sprints) under that stable id in the session registry,
the newest such session holding it, so `send_message` reaches it. When that
session closes the id moves to the newest one still open. If no target can be
resolved (the run has no fleet client), or the email channel is not configured,
the sprint logs that once at launch, naming how to configure it; each decision
still records that channel as `failed` (`no channel configured`) without
repeating the warning. A resolved message target is also checked once at
launch through `send_message`'s read-only `probe` mode: if no session that
declared the `claude/channel` capability holds it (for `orchestrator`, a
Claude Code session launched with `--dangerously-load-development-channels`),
the sprint logs ONE line naming that flag and the `message_member`
alternative, and each later decision's failed send logs one short line. A
failed check logs one line; the launch is never blocked. A configured target that is not connected when a
decision is raised records `failed` with the server's `member not connected`
reason. The sprint carries on in every case. A supervisor-launched
sprint can set it per launch with the `decisionNotify` field of
`POST /api/sprints` (see `packages/apra-fleet-se/docs/supervisor-api.md`).

## Late decision answers

A decision answered while the run waits at Cycle Evaluation of its last
allowed cycle (`maxCycles`) grants exactly one extra cycle when the run's
budget allows, so the released bead is dispatched in the same run (a further
late answer in that extra cycle grants one more). When the budget is
exhausted the run ends with a log line and a line in the final verdict notes
naming the released-but-unworked bead and its decision. An answer recorded
after the cycle loop has ended stays pending and is reported the same way.
A wait at the start of a develop round dispatches the bead in the same cycle.

## Verify-routed beads the exit stops waiting for

A verify-routed bead (every child closed) only closes when Integration Test
closes it, and the cycle loop does not exit while one is open. Two shapes no
cycle can resolve are carried over instead (`fleet-sprint/verify-carry-over.mjs`):

- **needs-external-evidence.** The engine counts, per bead, consecutive
  cycles in which the bead was handed to Integration Test, is still open
  afterwards, and has no gap bug filed under it. At
  `NEEDS_EXTERNAL_EVIDENCE_CYCLE_LIMIT` (2) the bead is not dispatched to
  verify again and no longer holds the exit. A cycle in which it closes or
  gets a gap bug resets its count; an infra dispatch failure (no verdict)
  neither counts nor resets. The run goes on to Final Review, Regression,
  Harvest and Publish PR; Final Review forces the verdict to FAIL and names
  the bead with the integ runner's reason (`verifySetLeftOpen`, else its
  summary) in the verdict notes and PR body. The bead stays open.
- **deferred during the run.** A verify-routed bead deferred mid-run is
  dropped from the exit gate and named in the verdict notes. If the engine's
  verify bounce cap deferred it (it kept failing verification), it is carried
  over as `deferred-bounce-cap` and the verdict is forced to FAIL. If it was
  deferred by anyone else (seen deferred at the next Route step), it is
  carried over as `deferred` and the verdict is left to the other gates.

The run result carries them as `verifyCarryOver: [{ id, kind, reason }]`
(kind `needs-external-evidence`, `deferred-bounce-cap` or `deferred`).

## A CHANGES_NEEDED that names only below-goal reopens

A reviewer CHANGES_NEEDED (per-round Review or Cycle Evaluation's Re-Review)
whose every reopenId the goal-scope guard skipped as below goal, with no
in-goal newTask created, no failing build (`buildFailing` not true) and no
pending NEEDS-DECISION, counts as APPROVED for the exit decision
(`belowGoalOnlyReopenIds` in `fleet-sprint/beads-transitions.mjs`). Without
it the next cycle could only repeat the same verdict until a stall. The
skipped ids are logged, named in the verdict notes as carried over, and
returned as `belowGoalCarryOver`. Anything in-goal keeps blocking the exit.

## Lane order and containers

Lane order (a lane-keyed ordering among sibling beads) holds a bead behind
its lower-order lane-mates. The rule is keyed on the parent edge, not on
`issue_type`: a lane-mate that is itself a container (a bead with children)
never holds a bead back, because a container closes only when its children
do, so waiting on it would deadlock. Lane metadata belongs on leaf tasks
only; when a container carries lane metadata the engine ignores it and logs
that once per run. One shared rule (`lowerOrderLaneMates` and
`containerIdsOf` in `fleet-sprint/beads-scope.mjs`) serves hold-back,
unmet-prerequisite and goal partitioning, so the blocked-report
classification agrees with what the dispatcher does.

## Red build gates Integration Test

While the most recent review reported a failing build, Integration Test is
not dispatched (a red-build skip is recorded as an integration failure), and
a degraded review round does not change that state. A sprint whose
Integration Test was skipped for a red build never publishes PASS: the
verdict is forced FAIL until Integration Test has run again against a green
build.

## Deploy probe fails closed

The probe for `deploy.md` fails closed: when the probe itself fails (as
opposed to reporting the file absent), the deploy-failure gate is not
cleared and the sprint cannot pass on the strength of a deploy that was
never examined. The other callers of the existence probe still receive a
plain boolean. The last deploy failure stays reported for that cycle even
when the deploy was then set aside.

## Permission denials

A refusal advice (grant a permission, rerun) is given only when a refused
call maps to something a grant can allow; a refusal no grant can allow gets
no `compose_permissions` advice, and a mixed refusal keeps the grant
remedy. A doer streak that fails on a permission denial is recorded as
failed, but the beads it did close are still reviewed.

## Known gaps

- Dependents are computed once, when the BLOCKED report arrives. A bead
  created later that depends on a set-aside bead is not set aside; it is
  never ready, but it keeps the immediate stall from firing, so the run falls
  back to the two-cycle stall.
- The abort path passing the set-aside data into the PR body is covered only by
  building the body directly, not by an end-to-end test.
- The "Set aside this run" report lists a decision only while it is pending;
  an answered decision is logged and kept on sprintState.answeredDecisions.
