# Sprint Analysis: feat/v05-m1-member-edit

Scope issue id(s): apra-fleet-i9ag.6.
Base branch: v0.5_dashboard.
Cycles run: 1.

## Progress

Closed-bead count history (per cycle evaluation): [10].
High-water-mark closed count this sprint: 12.
Final closed count: 9.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Reviewed the real net diff. NOTE: the local v0.5_dashboard ref was stale (8688e007); the true base is origin/v0.5_dashboard (2d6d5f31). Scoped review to the 10 sprint commits / 12 files via origin/v0.5_dashboard...feat/v05-m1-member-edit -- the stale ref inflated the diff to 476 files / 59k lines of already-merged unrelated PRs.

Verified green myself: npm run build exit 0; npm test all four suites -- vitest 368 files / 5403 tests 0 failed, apra-fleet-se 3833/0, apra-pm 468/0, apra-fleet-client 88/0. Matches the recorded closure evidence.

Per bead:
- 6.1 edit form: DONE. updateMember + UpdateMemberBody (api/members.ts), Edit member section, dirty-field-only body, onUpdated -> list refresh, verbatim error via role=alert. 4 tests.
- 6.2 compose inputs: DONE. composePermissions widened, own section (correctly removed from generic ACTIONS), client-side role/tags guard issuing zero fetch, NEVER_AUTO_GRANT rendered verbatim off the HTTP 200 text envelope. 4 tests.
- 6.3 unattended: DONE. list-members.ts/member-detail.ts emit it; FleetMemberFields + memberFieldGuards + fixtures updated; apra-fleet-client typedefs updated in the SAME change per CLAUDE.md, enforced green by client-server-typedef-parity.test.mjs. Read/write split (boolean false vs string false) is correct against update-member.ts:241.
- 6.5 harness: DONE. test/harness.ts shared by all 3 Members suites; findFieldInSection is section-scoped, fixing the ambiguous duplicate Tags label; LOCAL_MEMBER moved into fixtures and added to the drift guard.
- 6.4 re-sync drawer: IMPLEMENTED BUT DEFECTIVE -- reopening.

6.4 defect, verified with a standalone repro rather than inferred from the diff: Members.tsx load() re-points selected, and load(true) also runs on the 15s background poll, so buildUpdateBody's baseline moves while editState stays frozen -- editState is built once by the useState initializer and, because the drawer is keyed on selected?.id, never remounts or re-syncs. Any field changed on the server while the drawer is open therefore becomes spuriously dirty and the next save reverts it. Repro: open drawer, another operator renames the member, poll lands, operator edits ONLY tags -> POST body carries friendly_name local-one alongside the new tags, silently undoing the rename. That is exactly the clobber-a-concurrent-change harm 6.4's own description cited as motivation; the fix turned a harmless re-send into an active revert and dropped the precondition of a prior save. The buildUpdateBody comment claiming the baseline is stable for the whole life of this mount is now false and hides it. Fix direction: per-field touched flags instead of diffing against a moving baseline.

File hygiene: clean -- 12 files, all justifiable; no temp/scratch or tool config. The 3 non-ASCII chars in src/tools/member-detail.ts are pre-existing on the base, not introduced here.

kb_promotions: none -- no promotion-candidate block was supplied, and the apra-fleet/fleet MCP servers failed to connect, so KB and code_* tools were unavailable; fell back to diff reading, grep and a targeted repro.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Ran the full regression pass per regression-test-playbook.md at branch HEAD 2fef19d2e50f10b88cdde049cfd6aa98880ce8fe (feat/v05-m1-member-edit). Part 1 (real-bd unmocked apra-fleet-se suite, 283 files via scripts/run-integ-suites.mjs) completed with pass COMPLETE, elapsedWall=711s, cumFileTime=2424s, but 7 files failed: golden-transcript.test.mjs (snapshot divergence + non-determinism) cascaded into phase0-seams-facade.test.mjs, phase1-leaf-facade-completeness.test.mjs, phase3-dispatch-engine-completeness.test.mjs, and vcs-auth-extraction-facade.test.mjs; plus independent failures in mock-sprint-beads-identity.test.mjs (expect-beads mismatch messaging) and mock-sprint-parent-child-blocks-cycle-repair.test.mjs (bd dep add now hard-refuses the fixture's parent+blocks cycle). check-integ-suite-budget.mjs also flagged phase3-dispatch-engine-completeness.test.mjs at 540s over the 300s single-file budget. Every failure exactly matched an existing open [regression][carry-over]/[integ] bead with an established multi-sprint recurrence history (apra-fleet-zekq, apra-fleet-vwa2, apra-fleet-0aer, apra-fleet-eft.17), so each was updated with a recurrence note rather than filed as a duplicate -- no new bead was needed. Part 2 (sandbox smoke test) Setup succeeded fully (install, server start+port verify, toy-repo clone, sandbox-local git/beads isolation, supervisor boot with identity-checked readiness), but Test scenario step 3a (seeding the sandbox's persistent secret store from the runner's own ambient Claude credential) was denied by the Claude Code auto-mode classifier (reason: [Secret-Store Writes]) -- a known, recurring block (apra-fleet-j48h, open since 2026-08-19) that is a dynamic runtime classifier layer separate from the static permissions.allow coverage verified at Step 0. Per this repo's CLAUDE.md policy, no workaround was attempted; steps 1/2/3b/4/5 never executed. Teardown was run per the mandatory pass-or-fail rule; its final supervisor-liveness check false-reported 'still alive' immediately after a clean shutdown (the known, already-tracked apra-fleet-5mu3 race), confirmed via manual ps/curl re-check as already dead, and the remaining Teardown steps (marker cleanup, lock release, server stop, dolt reap, sandbox rm -rf) were completed manually and verified clean -- no stray processes or held ports remained. The leftover sandbox-deploy sweep for this sprint's own reservation id (apra-fleet-i9ag.6-6fb3fe77-1655-40bd-ad7a-7052f48098c4) found nothing to tear down. Both j48h and 5mu3 were updated with recurrence notes; no new bugs were filed this run (bugsFiled is empty because every failure was a confirmed duplicate of an existing parent-less carry-over bead, updated in place). This result is entirely informational: it does not gate this sprint's PASS/FAIL verdict, and every failure here is pre-existing breakage carrying over to a future sprint via the existing open beads.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
