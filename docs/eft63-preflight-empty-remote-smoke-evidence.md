<!-- llm-context: Live-smoke evidence record for apra-fleet-eft.63.3, corroborating
     apra-fleet-eft.63.1 (preflight D-pull treats a genuinely-empty Dolt remote as a
     benign no-op) and apra-fleet-eft.63.2 (mock-sprint unit coverage) on branch
     feat/sprint-service-1. -->
<!-- keywords: eft.63, preflight D-pull, empty remote, DOLT_SYNC_FAILED, Reset, smoke test -->

# eft.63 live smoke retest evidence (apra-fleet-eft.63.3)

## Context

apra-fleet-eft.63's impl (`.63.1`) and unit test (`.63.2`) were already closed against
mock-sprint fixtures. This bead is the live-smoke retest: reproduce the exact `##
Reset` fast-path condition (a Dolt remote auto-derived from git `origin` that has
never had anything pushed to it -- zero branches) against a real sandbox and a real
`node dist/index.js workflow ... --issue gh-toy-4ef ...` run, and assert the
preflight D-pull is a benign no-op (not `DOLT_SYNC_FAILED`) and the sprint reaches
Planning.

Ran integ-test-playbook.md's `## Setup` (fresh sandbox HOME
`~/temp/.apra-fleet-tests-eft633`, scratch port `18706` to avoid colliding with an
already-running sandbox on this machine, `node dist/index.js install`/`start`, toy
repo clone, sandbox-local git mirror + Dolt remote via
`scripts/sandbox-seed-beads.mjs`, `check-sandbox-sync-remote.mjs` all-OK), then `##
Reset` (`git reset --hard origin/main`, `git clean -fdx`,
`sandbox-seed-beads.mjs --mode reset`) -- the exact sequence the bug's repro steps
specify.

Note on workflow name: the bead's repro text says `workflow auto-sprint`, the name
in use when eft.63 was filed (2026-07-22). This branch has since renamed/restructured
that workflow to `fleet-sprint` (same as noted in apra-fleet-eft.65.8's evidence doc)
-- `workflow --list` in the sandbox shows only `fleet-sprint`/`hello-world` as
installed workflows, `auto-sprint` is not present. Ran the equivalent current command:

```
node dist/index.js workflow fleet-sprint --issue gh-toy-4ef --members toy-doer \
  --branch smoke-test-canary --base main --max-cycles 1 --dispatch-timeout-s 900
```

Credentials for `toy-doer` were provisioned per the playbook's step 3a/3b, using the
same bare-token workaround documented in the eft.74/eft.65 evidence docs
(`INTEG-TOY-DOER-TOKEN-RAW` seeded from the runner's bare `$CLAUDE_CODE_OAUTH_TOKEN`,
then `auth --oauth --member toy-doer secure.INTEG-TOY-DOER-TOKEN-RAW`), verified with
`scripts/check-toy-doer-credentials.mjs toy-doer "$SANDBOX"` (both env-var and
clean-env probe paths OK) before dispatch.

## Manual repro of the underlying condition (control)

Before running the workflow, confirmed the Reset-derived remote is genuinely empty,
reproducing the original eft.63 bug's raw signature directly:

```
$ bd dolt pull
Pulling from Dolt remote...
Error: fetch from origin/main: Error 1105: fetch failed: no branches found in remote 'origin'
```

## Live evidence (this run)

`node dist/index.js workflow fleet-sprint ...` output, annotated:

```
[Command API Error] [Command Failed] Exit code 1: Exit code: 1
Pulling from Dolt remote...

[stderr]
Error: fetch from origin/main: Error 1105: fetch failed: no branches found in remote 'origin'

[Workflow Log] [Dolt] D-pull for member 'toy-doer' skipped: dolt remote has zero      <- eft.63.1's fix: the raw
branches (nothing pushed yet, nothing to pull)                                       <-   Error 1105 is caught and
                                                                                       <-   reclassified as a benign
                                                                                       <-   no-op, NOT DOLT_SYNC_FAILED
=== Group: Sprint Setup ===
--- Phase: Ensure Sprint Branch ---
[Command API Error] [Command Failed] Exit code 128: Exit code: 128
[stderr]
fatal: couldn't find remote ref smoke-test-canary
[Workflow Log] [Dolt] D-pull for member 'toy-doer' skipped pre-attempt: bd-level sync.remote neutralized/absent -- no pull command issued

=== Group: Sprint Cycle 1 ===
--- Phase: Plan C1 R1 ---
[Workflow Log] [Sync] G-pull for member 'toy-doer': branch 'smoke-test-canary' does not exist on 'origin' yet (not pushed); skipping pull (nothing to sync down).
[Workflow Log] [Dolt] D-pull for member 'toy-doer' skipped pre-attempt: bd-level sync.remote neutralized/absent -- no pull command issued
[Dispatch] phase: Plan C1 R1 | member: toy-doer | label: none                        <- Planner dispatch reached
```

`ps` during this window confirmed a real dispatched Planner process, not just a log
line:

```
akhil  43722  claude --agent planner -p "[13xxc] ... " --model opus ...
```

running with `cwd=$SANDBOX/toy-repo` and the member's provisioned
`CLAUDE_CODE_OAUTH_TOKEN` exported into its clean-env shell.

No `Sprint failed: DoltSyncError` / `DOLT_SYNC_FAILED` line appears anywhere in the
run -- the sprint proceeded straight from the empty-remote preflight pull, through
"Ensure Sprint Branch" and "Ensure Sprint Branch" (a second, unrelated `fatal:
couldn't find remote ref smoke-test-canary` -- expected, since the sprint branch
itself has never been pushed either; this does not gate the preflight check under
test and does not abort the run), into `Plan C1 R1` with a live Planner dispatch.

The run was stopped intentionally once the Planner dispatch was confirmed live
(killing the workflow process and its dispatched `claude --agent planner` child) --
completing the full cycle through Develop/Review/Harvest is out of scope for this
bead (Harvest's `gh auth` gap is a separate open bug, apra-fleet-eft.64) and risks
burning the full 900s dispatch timeout for evidence already captured. Sandbox was
torn down after (`node dist/index.js stop` + `rm -rf` the sandbox HOME) per `##
Teardown`.

## Result

**PASS**: both assertions hold on `feat/sprint-service-1` at `926fca66`.

- The preflight D-pull against the genuinely-empty (never-pushed) auto-derived Dolt
  remote is a benign no-op success (`"D-pull for member 'toy-doer' skipped: dolt
  remote has zero branches (nothing pushed yet, nothing to pull)"`), NOT
  `DOLT_SYNC_FAILED`.
- The sprint reaches the Planning phase: a real `claude --agent planner` process was
  dispatched for `Plan C1 R1` against the toy repo, rather than the run aborting
  before Planner dispatch (the original eft.63 bug's exact failure mode).

This corroborates apra-fleet-eft.63.1's fix and apra-fleet-eft.63.2's mock-sprint
unit coverage with real, unmocked evidence against the real `bd` CLI and a real Dolt
remote.
