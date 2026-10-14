# Sprint Analysis: feat/kb-redesign-s6

Scope issue id(s): apra-fleet-b4g.56.9, apra-fleet-b4g.56.10.
Base branch: feat/kb-redesign.
Cycles run: 1.

## Progress

Closed-bead count history (per cycle evaluation): [7].
High-water-mark closed count this sprint: 9.
Final closed count: 7.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Final review of feat/kb-redesign..feat/kb-redesign-s6 (4 commits, 10 files). I reviewed the whole net diff against both scope beads.

b4g.56.9 (update_member fleet_install): MET.
- src/tools/update-member.ts adds `fleet_install: z.enum(['auto','skip'])`. 'auto' now triggers refreshMemberFleetMcp even when nothing else changed, and installs only on non-local members. 'skip' turns the install off (and force-install off) even when the provider changed. Omitting it keeps the old provider-change-only default.
- src/services/tool-registry.ts registers update_member through registerTool with `updateMemberSchema.strict()`, so an unknown key fails at the MCP layer before the handler runs. scopeGatedServer now also gates registerTool. The test fallback to .tool() is fine.
- I checked the fleet-sprint caller (member-provisioning.mjs: `{member_name, unattended}`): it still passes the strict schema.
- FLEET_MCP_FIX lines for register-failed, install-too-old, install-unverified and member-tools-missing now name `update_member {member_id, fleet_install: "auto"}`.
- CHANGELOG Upgrade lines are updated, and a test checks them.
- The client typedef and api-reference are updated in the same change, as the client-parity rule requires.
- The tests use a real McpServer/Client over InMemoryTransport: an unknown key errors, the error names the key, and the registry is byte-identical afterwards.

b4g.56.10 (build-aware version check): MET.
- isMemberOutdated() in src/services/member-fleet-install.ts: an older core is always outdated, a newer core never is (no downgrade).
- At the same core, a different build counts as outdated only when the install source is the orchestrator's own executable. A release-asset source installs the release build, so treating it as outdated would reinstall every time and report install-unverified.
- The post-install verify uses the same rule.
- tests/member-fleet-install-build-suffix.test.ts covers: v0.4.4_aaaaaa member vs v0.4.4_bbbbbb orchestrator upgrades; newer cores (with and without suffix) are never downgraded; no-suffix releases behave as before; the release-asset no-loop case; and a unit table.
- The isNewer/parseVersion functions shared with the CLI self-update are unchanged.

Tests: build OK. vitest 427 files / 5929 tests passed; workflow 340/0, apra-fleet-se 3900/0, apra-pm 489/0.
- The first full `npm test` exited 1 because of one test in packages/apra-fleet-client/test/fleet-client-timeout.test.mjs:48 ('expected to wait at least 50ms, waited 49ms'). It is a timer-granularity flake: the file is untouched by this diff and passed 5/5 in isolation, and the client suite then passed 60/0.
- No lint script is configured.
- File hygiene: every file is justified by the scope.
- The KB/MCP fleet server was unavailable this session, so I made no KB promotions.

Secondary findings (filed as newTasks, none block this epic): the flaky timeout test, and untested paths (fleet_install skip together with a provider change; the early returns for a build-only difference when arch is unknown or no install source exists).

## Regression pass (once per sprint, informational)

Regression pass: skipped by launch option -- not run this sprint.
