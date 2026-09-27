# Sprint Analysis: feat/v05-m1-supervisor-launcher

Scope issue id(s): apra-fleet-i9ag.2.
Base branch: v0.5_dashboard.
Cycles run: 3.

## Progress

Closed-bead count history (per cycle evaluation): [6, 12, 17].
High-water-mark closed count this sprint: 21.
Final closed count: 17.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
Integration test failures (1): C2: Integ test runner failed to return a schema-valid report after repair attempts: [Workflow Error] LLM returned non-compliant JSON. Validation failed after 3 attempt(s) (2 repair(s) exhausted): Candidate 1: schema validation failed: data must be object (bugs filed: none)

## Reviewer-proposed newTask rejections

None.

## Final verdict

FAIL -- Code is strong and all 7 beads are implemented in the net diff (v0.5_dashboard..branch, 13 commits, 34 files). Verified independently: build green; full `npm test` green (vitest 3857 pass/0 fail; node:test 468/0 and companions; TEST_EXIT=0); `node scripts/check-pack-size.mjs` OK (8,750,015 of 10,000,000 B); check-generic-boundary OK; `npm pack --dry-run` DOES list packages/apra-fleet-se/src/supervisor/server.mjs; `resolveNodeExecutable` = 0 hits tree-wide; SEA staging already carried src/ via collectPackageTree(packages/apra-fleet-se,'fleet-sprint') in scripts/gen-sea-config.mjs:199, so gap #2 needed only the package.json files entry. Launcher contract re-checked against the real serve.mjs (exports serveMain(argv)->{exitCode}; isMainModule() is undefined-safe), so the no-double-boot design in src/cli/supervisor.ts holds. Windows exit-128 tolerance verified with a standalone repro (execFileSync sets err.status and appends stderr to message). Test quality is high and criteria-aligned (ordering, multi-pid, loud-vs-tolerated, mcp-server isolation, real e2e health-200/401/single-listener/shutdown-0). File hygiene clean.

BLOCKER (reopening apra-fleet-i9ag.2.3): docs/install.md lines 95-121 -- a section ADDED by this sprint -- contradicts the behaviour this sprint shipped, on three counts: (a) the table row says the supervisor unit runs `<node> ~/.apra-fleet/workflows/fleet-sprint/bin/serve.mjs`, but it now runs `<binary> supervisor` with no node path (i9ag.2.3 criterion); (b) 'The installer resolves an absolute node path at install time and bakes it into the unit' describes resolveNodeExecutable(), which this sprint DELETED; (c) 'Supervisor registration is non-fatal: if serve.mjs or node cannot be found, install warns and continues' is the exact inversion of the headline criterion ('none of them prints an advisory and exits 0'); src/cli/install.ts:1745 now process.exit(1). The same wrong text is in llms-full.txt (lines 1145/1164/1170), so agents consuming it will mis-diagnose a failed install. Other docs (SKILL.md, getting-started, supervisor-setup-guide, project-model.md) were updated correctly -- only install.md was missed. Doc-only fix; regenerate llms-full.txt after.

Secondary findings filed as newTasks (not blocking the stated criteria): macOS stop->start cannot restart the supervisor (bootout unloads the job; kickstart then fails, downgraded to a warning); `apra-fleet stop` lacks the non-default-instance guard `apra-fleet start` has, so an overridden instance stops the machine-global supervisor; pack-size headroom now 12.5%. The supervisor WorkingDirectory/beads gap is already tracked by apra-fleet-n88b -- no new bead needed. The C2 integ failure was a runner schema/JSON fault, not a product defect.

KB/code-intelligence tools unavailable this round: the apra-fleet MCP server failed to connect (ConnectionRefused), so no kb_session_prime/code_impact was possible and no promotion candidates were supplied; fell back to diff reading, grep and standalone repros.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Ran the full regression pass at branch HEAD 7babc82999011ca42ff6e3b6becd0abfd0b7bac1. Part 1 (real-bd suite, resumed to pass COMPLETE, 285 files) had 7 failing files plus 1 slow-lane failure, all pre-existing recurrences of already-open carry-over/integ beads (zekq, vwa2, 0aer, eft.17, 5jlr), updated with this run's evidence -- no new bugs needed. Part 2's Setup fully succeeded but the Test scenario's step 3a credential-provisioning command was denied by the Claude Code auto-mode classifier, a recurrence of already-open apra-fleet-j48h; per this repo's CLAUDE.md no workaround was attempted, so the smoke test could not proceed past step 3a. Teardown ran to completion and the sandbox is fully torn down. This result is informational only and does not gate the current sprint's verdict; all identified failures carry over to a future sprint via their existing parent-less beads.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
