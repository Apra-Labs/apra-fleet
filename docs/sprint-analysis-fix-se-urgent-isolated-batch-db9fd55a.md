# Sprint Analysis: fix/se-urgent-isolated-batch

Scope issue id(s): apra-fleet-fyc.2.
Base branch: chore/integration-binary-fixes-and-auth-selfheal.
Cycles run: 1.

## Progress

Closed-bead count history (per cycle evaluation): [10].
High-water-mark closed count this sprint: 10.
Final closed count: 10.
Final open-at-goal-priority count: 0.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Final review of fix/se-urgent-isolated-batch (base chore/integration-binary-fixes-and-auth-selfheal) for scope apra-fleet-fyc.2 (children fyc.2.1-2.6, all closed) plus the isolated-batch beads egc.1/3ik.2/mf7.2. Verified against each bead's acceptance criteria:

- fyc.2.1 (P2, repoint npm-publish CI gating off retired dist/fleet-sprint.mjs): .github/workflows/ci.yml Verify-shebang, Dry-run pack verification, and Pack+install smoke-test steps now target packages/apra-fleet-se/bin/cli.mjs + fleet-sprint/runner.js + workflow.json and exercise a real `npm install` + `apra-fleet install` + `apra-fleet workflow fleet-sprint --help` path. `grep dist/fleet-sprint .github/workflows/ci.yml` -> NONE remaining (only an explanatory comment referencing the retired name). Redundant scripts/smoke-test-runner-import.mjs correctly deleted with justification.
- fyc.2.2 (docs/npm-packaging.md refresh) and fyc.2.4 (reword so the 'dist/fleet-sprint' literal no longer trips the grep): confirmed, no literal remains in docs/npm-packaging.md.
- fyc.2.3 (npm-publish gating passes end-to-end): tests/integration/npm-publish-gate.sh replays the CI npm-publish job locally (clean dist/, npm ci, prepublishOnly, shebang, dry-run pack asserts, clean-pack guard) and correctly refuses to add --force around the running-process guard.
- fyc.2.5 (install running-process guard was machine-wide, false-positived isolated prefixes): src/cli/install.ts now scopes the guard to the install target root via getOtherApraFleetPids()/resolveRunningInstanceRoot() with a conservative fallback (unresolved or same root keeps the guard active) and adds an explicit --skip-running-check opt-out (registered in known-flags + help text).
- fyc.2.6 (unit tests for guard root-scoping): tests/install-running-guard.test.ts adds 13 cases covering isolated-prefix proceed, same-root block, --force, --skip-running-check at same/different/unresolvable root, and cross-platform resolution (Linux /proc, macOS `ps -o comm=`, Windows wmic). Error/edge paths covered.
- mf7.2: src/tools/compose-permissions.ts now reads and writes .claude/settings.json (the file Step 0 checkers read) instead of settings.local.json; tests updated (compose-permissions.test.ts, settings-permissions-step0.test.ts). egc.1: scripts/sandbox-lock.mjs mutex + tests/sandbox-lock.test.ts. 3ik.2: scripts/check-settings-permissions.mjs + tests/settings-permissions-step0.test.ts.

Test results: root vitest 2935 passed / 24 skipped (exit 0); apra-fleet-se node:test 1537 pass / 0 fail of 1539 (exit 0); apra-pm suite exit 0. `npm run build` exit 0. No lint script configured (npm run lint absent) -- not a regression. `git status --porcelain` empty; no temp/junk/tool-config files in the diff. Client-wrapper concern N/A: compose-permissions tool schema unchanged (internal write-target change only).

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: pass).
Carry-over beads filed: apra-fleet-m1n, apra-fleet-yru.
Summary: Ran both parts of regression-test-playbook.md against branch HEAD. Part 1 (real-bd suite): the main lane via scripts/run-integ-suites.mjs could not run at all -- --status exited 2 fail-loud because a leftover integ-suite-status.json from an earlier session referenced test files since renamed/retired, and per INTEG-SUITE.md's explicit 'do not continue' instruction I stopped rather than self-heal with --fresh, filing apra-fleet-m1n (P2). The slow lane (npm run test:slow) did run: dispatch-watchdog-timer-ref.test.mjs passed; mock-sprint-planner-dispatch-stalled-session.test.mjs failed on a known bd-replay recording-drift issue, so I updated the existing apra-fleet-t91 (not a new bead) rather than duplicating it. Part 2 (smoke test): Setup initially attached to a stale, 82-hour-old orphaned server (and a leftover toy-repo/member registration) from a prior run whose Teardown never executed -- I stopped that orphan, wiped the contaminated sandbox, and re-ran Setup cleanly so the smoke test genuinely exercised the fresh branch-HEAD install; filed apra-fleet-yru (P2) for the underlying gap (Setup's 'start' silently reuses a stale server with no version check). With a clean sandbox, the rest of Part 2 passed fully: toy-doer registered, credentials provisioned and verified, canary gh-toy-4ef confirmed open pre-sprint, fleet-sprint ran one cycle to a PASS verdict, the canary and its two children closed, the sprint branch carries real commits, and --version/-v on the built CLI printed 'fleet-e2e-toy v1.0.0' and exited 0 as expected. Teardown ran and fully removed the sandbox and lock afterward. This result is informational only -- it does not gate this sprint's PASS/FAIL verdict, and the two newly filed bugs (plus the reconfirmed apra-fleet-t91) carry over as pre-existing breakage for a future sprint to pick up.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
