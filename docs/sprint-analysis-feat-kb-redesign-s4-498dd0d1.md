# Sprint Analysis: feat/kb-redesign-s4

Scope issue id(s): apra-fleet-b4g.67, apra-fleet-b4g.69.
Base branch: feat/kb-redesign.
Cycles run: 2.

## Progress

Closed-bead count history (per cycle evaluation): [9, 10].
High-water-mark closed count this sprint: 11.
Final closed count: 10.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- I reviewed the net diff feat/kb-redesign..feat/kb-redesign-s4 (132 files) against b4g.67 and every child of b4g.69. Build passes, the working tree is clean, and npm test exits 0: root vitest 414 files passed / 10 skipped, client/workflow/se/apra-pm 0 failures. contract:check is OK (26 tools).

What each bead shipped:
- .69.1: wrapTool (tool-registry.ts) refuses repo_path/repo/repo_remote_url on every kb_* tool with E-SCOPE-KEY-REMOVED (kb-removed-scope-keys.ts), and the client refuses them the same way (api.mjs). FULL-session E-SELF errors now name the cause and the fix (kb-self.ts). kb_context defaults to CONFIRMED+INFERRED; for members this is the bible merged with their own captures. kb_list accepts the old single-tier string. memory-contract schemas and fixtures are updated with it.
- .69.2: every pull, commit, push and reset in kb.mjs bibleAttempt checks the sprint branch first. gitSync.unpushedOnlyBible blocks a bible push that would also publish other commits; the real-git test 10 covers it.
- .69.3: update_member re-composes when the work folder moves. remove_member cleans up the member side before removing credentials and the key, and reports anything it could not clean.
- .69.4: release downloads have a time limit and are checked against SHA256SUMS, which ci.yml now publishes. The refusal of a full-install server is a typed full-install-running status, and E-FULL-INSTALL-RUNNING plus --force-stop-full-install are in place.
- .69.5: PowerShell and compose tests run only on win32 (describe.runIf(isWin)); kb_feedback FULL happy fixture added; finalVerdict.kb_discards has a description and minLength.
- .69.6: the CI gate is removed from the reviewer prompt; the final-review prompt says CI is out of scope; plan-reviewer has criterion 13; schema text is generic.
- .69.7: per-shell path quoting; memberFileExists uses test -f / -PathType Leaf.
- .69.8: user deny rules are kept (mergeDenyRules), the ledger is written before the MCP sync, the output gives a reason per member, and stale compose-owned fleetMcp statuses are cleared.
- .67: fleet_status lists every KB scope and works out bible drift from repo_path. The CHANGELOG section contains every required phrase, and all 11 entries have an Upgrade: line. Earlier CHANGELOG errors are fixed, and docs/member-fleet-mcp-wiring.md records the install source choices.

One finding, which does not block this epic: the member-install marker (install-guard.ts) is written only by installs from this change onward. A remote member installed by an earlier build has no marker, so its first automatic upgrade (memberInstallArgs passes --force but never --force-stop-full-install) is refused as full-install-running, and someone has to fix it by hand. The CHANGELOG Upgrade line does not mention this. Filed as a new task.

No KB promotion candidates were supplied, so nothing was promoted.

## Regression pass (once per sprint, informational)

Regression pass: skipped by launch option -- not run this sprint.
