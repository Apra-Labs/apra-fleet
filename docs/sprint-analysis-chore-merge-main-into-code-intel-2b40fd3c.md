# Sprint Analysis: chore/merge-main-into-code-intel

Scope issue id(s): apra-fleet-tm7.
Base branch: main.
Cycles run: 2.

## Progress

Closed-bead count history (per cycle evaluation): [5, 7].
High-water-mark closed count this sprint: 7.
Final closed count: 7.
Final open-at-goal-priority count: 0.

## Deploy/Integration outcomes

Deploy failures (2): C1: Missing permissions in the CLI permission settings (.claude/settings.json): Bash(gh run *), Bash(gh release *), Bash(mkdir *), Bash(rm -rf /tmp/fleet-deploy*), Bash(chmod +x /tmp/fleet-deploy*), Bash(*apra-fleet-installer-* install *), Bash(*apra-fleet* --version), Bash(npm ci), Bash(npm run build), Bash(npm run build:binary), Bash(dist/apra-fleet-installer-* install *). The project .claude/settings.json has no permissions.allow section at all. Add these to the permissions allowlist and re-trigger the deploy. No deploy commands were executed. | C2: Stopped at Step 0: .claude/settings.json has no permissions.allow section at all, so none of the command prefixes required by deploy.md's ## Permissions section are present. Missing permissions in the CLI permission settings (.claude/settings.json): Bash(gh run *), Bash(gh release *), Bash(mkdir *), Bash(rm -rf /tmp/fleet-deploy*), Bash(chmod +x /tmp/fleet-deploy*), Bash(*apra-fleet-installer-* install *), Bash(*apra-fleet* --version), Bash(npm ci), Bash(npm run build), Bash(npm run build:binary), Bash(dist/apra-fleet-installer-* install *). Add these to the permissions allowlist and re-trigger the sprint. No deploy commands were run.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

FAIL -- Code quality for apra-fleet-tm7 is good, but the sprint cannot pass: the deploy phase failed in BOTH cycles and the cause is still present in the repo.

VERIFIED GREEN
- Build: `npm run build` exit 0. No lint script is configured in package.json (build/test only).
- Tests: `npm test` -> 246 files / 3290 passed, 10 skipped, exit 0.
- tm7 implementation is real and matches the bug report's fix sketch: src/tools/kb-harvest.ts:104-105 now routes through `getKbProviders(input.repo_path)` (getKBService gone); src/services/knowledge/kb-service.ts reduced to file-hash re-exports; src/services/knowledge/kb-providers.ts:44-77 caches providers per resolved slug (storing the promise, so concurrent callers share one provider) with a single-slot global provider; src/index.ts:138-141 migrates `apra-fleet kb invalidate` off the deleted accessor; every kb_* tool gained an optional `repo_path`; src/services/knowledge/project-slug.ts:29-33 fixes the greedy `[^@]*@?` userinfo strip that collapsed plain-HTTPS remotes.
- Tests are proportionate and non-redundant: tests/knowledge/kb-harvest.test.ts:96-176 exercises the REAL getKbProviders with two temp git repos in one process (and explicitly `vi.restoreAllMocks()` to defeat the file-level mock, plus provenance assertions on repo B's own provider) -- that is exactly tm7.4/tm7.7's criterion; tests/execute-prompt-kb-harvest-repo-path.test.ts spies the harvest module rather than grepping source, covering local AND remote members; tests/knowledge/kb-single-accessor.test.ts is a source-level guard with an explicit CLI allowlist; tests/knowledge/kb-repo-isolation.test.ts:45-66 covers the HTTPS/SSH slug-parity edge case. FLEET_DIR is redirected to a per-run temp dir by tests/setup.ts, so these real-DB tests do not pollute a developer's ~/.apra-fleet.

BLOCKING
1. Deploy failed in cycle 1 and cycle 2 for the same reason, and it is still true at HEAD: .claude/settings.json contains only a `hooks` block -- there is no `permissions.allow` section at all, so none of the prefixes deploy.md requires (Bash(gh run *), Bash(gh release *), Bash(mkdir *), Bash(rm -rf /tmp/fleet-deploy*), Bash(chmod +x /tmp/fleet-deploy*), Bash(*apra-fleet-installer-* install *), Bash(*apra-fleet* --version), Bash(npm ci), Bash(npm run build), Bash(npm run build:binary), Bash(dist/apra-fleet-installer-* install *)) are grantable. Zero deploy commands were executed in either cycle; nothing on this branch has been shipped or smoke-verified end to end.

NON-BLOCKING GAPS (filed as newTasks)
2. Remote members are still not repo-routed. src/tools/execute-prompt.ts:796-809 passes `resolvedWorkFolder` unconditionally, but for a REMOTE member that path does not exist on the fleet server, so resolveProjectSlug (src/services/knowledge/project-slug.ts:15-24) falls through to the literal 'default' slug. Every remote member on every repo therefore harvests into one shared 'default' KB. The code comment calls this deliberate and acceptable, and it is strictly better than the old server-cwd collapse, but tm7's done criterion 1 ("a harvest on a member working in repo B writes to repo B's KB") is only proven for local paths -- tests/execute-prompt-kb-harvest-repo-path.test.ts asserts the argument, never the destination DB, for the remote case. No follow-up bead exists for it.
3. The single-accessor guard is textual only. tests/knowledge/kb-single-accessor.test.ts greps for `getKBService` and bare `getKbProviders()`; it does not catch a direct `new SqliteProvider()` with no dbPath, which still resolves the slug from process.cwd() (src/services/knowledge/sqlite-provider.ts:59). src/services/knowledge/http-provider.ts:52 does exactly that today.
4. Stale docs: docs/knowledge-layer.md:77 still calls `KBService` "the singleton factory" and line 439 still describes `KBService.getProvider()` as the provider-selection point. Both describe a class deleted in d238ca3. (The related inert-http-config issue is already tracked as apra-fleet-b6v -- not duplicated here.)
5. Working-tree hygiene: `git status --porcelain` is not clean -- HANDOFF-tm7.md and sprint-tm7-run4.log are untracked in the repo root. Not committed, so not in the diff, but they are sprint scaffold left behind and neither is gitignored.
6. Bookkeeping mismatch: the dispatch evidence says "0 bead(s) still open at or above goal priority P1/P2", but `bd show apra-fleet-tm7` reports the parent as OPEN at P1 with all 7 children closed. Worth confirming the parent is intentionally left open rather than missed.
7. Scope note (not a defect): commit bfc62e5 rewrites packages/apra-fleet-se/apra-pm/agents/reviewer.md (new Step 5 promote contract, Step 5 -> Step 6 renumbering, internally consistent). It belongs to the reviewer-KB work, not tm7, but it is coherent and self-contained.
