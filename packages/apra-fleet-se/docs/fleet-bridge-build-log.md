# fleet-bridge build log

Running record of the fleet-bridge implementation. One row per checkpoint, newest
last. Plan of record: `fleet-bridge-implementation-plan.md` in this directory.

**Build scope:** local development and unit tests against injected fakes only. No
credentials, no real Azure DevOps, no real storage account, no push. The integration
pass is deferred until credentials exist.

**Terminology note (added later):** entries below were written while the credential
placeholder still used the legacy prefix. After the repo standardized on
`{{secret.NAME}}` (the legacy form still resolves, for backward compatibility), the
spelling in this log was updated so it teaches the current form. Only the spelling
changed -- the accounts of what happened, and when, are unaltered.

**Branch:** `worktree-fleet-bridge-plan` (worktree at
`.claude/worktrees/fleet-bridge-plan`). Commits are local; nothing is pushed.

---

## Progress by work unit

Status: `todo` / `wip` / `review` / `done`.

| # | Work unit | Plan ref | Model | Status | Commit |
|---|---|---|---|---|---|
| 0 | Design doc + implementation plan | Parts A-D | - | done | 35549738..ead14817 |
| 0a | Relocate bridge docs into apra-fleet-se/docs | - | - | done | a306e44f |
| 1 | A1 publishState plan channel in plan.mjs + runner.js wiring | A1 | sonnet | done | CP2 |
| 2 | A2 proxy helper exports + extraHeaders | A2 | sonnet | done | CP2 |
| 3 | A1/A2 tests (plan-state-publication.test.mjs) | A tests | sonnet | done | CP2 |
| 4 | A3-A5 workspace wiring + package skeleton | A3-A5 | sonnet | done | CP2 |
| 5 | contracts.mjs, errors.mjs, cli/args.mjs | B step 2 | haiku | done | CP2 |
| 6 | supervisor-client.mjs (bearer-aware) | B step 3 | sonnet | done | CP3 |
| 7 | beads-client.mjs (sync/async split, assertNoBareSync) | B step 4 | sonnet | done | CP3 |
| 8 | adapters registry + native-beads-sync + azure-devops | B step 5 | sonnet | done | CP5 |
| 9 | verb: preflight | B step 6 | sonnet | done | CP6 |
| 10 | verb: ingest | B step 7 | sonnet | done | CP6 |
| 11 | spool.mjs (launch verb still todo) | B step 8 | sonnet | done | CP5 |
| 13a | verb: watch (+ cooperative abort) | B step 10 | sonnet | done | CP7 |
| 14a | verb: finalize | B step 11 | sonnet | done | CP7 |
| 14b | adapters/facade.mjs (unifies adapter.comment) | - | sonnet | done | CP7 |
| 12 | await-gate.mjs | B step 9 | sonnet | done | CP5 |
| 12a | templates/*.yml + examples/azure-devops-toy + README | B step 9 | haiku | done | CP6 |
| 13 | snapshot, throttle, sinks/index, sinks/jsonl-file (watch in CP7) | B step 10 | sonnet | done | CP6 |
| 14 | carry-over.mjs (finalize in CP7) | B step 11 | sonnet | done | CP6 |
| 15 | verb: daemon (+ bounded shutdown) | B step 12 | sonnet | done | CP7 |
| 16 | sinks/append-blob + append-blob-http + record.mjs | B step 13 | sonnet | done | CP7 |
| 17 | viewer-proxy.mjs + verb: viewer | B step 14 | sonnet | done | CP8 |
| 18 | D1 archive SPA (spa/archive.mjs) | Part D1 | sonnet | done | CP8 |
| 19 | D2 live SPA (dataProvider seam) | Part D2 | sonnet | done | CP9 |
| 20 | log-safe.mjs redactor (sweep 2 gap) | Part C | sonnet | done | CP8 |
| 21 | verb: launch (the core - missed entirely in phase 1) | B step 8 | sonnet | done | CP10 |
| 22 | verb: status | B step 6 | sonnet | done | CP10 |
| 23 | rest-client.mjs (member-dispatched REST) | Part C | sonnet | done | CP10 |
| 24 | bin/runtime.mjs (readTokenFile, git, isAlive, clock) | phase 2 | sonnet | done | CP10 |
| 25 | remove --viewer-token | phase 2 | haiku | done | CP10 |
| 26 | bin/fleet-bridge.mjs composition root + smoke test | phase 2 | sonnet | done | CP11 |

---

## Phase 2 - making it runnable

Phase 1 reported "all units done" and that was **wrong**. Three gaps, found only when
the filesystem was checked against the claim rather than the tracker:

- **`launch` and `status` verbs were never written.** `launch` is the verb that starts
  a sprint - the core of the bridge. `src/cli/args.mjs` advertised both; neither had a
  file.
- **`bin/fleet-bridge.mjs` dispatched zero verbs** and constructed zero dependencies.
- **`restClient` had no implementation** - only test fakes - so `adapter.comment` could
  never post.

The cause is worth keeping, because it is a property of how this was built rather than
an oversight by anyone: **the injected-I/O rule made 856 tests possible with no
credentials and no cloud, and the one thing every unit deferred - constructing reality
- was the same thing for all of them, so it belonged to no unit.** There was no row on
the tracker for "wire it together", and passing tests cannot detect code nobody calls.

The durable fix is not the missing files. It is `test/composition-root.test.mjs`,
which drives its assertions from `VERBS` and each verb's own `validate*Deps`, so adding
a verb without wiring it turns the suite red.

---

## Checkpoints

### CP0 - design and plan committed

- `35549738` fleet-bridge design doc
- `1f89854c` LAN-binding risk accepted pending #493; supervisor rationale corrected
- `8212dcc8` #493 pinned as fix/m0-s1-loopback-bearer; bearer forward-compat required
- `4079b9ac` observability reworked: plan gate, LAN viewer proxy, remote sinks
- `7d80736e` viewer is a control surface; append-blob streaming limits verified
- `ead14817` approved implementation plan

### CP1 - docs relocated, Wave 1 in flight

Bridge docs moved from the repo-root `docs/` into `packages/apra-fleet-se/docs/`,
alongside `supervisor-api.md`, `supervisor-setup-guide.md`,
`azure-devops-user-guide.md` and `fleet-sprint-cli-contract.md` - the same class of
document. Moved with `git mv` so history survives; the plan's self-reference and the
bridge README's pointers were updated to match.

Wave 1 (in flight, not in this commit): Part A engine changes and their tests, plus
the package skeleton and monorepo wiring. Committed separately once reviewed.

### CP2 - Wave 1 reviewed and committed

Part A (engine), the package skeleton, and the contracts/errors/args foundation.

- `packages/apra-fleet-se/test/plan-state-publication.test.mjs`: **6/6 pass** -
  clean APPROVED, plan-cap deferral, hard rejection, missing-publishState safety,
  the lean round-trip, and the proxy export guard.
- `packages/apra-fleet-bridge`: **125/125 pass**, workspace linked, `npm install`
  clean, suite wired into root `npm test`.

**Review: CHANGES_NEEDED, then fixed and re-verified.** The reviewer passed 17 of 18
checks and caught one real defect worth recording, because the shape of it will
recur:

`exitCodeFor` silently collapsed 7 of the 22 error codes into the generic exit code
1 - `WATCH_LOST`, `SUPERVISOR_UNAVAILABLE`, `SUPERVISOR_UNAUTHORIZED`,
`BEADS_FAILED`, `BEADS_BARE_SYNC_REFUSED`, `ADAPTER_UNKNOWN`, `ADAPTER_INVALID`. The
telling part was that the tests asserted every *other* group's mapping and simply
never mentioned these seven: the coverage routed around the gap instead of pinning
it. Since the pipeline templates branch on exit code to tell failure classes apart,
"the supervisor is unreachable" and "something threw" would have been
indistinguishable.

Fixed with explicit buckets - 2 config/usage, 3 preflight, 4 ingest, 5 launch,
6 finalize/carry-over, 7 launch conflict, 8 infrastructure, 9 internal defect, and 1
reserved solely for an unrecognised code or a plain `Error`. The durable part is not
the switch but a **completeness test** iterating every value in
`BRIDGE_ERROR_CODES` and asserting none maps to 1, so the gap cannot silently
reopen.

Also taken from the review (non-blocking, fixed anyway): `assertNoSecrets` was an
exact-match key blocklist, so `accessToken`, `clientSecret` and `sasUrl` passed
straight through. Now substring-matched - except `pat`, which stays exact-match
because a substring rule would reject `path`, `patch` and `compatible`. That
asymmetry carries a comment and a regression test so it is not "fixed" later.

**Pre-existing failures, triaged - not regressions.** A doer attributed four
`apra-fleet-se` failures to Part A. Two were verified false:
`phase0-seams-facade.test.mjs` and `phase1-leaf-facade-completeness.test.mjs` fail
with `EPERM: operation not permitted, symlink` when building their temp sandbox, and
**the identical failure reproduces on the unmodified main checkout** at
`C:\ak\apra-fleet`. It is a Windows symlink-privilege issue (needs elevation or
Developer Mode), unrelated to this work. The three `plan-state-publication` subtests
it saw failing were a mid-implementation snapshot and now pass. Still to confirm:
`serve-wiring-integration.test.mjs` (2 subtests, ~90 s each, suspected boot-timeout
flake).

Lesson recorded for later waves: **verify a doer's failure attribution before acting
on it.** Baselining against the unmodified checkout takes one command and prevented
a false regression hunt here.

Root `npm test` also shows two unrelated vitest failures:
`tests/regression-command-surface.test.ts` (needs `npm run build` first - `dist/`
absent) and `tests/strategy-process-tree-kill.test.ts` (timing-sensitive).

### CP3 - supervisor-client and beads-client, both reviewed

`packages/apra-fleet-bridge` now at **200 tests, 0 fail** (beads-client 36,
supervisor-client 39, contracts 64, cli-args 33, errors 19, smoke 9).

**supervisor-client: APPROVED**, then hardened on four non-blocking findings.
- The reviewer specifically cleared the retry-body bug: the request body is a plain
  object re-stringified per attempt, so the classic "consumed stream retries empty"
  trap does not apply.
- **Dropped the relaunch-gate message regex.** Discrimination required
  `field === 'issue'` AND `/deterministic/i` against the server's prose. Verified in
  `api.mjs` that `POST /api/sprints` has exactly two 409 sources - the member-overlap
  guard (`field: 'members'`) and the relaunch gate (`field: 'issue'`) - so the field
  alone is unambiguous. The regex bought nothing and risked silently reclassifying a
  relaunch-gate refusal as a plain conflict (exit 5 instead of 7, remedy text lost)
  the moment upstream reworded. `field` is a structural contract; prose is not.
- Widened `request()`'s guard: `res.status` and `res.text()` ran outside the
  try/catch, so a malformed response threw a raw `TypeError` instead of the
  documented `BridgeError`.
- Token now redacted from any echoed response body before it reaches a log line or
  error message.

**beads-client: CHANGES_NEEDED**, two blockers fixed.
- **Error taxonomy.** A missing `callTool` threw `SUPERVISOR_UNAVAILABLE` (exit 8,
  "transient infrastructure") for what is a permanent constructor-wiring defect that
  recurs identically on retry - while the check two lines below it used
  `CONFIG_MISSING` (exit 2) for the same class of problem. Now both are
  `CONFIG_MISSING`, and `SUPERVISOR_UNAVAILABLE` is documented as reserved for an
  actual failed connectivity attempt.
- **Leading-dash refs were argument injection, severity escalated.** The reviewer
  rated this non-blocking on the assumption refs are beads-internal. They are not -
  refs come from the pipeline's `workItems` parameter, i.e. externally supplied - and
  they are placed as bare positional elements next to `bd ado push`. A ref of
  `--all` would therefore land as a flag in bd's own CLI parser, defeating exactly
  the ID-scoping `assertNoBareSync` exists to enforce. Fixed by rejecting any ref
  starting with `-`, and by restructuring so module-added flags like `--dry-run` are
  passed as a separate parameter rather than smuggled through ref validation.

Two claims were independently verified against source rather than trusted, and both
held: the pre-quoted `{{secret.NAME}}` substitution, and the `wrapForMember` base64
trap. Both are now recorded in the implementation plan's Part C.

One report inaccuracy caught by checking: a fix agent described `lastReadToken` as a
"module-level variable", which would have been a real defect (two clients with
different tokens cross-contaminating). The code actually declares it inside
`createSupervisorClient`, so it is a per-instance closure variable. Correct as
written - but the report was not.

Open item for the `preflight` unit: `doltPullProbe()`'s exact invocation is not
pinned in any doc. It is implemented as a bare `bd dolt pull` returning
`{ ok, stdout, stderr }`, with exec failures propagating as `BEADS_FAILED`. Confirm
that contract before depending on it.

### CP4 - periodic sweep findings fixed

The first whole-branch sweep. Bridge package **213 tests, 0 fail**.

**Blocking: a third instance of the same taxonomy defect.** Ref-validation failures
in `buildTrackerCommand` threw `BEADS_FAILED` (exit 9, "internal defect, recurs on
retry"), but refs originate from the pipeline's externally-supplied `workItems`
parameter. A mistyped work-item id was indistinguishable from the bd binary
crashing. Now `CONFIG_INVALID` (exit 2), with the rule written down: input
validation fails as CONFIG_INVALID, the bd process failing is BEADS_FAILED.

That this was the third such case across three modules is the real finding. An error
taxonomy only pays off if every throw site respects it, and three separate agents
each got one site wrong while passing their own tests.

**Cross-unit drift only a whole-branch view could see:**
- `TRACKER_REF_PATTERN` existed in two modules; `contracts.mjs` now owns it and
  exports `assertValidTrackerRef`, which both the tracker-ref loop and
  `validateSprintRequest`'s `workItems` loop call. Malformed work-item ids are now
  rejected at the contract boundary instead of surviving to the bd command.
- `bin/fleet-bridge.mjs` hand-rolled its own verb list and usage text rather than
  importing `src/cli/args.mjs`. Two sources of truth, both passing their own tests.
  Collapsed, with a test asserting the binary advertises exactly the exported list.
- `assertThrows` was byte-identical in three test files; now one `test/helpers.mjs`.
- A documented drift risk had no guard: `beads-client` deliberately mirrors
  `exec-bd`'s private charset regex and its comment warns they must never diverge.
  `test/pattern-drift.test.mjs` now reads both sources and compares the literals.
- Dead `"./snapshot"` entry in the exports map pointed at a file that does not exist.

**One sweep recommendation was overruled.** It proposed applying
`ISSUE_ID_PATTERN` to `workItems`. That pattern has no `/` or `#`, so it would
reject legitimate GitHub refs like `owner/repo#123` and break Phase 4. The gap was
real; the fix was not. `ISSUE_ID_PATTERN` was instead found to be entirely unused -
exported and unit-tested but applied nowhere - and is now wired to
`makeSprintHandle`'s `issueRoots`, where genuine bead ids appear. A validator that
exists only in its own test is worse than none, because it reads as coverage.

**Tooling note.** The mandated GitNexus `impact` analysis could not run: there is no
index for this worktree ("No code intelligence index found"). The agent fell back to
grep for its import-cycle check and said so rather than claiming an analysis it had
not done. Until someone runs `node .gitnexus/run.cjs analyze` against the worktree,
the impact-before-edit rule is unenforceable here.

---

### CP5 - adapters, spool, await-gate; the error rule settled and enforced

Bridge package **334 tests, 0 fail**. Adapter registry, native-beads-sync, the Azure
DevOps adapter, the handle spool, and the configurable await gate.

**The taxonomy defect reached five modules before it was stopped properly.** The
reviewer's decisive observation was that `beads-client.mjs` had been doing the same
thing since CP3 and had passed review unflagged - which reframed it from "four
agents made the same mistake" to "the rule was never written down, so each module
re-derived it". Sweeping the whole package afterwards found a fifth instance in
`supervisor-client.mjs`, a module already reviewed and APPROVED.

The rule is now written down (below) and, more importantly, mechanically enforced by
`test/error-rule.test.mjs`: a source scan over every `.mjs` under `src/` that fails
on any raw `Error`/`TypeError` outside a data-driven allowlist. The allowlist carries
a written reason per entry and is itself checked for staleness, so dead exemptions
cannot accumulate. The guard was proven by inserting a raw throw, confirming the
failure message, and removing it - a source-scan test that has never actually failed
is indistinguishable from one that cannot.

Only two raw throws remain package-wide, both internal sentinels in
`supervisor-client.mjs` that are caught by their own enclosing handler and converted
to `SUPERVISOR_UNAVAILABLE`. They never cross a module boundary, so the rule does not
apply - and both now carry a comment saying so, because the next person applying the
rule mechanically would otherwise "fix" them and change the error contract.

**`claim()` was inverted to fail safe.** It had defaulted to treating every existing
claim as dead when no liveness probe was injected, taking over with a logged warning.
That trades away the exact invariant the blob sink depends on: two daemons both
believing they own a sprint would both advance the `appendpos` cursor and corrupt the
log **silently**. Now a missing probe means refuse; takeover requires an explicit
`{ force: true }`. The code also distinguishes "no probe, cannot know" from "probe
says dead" rather than collapsing both into a takeover.

**Honesty fixes.** `scrapeVerdictFromLog`'s docstring implied occasional success; a
trace confirmed no code path writes a matching verdict to the log it reads - the
plan-reviewer verdict is deliberately unlogged, which is why the publishState channel
exists at all. Reworded as a defence against a future regression, not present
coverage. `capabilities()` was shallow-frozen, so a nested object from an out-of-tree
adapter stayed mutable; now built from an exact five-key whitelist that rejects
extras at registration.

**One earlier concern of mine was wrong.** I suspected `cycle:N` might silently never
fire, since it reads `plan.cycle` which only updates when the Plan phase publishes.
The reviewer traced `runner.js` and confirmed Plan runs unconditionally at the top of
every cycle, so every N is reachable.

---

### The error rule (settled at CP5 - read this before adding a throw)

This defect recurred in **four consecutive waves**, in four different modules,
written by four different agents, each passing its own tests. That pattern is a
documentation failure, not four coding mistakes: the rule existed only in reviewers'
heads, so every new module re-derived it and roughly half got it wrong.

**Every throw crossing a module boundary in this package is a `BridgeError`.**

| Situation | Code | Exit |
|---|---|---|
| Dependency never injected at construction or call time | `CONFIG_MISSING` | 2 |
| Caller-supplied value present but malformed | `CONFIG_INVALID` | 2 |
| Required pipeline parameter absent | `CONFIG_MISSING` | 2 |
| An external process or service genuinely failed | its own code (`BEADS_FAILED`, `SUPERVISOR_UNAVAILABLE`, ...) | 8/9 |
| Unrecognised - the only legitimate route to exit 1 | plain `Error` escaping | 1 |

Raw `Error` / `TypeError` is **not** used for a missing dependency or a bad
argument. A reviewer found `beads-client.mjs` doing exactly that and passing CP3
unflagged, which is what exposed the real problem: an undocumented convention is
indistinguishable from the bug it resembles. Converted everywhere, including that
pre-existing case.

Two corollaries worth stating, because both were got wrong once:
- **A missing injected dependency is never `SUPERVISOR_UNAVAILABLE`.** It is a
  permanent wiring defect that recurs identically on retry; the infrastructure code
  tells a pipeline to retry something that cannot succeed.
- **Externally-supplied input is never an "internal defect" code.** Refs come from
  the pipeline's `workItems` parameter, so a malformed one is `CONFIG_INVALID`, not
  `BEADS_FAILED`.

The guard that makes this stick is the completeness test over `BRIDGE_ERROR_CODES`
added at CP2: every code must map to something other than exit 1.

### Pinned contracts between units

Recorded when a producer lands before its consumer, so the consumer conforms rather
than the two being reconciled after the fact. Producer/consumer drift is what the
first sweep flagged as the most likely defect class when modules are written
concurrently.

**Adapter `ingest` / `publishCarryOver` call shape** (producer: `adapters/*.mjs`,
consumers: the not-yet-built `verbs/ingest.mjs` and `verbs/finalize.mjs`). Nothing
upstream specified it, so the adapter mirrors `beads-client.mjs`'s own method
signatures:

```js
adapter.ingest({ refs, secretName }, { beads })
adapter.publishCarryOver({ beadIds, secretName, dryRun }, { beads })
```

The beads client arrives per-call via `deps`, never closed over at module load -
that is what keeps a future `github.mjs` to "same file, different namespace string".

**`adapter.ingest`'s RETURN shape was unpinned, and the two sides had already
diverged.** The earlier entry pinned only the call shape. `verbs/ingest.mjs` treats
the return value as structured bead records, while `native-beads-sync` forwarded the
raw result of dispatching `bd ado pull` to a member. Both passed their own tests,
because each was tested against its own fake - the exact blind spot unit tests have.

The root cause is that `bd ado pull` *writes into* the local beads DB rather than
returning records, so the adapter must dispatch the pull and then **read back** what
landed, keyed on `external_ref`. That read is credential-free and therefore takes the
local exec-bd path, not `execute_command`. Being explicit: a requested ref that
matches no bead after the pull must surface as a named error or an explicit omission,
never as a silently short list - otherwise `ingest`'s child-count assertion passes or
fails for the wrong reason.

Lesson: pinning a call shape without its return shape pins half a contract.

**`runPreflight`'s `opts` shape is provisional.** No consumer exists yet
(`bin/fleet-bridge.mjs` does not dispatch verbs), so the shape was designed to mirror
`SprintRequest` where they overlap: `{ member, repo: {remoteUrl, localPath},
baseBranch, requiredCredentials, playbooksDir, spawn }`. Whoever wires `launch` or
the binary should reconcile it rather than adding a second translation layer.

**PR capability is a git-host property, not a tracker-adapter one.** `preflight`
resolves it through the real `capabilities(remoteUrl)` in `apra-fleet-se`'s
`vcs-module.mjs` - the same function fleet-sprint's own publish gate calls - so the
check cannot drift from what an actual launch sees. The tracker adapter's
`capabilities()` has no PR-related field and should not grow one; the two axes are
genuinely separate.

**`adapter.comment` has three incompatible signatures - UNRESOLVED, must be fixed
before wiring.** Third instance of the producer/consumer species, and the clearest:

| Module | Assumes |
|---|---|
| `adapters/azure-devops.mjs` (the real one) | `comment({resolved, workItemId, body}, {restClient})` |
| `verbs/watch.mjs` | `comment(markdownText)` on a per-sprint-bound facade |
| `verbs/finalize.mjs` | `adapter.comment()` targeting `handle.request.workItems[0]` |

Every one passes its own tests. None of them would work against the others. The
`watch` author flagged the mismatch explicitly rather than assuming, which is the
only reason it is known now instead of at first wiring.

Resolution: a per-sprint **adapter facade**, built by the wiring layer, exposing the
small conceptual surface the verbs actually want (`emitProgress(snapshot)`,
`comment(markdown)`), with the REST plumbing and work-item targeting resolved once
inside it. The facade is the thing the verbs take; the registry adapter stays as it
is. This needs a contract test importing the real registry adapter and the real verb
expectations together - fakes on both sides is precisely how three signatures
diverged unnoticed.

Also unresolved and part of the same fix: **which work item receives the comment.**
`finalize` picks `workItems[0]`; `watch` does not decide at all. The facade should
own that choice so both agree.

**`daemon.stop()` can take up to two days - needs a cancellation signal.** The daemon
drains gracefully: `stop()` awaits every in-flight worker's natural completion. Since
a worker's `runWatch` polls until the sprint terminates, and `deps` carries no abort
hook, `stop()` is bounded by the sprint, not by the shutdown.

The author reasoned to this deliberately and documented it: releasing a claim out
from under a call that is still executing would reopen the single-writer hazard
`spool.claim()` exists to prevent - a second daemon could claim and start a competing
watch while the first daemon's abandoned promise is still running, and both would
advance the append-blob cursor. Given the choice between "slow shutdown" and "silent
log corruption", slow is right.

But a foreman that cannot be restarted inside two days is not operable, so neither
option is acceptable long-term. The fix is the third path: thread an abort signal
into `runWatch` so it exits its poll loop at the next tick, await that clean exit,
then release the claim. `watch`'s loop already uses an injected `sleep`, so this is
cheap - shutdown becomes bounded by one poll interval rather than by the sprint, and
the claim is still only released after the worker has genuinely stopped.

Queued behind the adapter-facade work, which owns `watch.mjs` right now.

**Append-blob manifest name and shape - pinned here because nothing else pins it.**
The sink invented both, and the D1 archive SPA will read them, so recording before a
second module guesses differently:

```
<container>/<sprintId>.manifest.json      (a BLOCK blob, rewritten wholesale)
{ version: 1, sprintId, parts: [ { part, blob, bytes, blocks, sealed }, ... ] }
```
The JSONL parts are `<sprintId>-partN.jsonl` (append blobs). The viewer reads the
manifest first, then Range-GETs each part in order.

**Append-blob cursor shape** (persisted into the spool's `sinkCursors`, and
deliberately free of the SAS):
```js
{ version: 1, sprintId, blobName, partNumber, appendPos, committedBlockCount, parts }
```
A non-null cursor at construction means *resume*: the blob already exists and must
never be recreated, since creating an append blob overwrites it. That is a sharp
edge - a resume path that "helpfully" ensures the blob exists would silently destroy
the log it was trying to continue.

**Archived command output can be permanently capped - inherent, not a bug to fix.**
`GET /activities/:id/output` has two branches. Its primary path reads
`command-output-cap.mjs`'s **in-memory** store, which is per-process and never
persisted; the fallback reads `output`/`error` off the activity in the state tree.

An offline archive built from `old_runs/<runId>.json` can only mirror the fallback,
so a `command` activity's text may still carry the head+tail excerpt that
`command-output-cap.mjs` applied **at storage time**. That is distinct from
`lean-state.mjs`'s 200-char wire truncation, which the un-leaned terminal snapshot
never goes through - this cap is baked into what was persisted.

There is no offline recovery: once the sprint child has exited, the uncapped bytes
are gone. Worth stating plainly so nobody later "fixes" the archive expecting full
text to appear. `finalize` cannot rescue it either - it runs in the bridge daemon,
not inside the sprint child, so that in-memory store is not reachable from there.

**Extension detail enumeration is deliberately generic.** The viewer's extension
contract has `detailLookup(state, itemId)` but no "list every id" hook, anywhere.
Rather than add a beads-specific enumerator - which would break the domain-neutrality
rule the plan repeats - the archive walks `state.extensions[extId]` for nested
objects carrying an `id`, then asks the extension's own `detailLookup` about each.
A false-positive candidate costs one skipped lookup and never produces a wrong file.
Verified against the real `beadsExtension`, not a fake.

**`--viewer-token` removed: a meaningless guard is worse than none.**
The LAN viewer proxy had implemented `viewerToken` as `Authorization: Bearer <token>`,
matching the supervisor's own scheme. But a bare address-bar navigation cannot set
a request header, so the token guarded only programmatic callers (fetch/XHR), leaving
a human opening the URL in a browser unguarded. Since the browser page load is the
primary use case, the flag made the viewer unreachable without actually protecting it.

The flag was removed rather than patched. A control that bricks the page it claims to
protect is worse than no control. Decision recorded in #493 and this build log: the
LAN binding risk is accepted pending #493 (supervisor loopback binding), since the
supervisor's own surface is larger and includes POST /api/shutdown, which this proxy
withholds unconditionally.

After #493 lands and the supervisor binds loopback, this proxy becomes the sole LAN
path to sprint control. That is when a proper guard belongs: a cookie-based scheme
(a small login route setting an HttpOnly, SameSite=Strict cookie; `isAuthorized` accepting
either cookie or bearer for API callers). A query-string token was rejected because
it leaks into browser history, access logs, and Referer headers.

**`rewriteChildHtml` is deliberately NOT used by the bridge's viewer proxy.** It
exists because the supervisor's own live-view proxy inserts a `/sprints/:id/live`
path prefix, so the child's absolute app-paths must be rewritten to re-enter under
it. The bridge proxy inserts no prefix - it is a pure host:port swap one layer
further out - so rewriting would be a no-op at best and a double-rewrite bug at
worst. Pinned by a test asserting live-view HTML passes through byte-identical,
including the `'/events'` and `'/state?` literals.

**Unscrubbed downstream `authorization` is an assumption, not a guarantee.**
`proxy.mjs`'s `downstreamResponseHeaders` does not strip `authorization` from
upstream responses. Safe today because nothing in the supervisor echoes it, and
proven by test - but if `proxy.mjs` ever changes, this is where it would leak.

**Correction: the client coupling surface is SEVEN literals, not eight.**
`rewriteChildHtml` string-patches eight literals, and earlier entries here repeated
that as the number of client call sites the D2 seam had to preserve. Verified: in
`apra-fleet-workflow/src/viewer/index.mjs`, `/save_logs` appears only at lines
1755/1762 as the **server-side route handler** - there has never been a client call
site for it. The patcher rewrites a literal the browser never emits.

So the guarded set is seven: `/events`, `/state?`, `/stop`, `/pause`, `/resume`,
`/extensions/`, `/activities/`. The D2 lockstep test asserts those seven are present
and rewritable, and separately documents `/save_logs`'s absence with a note to
promote it if a client call is ever added - rather than asserting its presence, which
would have been a tautology that passes forever without checking anything.

Worth stating because a guard defined against the wrong number can pass while
missing something. The agent verified against the pre-existing code *before* editing,
which is the only way this was distinguishable from a regression it had caused.

**D2 seam exists but nothing calls it in production.** `HTML_TEMPLATE` now takes
`opts.dataProvider` (`'http'` default, `'blob'`), and the blob provider reads its
state URL from the page fragment (`#state=<url>&socket=<url>`), keeping the shell
data-free per the access model. The daemon-side `state.json` writer, the Web PubSub
publisher and the export call site are deliberately not built - later work per the
plan's own sequencing. The seam is testable today via
`HTML_TEMPLATE([], {dataProvider: 'blob'})`.

**Stop/pause/resume deliberately bypass the provider.**
`apra-fleet-se/test/4yr-stop-modal.test.mjs` extracts `confirmStopWorkflow` verbatim
out of the emitted HTML and executes it through `new Function(...)` with no
`dataProvider` in scope, so routing control through the provider threw a
`ReferenceError`. `httpProvider.control` exists for contract completeness and
`blobProvider.control` is null (read-only), but the DOM-wired functions still call
their literal fetches. Documented at the call site. A real test constraint, not an
oversight.

**`execute_command`'s result shape - pin it, do not each invent a fallback chain.**
`rest-client.mjs` needed the stdout of a member-dispatched command and found the shape
pinned nowhere; `beads-client.mjs` never inspects it either. Traced to
`src/tools/execute-command.ts`, the real MCP tool returns:

```js
{ text, structuredContent: { exitCode, stdout, stderr } }
```

`rest-client` reads `structuredContent.stdout` first and degrades through three
fallbacks rather than assuming. That is the right call for one consumer and the wrong
pattern for three - the next module should read the pinned shape above, not grow a
fourth chain.

**Secret delivery in a member-dispatched REST call: two statements, not one.**
Two shell facts make the obvious single-line form wrong, and both are easy to
rediscover the hard way:

- A POSIX prefix assignment (`VAR=value cmd`) is **not visible to `$VAR` expansion on
  that same command line**. beads-client's form works because `bd` reads the env
  itself; a curl argument interpolating `$VAR` does not.
- Gluing the bare placeholder onto an unquoted prefix (`-u :{{secret.NAME}}`) relies on
  the shell concatenating adjacent words after substitution. Well-defined in POSIX;
  unverified against PowerShell's native-command argument binder, which
  `shell-helpers.mjs` documents as having measured, non-obvious quirks.

So: assign the secret to an intermediate variable in its **own** statement, then
reference it from a separate one. The placeholder stays bare (never quoted) and never
passes through `wrapForMember`.

`secretName`'s charset guard excludes `}` specifically, so a hostile name cannot close
the placeholder and inject a second one. That guard is load-bearing - the name is
interpolated bare and unescaped, unlike the url and body, which go through
`shell-helpers.mjs`'s `shQuote`/`shQuoteJson`.

**Residual, unfixable-here:** a PAT whose own bytes contain a literal double quote
could still mis-split under the legacy Windows argv binder. Not fixable without
reading the secret, which Part C forbids. PATs are practically base64/hex-shaped, and
`shell-helpers.mjs` documents the same residual class for values it cannot pre-escape.

**One daemon cannot serve two Azure DevOps organisations - a real limitation, not a
bug.** A `SprintHandle` carries `request.platform` and `request.member`, but **no
adapter-specific coordinates**: no `adoOrgUrl`, no `adoProject`, no tracker
`secretName`. So when `watch`, `finalize` or `daemon` rebuild a facade for a sprint
read back from the spool, they resolve those three from **this invocation's** global
config (CLI flag > env > `bridge.config.json`), applied uniformly to every sprint that
daemon instance manages.

Consequences, in order of how likely they are to bite:
- A daemon managing sprints from two different organisations will comment on the wrong
  one, or on neither.
- Missing `adoOrgUrl`/`adoProject` degrades `comment()`/`setBuildStatus()` to a logged
  no-op rather than a crash, because the facade's comment path never throws. So the
  failure mode is **silence**, not an error - a sprint runs to completion and simply
  never posts.

The fix, when wanted, is to persist the resolved adapter coordinates into the
`SprintHandle` at launch, so every later verb rebuilds the facade from the sprint's own
record rather than from ambient config. That is a contract change to `makeSprintHandle`
and should go through the same pinning discipline as the others here - note
`assertNoSecrets` runs inside it, so the `secretName` (a name, never a value) is fine
but must stay a name.

**`REQUIRED_DEPS_BY_VERB` in the composition-root test is hand-transcribed.** None of
the verbs' `validate*Deps` functions are exported, so the test cannot call them; it
restates what each throws `CONFIG_MISSING` for, with citations, plus a `deepStrictEqual`
guard keeping its keys in step with `VERBS`. That guard catches a verb being added or
removed; it does **not** catch a verb's validator being loosened or tightened. Exporting
the validators would close it properly.

**`NODE_TEST_CONTEXT` leaks into spawned children.** `node --test` sets it, `spawnSync`
inherits it by default, and `bin/fleet-bridge.mjs`'s `isMainModule()` guard reads it -
so a spawned `node bin/fleet-bridge.mjs --help` saw itself as a test file and no-op'd
with empty stdout and exit 0. The smoke test passed **vacuously**. Strip that variable
from every spawned child's env; the monorepo already does this in
`apra-fleet-se/test/phase1-leaf-facade-completeness.test.mjs` and siblings.

**Credential-name defaults are in scope, credential values are not.**
`azure-devops.mjs` defaults `adoPatSecretName` to `fleet_bridge_azdevops_pat` (this
bridge's OWN default, deliberately NOT the same string as the engine's own default,
`azdevops_pat` - see the next entry for why they must differ). Part C's
no-ambient-defaults rule targets deployment-specific values - organisation, project,
storage account, container, pool - and a credential *name* is none of those: it is a
lookup key, always overridable, and never a secret. Documented in the adapter's
header so the exception is deliberate rather than an oversight.

**Two Azure DevOps PAT consumers exist, configured separately - the bridge's own and
the sprint engine's - and previously could silently diverge.** There are TWO places a
PAT secret name is used:
- the **bridge**, for `bd ado pull/push` and REST comments/build-status
  (`azure-devops.mjs`'s `DEFAULT_ADO_PAT_SECRET_NAME`, default `fleet_bridge_azdevops_pat`);
- the **sprint engine**, for `provision_vcs_auth` so the sprint can push its branch and
  open the PR (`fleet-sprint/sprint-args.mjs`'s `azdevops_pat_secret_name` launch arg,
  default `azdevops_pat` - untouched, since that default is shared apra-fleet surface
  with other consumers, not this bridge's to change).

The rename above exists because an operator's `azdevops_pat` credential-store name was
already taken by an unrelated system, so the bridge could not default to it. But
`launch` never sent the engine's own key at all: it was absent from
`KNOWN_REQUEST_KEYS`, so `validateSprintRequest` would have rejected it and
`buildPostSprintBody` had no way to carry it - meaning the sprint always reached for
`azdevops_pat` regardless of what the bridge itself was configured with, failing (or
worse, succeeding against the wrong account) only at the publish step after a
potentially multi-day run.

Fixed by threading a new, platform-neutral `patSecretName` field through
`contracts.mjs`'s `SprintRequest` (added to `KNOWN_REQUEST_KEYS`, validated by the new
`assertValidSecretName` - the same `[A-Za-z0-9_.-]+`/no-leading-dash/excludes-`}`
charset guard `rest-client.mjs`'s `secretName` check already uses, so the two never
drift). Named `patSecretName`, not `adoPatSecretName`: `SprintRequest` is meant to stay
platform-neutral (see `platform` itself), and every tracker adapter's PAT/token is
conceptually the same one stored-credential-name shape for the engine's VCS-auth step.
`verbs/launch.mjs`'s `buildPostSprintBody` renames it onto the engine's own
`azdevops_pat_secret_name` arg ONLY when present, so an unconfigured bridge leaves the
engine to fall back to its own default rather than ever receiving an explicit
`undefined`.

**Correcting an earlier assumption in this log (see the `SprintHandle` adapter-
coordinates entry above): a key merely NAMED like a secret is NOT "fine" under
`assertNoSecrets`, regardless of what it holds.** `isSecretKey`'s substring rule
(`contracts.mjs`) matches `'patSecretName'.toLowerCase()` (and would equally match a
literal `secretName`) purely by name, before ever looking at the value - so simply
adding this field to the `SprintRequest` object that `makeSprintHandle` embeds as
`request` made every launch throw CONFIG_INVALID, whether or not the field was ever
populated. `patSecretName` has already done its one job by the time `makeSprintHandle`
runs (`buildPostSprintBody` reads it first), and nothing downstream ever reads it back
off a persisted handle, so `runLaunch` now strips it from the object it hands to
`makeSprintHandle` rather than loosening `assertNoSecrets`' key-name guard for every
other caller (including `log-safe.mjs`'s redactor, which reuses the same
`isSecretKey`).

### Follow-ups outstanding

Small items deliberately deferred, recorded so they are not lost.

| Item | Why deferred | Where |
|---|---|---|
| Three string-truncation helpers remain unconsolidated | Each is locally correct and they span two packages; consolidate before more call sites accrete copies | `plan.mjs` capText(300), `supervisor-client.mjs` snippet(200), `beads-client.mjs` inline(500) |
| `package-lock.json` regeneration stripped `"peer": true` from unrelated packages | Suggests the local npm differs from the one that produced the baseline lockfile. Harmless locally, but CI runs `npm ci`, which is strict about lockfile fidelity - verify before this branch reaches CI | root `package-lock.json` |
| `serve-wiring-integration.test.mjs` flake unconfirmed | 2 subtests, ~90 s each, suspected boot timeout; never reproduced against a clean baseline | `packages/apra-fleet-se/test/` |
| `doltPullProbe()` invocation unpinned | Implemented as a bare `bd dolt pull`; no doc specifies the intended flags or failure contract | confirm when building `preflight` |
| `claim()` on a never-written sprintId reuses `CONFIG_INVALID` with `details.reason: 'no-such-document'` | The agent could not add a dedicated code - `errors.mjs` was outside its permitted file set. A named code would read better at the call site | `spool.mjs`, `errors.mjs` |
| Adapter `ingest` read-back uses an unfiltered `bd list --json` | `beads-client.list()` has no `external_ref` filter, and narrowing by `createdAfter` would silently drop refs pulled by an earlier ingest - reproducing the very "looks like it worked, actually dropped data" bug being fixed. Correctness was chosen over cost; on a large tracker this is a full scan per ingest. Revisit if `bd` gains an `external_ref` filter | `adapters/lib/native-beads-sync.mjs` |
| `assertNoSecrets` is name-based plus a URL-credential check | Deliberate scope: the structural defence is that the bridge only handles secret NAMES. Revisit if handles are ever persisted more widely | `contracts.mjs` |

---

## Conventions for this build

- **Doer then reviewer.** Each work unit is implemented by one agent and then
  reviewed against the plan's acceptance criteria by a second before it is committed.
  A reviewer may reopen the unit; work is not committed on the doer's say-so alone.
- **Delegate down aggressively.** Implementation and review both run on **sonnet**;
  mechanical, low-judgement units (YAML templates, README checklists, doc edits,
  repetitive test scaffolding) run on **haiku**. The orchestrating model writes no
  production code - it is reserved for synthesis: sequencing waves, reconciling
  reviewer findings, and the cross-cutting calls that span several units. A unit is
  only escalated above sonnet if a reviewer twice reports it unresolved.
- **Two levels of review, both mandatory.**
  1. *Per unit*: a reviewer agent (sonnet) diffs the unit against its acceptance
     criteria before the unit is committed. Returns APPROVED or CHANGES_NEEDED with
     specifics; CHANGES_NEEDED sends it back to the doer.
  2. *Periodic sweep*: after every second wave, a reviewer (sonnet) reviews the whole
     accumulated diff on the branch, not just the latest unit. Per-unit review cannot
     see cross-unit drift - duplicated helpers, contracts that diverged between
     producer and consumer, an injected-dependency rule quietly abandoned three units
     ago. The sweep is what catches those, and its findings are logged as a
     checkpoint entry even when nothing needs fixing.
- **Commit per reviewed wave**, locally. Never push, never merge, never commit
  another agent's half-finished files - stage by path, not with `git add -A`.
- **Injected I/O is mandatory.** A module reaching for `globalThis.fetch`,
  `process.env` or the real filesystem directly is a defect: with no integration run
  available, fakes are the only verification that exists.
- **ASCII only** in `.md`, `.yml`, `.yaml` and `.sh` - a pre-commit hook enforces it
  and blocks the commit otherwise. It also rejects PowerShell backtick escapes.
- **Never `git stash` from an agent.** The stash stack is shared across every
  worktree and every concurrent session, so a stash/pop from one agent can swallow
  another's uncommitted work. A Wave 1 doer used it to baseline test failures and got
  away with it - the stack was verified empty and all files intact afterwards - but
  the next one may not. To compare against a clean baseline, run the test in the
  unmodified checkout at `C:\ak\apra-fleet` instead, or capture `git diff > patch`
  and restore with `git apply`. Never `git stash pop`.
- **Verify a doer's failure attribution before acting on it.** Reported failures have
  twice been blamed on in-flight work and twice turned out to be pre-existing. One
  baseline run settles it.
- **Task tracking:** this repo mandates `bd`, but the clone has no beads database
  (`bd` reports "no beads database found"), so this file is the tracker instead.
  If a beads DB is initialised here later, migrate these rows into it.

---

## Integration run 1 -- first live exercise against Azure DevOps

Target: `apralabs/e2e-fleet-testing`, repo `fleet-e2e-toy`, base branch
`basic_workshop_start`, member `aztoy` (Windows/gitbash). Work items: Epic 1 with
children 2 (updatedAt bug), 3 (pagination), 4 (sorting).

Five defects found by running the binary. **None was catchable by a unit test** -
every one is a mismatch between the bridge and a real external surface, and the suite
was green (886 passing) the whole time. Recorded here because the pattern, not the
individual bugs, is the lesson: injected-I/O fakes verify that a module honours the
contract we *believed* the outside world had.

1. **Local `bd` ran in the bridge's cwd, not the repo under test.** Every local beads
   verb was affected; `preflight`'s beads-health check surfaced it first ("no beads
   database found"). `ingest` would have operated on the wrong DB or none. Fixed by
   threading a `cwd` spawn option from the composition root. Note `--repo-local-path`
   must be passed to `ingest` as well as `preflight`; the docs said otherwise.
2. **`member-vcs-provider` could never pass for any member.** It read `vcsProvider`
   off the supervisor's `GET /api/members`, which has no such field. Sourced from the
   fleet MCP `member_detail` instead - deliberately NOT by adding the field to the
   supervisor, which would be a change to apra-fleet.
3. **`beads-health` hard-failed when no dolt remote was configured.** A local-only
   beads DB is a legitimate single-runner setup: the dolt remote only matters for
   sharing beads across machines, and carry-over reaches the tracker via
   `bd ado push`, which needs no remote. Now a warning; a *configured but broken*
   remote is still a hard fail. Detected via `bd dolt remote list --json` returning
   an empty array, a structural signal, rather than matching the error prose.
4. **Tracker refs did not round-trip.** The caller passes a bare work item id (which
   `bd ado pull` documents as valid), but beads stores `external_ref` as a full URL
   (`https://dev.azure.com/<org>/<project-guid>/_workitems/edit/2`). The bridge
   compared them with string equality, so every ingest matched zero beads. Now
   matched by normalized identity - last path segment, compared whole, never as a
   substring, so `2` cannot match a ref ending in `12` nor a digit inside the GUID.
   Platform-general: GitHub refs are URLs too.
5. **The acceptance-criteria gate read a field that does not exist.** It required
   beads' `acceptance_criteria`, populated from Azure DevOps'
   `Microsoft.VSTS.Common.AcceptanceCriteria` - a field the Agile process's User
   Story has, the Basic process's Issue does not, and GitHub has never had. As built
   the gate could **never** pass on GitHub. Criteria are now resolved from the
   dedicated field when a tracker has one, else extracted from an "Acceptance
   criteria" heading in the description. Deliberately does NOT fall back to the whole
   description: that would make the gate meaningless, and the gate exists to stop a
   two-day sprint running on vague input.

Defect 5 is the one worth generalising. **A work item type assumption can hide
several layers below where it looks like it lives.** The obvious form - hardcoding
`Epic`/`Issue`/`Task` - the bridge never had. The dangerous form was a *field* whose
existence is contingent on the type and process template, read through two layers of
indirection (bridge to beads to tracker), where its absence looked like "the operator
wrote a vague work item" rather than "this field cannot exist here".

### Decisions taken during the run

- **The parent Epic is not pulled.** `bd ado pull 2 3 4` fetches exactly what it is
  given, so an epic that is the parent of the selected items is absent from the local
  DB and `ingest` synthesises a root instead. Accepted: the sprint's scope is what
  the operator selected, and the synthetic root is the sprint container. The cost is
  that carry-over items do not attach under the tracker epic the work belongs to.
  Revisit if operators ask for it; it is not free, since pulling the parent would
  also pull its other children into scope unless filtered.

### Defect 6 -- the bridge and the engine were never connected

The first real `launch` against a live supervisor failed with the engine's
`[Arg Contract] Invalid issue id "undefined"`.

`buildPostSprintBody` performed almost no translation: it spread the SprintRequest
verbatim and mapped exactly one field. The two sides speak different vocabularies -
the supervisor's `POST /api/sprints` requires `issue`, `branch`, `base` and
`members`, while the bridge sends `workItems`, `targetBranch`, `baseBranch` and
`member` - so every field the engine requires arrived undefined.

The sharpest part: `--synthetic-root-id`, the beads root that `ingest` exists to
produce and the one value that tells the engine WHAT TO WORK ON, was accepted as a
flag, threaded into the sprint handle, and never placed in the launch body at all.
`ingest` computed the root; `launch` posted without it. The bridge's two halves had
never been joined.

This is the same shape as the phase-1 "nobody's unit" gap, one level up, and for the
same reason: the launch unit tests mocked the supervisor using the BRIDGE's own
vocabulary, so they proved the bridge is self-consistent - which was never in doubt.
A fake built from the same misunderstanding as the code cannot detect the
misunderstanding. **When a test fake stands in for an external system, its shape must
be derived from that system's own source or docs, never from the calling code.**

Deliberately NOT done: mapping `workItems` onto `issue`. Those are tracker work item
numbers (2, 3, 4), not beads ids; the substitution would launch a sprint against
issue roots that do not exist and fail much later, far less legibly. A missing root
now fails fast naming the flag.

### Open gaps found while wiring launch (neither fixed here)

- **The supervisor dropped `azdevops_pat_secret_name`.** RESOLVED - the entry
  below is kept because the reasoning was wrong in an instructive way.
  Originally recorded as an accepted gap, on the argument that fixing it meant
  changing apra-fleet and that the first integration run had survived it
  anyway. Both halves were mistaken. The run survived only because
  `provision_vcs_auth` had been run against the member by hand beforehand; the
  next run did not survive it at all. The engine's sync preflight provisions a
  credential itself, and with no secret name reaching the child it used the
  provider default `azdevops_pat` - a different project's token on this
  operator's machine - which overwrote the working credential and killed the
  sprint in its first plan round.
  Fixed by threading the value through the three layers that dropped it
  (`bin/cli.mjs`'s option spec and `buildRunnerArgs`, `buildSprintArgv`, and
  `api.mjs`'s `spawnOpts`), then through the PR-capable provisioning path,
  which was a second, separate omission found later the same day.
  **The lesson is about how the gap was classified, not the code.** "Harmless,
  because the run passed" was an inference from one observation, and the
  mechanism - that the engine re-provisions credentials on its own - was never
  checked. A gap in a credential path should be assumed load-bearing until the
  mechanism is read.
- **A tracker-native root cannot be launched.** `runIngest` may return a real
  `rootBeadId` with `syntheticRootId` undefined (when a natural parent was found or
  an existing root reused), but the `launch` verb wires only `--synthetic-root-id`.
  That path is now explicitly unsupported rather than silently posting
  `issue: undefined`. Needs a `--root-bead-id` equivalent.
