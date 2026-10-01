# Sprint Analysis: feat/kb-redesign-s1

Scope issue id(s): apra-fleet-b4g.53, apra-fleet-b4g.57, apra-fleet-b4g.54, apra-fleet-b4g.66, apra-fleet-b4g.62, apra-fleet-b4g.63, apra-fleet-b4g.18.1, apra-fleet-b4g.18.2.
Base branch: feat/kb-redesign.
Cycles run: 3.

## Progress

Closed-bead count history (per cycle evaluation): [15, 19, 25].
High-water-mark closed count this sprint: 31.
Final closed count: 25.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Final review of feat/kb-redesign..feat/kb-redesign-s1 (20 commits, 209 files). I read the net diff. Build passes and `npm test` exits 0: vitest 386 files / 5426 tests, client 43/0, workflow 321/0, apra-fleet-se 489/0, plus contract and generic-boundary checks. Tracked tree is clean. KB MCP tools could not connect, so no kb_promotions.

Scope beads, each checked against its criteria:
- b4g.53: member-tool-allowlist.ts is the single source, derived from REGISTERED_TOOL_NAMES by the kb_/code_ prefix rule plus version, report_status and session_stats. tool-scope.ts uses AsyncLocalStorage to pass the session member id. The tool-registry Proxy skips any tool outside the scope (deny by omission). An unregistered ?member= gets 403 in http-transport.ts. The agy lists are derived from the allowlist. Covered by member-session-scope.test.ts.
- b4g.57: src/cli/call.ts reads args from a file only and returns typed errors. member-call.mjs runs local calls in-process and remote calls via send_files + execute_command, with a charset-validated command string. Client connectFleetMember and close() send an HTTP DELETE.
- b4g.54: kb-self.ts resolves the member's work folder (FULL session -> server cwd) with typed E-SELF-* errors. repo_path/repo/repo_remote_url are removed from every kb_* schema and the contract. Engine KB calls go through memberCall. Tests are over real HTTP.
- b4g.66: reads default to CONFIRMED and undisputed; flagged_only is exempt; named callers pass confidence explicitly.
- b4g.62: --id is idempotent and returns E-FOLDER-TAKEN on a folder conflict.
- b4g.63: --member touches no user config and fails with E-MEMBER-AUTOSTART when no auto-start runs.
- b4g.18.1/.2: Step 0 in the role prompts is rewritten. The contract test imports the built allowlist and uses a pre-rewrite fixture to prove it is not vacuous.

Non-blocking findings (filed as tasks):
1. Remote members: KB calls now run `apra-fleet call` on the member, so until b4g.56 (still open) installs and registers apra-fleet there, every remote-member KB call fails, logged as non-fatal. Remote KB goes cold in the meantime, though the description of b4g.54 says engine KB behaviour is preserved. This is acceptable on the feature branch because b4g.56 and b4g.25 track it.
2. Short-lived tool-only ?member= sessions still register in sessionRegistry when no live channel session exists. They can briefly look like the member's online session, and closing them unregisters it.
3. The remote branch of resolveSelfAnchor (member not local -> knownRepoRemoteUrl) has no test.
4. The member allowlist includes write/admin KB tools (kb_setup writes the machine-wide provider config, plus kb_promote, kb_resolve_contradiction and kb_export with auto-commit). This matches the spec, but member sessions can mint CONFIRMED and reconfigure the KB.
5. README.md:225 and docs/knowledge-layer.md still document the removed repo_path/repo_remote_url inputs.
6. Each remote kb call costs one send_files plus one execute_command; captures are not batched.

## Regression pass (once per sprint, informational)

Regression pass: skipped by launch option -- not run this sprint.
