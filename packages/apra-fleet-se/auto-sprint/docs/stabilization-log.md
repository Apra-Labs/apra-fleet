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

### Still open / watched

- **apra-fleet-eft.14 (server)**: why does the provider CLI sometimes exit
  0 with no parseable result/usage/sessionId? Client-side typed handling
  is in place (Issue 3); the server-side parse gap needs its own
  investigation.
- **apra-fleet-eft.15 (perf)**: repeated near-identical project-wide
  `bd list` dumps within a phase (clearly visible in the fleet server log,
  ~1.5-2s each); P2, not sprint-fatal.
- **POST-stream idle timeout risk**: a >300s-silent execute_prompt POST
  response stream would hit the same undici bodyTimeout as Issue 1. Not yet
  observed (dispatch responses arrive as single final SSE events; observed
  long dispatches were 204s/235s). If it appears, fix with server-side SSE
  keepalives on POST responses (src/, needs fleet server rebuild+reinstall)
  or an explicit undici dependency with bodyTimeout: 0.
- **apra-fleet-qv1**: parallel doer streaks to a single member are unsafe
  (pre-existing bead, visible in the server log's bead dumps); single-member
  sprints serialize doers so not currently hit.
