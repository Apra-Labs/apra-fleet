# Sprint Analysis: feat/v05-s1-groundwork

Scope issue id(s): apra-fleet-ky2l.
Base branch: v0.5_dashboard.
Cycles run: 5.

## Progress

Closed-bead count history (per cycle evaluation): [14, 14, 21, 22, 22].
High-water-mark closed count this sprint: 24.
Final closed count: 22.
Final open-at-goal-priority count: 3.

## Deploy/Integration outcomes

Deploy failures (1): C2: Deployer dispatch failed: [Workflow Error] Agent dispatch failed (auth): Authentication failed on "fleet-lin1". Run /login to refresh your credentials, then run provision_llm_auth to deploy them to this agent.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

FAIL -- FINAL REVIEW apra-fleet-ky2l (v0.5_dashboard..feat/v05-s1-groundwork, 72 files, +5735/-173). Build passes; npm test is RED: 2 failed / 326 passed test files (185s). Epic AC 'npm test green on the branch' is unmet, so FAIL regardless of the 22 closed beads.

Failures (both confirmed by running the suite, both already tracked as OPEN P1 beads):
1. tests/integ-playbook-permission-profiles.test.ts: 095cac8c added 'curl' to integ-test-playbook.md ## Permissions but skills/fleet/profiles/base-reviewer.json + node.json reviewer stack grant no Bash(curl:*) (only base-dev.json has it). -> ky2l.9.
2. tests/sandbox-deploy.test.ts 'smoke with dist but /ui returns 404': sets APRA_FLEET_PORT=stub.port+1 so smoke() throws at the /health check (sandbox-deploy.mjs:544) before the /ui probe; the 404 branch at :562 is untested. -> ky2l.10. NOTE ky2l.4.2 was closed although its AC requires exactly this case to pass (reopened below).

Other open goal-priority work: ky2l.11 (P2) confirmed -- deploy.md Step-2 notes and integ-test-playbook.md:30 say '<sandbox>/.apra-fleet/fleet.key' but resolveServiceToken (auth.mjs) and jwt.ts KEY_PATH resolve the REAL os.homedir(); the regression playbook curls correctly use $HOME/.apra-fleet/fleet.key. Also root package.json lost its trailing newline (921b6534) despite the epic's 'root package.json is NOT touched here' rule.

Deploy phase failed in C2 (member auth on fleet-lin1) -- infra, not code; live evidence for ky2l.2/ky2l.4 came from a later successful sandbox.

What is verified good: auth.mjs (fleet.key preferred, private/token fallback, 0600 enforced, torn-write race documented, path-normalized requiresAuth fail-closed, constant-time compare); server.mjs 127.0.0.1 bind + pre-dispatch 401 (guard is skipped only when no token/dataDir configured -- bin/serve.mjs always supplies one); dashboard GET / hands the token out only as an HttpOnly SameSite=Strict cookie; api.mjs sync boolean validation -> extraArgs ['--sync'] and ledger persistence; coordination clients + spawner env FLEET_SE_SERVICE_TOKEN; check-foreign-sprints treats 401 as exit 1 not 'no sprints'; ci.yml build:ui --if-present in both jobs; check-generic-boundary per-entry ids filter with skills dir, no tracker ids left in skills/*/SKILL.md; fleet-integrator SKILL.md generic + integration-gate-status.mjs read-only with fixture tests; list_members json empty-registry envelope + preamble-skip (54d1aa7f/e739286f) implemented and pinned although ky2l.7.1/7.2 are still OPEN -- doer should close them, work is on the branch.

Secondary: README.md, llms-full.txt, packages/apra-fleet-se/docs/architecture.md and CHANGELOG.md still describe the token as minted under <data-root>/private/token; after DQ-20 fleet.key is the preferred source (only fleet-supervisor SKILL.md says so). kb_promotions: none (no candidate block supplied).

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: apra-fleet-vwa2.
Summary: Ran the full regression pass at branch HEAD e739286f96980e306b00710054c124c1048e6eed. Part 1 (real-bd suite, 277 files + 2 slow-lane files): 7 files failed in the main suite (5 share one root cause -- an un-normalized bd 'revision' field breaking golden-transcript determinism, already tracked as apra-fleet-zekq and updated with today's evidence; mock-sprint-parent-child-blocks-cycle-repair.test.mjs already tracked as apra-fleet-0aer and updated; mock-sprint-beads-identity.test.mjs is new, filed as parent-less apra-fleet-vwa2) plus the slow lane's mock-sprint-planner-dispatch-stalled-session.test.mjs (already tracked as apra-fleet-5jlr, updated -- now fails even earlier than before). Part 2 (sandbox smoke test): Setup completed fully, but the Test scenario was blocked at step 1 (register-member) by the Claude Code auto-mode classifier's Secret-Store-Writes denial -- a recurring, already-tracked issue (apra-fleet-j48h, updated), surfaced per policy rather than routed around, so steps 2 through 5 never ran. Teardown was run to completion regardless (hit and recovered from one transient false-positive in the supervisor-stop check), and the sandbox was fully cleaned up. This result is informational only: it does not gate the current sprint's PASS/FAIL verdict, and every failure/bug filed here (all pre-existing, none newly introduced by this sprint) carries over to a future sprint for someone to actually fix.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
