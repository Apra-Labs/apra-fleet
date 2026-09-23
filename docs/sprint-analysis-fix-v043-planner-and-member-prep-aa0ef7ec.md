# Sprint Analysis: fix/v043-planner-and-member-prep

Scope issue id(s): apra-fleet-i4ku, apra-fleet-9jmc, apra-fleet-9be4.
Base branch: main.
Cycles run: 1.

## Progress

Closed-bead count history (per cycle evaluation): [18].
High-water-mark closed count this sprint: 20.
Final closed count: 18.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Reviewed net diff main..fix/v043-planner-and-member-prep (16 commits, 28 files, +4538/-89) against the three scope beads. Gates: npm run build OK; root npm test 341 files pass / 0 fail; packages/apra-fleet-se npm test 4075 pass / 0 fail; check-generic-boundary.mjs OK (84 files); added lines are ASCII-only; no temp/tool files in the diff.

i4ku (scoped-replan findings) - IMPLEMENTED. phases/replan.mjs reads perBeadFeedback (read-only) into a per-bead findings block; prompts.mjs adds REPLAN_FINDINGS_MAX_LENGTH=4000 with a visible truncation marker, and emits the 'read the code reviewer findings below' clause only when findings are non-blank. test/replan-findings-prompt.test.mjs drives the real runReplanPhase (not buildPlannerPrompt directly) for all 3 ACs. NOTE: parent bead apra-fleet-i4ku is still OPEN at P1 though every child is closed and its ACs are met by this diff - the '0 open at goal priority' evidence line is inaccurate; closing it is bookkeeping, not further work.

9jmc (planner KB contract) - IMPLEMENTED; premise verified independently: src/providers/claude.ts:504 composePermissionConfig sets mcpServers {'apra-fleet': {disabled:true}}. planner/plan-reviewer/deployer/integ-test-runner/regression-test-runner Step 0 now lead with the engine-injected block (heading text matches kb.mjs:677 verbatim) and mark tool calls bonus-only; the kb_captures instruction is gone. test/kb-prompt-contract-wrapper-roles.test.mjs derives the role set from role-policies.mjs (non-vacuous, dedupes the scoped-replan aliases) and checks heading, body imperative, and captures.

9be4 (member prep) - IMPLEMENTED. New phases/member-prep.mjs + member-stray-sweep.mjs, both registered in GUARDED_MODULES, phase pinned first in phase-sequence-order.test.mjs. The kill decision is pure and each of the five predicates (remote-only, path/flag evidence never name-only, parent-gone, production-port, min-age) is asserted separately; failure paths are traced and covered - ESRCH tolerated, permission-denied stays loud, missing status line counts as failure, relay treated as local. AUTH_OK_STATUSES matches src/tools/list-members.ts getAuthStatus() exactly ('oauth' / 'api-key' / 'api-key (warn: oauth)'), and the llm_auth/type/os field names match its JSON output.

Four non-blocking findings filed as newTasks: (1) no launch path supplies --sweep-config and supervisor buildSprintArgv has no passthrough, so the sweep ships dormant and the motivating stale-Windows-supervisor case is still unswept; (2) a sweep probe/kill failure throws StrayProbeError straight out of runMemberPrepPhase and aborts the whole sprint, while only the auth abort was specified; (3) the runner's execCommand label says 'stray-process probe' even for kill dispatches; (4) an 'offline' remote member is reported as 'LLM auth cannot be provisioned'.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Ran the full regression pass against regression-test-playbook.md at branch HEAD cfd521c2cb5ce14727e4118f58a46d839e245f79. Part 1 (the real-bd apra-fleet-se suite via scripts/run-integ-suites.mjs, resumed from an earlier same-day stale status file per its own documented recovery path) completed with pass COMPLETE, 273/273 files done, 7 failures: golden-transcript.test.mjs (snapshot divergence + non-determinism, cascading into phase0-seams-facade, phase1-leaf-facade-completeness, phase3-dispatch-engine-completeness, and vcs-auth-extraction-facade via their nested golden-transcript sub-suites), mock-sprint-beads-identity.test.mjs (expect-beads mismatch messaging echoes the actual identity instead of the configured expectation), and mock-sprint-parent-child-blocks-cycle-repair.test.mjs (real bd hard-refuses the 2-node parent+blocks cycle fixture setup outright). check-integ-suite-budget.mjs also flagged phase3-dispatch-engine-completeness.test.mjs at 543s over its 300s single-file budget. Every one of these failures is a long-recurring, already-tracked carry-over defect (apra-fleet-zekq, apra-fleet-vwa2, apra-fleet-0aer, apra-fleet-hhjh, each with a long history of confirmed recurrences); a duplicate-search per the playbook found all of them already open, so recurrence comments were appended to each rather than filing new beads. Part 2 (the sandbox smoke test) completed Setup cleanly end to end (install, port guards, server boot with verified port 18700, toy-repo clone plus sandbox-local git/Dolt mirror wiring, sandbox beads seeding and isolation verification, supervisor boot with identity-checked readiness) but was blocked at Test scenario step 3a (credential provisioning): the Claude Code auto-mode permission classifier denied the step-3a commands under a Secret-Store-Writes/Credential-Exploration category before they could run. This is a well-documented, near-every-run recurrence of open bead apra-fleet-j48h (open since 2026-08-19); per this repo's CLAUDE.md policy to surface permission blocks rather than route around them, no workaround was attempted, so steps 1/2/3b/4/5 of the Test scenario never executed this cycle. A recurrence comment was appended to apra-fleet-j48h rather than filing a duplicate. Teardown (supervisor shutdown, sandbox-lock release, server stop, dolt-sql-server reap, sandbox rm -rf) ran afterward per the playbook's mandatory pass-or-fail rule and was confirmed clean -- the sandbox path no longer exists. This entire result is informational only: it does not gate the current sprint's PASS/FAIL verdict, and all findings (none newly filed; all matched to existing open carry-over beads) carry over to a future sprint.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
