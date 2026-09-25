# Sprint Analysis: feat/v05-s4-shell-pages

Scope issue id(s): apra-fleet-9h9j.
Base branch: v0.5_dashboard.
Cycles run: 3.

## Progress

Closed-bead count history (per cycle evaluation): [3, 9, 11].
High-water-mark closed count this sprint: 14.
Final closed count: 11.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

FAIL -- Reviewed the true sprint diff. NOTE ON BASE: local v0.5_dashboard (cecd3e07) is stale vs origin/v0.5_dashboard (cc105c14); merge-base is b009a4f1 (the prerequisite S2 UI-shell squash, #525, already on origin). The reviewed net diff is the 7 sprint commits 8a506d52..2791dc02 (24 files, +3956/-82). File ownership is CLEAN: no file under src/tools/, no src/types.ts, no src/console/server.ts.

VERIFICATION RUN (clean tree, all green): npm run build OK; npm run build:ui OK (tsc + vite, 42 modules); npx vitest run = 352 files / 5121 passed, 43 skipped, 0 failed (incl. console-routes-fleet 112, console-server 8, console-static 14, http-transport 29, and all 6 shell-ui suites); apra-fleet-se SUMMARY pass=4216 fail=0; apra-pm 468/468.

BLOCKING DEFECT (9h9j.2) -- Members table crashes after merge. The epic criterion says the owner column "renders the owner field when list_members json carries it". On the merge target origin/v0.5_dashboard that field NOW EXISTS and is an OBJECT: src/types.ts:74 `owner?: { package: string; ref: string }`, emitted at list-members.ts:125. packages/apra-fleet-shell-ui/src/api/members.ts declares `owner?: string | null` and Members.tsx:29 renders `row.owner ?? "(none)"` directly as a React child. Reproduced empirically with a throwaway jsdom test against Members.tsx using the real payload shape: React throws "Objects are not valid as a React child (found: object with keys {package, ref})" and the whole S1 screen unmounts (App.tsx has no error boundary). Aggravating: test/members.test.tsx:29 hardcodes `owner: "alice@example.com"`, so the suite certifies the wrong shape -- all three CI checks stay green through the merge and S1 white-screens in a browser. Fix is inside packages/apra-fleet-shell-ui/ (this sprint's own territory), e.g. render `${owner.package}@${owner.ref}`.

SECOND GAP (9h9j.2) -- member_detail has a route + route test but NO UI control. MemberDrawer.tsx renders type/OS/provider/auth-state off the already-fetched list row and never calls /api/fleet/member-detail, so the "route with a test AND a UI control with a test" criterion is unmet for that action. (The design doc s3.1 action table is not in this repo -- docs/planning/v05-dashboard/ holds only sprint-plan.md -- so I checked against 9h9j.1's explicit 18-method enumeration and the epic's own drawer wording.)

CLEAN: 9h9j.1 -- all 18 routes present and validated with each tool's own zod schema, thrown->400 / isError->422 mapping, credential responses built from an explicit whitelist, credential_store_set pins return_url. Checked the secret paths myself: provision_vcs_auth metadata passes a key allowlist and providers only emit a 4-char-truncated token (src/services/vcs/github.ts:71,103), so no value leaks. The SENTINEL assertions are non-vacuous -- tests/console-routes-fleet.test.ts:631 asserts the stub text CONTAINS the sentinel before 637/640 assert the response body does not. 9h9j.3 -- Secrets/Health match their criteria; health.test.tsx covers BOTH the 404 and the network-failure empty-state branches; secrets.test.tsx asserts no secret value in any request body or the DOM. kb_promotions: none -- I did not read scripts/run-all-tests.mjs this round, so no candidate was independently verified.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: apra-fleet-3dk4.
Summary: Ran the full regression pass at branch HEAD 2791dc02ebf40ccbc0f71d4830a855b32ce844a5. Part 1 (real-bd suite, 279 files + slow lane) completed with 10 failures in the main suite plus 1 in the slow lane; 9 of these matched existing open [regression][carry-over]/[integ] beads and were updated with recurrence notes, and one new failure (supervisor-guard-e2e.test.mjs GET / timeout under load, a recurrence of closed bead v6t7.7) was filed as standalone parent-less bead apra-fleet-3dk4. Part 2 (smoke test) completed Setup successfully but was blocked at Test scenario step 3a by the Claude Code auto-mode classifier denying the credential-provisioning command, matching existing open bead apra-fleet-j48h (updated, no workaround attempted per repo policy); Teardown and the sandbox-deploy sweep both ran cleanly regardless. This result is informational only and does not gate the current sprint's verdict; apra-fleet-3dk4 and all updated beads carry over to a future sprint.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
