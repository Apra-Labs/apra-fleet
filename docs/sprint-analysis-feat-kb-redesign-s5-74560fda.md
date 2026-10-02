# Sprint Analysis: feat/kb-redesign-s5

Scope issue id(s): apra-fleet-b4g.56.8, apra-fleet-b4g.67.1.
Base branch: feat/kb-redesign.
Cycles run: 2.

## Progress

Closed-bead count history (per cycle evaluation): [3, 6].
High-water-mark closed count this sprint: 8.
Final closed count: 5.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

FAIL -- Net diff feat/kb-redesign..feat/kb-redesign-s5 reviewed (11 files). The build and full `npm test` passed locally (EXIT 0). The KB MCP server was unreachable, so no KB promotions were made.

apra-fleet-b4g.56.8 (clean member self-registration): PASS. `register-member --id` now passes `skipCompose` (src/cli/register-member.ts, src/tools/register-member.ts), so a member-side self-registration no longer needs the skill profiles a member install lacks. The design is stated in docs/member-fleet-mcp-wiring.md. `memberErrorDetail` keeps the start of the error, including the leading ERROR line, capped at 4000 chars (src/services/member-fleet-install.ts). The fresh-HOME integration test (tests/member-self-register-clean-home.test.ts) and the long-error tests are solid.

apra-fleet-b4g.67.1 (pre-marker member upgrade): FAIL. The bead is still OPEN and was never verified against a deployed build. Its first acceptance criterion is also not met in substance. The retry only fires when `fleetMcp.fleetInstalledAt` is set, and that field is new in this diff. It is stamped only by a successful install from this build. Any install from this build or stage 4 already writes the member-install marker (src/cli/install.ts:1910). So the real pre-marker members (installed by older builds) never carry `fleetInstalledAt`, never get the retry, and still need the manual `--force-stop-full-install` step. That is exactly the case the bead exists to fix. The happy-path test (tests/member-fleet-install-premarker.test.ts, `PRIOR_FLEET_INSTALL` = v0.4.2 plus `fleetInstalledAt`) uses a registry state no pre-marker build could have produced. The docs and CHANGELOG now say a manual step is needed for 'a member the fleet has no record of', which in practice means every pre-marker member. The second criterion (a human full install is never stopped) and the third (docs and CHANGELOG name the override) are met. The fix that would meet criterion 1 is its second option: treat a running server as member-owned when the member's OWN registry, queried through its installed binary, holds an entry with this member's uuid. Older builds created that entry through `register-member --id`.

Secondary findings:
(1) compose-permissions.ts overwrites `fleetMcp` (recordFleetMcpStatus on MemberConfigError) and clears it (`fleetMcp: undefined`), which wipes `fleetInstalledAt`.
(2) The client typedef `FleetMcpStatus` in packages/apra-fleet-client/src/client/api.mjs is missing the new `fleetInstalledAt` field that member_detail now returns. CLAUDE.md requires client updates in the same change.
(3) Behaviour change: a refused install over an older install now returns `full-install-running` instead of self-registering into it. The CHANGELOG covers this; it is noted for reviewers.

Hygiene: all changed files are justified by the two beads.

## Regression pass (once per sprint, informational)

Regression pass: skipped by launch option -- not run this sprint.
