# Sprint Analysis: feat/v05-s5-console-auth-proxy

Scope issue id(s): apra-fleet-iywi.
Base branch: v0.5_dashboard.
Cycles run: 4.

## Progress

Closed-bead count history (per cycle evaluation): [12, 16, 23, 25].
High-water-mark closed count this sprint: 30.
Final closed count: 25.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Reviewed the net diff v0.5_dashboard..feat/v05-s5-console-auth-proxy. The base branch trails the merge-base, so the raw range pulls in 404 files of already-merged PRs; this sprint's own work is b009a4f1..HEAD = 27 files / +4685 (console auth guard, /ext reverse proxy, workflow-package registry, permissions denylist). That is what I reviewed.

Build: npm run build clean. Tests: bounded npm test EXIT=0 -- vitest 352 files, 5074 passed / 55 skipped / 0 failed; apra-fleet-se 3663 and 468 pass, 0 fail; apra-fleet-client 80 pass, 0 fail (that lane is new from iywi.6 and I confirmed it actually executes, not just that it was added). No tracked working-tree changes, no temp/tool-config files in the diff, and deploy.md plus the shell-pages route files were untouched, so wave-2 file ownership held.

Per-bead, with the lines that implement each:
- iywi.1: local-token.mjs lifted; supervisor auth.mjs imports and re-exports only the generic pieces, keeping requiresAuth/TOKEN_COOKIE_NAME local, so route policy did not leak across callers.
- iywi.2/.11: server.ts guards /api/* and non-GET /ext/*. The cookie carries HMAC(fleetKey, label), never the raw key -- load-bearing, since jwt.ts uses that same key as the member-JWT HMAC secret. iywi.11 gates the upstream credential on GET authentication; console-proxy.test.ts:780 proves an unauthenticated cross-origin GET reaches the upstream with zero credential headers, with a revert-pin.
- iywi.4: the SSE case (console-proxy.test.ts:224) is a real handshake -- the upstream awaits each event's arrival before writing the next, so a buffering proxy cannot pass it vacuously. The credential test asserts not-byte-equal to fleet.key, differing per package id, and that the raw key appears in no forwarded header.
- iywi.3/.9: one shared validateWorkflowPackageBaseUrlScheme is called from both the register route and the config reader; HTTP 400 is covered for ftp://, file:/// and scheme-less localhost:9000; the config path reports a distinct configError instead of aging into "offline".
- iywi.5/.7: denylist patterns are port-agnostic; deploy.md's two documented supervisor grants are still accepted, guarded by a non-vacuous "parses a non-zero number of bullets" check.
- iywi.8: tests/setup.ts fails closed when FLEET_DIR is not the isolated dir, with a second local guard before the delete/restore block.
- iywi.10: the outer try/catch makes handleConsoleRequest total, the false-return contract is asserted intact, and that commit touched only server.ts, so its "jwt.ts/http-transport.ts unmodified" criterion holds.

I traced failure paths rather than pattern-matching the diff. Two standalone repros: (a) Node's client parser rejects malformed upstream headers (HPE_INVALID_HEADER_TOKEN), so an upstream cannot smuggle a header that makes writeHead throw from the proxy's async response callback; (b) a client abort mid-SSE against the exact pipe shape in proxy.ts raises no uncaught exception. Both theoretical server-kill paths are closed.

No reopens. Five secondary findings are filed as newTasks; none blocks this epic's acceptance criteria.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Ran the full regression pass against branch HEAD 0050bbe587a29717df874d6c41d52b471bbc5bb1. Part 1 (real-bd suite via scripts/run-integ-suites.mjs, 279 files, plus the npm run test:slow slow lane): recovered from a stale prior-session status file via --fresh, then completed pass COMPLETE with 7 failures (golden-transcript.test.mjs snapshot divergence/non-determinism cascading into phase0-seams-facade, phase1-leaf-facade-completeness, phase3-dispatch-engine-completeness, and vcs-auth-extraction-facade; mock-sprint-beads-identity.test.mjs expect-beads mismatch messaging; mock-sprint-parent-child-blocks-cycle-repair.test.mjs bd dep add cascade-block errors) plus check-integ-suite-budget.mjs flagging phase3-dispatch-engine-completeness.test.mjs at 541s over the 300s single-file budget; the slow lane's mock-sprint-planner-dispatch-stalled-session.test.mjs also failed with a bd-replay recording-drift error. Every one of these failures exactly matches an already-open [regression][carry-over] or [integ] bead (apra-fleet-zekq, apra-fleet-0aer, apra-fleet-vwa2, apra-fleet-eft.17, apra-fleet-5jlr), so no new duplicate beads were filed -- each was updated with a dated recurrence note instead. Part 2 (sandbox smoke test): Setup completed cleanly (install, server boot on port 18700, toy-repo clone with sandbox-local origin mirror, beads DB seed and isolation verified, supervisor boot on port 18701 identity-checked), but Test scenario step 3a's credential-provisioning command (node dist/index.js secret --set ...) was denied by the Claude Code auto-mode permission classifier -- the exact known recurring block already tracked by open bead apra-fleet-j48h, updated with a recurrence note; per this repo's CLAUDE.md policy no workaround was attempted, so steps 1/2/3b/4/5 (member registration, canary check, sprint dispatch, closure assertion) never ran. Teardown ran regardless: the supervisor-stop check hit the known false-alive race (apra-fleet-5mu3, updated with a recurrence note) but manual verification confirmed the process and port were actually already down; lock release, server stop, dolt reap, and sandbox rm -rf all completed cleanly with no leftover processes and no sprint-scoped sandbox-deploy to sweep. This entire result is informational: it does not gate the current sprint's PASS/FAIL verdict, and every failure identified here is pre-existing breakage that carries over to a future sprint via its existing parent-less bead.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
</content>
