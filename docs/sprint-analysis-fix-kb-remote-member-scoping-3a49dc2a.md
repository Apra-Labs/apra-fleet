# Sprint Analysis: fix/kb-remote-member-scoping

Scope issue id(s): apra-fleet-b4g.
Base branch: feat/code-intelligence-abstraction.
Cycles run: 3.

## Progress

Closed-bead count history (per cycle evaluation): [8, 9, 9].
High-water-mark closed count this sprint: 11.
Final closed count: 9.
Final open-at-goal-priority count: 3.

## Deploy/Integration outcomes

Deploy failures (3): C1: Stopped at Step 0a (pre-flight permission check) -- did not execute any of the ## Deploy commands. Read deploy.md's ## Permissions section and merged .claude/settings.json + .claude/settings.local.json via the mandated node one-liner; the merged effective allowlist is: Read, Write, Edit, Glob, Grep, Bash(git:*), Bash(which:*), Bash(ls:*), Bash(cat:*), Bash(head:*), Bash(tail:*), Bash(mkdir:*), Bash(cp:*), Bash(mv:*), Bash(rm:*), Bash(find:*), Bash(wc:*), Bash(sort:*), Bash(diff:*), Bash(echo:*), Bash(touch:*), Bash(chmod:*), Bash(curl:*), Bash(tar:*), Bash(unzip:*), Bash(npm:*), Bash(npx:*), Bash(node:*), Bash(yarn:*), Bash(pnpm:*), Bash(tsx:*), Bash(gh:*). Four required prefixes from deploy.md's Permissions section have NO covering entry in this merged set: Bash(*apra-fleet-installer-* install *), Bash(*apra-fleet* --version), Bash(*apra-fleet* start), and Bash(dist/apra-fleet-installer-* install *) (the built installer invocation and the resulting apra-fleet start/--version calls). The other required prefixes ARE covered: node scripts/preflight-clear-build-locks.mjs, npm ci, npm run build, npm run build:binary via Bash(node:*)/Bash(npm:*), and the curl localhost:8787/api/sprints check via Bash(curl:*). Ask the orchestrator/operator to run compose_permissions to add the four missing grants (to .claude/settings.local.json, the correct per-checkout target -- not a hand-edit), then re-trigger deployment. No files were modified; no build or install commands were run. | C2: Stopped at Step 0a permission check before running any deploy.md commands. Merged effective allowlist (.claude/settings.json + .claude/settings.local.json, checked via the mandated node -e merge one-liner) does not cover 4 of the 9 required prefixes from deploy.md's Permissions section: Bash(*apra-fleet-installer-* install *), Bash(*apra-fleet* --version), Bash(*apra-fleet* start), Bash(dist/apra-fleet-installer-* install *). These gate the installer 'install --force' step and the resulting apra-fleet 'start'/'--version' steps in Deploy and Smoke test. Ask the orchestrator/operator to run compose_permissions with these missing grants, then re-trigger the deploy. No deploy commands were executed. | C3: Stopped at Step 0a (permissions check) -- did not execute any deploy.md commands. Merged effective allowlist (.claude/settings.json is absent in this checkout; .claude/settings.local.json is the sole source) does not cover 4 of the 6 required command prefixes listed in deploy.md's Permissions section:

Missing:
  Bash(*apra-fleet-installer-* install *)
  Bash(*apra-fleet* --version)
  Bash(*apra-fleet* start)
  Bash(dist/apra-fleet-installer-* install *)

Covered (via broader entries already present in settings.local.json):
  Bash(node scripts/preflight-clear-build-locks.mjs) -- covered by Bash(node:*)
  Bash(npm ci) / Bash(npm run build) / Bash(npm run build:binary) -- covered by Bash(npm:*)
  Bash(curl * localhost:8787/api/sprints*) -- covered by Bash(curl:*)

The missing entries are all direct invocations of the built apra-fleet-installer/apra-fleet binaries (dist/apra-fleet-installer-*, $HOME/.apra-fleet/bin/apra-fleet), which no existing broad prefix (npm:*, node:*, etc.) covers -- these are separate executables, not npm/node subcommands.

Ask the orchestrator/operator to run compose_permissions with these 4 missing grants (targeting .claude/settings.local.json, the correct per-checkout target for Claude Code), then re-trigger the deploy. Did not attempt to add permissions myself, and did not proceed to KB priming or any deploy.md command per the runbook's Step 0a stop condition.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

FAIL -- VERIFIED IN THE DIFF (good work, all of it is really there): b4g.3 -- scripts/check-sandbox-sync-remote.mjs:373-376 adds the `list === null -> []` branch, and tests/check-sandbox-sync-remote.test.ts:326-331 pins 'null'/'null\n'; the vacuous-pass tightening at :439-454 now branches on whether `bd` is actually on PATH, so the parser is genuinely exercised. b4g.1.1/1.2 -- project-slug.ts:4-8 short-circuits on remoteUrl with a correct empty-slug fallthrough; kb-providers.ts slugFor/_slugCache now key on `dir\0remoteUrl`. b4g.1.3/1.4 -- kb-scope-input.ts defines ONE kbScopeFields fragment, spread into all 16 kb_* schemas, and every getKbProviders call site in src/tools passes input.repo_remote_url as arg 2 (grep confirms no tool call site missed). b4g.2.1 -- providerKey(slug, repoPath) NUL-joined, kb-providers.ts:85-100. b4g.1.5/1.6/2.2 -- three new test files, 56 tests, all green; the forwarding test is table-driven over 15 tools and asserts arg[1] explicitly, so deleting a forward fails it. Hygiene clean: 23 files, all in scope, no scaffold, working tree empty, build green, npm test 3905 passed / 0 failed. packages/apra-fleet-client correctly untouched -- grep -c kb on src/client/api.mjs is 0, so it exposes no kb_* wrapper and the repo's client-parity convention does not apply.

WHY THIS IS STILL A FAIL:

1. VERIFIED LIVE DEFECT, epic goal not met. b4g.4 (P1) is open and the defect is real on this branch. Standalone repro (isolated APRA_FLEET_DATA_DIR, dist build): capture a healthy entry from a real clone of remote R (stale=0 on the raw row), then getKbProviders('C:\\Users\\member\\work\\repo', R).project.prime({hint_symbols}) -> the SAME kb.sqlite -> the healthy entry is UPDATEd to stale=1. Before this sprint a remote path collapsed to the isolated 'default' slug and could not touch the real project KB at all; b4g.1 opened that door and b4g.4 is the lock that did not ship with it. Shipping b4g.1 without b4g.4 makes remote members net-destructive, not merely unhelpful.

2. NEW, UNTRACKED, WORSE VARIANT OF THE SAME PROBLEM (I could not find a bead covering it). kb-session-prime.ts:110-114 resolveRepoPath() returns null for a directory that does not exist on this host, and line 185 does `getKbProviders(resolveRepoPath(input.repo_path) ?? undefined, input.repo_remote_url)`. getKbProviders then does `cwd ?? process.cwd()`. So for a remote member the slug comes from the URL (the REAL shared project KB) while the anchor silently becomes the FLEET SERVER'S OWN process.cwd(). Repro confirms it exactly: with cwd=/tmp/.../server-cwd and repo_path='C:\\Users\\member\\work\\repo' + remote R, provider.dbPath=<data>/knowledge/githubcom-acme-b4g-cwd/kb.sqlite while provider.repoPath=/tmp/.../server-cwd. That is verbatim the corruption mode b4g.2's own description forbids ('Do NOT silently fall back to process.cwd()') and it now reaches the real shared DB rather than an isolated one. kb-stats.ts:52 and kb-export.ts:325 share the identical resolveRepoPath-nulls-to-cwd shape. Note this also explains why my first repro through kbSessionPrime did NOT stale anything -- the anchor was cwd, not the missing path.

3. NO DEPLOY VERIFICATION AT ALL. Deploy stopped at Step 0a in all 3 cycles on the same 4 missing permission grants (Bash(*apra-fleet-installer-* install *), Bash(*apra-fleet* --version), Bash(*apra-fleet* start), Bash(dist/apra-fleet-installer-* install *)). The two verify-routed beads b4g.1 and b4g.2 were therefore never confirmed against a deployed build, and both remain open. The original bug was proven empirically against a live member (win-apra-fleet, 2026-08-14); nothing in this sprint re-tested it that way. Unit tests are necessary but are not the evidence this epic's acceptance criteria asked for.

4. Two more open goal-priority beads: b4g.5 (P2, docs/knowledge-layer.md still says 'caches one provider instance per slug' and 'remote members are not yet repo-routed' -- both now contradicted by the code) and b4g.6 (P2, execute-prompt.ts:1369 auto-harvest still passes repo_path only, so the fleet's own main caller still pools into 'default'). b4g.6 is correctly ordered behind b4g.4 and must stay that way.

NOTHING REOPENED: every closed bead I checked is genuinely reflected in this diff with matching tests. The gaps are all in beads that are still open, which is correct triage -- the sprint's problem is that it stopped with the dangerous half landed and the safety half not.

KB PROMOTIONS: none. Specifically, I did NOT promote 54700078 ('A KB provider anchored at a nonexistent repoPath silently stales entries via prime') even though its OUTCOME reproduces, because its stated MECHANISM is wrong for the tool it names: my direct kb_session_prime repro with a nonexistent repo_path + valid repo_remote_url left stale=0, since resolveRepoPath nulls the path and the anchor becomes process.cwd(), not the missing path. The staling reproduces only via tools that pass repo_path through unvalidated. Promoting it as written would mislead a future session about which call sites are affected -- it stays INFERRED and finding 2 above should correct it. 155fbca9 and 28b993e0 are both now FALSE on this branch (b4g.3 landed the null branch; kb-provider-cache-key.test.ts pins the cache key), so they are obsolete rather than promotable. 4c0b14dc, a0773fc9 and bd281bfb touch files outside this diff and I verified none of them here.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Stopped at the mandatory Step 0 permissions check before running anything: regression-test-playbook.md's Permissions section requires Bash(bd *) (for bd search/bd create failure-filing and the sandbox bd show/bd dolt steps in Setup and the smoke-test scenario), but no covering entry exists in either .claude/settings.json (file absent from this checkout entirely) or .claude/settings.local.json (which covers git/npm/node/gh/etc. but has no bd:* or bd * grant). Per policy this is a hard stop -- no self-edit of either settings file, no workaround -- so neither Part 1 (real-bd suite) nor Part 2 (sandbox smoke test) was run, no sandbox was ever brought up (so no Teardown was needed), and no bugs were filed. This result is informational and does not gate the current sprint; escalate to the orchestrator/operator to grant Bash(bd:*) via the compose_permissions MCP tool (or a team PR to settings.json) and re-dispatch this run.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
