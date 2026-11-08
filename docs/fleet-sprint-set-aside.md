# fleet-sprint: set-aside and immediate stall

How the sprint engine handles work that cannot proceed, without retrying it
forever or burning cycles on it.

## Rules

1. **A BLOCKED bead is set aside, with its dependents.** When a doer reports
   BLOCKED, the engine records the blocked bead ids and every bead that
   transitively depends on them via open `blocks` edges. Set-aside beads are not
   handed to doers again this run. Other beads in the same streak return to the
   ready pool.
2. **A deploy Permissions failure sets the deploy aside.** Only a deployer
   result whose `failedStep` is `permissions` does this. Later cycles skip the
   deployer, but the last deploy failure is still reported so the deploy
   verdict gate keeps working.
3. **Immediate stall.** If nothing is left that can make progress because of
   set-aside work, the sprint stalls at once, rather than after the usual
   two no-progress cycles. The stall error names every set-aside bead and
   `deploy` (blocker ids and reasons). A parent whose children are all
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
   never holds a pause: a stall on it still throws StalledSprintError, whose
   set-aside reason names it with its full question and says the decision
   bead could not be filed, and `recordDecisionAnswer` refuses it.

   While parked, NO command runs on any sprint member and the members stay
   reserved by the sprint (the CLI skips the usage-limit pause's reservation
   hand-back for this pause source, so no other sprint can take a member);
   the sprint lock is held. Once per interval (60s, or
   `APRA_FLEET_DECISION_POLL_MS`) the wait checks only its in-process answer
   queue, which the dashboard's decision banner and the supervisor's
   `POST /api/sprints/:id/decisions/:decisionId` (both reaching
   `recordDecisionAnswer`) feed: such an answer resumes the run at once,
   exactly once. There is no member-free way to see a
   `bd human respond <decision bead> "<answer>"` made elsewhere (the beads
   clone lives on a sprint member), so that answer is picked up when the run
   is next resumed -- by the operator's dashboard Resume, or by an in-process
   answer; a resume with nothing answered logs one line and parks the run
   again after one interval. Logging is one line per state change, never one
   per poll. The fleet server's 30-minute cloud idle timeout only stops an
   idle cloud member's VM (restarted by its next dispatch); it never aborts
   the wait, and the wait has no total budget. An operator stop during the
   pause ends the run at once.

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
repeating the warning. A configured target that is not connected when a
decision is raised records `failed` with the server's `member not connected`
reason. The sprint carries on in every case. A supervisor-launched
sprint can set it per launch with the `decisionNotify` field of
`POST /api/sprints` (see `packages/apra-fleet-se/docs/supervisor-api.md`).

## Known gaps

- Dependents are computed once, when the BLOCKED report arrives. A bead
  created later that depends on a set-aside bead is not set aside; it is
  never ready, but it keeps the immediate stall from firing, so the run falls
  back to the two-cycle stall.
- The abort path passing the set-aside data into the PR body is covered only by
  building the body directly, not by an end-to-end test.
- A decision answered while the run waits at Cycle Evaluation of its last
  cycle is applied, but the run ends with that cycle; the released bead is
  dispatched by the next run. A wait at the start of a develop round
  dispatches it in the same run.
- The "Set aside this run" report lists a decision only while it is pending;
  an answered decision is logged and kept on sprintState.answeredDecisions.
