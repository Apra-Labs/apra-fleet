# Sprint Analysis: feat/kb-redesign-s2b

Scope issue id(s): apra-fleet-b4g.55, apra-fleet-b4g.56, apra-fleet-b4g.61, apra-fleet-b4g.60, apra-fleet-hn0i.2.
Base branch: feat/kb-redesign.
Cycles run: 3.

## Progress

Closed-bead count history (per cycle evaluation): [10, 22, 27].
High-water-mark closed count this sprint: 32.
Final closed count: 27.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
Integration test failures (1): C1: I tested no features, closed two verify-set beads, filed one bug and tore down the sandbox. The three handed features (apra-fleet-b4g.60, apra-fleet-b4g.56, apra-fleet-hn0i.2) are not testable yet. Their implementation and [test] child tasks are all still open on a33a19b6, so there was nothing to run. I left them open and appended an 'inconclusive' note to each. I verified apra-fleet-b4g.55 and apra-fleet-b4g.61 against a33a19b6 and closed both. `npx vitest run tests/member-mcp-config-e2e.test.ts tests/code-self-http.test.ts` passed 2 files and 15 tests. `rg registerMcpEndpoint src` and `rg 'getActiveMemberId|inFlightAgents.size === 1' src` (test files excluded) each returned 0 matches. The client-server typedef parity test passed under `npm test`. Within `npm test`, the vitest suites passed 390 files and 5450 tests. The node:test suites that print a '# fail' summary all reported 0 failures. `npm test` itself still exited 1 because of one unrelated failure: the dist schema staleness guard reports a stale `planner-output.json`. I filed that as apra-fleet-b4g.55.5 under apra-fleet-b4g. I first parented it under apra-fleet-b4g.55, which blocked closing that bead, so I moved it. The sandbox was torn down with exit 0. (bugs filed: apra-fleet-b4g.55.5)

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Final review of feat/kb-redesign..feat/kb-redesign-s2b (159 files, +7827/-1390). I reviewed the net diff against the 5 scope beads.

b4g.55: compose_permissions now writes the per-folder apra-fleet entry with URL ?member=<uuid>. Claude gets it in LOCAL scope in ~/.claude.json or $CLAUDE_CONFIG_DIR/.claude.json, probed on the member. opencode gets it in <workFolder>/opencode.json, which is added to .git/info/exclude. agy gets no entry. Claude and agy deny rules are derived from MEMBER_DENIED_TOOLS. Legacy apra-fleet-member and {disabled:true} entries are pruned in pruneLegacyMcpEntries. removeComposedMemberConfig handles a provider switch. rg registerMcpEndpoint over src returns 0 matches.

b4g.61: resolveCodeSelf() is used by every code_* handler, and any repo key in the input is overwritten. E-CODE-INDEX-NOT-READY and E-CODE-INTEL-DISABLED are thrown as typed errors from code-intelligence-readiness.ts. The in-flight heuristic is gone (0 rg matches).

b4g.60: code_reindex and code_status are added, with analyze.log and status.json. Readiness now requires a non-empty lastCommit, no incrementalInProgress and no lock. indexedCommit is added on every code_* result through withIndexedCommit. The memory-contract v1 spec, schemas, fixtures and roster are updated in the same change, as are the client exports.

b4g.56: member-fleet-install.ts covers the install source choice (copying the SEA executable vs downloading the release asset vs unavailable), the member-mode install flags, the PowerShell $LASTEXITCODE probe, self-register, MEMBER-session verification and recoverable fleetMcp statuses. It is wired into register_member, update_member and remove_member. member_detail gains refresh; fleet_status never probes. Every acceptance criterion has a named test in tests/member-fleet-wiring.test.ts.

hn0i.2: the server counts calls per member uuid in member-call-counts.ts. Sessions with origin=engine are excluded; memberCall local and `apra-fleet call` set it. session_stats is allowlisted. dispatch-accounting.mjs takes before/after snapshots, and any count it cannot read is recorded as 'unknown', never 0. The sprint summary section and the Knowledge & Code Intel viewer tab are both tested.

Verification on this checkout: build OK. npm test exit 0: vitest 396 files / 5542 tests passed, and every node:test suite reported 0 failures. git status is clean.

The C1 integ failure (b4g.55.5, stale dist planner-output.json) did not reproduce here. dist is untracked, so it is a sandbox deploy artifact, not a branch defect.

The secondary findings below are filed as newTasks; none of them blocks acceptance. The KB MCP server was unreachable, so no KB promotions were made.

## Regression pass (once per sprint, informational)

Regression pass: skipped by launch option -- not run this sprint.
