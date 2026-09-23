# Sprint Analysis: fix/v043-planner-and-member-prep

Scope issue id(s): apra-fleet-i4ku.
Base branch: main.
Cycles run: 2.

## Progress

Closed-bead count history (per cycle evaluation): [16, 19].
High-water-mark closed count this sprint: 20.
Final closed count: 19.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Reviewed the net diff main..fix/v043-planner-and-member-prep (44 files, +7957/-91) against apra-fleet-i4ku and all 18 children; every bead is traceable to specific lines, not just to a closed status.

GATES (all run by me, this branch, HEAD 24a80025): npm run build exit 0; root npm test 341 files / 4851 tests pass, 0 fail; packages/apra-fleet-se suite 4123 pass / 0 fail (plus 468 pass / 0 fail); scripts/check-generic-boundary.mjs OK (84 files); all added lines ASCII-only; no temp/tool/config files in the diff (.fleet/sweep-config.json is target-owned data, docs/sprint-analysis-*.md has precedent).

VERIFIED PER BEAD: i4ku/.1/.2 -- replan.mjs threads perBeadFeedback read-only; prompts.mjs adds exported REPLAN_FINDINGS_MAX_LENGTH=4000, deterministic truncation with a visible marker, a code-reviewer.findings untrusted block (not plan-reviewer.notes), and the 'read the ... findings below' clause is now conditional; replan-findings-prompt.test.mjs drives runReplanPhase, not buildPlannerPrompt. .3 -- I independently ran the generated kill command against a nonexistent pid under both /bin/sh and /bin/bash: output parses as {gone:[pid],failed:[]}, so the benign race no longer raises StrayProbeError; permission-denied and missing-status paths stay loud (safety-matrix tests 480-531). .4 -- win32 probe emits every row with a '-' sentinel, no Where-Object drop. .5 -- DEFAULT_MIN_AGE_MS 60s, unknown age blocks a kill. .6 -- KB contract test now scans the section body for unconditional imperative tool calls, paragraph-collapsed. .7/.10/.14 -- --sweep-config chain closed: sweep-config.mjs loader -> buildSprintArgv -> resolveSweepConfig -> validateArgs -> runner -> runSweepStep, with round-trip and omission pins. .8 -- SPECIAL_PARAM_RE covers $? $! $$ $# $@ $* $0-$9 with documented exclusions, and buildKillCommand carries an annotated carve-out. .9 -- killed/alreadyGone split, summary line accounts for both. .11 -- sweep failure is a loud per-member FAILURE and continues; only StrayProbeError is contained, engine defects still propagate. .12/.16 -- kind flows through the seam into memberPrepExecLabel, with a source-text pin on the runner adapter. .13 -- MemberUnreachableError raised before provision_llm_auth. .17/.18 -- liveness armed by default, unevaluable spares, portless candidates classified per candidate (not per pass) and reported as unchecked.

NOTE: one local repro (a permission-denied kill against a root-owned pid) was blocked by the sandbox permission layer; I surfaced rather than worked around it. That path is covered by unit fixtures instead.

NON-BLOCKING FINDINGS filed as newTasks: (1) the CHANGELOG 'Carried forward as backlog' paragraph is stale -- all four gaps it lists were fixed later on this same branch; (2) the cli.mjs --sweep-config help text is garbled by the liveness insertion and cli-reference.md omits livenessProbe; (3) the liveness probe only asks 127.0.0.1, so a live process bound to a non-loopback interface reads as dead; (4) sweep-config validators silently ignore unknown top-level keys, so a typo'd productionPorts quietly removes port protection.

No bead needs reopening: each closure is backed by code plus a test in this diff.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Ran the full regression pass against branch HEAD 24a800256f4e3983d9167540fbf0532846848315. Part 1 (real-bd suite, node scripts/run-integ-suites.mjs --fresh/--start, chosen over resuming a stale prior-session run whose recorded results predated this branch's HEAD commit): 275/275 files completed, 7 failures -- golden-transcript.test.mjs (snapshot diverged + non-deterministic transcript) cascading into phase0-seams-facade.test.mjs, phase1-leaf-facade-completeness.test.mjs, phase3-dispatch-engine-completeness.test.mjs, and vcs-auth-extraction-facade.test.mjs, plus mock-sprint-beads-identity.test.mjs and mock-sprint-parent-child-blocks-cycle-repair.test.mjs; check-integ-suite-budget.mjs also flagged phase3-dispatch-engine-completeness.test.mjs at 547s (over its 300s single-file budget). The slow lane (npm run test:slow) then ran: dispatch-watchdog-timer-ref.test.mjs passed, mock-sprint-planner-dispatch-stalled-session.test.mjs failed with a bd-replay recording-drift error. Every one of these failures exactly matches an existing open [regression][carry-over] bead (apra-fleet-zekq, apra-fleet-vwa2, apra-fleet-0aer, apra-fleet-5jlr) with a long history of recurrence across prior regression passes, so no new duplicate beads were filed -- each was updated with a recurrence-confirmation comment instead, per the playbook's dedupe instruction. Part 2 (smoke test): Setup completed cleanly (install, sandbox server start on port 18700 with port-binding verified via server.json, toy-repo clone + sandbox-local git/Dolt remote isolation verified via check-sandbox-sync-remote.mjs, supervisor boot on port 18701 with identity-checked readiness). The Test scenario was blocked at step 3a: the Claude Code auto-mode classifier denied the documented credential-provisioning command ('node dist/index.js secret --set ... --persist') with reason '[Secret-Store Writes]'. Per this repo's CLAUDE.md policy, no workaround was attempted; steps 1/2/3b/4/5 never ran this cycle. This is an exact, long-recurring match for existing open bead apra-fleet-j48h, updated with a recurrence-confirmation comment rather than a new duplicate. Teardown (supervisor stop, lock release, fleet-server stop, dolt-sql-server reap, sandbox rm -rf) ran to completion and verified clean; a leftover sandbox-deploy sweep for this sprint's reservation id found nothing to tear down. Separately (not a product regression): this run's own step 3a script initially issued a 'git config --global' call without re-exporting HOME=$SANDBOX in that same Bash invocation -- since environment variables do not persist across separate tool calls in this harness, it briefly overwrote the real operator's ~/.gitconfig user identity; this was caught immediately and the real identity (Akhil Kumar <akhil.kumar@gmail.com>) was restored before Setup continued, and is noted on apra-fleet-j48h for traceability. This entire result is informational: it does not gate the current sprint's PASS/FAIL verdict, and all listed failures carry over to a future sprint via their existing parent-less [regression][carry-over] beads.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
