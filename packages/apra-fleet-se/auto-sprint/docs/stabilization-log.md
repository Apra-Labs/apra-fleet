# Auto-Sprint Stabilization Log

Running log of issues found while driving the real `apra-fleet-eft` sprint
(member: fleet-rev, branch `auto-sprint/eft-service`, base `feat/fleet-reorg`)
per `docs/README.md`, and the fixes made for each. Newest entries at the
bottom. Each entry: symptom -> root cause -> fix -> evidence.

## Loop iteration 1 (2026-07-19)

### Issue 1: Transport closed kills the whole sprint at start+~304s, every run

- **Symptom**: every CLI sprint run died ~5 minutes in with
  `FleetTransportError: Transport closed`, regardless of which dispatch
  happened to be in flight at that moment (`sprint-logs/auto-sprint-relaunch2.log`,
  `relaunch3`, `relaunch4`).
- **Root cause** (deterministic, confirmed by timestamps): the
  `StreamableHttpTransport` persistent SSE GET stream is normally silent
  (JSON-RPC responses arrive over each POST's own SSE response). Node's
  built-in fetch (undici) enforces a default ~300s idle `bodyTimeout` on
  response bodies, so the single-shot GET stream died at start+~304s
  (fleet server log: stream opened 23:37:40, `Transport closed` 23:42:44).
  `transport.mjs`'s `finally` block then emitted `close`, and
  `McpClient`'s close handler rejected EVERY in-flight request.
- **Fix**: `packages/apra-fleet-client/src/client/transport.mjs` -- the
  persistent GET stream is now a self-reconnecting background loop. An
  idle-death is treated as an expected, recoverable event (quiet reopen with
  capped backoff); `close` only surfaces on deliberate `stop()` or 5
  consecutive reconnect failures. Regression test:
  `packages/apra-fleet-client/test/transport-reconnect.test.mjs` (real local
  SSE server, kills the first stream, asserts a second GET arrives and no
  `close`/`error` fires).

### Issue 2: busy-lock race -- orphaned remote session holds the member lock for minutes

- **Symptom**: after any client-side abandonment of a dispatch (e.g. Issue
  1's transport close), every subsequent dispatch to that member failed with
  `execute_prompt is already running for "fleet-rev"` until the sprint
  aborted. A blind timed backoff (up to ~110s) lost the race every time.
- **Root cause**: the client-side failure does not cancel the REMOTE
  session -- the member's CLI keeps running (fleet server log: the orphaned
  plan-reviewer repair session ran 235s after the client gave up at 4.6s,
  completing with a perfectly good 12,976-token response that was
  discarded) and holds the server's one-dispatch-per-member lock the whole
  time. Busy is transient-but-SLOW: minutes, not seconds.
- **Fix**: `packages/apra-fleet-workflow/src/workflow/index.mjs` -- agent()
  now busy-waits by default: on a `busy` dispatch rejection it polls
  (cheap, side-effect-free re-dispatch) every `busyPollMs` (default 15s) up
  to `busyWaitMs` (default 10 min) before surfacing the busy
  AgentDispatchError. Tests:
  `packages/apra-fleet-workflow/test/apra-fleet-workflow-busy-and-empty.test.mjs`.
  (The runner-level Planner timed-backoff loop from earlier the same day is
  retained as an outer safety net but should rarely trigger now.)

### Issue 3: empty execute_prompt response misreported as "LLM returned invalid JSON" (apra-fleet-eft.14)

- **Symptom**:
  `[Agent API Error] Schema-invalid output ... Unexpected token '\ud83d', "[clipboard-emoji] Respons"... is not valid JSON`
  -- looked like a Unicode/JSON bug. It is not: the emoji is just the first
  char the JSON parser saw.
- **Root cause**: the fleet server returned success (exit 0, no isError)
  whose text was EXACTLY the display wrapper `"[clipboard-emoji] Response from
  fleet-rev:\n\n"` -- 29 chars, empty parsed result, no Tokens/session
  footer (the server-side log line for that dispatch also lacks its usual
  `in=`/`out=` token counts: `exit=0 elapsed=65241ms`). The member CLI
  produced no parseable output; the wrapper-only text then went to schema
  extraction, which correctly found no JSON and misclassified the failure.
  This is bead apra-fleet-eft.14 (first seen on the Planner, now confirmed
  on the plan-reviewer). The underlying server-side parse gap (provider CLI
  exits 0 with nothing parsed) is still open -- tracked in eft.14.
- **Fix (client-side resilience)**:
  `packages/apra-fleet-workflow/src/workflow/index.mjs` -- agent() now
  detects a wrapper-only response (header + optional Tokens/session footer,
  nothing else) and throws a typed
  `AgentDispatchError` with `reason: 'empty_response'` instead of feeding
  it to schema extraction (or returning it as a garbage success for
  no-schema calls). Every runner dispatch site already catches
  AgentDispatchError and degrades the round gracefully. Tests: same new
  test file as Issue 2.

### Issue 4: transport-closed rejections were untyped

- **Symptom**: downstream had to sniff the string 'Transport closed'.
- **Fix**: new `TransportClosedError` (`code: 'TRANSPORT_CLOSED'`) in
  `packages/apra-fleet-client/src/client/errors.mjs`, used by McpClient's
  close handler. Convention documented in that file: new
  execute_prompt/execute_command failure kinds get a typed class there
  (transport/request-level) or an AgentDispatchError `reason` code
  (dispatch-level via structuredContent) -- never a bare Error message to
  sniff.

### Earlier same-day fixes (pre-loop, first crash analysis)

- **FleetTransportError uncaught at schema dispatch sites**: every
  combined-catch site (Reviewer, Plan Reviewer, Streak Assignment,
  Deployer, Integ Test Runner, Final Review x2, Harvester) only handled
  AgentOutputError/AgentDispatchError; a raw transport failure propagated
  and killed the sprint. All sites now also catch FleetTransportError and
  degrade to the same failed-round handling. (runner.js, commit 3daa8fe)
- **finalizeAbort() rev-list against a nonexistent local base ref**: the
  abort path ran `git rev-list --count <base>..<branch>` assuming the raw
  `--base` value resolves locally on the member; exit 128 ("unknown
  revision") made finalizeAbort itself throw and the [ABORTED] PR was never
  raised. Now fetches the base branch and diffs against
  `origin/<baseBranch>`. (runner.js, commit 3daa8fe)
- **Planner dispatch single blind retry**: replaced with a bounded
  retry-with-backoff loop (commits 96eaf25, fbb7619); superseded in
  practice by Issue 2's busy-wait but retained as an outer net.
- **Stale test assertions (4 failures)**: roleMap tests now exclude
  per-member `bd dolt pull/push` sync brackets from the
  orchestrator-routing assertion (verified correct via live dispatch-log
  probe); R12 no-auto-merge check excludes the safe `git merge --ff-only`
  self-sync; run1/run2/multidoer bd recordings re-recorded via
  `npm run test:record`. (commit 827dabe)

### Issue 5: G-pull fetch hard-fails on a brand-new (not-yet-pushed) sprint branch

- **Symptom**: `mock-sprint-ensure-branch-fetch-failure.test.mjs` failing
  with `[Sync] G-pull fetch failed ... couldn't find remote ref
  auto-sprint/mock-branchnotexist` (110s of transient retries first).
- **Root cause**: syncMemberBefore() treated EVERY fetch failure as an
  error, but a sprint branch just created locally from base (first G-push
  hasn't happened) legitimately does not exist on the remote yet -- there
  is nothing to pull, which is a no-op, not a failure. Any real first-cycle
  sprint on a fresh branch would have died on its first sync bracket.
- **Fix**: runner.js syncMemberBefore() -- the exact `couldn't find remote
  ref` git message (and only that message, mirroring Ensure Sprint Branch's
  own fetch-fallback rationale) now skips the pull half of the bracket with
  a log line instead of throwing.

### Issue 6: injected git-push failure now surfaces as GitSyncError, not CommandError

- **Symptom**: `mock-sprint-finalization-git-push-failure.test.mjs`
  asserting `CommandError` failed with `GitSyncError`.
- **Root cause**: not a bug -- an architecture shift. Before the sync
  brackets, the first `git push` a sprint issued was the finalization
  publish (plain command() -> CommandError). The brackets now G-push after
  every code-writing dispatch, so an injected `/^git push/` failure is hit
  first by a bracket push, surfacing as its typed GitSyncError.
- **Fix**: test updated to accept either typed error (both are
  never-swallowed surfaces of the same failure), with the
  underlying-git-text assertion retained so a silent swallow still fails.

### Issue 7: recording/snapshot drift from the sync-bracket work

- `apra-fleet-mock-sprint-abortprfail.jsonl` was a crashed mid-scenario
  capture (exitCode null entry) -> re-recorded via
  `node scripts/run-tests.mjs record test/mock-sprint-abort-pr.test.mjs`.
- Both golden transcripts regenerated (UPDATE_GOLDEN=1) after verifying
  the diff is exactly the expected shape: sync-bracket commands (git
  fetch / merge --ff-only / bd dolt pull before each dispatch, bd dolt
  push after) interleaving an otherwise-identical dispatch sequence.

**Iteration 1 result**: full apra-fleet-se suite 500/500 green (was 10
failing). apra-fleet-client 21/21 + new reconnect test. apra-fleet-workflow
core suites green + 8 new busy/empty tests; 2 pre-existing eft-WIP
conditions confirmed NOT caused by this work (debounced-writer 3 failures,
sprint-state file-level exit hang -- both reproduce with all stabilization
changes stashed; they belong to the in-flight eft.2.1 feature work).

## Loop iteration 2 (2026-07-19)

### Issue 8: POST-stream idle timeout kills every >300s-silent dispatch ("terminated")

- **Symptom** (run 5, `sprint-logs/auto-sprint-relaunch5.log`): long
  dispatches failed with `[Agent API Error] terminated`, then the retry hit
  `busy`, busy-waited out the orphan, re-dispatched -- and the redo ALSO
  died with `terminated`. The sprint survived (Issues 1-3 fixes all held)
  but ground in a terminated -> retry -> busy-wait -> duplicate-dispatch
  loop, doing each long planner run twice and discarding the results.
- **Root cause**: the Issue 1 fix covered the persistent GET stream, but
  each POST's own SSE response stream has the same undici ~300s idle
  bodyTimeout. `claude -p` prints nothing until the turn completes, so any
  dispatch quieter than 300s+ loses its response stream mid-flight
  ("terminated" is undici's body-timeout error message). Server log
  evidence: planner R2 pid 15590 ran 675s (00:44:40 -> 00:55:55, exit=0
  out=16285) -- client stream killed at ~00:49:40, full result discarded,
  duplicate planner pid 18865 dispatched 00:55:55 by the busy-waiting
  retry, which then also exceeded 300s and got terminated in turn.
- **Fix**: `packages/apra-fleet-client` now depends on `undici` explicitly
  and `transport.mjs` routes ALL StreamableHttpTransport fetches (init
  POST, persistent GET, send POST) through undici's fetch with a shared
  `Agent({ headersTimeout: 0, bodyTimeout: 0 })` dispatcher. No unbounded
  hangs result: McpClient's per-request timeout still bounds every
  JSON-RPC call, and the GET stream keeps its reconnect loop. Guard test:
  `packages/apra-fleet-client/test/transport-idle-timeout-guard.test.mjs`
  (asserts the wiring at source level -- a behavioral test would need a
  >300s silent stream; the existing reconnect test exercises the undici
  fetch path against a real server).
- **Decision note**: server-side SSE keepalives on POST responses would fix
  this for ALL clients and remain a good hardening follow-up, but need a
  fleet-server rebuild+redeploy; the client-side dispatcher fix is
  deterministic and deploy-free, so it ships first.

### Server-side eft.14 classification (committed, deploy deferred)

- `src/tools/execute-prompt.ts` now classifies an exit-0-with-empty-result
  dispatch as a typed failure (`structuredContent: { isError: true,
  reason: 'empty_response' }` + stderr tail in the text) instead of
  returning a bare display wrapper as success. Tests added in
  `tests/execute-prompt.test.ts`; full root vitest suite green (2318
  passed). Deployment needs a fleet-server rebuild+reinstall+restart, which
  kills live member sessions -- deferred to a natural stop; the workflow
  layer's Issue 3 detection handles it in the meantime.

## Loop iteration 3 (2026-07-19)

Run 6 (the first on the Issue 8 transport fix) got dramatically further
than any prior run: Plan C1 approved in round 1 (the previously
empty-response-prone plan-reviewer completed normally), the full Develop
C1 R1 phase ran multi-minute doer streaks back-to-back with ZERO transport
failures (beads closed: eft.6.4, 9.1, 4.6, more; one streak correctly
degraded on a VERIFY/still-open mismatch), and the sprint reached Review
C1 R1 -- where it found the next two systemic issues:

### Issue 9: reviewer budgets undersized for a full-cycle review + infra failures tripped the contract-violation guard

- **Symptom** (run 6): the reviewer ran out of turns (num_turns=51 after
  ~12 min of legitimate review work, typed max_turns_exhausted); the retry
  then hit the 930s client-side request timeout. BOTH synthesized
  CHANGES_NEEDED fallback verdicts had empty reopenIds/newTasks, so
  isReviewerContractViolation() -- designed to catch a GENUINE
  self-contradictory LLM verdict -- counted two "contract violations" and
  aborted the sprint with ReviewerContractViolationError.
- **Root cause**: two distinct gaps. (a) The reviewer dispatch had no
  explicit max_turns and no resume path, so a big-cycle review
  deterministically dies at the fleet default and a fresh retry re-dies
  the same way. (b) dispatchReview() synthesized infrastructure-failure
  verdicts in the same shape as LLM verdicts, so the contract-violation
  guard could not tell them apart.
- **Fix** (runner.js dispatchReview): explicit
  `max_turns: BASE_REVIEWER_MAX_TURNS (60)`; on max_turns_exhausted the
  SAME session is resumed once with a doubled budget (mirrors
  dispatchDoerResume -- the session already holds the review context).
  Synthesized failure verdicts now carry `dispatchFailed: true` and are
  returned as a DEGRADED round (counting toward the bounded stall budget
  like every other role) after one infrastructure retry -- they can no
  longer throw ReviewerContractViolationError, which is reserved for
  genuine schema-valid self-contradicting LLM verdicts. Structural test
  baselines bumped (11 agent sites / 10 withGitSync brackets), reviewer
  scenario recordings re-recorded; se suite 602/602.

### Issue 10: agent() silently dropped max_total_s from the dispatch payload

- **Symptom** (run 6): the reviewer retry timed out client-side at exactly
  930000ms despite the runner passing `max_total_s: 3600` (which
  deriveTimeoutMs prefers -- it should have produced a 3630s request
  timeout).
- **Root cause**: the payload object built inside
  `packages/apra-fleet-workflow/src/workflow/index.mjs` agent() forwarded
  timeout_s/max_turns/etc. but NOT max_total_s, so (a) the server never
  received the hard wall-clock ceiling for ANY workflow dispatch, and (b)
  the derived client timeout always fell back to timeout_s+30s = 930s,
  killing any legitimately-slow dispatch at ~15.5 min while the remote
  session kept running (orphan + busy lock).
- **Fix**: `max_total_s: opts.max_total_s` added to the payload, with
  JSDoc documenting both server- and client-side effects.

### Issue 11: dirty member working tree kills the next sprint at Setup

- **Symptom** (run 7): `Ensure Sprint Branch` died immediately with
  `error: Your local changes to the following files would be overwritten
  by checkout` -- fleet-rev had an uncommitted runner.js modification left
  by an interrupted dispatch from run 5/6.
- **Root cause**: any infrastructure-killed dispatch (transport drop,
  timeout, stop_prompt) predictably leaves the member's tree dirty with
  whatever the agent had in flight; `git checkout -B` refuses to proceed.
  A stabilized sprint loop guarantees such orphans will keep happening, so
  Setup must expect them.
- **Fix** (runner.js Ensure Sprint Branch): the checkout is now failSoft;
  on the specific "would be overwritten" failure the orphaned WIP is
  preserved in a named stash (`git stash push -u -m "auto-sprint[branch]
  auto-stash of orphaned WIP..."`) and the checkout retried once. Any
  other checkout failure still aborts loudly. Happy path (clean tree)
  issues no extra commands. The run-7 orphan itself (a one-line eft.8.x
  error-shape WIP) was inspected and hand-stashed on fleet-rev with a
  descriptive message; its bead is still open so a future streak redoes
  it properly. Command-count baseline 26 -> 28.

### Feature bug found by the loop, routed to the sprint backlog

- The run-6 doer's new supervisor-lifecycle test (eft.4.6, written and
  verified on macOS fleet-rev) fails on Windows: live-child re-adoption
  recovers the port from the process command line via a ps reader that
  returns nothing usable on Windows. Filed as a P1 bug bead under
  apra-fleet-eft.4 (2026-07-19) so the sprint's own doers fix it --
  stabilization-loop scope stays on the sprint machinery, not the eft
  feature. se suite otherwise green (667 pass / 2 fail, both this bug).

## Loop iteration 4 (2026-07-19)

Run 8 was the best run yet: TWO full cycles of plan -> develop -> review,
with the plan approved first-round both times, every reviewer round up to
C2 returning a genuine actionable verdict (real catches: a red test suite
from a doer regression, uncommitted freshest work, a stale guard-test
baseline), the doer resume path recovering every turn-limit exhaustion,
and Cycle 1 evaluation rolling into Cycle 2 cleanly. It died in Review C2
R1 on two NEW issue types:

### Issue 12: server inactivity timeout (900s) makes max_total_s unreachable for silent CLIs

- **Symptom** (run 8): the C2 reviewer was killed with "Command timed out
  after 900000ms of inactivity" despite max_total_s: 3600.
- **Root cause**: `claude -p` prints nothing until the turn completes, so
  server-side INACTIVITY == total runtime for every agent dispatch; the
  900s inactivity timer always fires before the 3600s wall-clock ceiling
  can matter. Earlier reviews survived only by finishing under 15 min.
- **Fix**: every agent dispatch site in runner.js now sets
  `timeout_s: 3600` equal to its `max_total_s: 3600` -- the hard ceiling
  is the real limit; inactivity adds nothing for a silent-until-done CLI.
  (Also: BASE_DOER_MAX_TURNS 50 -> 100, since in run 8 EVERY streak --
  even single-bead ones -- exhausted 50 turns and paid a resume
  round-trip; resumes now escalate 200 -> 400. Assertion ladder updated in
  mock-sprint-doer-max-turns.test.mjs.)

### Issue 13: sporadic client 'fetch failed' + sync-bracket failures are sprint-fatal at the review site

- **Symptom** (run 8): sporadic `[Command API Error] fetch failed`
  throughout the run (dashboard badge computation, a doer bracket, and
  finally the review-retry G-pull). The last one surfaced as GitSyncError
  from dispatchReview's sync bracket -- which the reviewer catch did not
  handle -- and killed the sprint. The fleet server was healthy the whole
  time.
- **Root cause**: three stacked gaps. (a) The pooled undici dispatcher
  (Issue 8 fix) can reuse a socket the server just decided to close
  (Node http default keepAliveTimeout 5000ms) -- the request then fails at
  the socket level as 'fetch failed'. (b) classifyGitFailure() rated
  "Transport failure while executing command: fetch failed" as 'unknown'
  (never retried) instead of transient. (c) dispatchReview degraded
  dispatch/transport errors but not sync-bracket GitSyncError/
  DoltSyncError.
- **Fix**: (a) transport.mjs -- dispatcher keepAliveTimeout: 4000 (below
  the server's 5000ms) plus a bounded connection-level retry in send()
  (2 retries, 500ms/2s; only for rejections where no response was
  received, so a re-send cannot double-execute). (b) the transport-failure
  strings added to GIT_TRANSIENT_PATTERNS so runGitStep retries them.
  (c) dispatchReview's catch now also degrades GitSyncError/DoltSyncError
  (dispatchFailed round); GitDivergedError/DoltDivergedError still
  propagate -- real divergence is an integrity problem, not a blip.

Rebased over 10 doer commits from run 8 (including the doer's own
eft.9.7 claim-loop restructure of dispatchDoer -- conflict resolved
keeping the doer's structure with the new timeouts applied). se suite
759 pass / 2 fail (both the beaded Windows lifecycle bug); client 22/22.

## Loop iteration 5 (2026-07-19)

Run 9 aborted at planning (SprintPlanRejectedError, 3 rounds): R1-R2
flagged all-children-closed features as undecomposed (the planner resolved
this itself by R3 -- no runner change needed), and R3's sole blocker was
an operator-injected bug bead (eft.4.7) missing the `model` metadata the
plan contract requires. Operator lesson recorded (bead injections must
carry model metadata and be created member-side + dolt-pushed; the
orchestrator's local clone is stale/conflicted outside sprint brackets).
Run 10 relaunched after fixing the metadata; its plan R1 caught the run-9
planner's duplicate re-creations of closed eft.13 work and R2 approved a
deduplicated DAG -- the plan gate working as designed.

### Final Review hardening (turn budget, resume, feedback-to-beads)

- **Gap 1**: dispatchFinalReview had no explicit max_turns and no resume
  path -- an epic-wide review would deterministically die at the fleet
  default (50 turns) twice (the retry restarts from scratch) and flip the
  sprint to a FAIL whose notes carry only the error text.
- **Gap 2**: the finalVerdict schema was {verdict, notes} only; a FAIL's
  actionable findings reached the PR body and analysis doc but NEVER
  beads -- invisible to the next sprint's planner, which reads only
  beads.
- **Fix** (runner.js + contracts.mjs): FINAL_REVIEW_MAX_TURNS = 60 with
  one same-session resume at 120 turns (mirrors doer/reviewer);
  finalVerdict gains optional newTasks (same item shape as
  reviewerVerdict), the prompt instructs findings-as-newTasks on FAIL,
  and the orchestrator applies them via the same validateNewTask
  allowlist + child-id allocator + D-push path as per-round reviewer
  newTasks. Structural baselines 12 agent sites / 11 brackets; goldens
  regenerated (diff = the Final Review prompt/schema line only); se
  suite 759 pass / 2 fail (the beaded Windows lifecycle bug).

### Issue 15: streak-assignment candidates with shortened bead ids silently lose the whole grouping

- **Symptom** (run 8, Develop C2 R1; operator-reported): the streak
  assignment LLM returned suffix-stripped ids
  (`{"streaks":[["8.4","8.6"],["9.3","9.7"],...]}` for
  apra-fleet-eft.8.4 etc.). selectStreaks() correctly rejected the
  candidate (`unknown/non-ready bead id '8.4'`) and fell back to
  one-bead-per-streak -- safe, but the model's sequencing intent
  (8.4+8.6 same-doer, 9.3+9.7 same-doer) was silently discarded. On a
  multi-doer fleet that fallback would PARALLELIZE beads the model said
  must run sequentially.
- **Design stance (per operator)**: bead ids from different scopes need
  not share any prefix, so suffix-matching/prefix-inference repair is
  forbidden -- a shortened id is genuinely ambiguous and must stay
  rejected. The fix is to stop the model shortening ids and to recover
  via RE-ASK, never via guessing.
- **Fix** (runner.js): (a) buildStreakAssignmentPrompt now demands
  verbatim ids (full prefix, character for character, explicit warning
  that shortened ids are rejected); (b) one bounded semantic-repair
  re-ask -- when a schema-VALID candidate fails selectStreaks(), the
  agent is re-asked once with the exact rejection reason before the
  one-bead-per-streak fallback engages. Structural baselines: 13 agent
  sites; the repair re-ask is the second documented no-bracket exemption
  (same pure-compute grouping task as the first).

### Issue 14: pending-closure features misread as "undecomposed" burn entire plan phases

- **Symptom**: run 9 (cycle 1) and run 10 (cycle 2) each exhausted all 3
  planning rounds -- SprintPlanRejectedError -- because plan-reviewer
  dispatches flagged features whose children are ALL CLOSED (eft.1/3/4/5/
  7/8 by run 10) as "undecomposed, zero child tasks, no model metadata"
  and demanded re-decomposition. The planner cannot sensibly satisfy that
  without recreating closed work -- run 9's planner did exactly that, and
  the NEXT review round correctly rejected the duplicates (thrash both
  ways).
- **Root cause**: verdict inconsistency across reviewer dispatches on the
  same DAG state. The reviewer's child queries default to OPEN issues, so
  an all-children-closed feature looks childless; some dispatches
  correctly read it as "eligible for closure, non-blocking" (run 8 C2),
  others fail hard criteria on it. Feature closure belongs to the
  integ-test phase, so mid-sprint this state is NORMAL and long-lived.
- **Fix** (runner.js): pin the interpretation in both prompts.
  buildPlanReviewerPrompt now instructs: check closed children (bd list
  --all) before flagging a feature undecomposed; all-children-closed =
  pending feature-closure = non-blocking note only, never a criteria
  failure, never a re-decomposition demand. buildPlannerPrompt's
  re-planning preamble gets the symmetric guard: leave such features
  alone even if review feedback appears to demand decomposition.

### Issue 16: closed beads invisible in the viewer sprint tree

- **Symptom** (operator-reported): the sprint viewer showed only open
  items under the sprint tree, making progress impossible to judge -- by
  run 11 most eft work was CLOSED, so the tree looked nearly empty.
- **Root cause**: updateDashboard fetched beads via bdListScoped('--json').
  Any non-empty argument string routes to a second plain `bd list`
  invocation, which defaults to open/in_progress only. The no-args path
  bdListScoped('') reuses the shared `bd list --all --limit 0 --json`
  fetch, which includes closed beads.
- **Fix** (runner.js): updateDashboard now calls bdListScoped('') so the
  dashboard payload carries the full DAG including closed items. Golden
  transcripts regenerated (the dashboard section of every golden changed).

### Issue 17: reviewer pins CHANGES_NEEDED by reopening deferred P3 features

- **Symptom**: run 11 cycles 2-3 -- reviews returned CHANGES_NEEDED with
  reopenIds ['apra-fleet-eft.10','apra-fleet-eft.11' (,'.12')] round
  after round. Those are P3 features, deferred by design under the sprint
  goal constraint (P1/P2). The completion gate needs zero open
  goal-priority beads AND a final APPROVED verdict, so a reviewer that
  keeps reopening below-goal beads pins the verdict and starves the gate.
- **Root cause**: buildReviewerPrompt never told the reviewer what the
  sprint goal was. The reviewer read the epic's full child list, found P3
  features with no commits, and (correctly, from its blind viewpoint)
  demanded the missing work.
- **Fix** (runner.js), two layers:
  (a) buildReviewerPrompt now takes the goal and carries a SPRINT SCOPE
  instruction: features/beads below the goal priority are deferred by
  design, must not fail the verdict, must not appear in reopenIds.
  (b) Deterministic guard at the reopen loop: when reopenIds is
  non-empty, fetch the scoped DAG once (bdListScoped('')) and SKIP any
  id whose bead priority is numerically below the goal (priority >
  goalMax), logging the skip. The lookup is conditional on reopenIds
  being non-empty so the common empty path issues no extra bd call.
- **Test fallout lesson**: the first (unconditional) lookup shape caused
  35 bd-replay drift failures; the conditional shape confined drift to
  the 14 scenario files that genuinely exercise reopenIds. Those were
  re-recorded (SUMMARY pass=37 fail=0) and the golden bd recordings +
  transcripts re-recorded/regenerated; full suite green (789/789).

### Issue 18: Deploy fails every cycle on a permission self-check; Integ Test never runs, so features can never close

- **Symptom**: run 11 C1-C3 -- "Deploy FAILED this cycle: Stopped at
  Step 0 (permission check)... Skipping Integration Test phase." Every
  cycle evaluation then reports the same ~11 open P2+ beads. Those 11
  are the pending-closure FEATURE nodes themselves (all children
  closed): the integ-test-runner is the only role that closes verified
  features, so with Deploy failing its pre-flight, the completion gate
  (zero open goal beads + APPROVED) is mathematically unreachable and
  every run rides to maxCycles.
- **Root cause**: deploy.md's Permissions section requires Bash(gh run *),
  Bash(gh release *), Bash(mkdir *), Bash(*apra-fleet-installer-*
  install *), Bash(*apra-fleet-installer-* --version) in the member's
  permissions.allow. fleet-rev's .claude/settings.json had no
  permissions key at all, and settings.local.json (composed at
  onboarding, BEFORE deploy.md existed -- the playbook is sprint-authored
  content) covered only Bash(gh:*). Nothing re-composes member
  permissions when the sprint's own doers author a playbook that carries
  new permission requirements.
- **Fix** (member-side, live, no sprint restart): added the five
  deploy.md prefixes (plus a colon-syntax mkdir variant) to BOTH
  .claude/settings.json and .claude/settings.local.json in fleet-rev's
  sprint workspace. Both files are gitignored, so the member's working
  tree stays clean. Applied while run 11 was in Review C4 R1, before
  Deploy C4 fired.
- **Durability caveat (watched)**: if fleet-rev's permissions are ever
  re-composed (compose_permissions / re-onboarding), these entries are
  lost. The structural fix belongs in the permission profile for the
  deployer/integ-test roles, or a pre-Deploy permission-ensure step in
  the runner; deferred until Integ Test is observed actually running.

### Run 11 outcome: StalledSprintError, reopen-thrash on the deferred P3 trio

- Run 11 ended at Deploy C4 with StalledSprintError: closed-count history
  [57, 62, 62, 62], reopen-thrash detected on apra-fleet-eft.10/.11/.12
  (each reopened more than 3 times). This is exactly the Issue 17
  oscillation -- the stall detector (correctly) refused to burn cycle 5
  on it. It also means Deploy C4 never ran, so the Issue 18 permission
  fix gets its first live test in run 12. finalizeAbort worked as
  designed (idempotent [ABORTED] PR, terminal history record). Run 11's
  content record: 4 cycles, zero infrastructure failures, closed beads
  57->62, every P1/P2 feature at all-children-closed pending closure.

### Issue 19: deploy.md is non-idempotent and hardcodes the Windows artifact

- **Symptom**: run 12 Deploy C1 -- with Issue 18's permissions in place the
  deployer executed deploy.md for the first time ever, and failed mid-run:
  `gh run download ... error extracting "apra-fleet-installer-win-x64.exe":
  file exists` (/tmp/fleet-deploy already held the artifact from the same
  deploy session's earlier attempt).
- **Root cause**, two content defects in the sprint-authored playbook:
  (a) NON-IDEMPOTENT: `mkdir -p /tmp/fleet-deploy` then download -- any
  re-run (or step retry) collides with the previous download, and gh run
  download has no overwrite flag. (b) WRONG PLATFORM: the Deploy and smoke
  test sections hardcode apra-fleet-installer-win-x64.exe and
  apra-fleet.exe -- authored from the orchestrator's Windows viewpoint,
  but the runbook executes ON THE MEMBER (fleet-rev is macOS ARM). Even a
  clean download would have died at the install step. The playbook's own
  Platform binaries table already listed the right artifact names.
- **Fix** (deploy.md, committed to the sprint branch): Deploy section now
  selects the artifact by `uname -s` (Darwin/Linux/fallback-Windows),
  does `rm -rf /tmp/fleet-deploy` before mkdir, and `chmod +x` before
  install; smoke test tries both binary names; manual/rollback sections
  parameterized on the platform table. Permissions section gains
  `Bash(rm -rf /tmp/fleet-deploy*)`, `Bash(chmod +x /tmp/fleet-deploy*)`,
  and widens the version check to `Bash(*apra-fleet* --version)` (the old
  prefix only covered the installer, not the installed binary the smoke
  test runs). Same prefixes added live to fleet-rev's settings files, and
  the stale /tmp/fleet-deploy was removed on the member.

### Observed while dispatching the 0ei hotfix (separate track): stale busy lock

- fleet-dev's execute_prompt lock returned {"isError":true,"reason":
  "busy"} for ~20 minutes while the member session was idle with no live
  process (token counts frozen); stop_prompt reported "no active session
  was running" and cleared it. A dispatch-layer lock leak on the fleet
  server (v0.3.5_8a1ef3) -- likely left by an earlier abandoned/killed
  dispatch. Watch for recurrence; if it repeats, file a server bead (lock
  release on child-process reap, or a TTL/liveness check on
  inFlightAgents).

### Still open / watched

- **apra-fleet-eft.14 (server)**: why does the provider CLI sometimes exit
  0 with no parseable result/usage/sessionId? Client-side typed handling
  is in place (Issue 3); the server-side parse gap needs its own
  investigation.
- **apra-fleet-eft.15 (perf)**: repeated near-identical project-wide
  `bd list` dumps within a phase (clearly visible in the fleet server log,
  ~1.5-2s each); P2, not sprint-fatal.
- **POST-stream idle timeout risk**: OBSERVED in run 5 and fixed as Issue
  8 (iteration 2). Server-side SSE keepalives remain an optional hardening
  follow-up.
- **apra-fleet-qv1**: parallel doer streaks to a single member are unsafe
  (pre-existing bead, visible in the server log's bead dumps); single-member
  sprints serialize doers so not currently hit.
