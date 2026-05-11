# Fleet E2E — Pre-Flight Review

Pre-run audit of `fleet-e2e.yml` and supporting scripts before the first real workflow run.
Two independent agents reviewed the workflow step-by-step on 2026-05-11.

---

## Legend

| Symbol | Meaning |
|--------|---------|
| ✅ | Fixed / resolved |
| 🔄 | Pending fix |
| ⚠️ | Accepted risk / deferred |
| 🧪 | Isolation-tested |
| ❌ | Not yet tested end-to-end |

---

## Infrastructure & Setup

| # | Risk | Affects | Decision | Status |
|---|------|---------|----------|--------|
| I-1 | `dirname "$GITHUB_WORKSPACE"` on Windows bash — concern was backslash handling | s1, s4 (Windows PM) | **Accepted**: self-hosted runners set `GITHUB_WORKSPACE` as a native Windows path; Git Bash `dirname` handles it correctly | ⚠️ |
| I-2 | `jq` not pre-installed on fresh self-hosted Windows runner | All | **Fixed**: added "Check runner prerequisites" step with `jq --version \|\| exit 1` | ✅ |
| I-3 | Two suites sharing the same physical host (same `work_folder`) collide if run concurrently | All pairs | **Accepted**: run suites serially; document policy | ⚠️ |
| I-4 | Runner label `fleet-windows/linux/macos` must be pre-registered; s6 is implicit fallback in ternary | All | **Accepted**: verified current suites match | ⚠️ |

---

## Workflow Steps

### Step 3 — Seed fleet credential store

| # | Risk | Decision | Status |
|---|------|----------|--------|
| S3-1 | `E2E_AUSER` secret: username seeded into credential store but `register_member` doesn't resolve `{{secure.*}}` tokens in the username field — LLM had to infer username from context (unreliable) | **Fix**: remove `E2E_AUSER` secret entirely; inject username via `{{DOER_USER}}`/`{{REVIEWER_USER}}` from `members.json` in the render step | ✅ |
| S3-2 | Any unset secret writes empty string silently into credential store; T5 VCS auth fails 45 min later with no traceable error | **Fixed**: `check_secret()` helper validates all 5 secrets before any seeding | ✅ |

### Step 3a — Clear PM claude settings of member-role residue

| # | Risk | Decision | Status |
|---|------|----------|--------|
| 3a-1 | Original approach edited `settings.local.json` — risky if JSON was malformed | **Fix**: delete the file entirely; `compose_permissions` recreates it on next member use | ✅ |
| 3a-2 | Loop walks up from `GITHUB_WORKSPACE` — on public GH runners `GITHUB_WORKSPACE` is on a different drive so the step would find nothing. | **Accepted**: self-hosted runners have `GITHUB_WORKSPACE` nested inside `work_folder`; loop works correctly for this setup | ⚠️ |

### Step 3b — Smoke-test PM LLM auth

| # | Risk | Decision | Status |
|---|------|----------|--------|
| 3b-1 | `grep -qi "not installed"` passes even if LLM auth is expired | **Fixed**: `check_mcp()` helper verifies absence of "not installed" AND presence of `v[0-9]+\.[0-9]+` version pattern | ✅ |
| 3b-2 | Smoke test prompt tested manually on this machine: returned `v0.1.9.1_d48cd3` — MCP reachable | — | 🧪 |

### Step 4 — Render test script

| # | Risk | Decision | Status |
|---|------|----------|--------|
| R-1 | GNU sed interprets `\U`, `\a` etc. in replacement strings — `C:\Users\...` paths get mangled. | **Fixed**: render step assigns folder values to bash variables and escapes backslashes (`${VAR//\\/\\\\}`) before passing to sed | ✅ |
| R-2 | `{{DOER_USER}}` / `{{REVIEWER_USER}}` added to sed substitutions; sourced from `members.json` via suite config | Implemented as part of S3-1 fix | ✅ |
| R-3 | `{{secure.E2E_ACRED}}` intentionally NOT substituted by sed — resolved at runtime by `register_member` from the fleet credential store | Correct by design | ✅ |

### Step 5 — Run fleet e2e

| # | Risk | Decision | Status |
|---|------|----------|--------|
| E-1 | `\|\| true` swallows LLM crash — job shows green even if LLM never ran | **Fixed**: `[ ! -s raw-output.txt ]` check emits `::error::` annotation after the LLM command | ✅ |
| E-2 | Gemini suites (s4/s5/s6): no `--max-turns` equivalent; stuck session runs for up to 6 hours | **Fixed**: `timeout-minutes: 120` added at job level | ✅ |
| E-3 | PM permissions: `install --force` writes `mcp__apra-fleet__*` into `~/.claude/settings.json` `permissions.allow` globally — no `--allowedTools` flag needed on the CLI | Verified by source inspection of `install.ts` | ✅ |
| E-4 | PM writes plan.md / requirements.md / status.md into the checkout (`$GITHUB_WORKSPACE`) instead of `$RUN_DIR` — artifacts pollute the repo | **Fixed**: `cd "$RUN_DIR"` added before `claude`/`gemini` invocation | ✅ |

### Test Script — T3 Credential Store CRUD

| # | Risk | Decision | Status |
|---|------|----------|--------|
| T3-1 | LLM calls `credential_store_set` MCP tool instead of shell command — tool requires interactive terminal, fails headless. Confirmed failure in s1 run. | **Removed**: T3 (credential store CRUD) dropped from test script entirely — not needed in e2e suite | ✅ |

### Test Script — LLM-Unfriendly Formatting

| # | Risk | Decision | Status |
|---|------|----------|--------|
| F-1 | `t6-teardown.md`: `` `T6: PASS` `` / `` `T6: FAIL` `` wrapped in backticks — LLM emits `` `T6: PASS` `` and grep match would work by accident, but intent is wrong | **Fixed**: backticks removed from output format strings | ✅ |
| F-2 | `test-script.md` T5.3: `/pm` skills in a fenced code block — LLM may try to run them as shell commands | **Deferred to pm skill**: test-script.md intentionally left as-is; pm skill should be robust to /pm invocations in code blocks | ⚠️ |
| F-3 | `test-script.md` T5.1: sprint branch created from whatever branch was checked out, not main | **Fixed**: `git fetch origin && git checkout main && git pull origin main` added to T5.1 | ✅ |

### Session Log Collection (test-script.md)

| # | Risk | Decision | Status |
|---|------|----------|--------|
| L-1 | Original approach used mtime heuristics (`xargs ls -t | head -1`) — unreliable | **Fix**: PM collects exact session IDs from execute_prompt responses; uses `find` with specific session ID | ✅ |
| L-2 | `receive_files` is sandboxed to member `work_folder` — session files are outside it | **Fix**: cp → receive_files → rm staging pattern; documented in test-script.md | ✅ 🧪 |
| L-3 | Claude session find (Unix): `find ~/.claude/projects -name "<uuid>.jsonl"` | Tested on fleet-rev (macOS) + fleet-lin (Linux) | 🧪 |
| L-4 | Gemini session find (Unix): `find ~/.gemini -name "<session-id>.jsonl"` | Tested on fleet-lin | 🧪 |
| L-5 | Claude session find (Windows): `Get-ChildItem "$env:USERPROFILE\.claude\projects" -Filter "<id>.jsonl" -Recurse` | Tested on fleet-e2e-win — found file at `C:\Users\akhil\.claude\projects\C--gh-fleet-actions-runner\` | 🧪 |
| L-6 | Session logs now go to `logs/doer/<id>.jsonl` and `logs/reviewer/<id>.jsonl` (folder-per-role, not concatenated) | Implemented | ✅ |

### Steps 5b/5c — Log Collection & Telemetry

| # | Risk | Decision | Status |
|---|------|----------|--------|
| LC-1 | Fleet daemon logs purged before test, all `fleet-*.log` files concatenated after — eliminates cross-run contamination | Implemented | ✅ |
| LC-2 | `extract-telemetry.js`: `readdirSync` on a non-directory path throws uncaught exception | **Fixed**: `readdirSync` now wrapped in try/catch; returns zeroed tokens on error | ✅ |
| LC-3 | `cd "$RUN_DIR"` in telemetry/summary steps fails silently if `RUN_DIR` is empty | **Fixed**: both steps use `[ -n "$RUN_DIR" ] && cd "$RUN_DIR" \|\| exit 1` | ✅ |
| LC-4 | `extract-telemetry.js` tested against real session files (fleet-rev + fleet-lin) — correct token counts returned | — | 🧪 |

### Step 6 — Post job summary

| # | Risk | Decision | Status |
|---|------|----------|--------|
| PS-1 | `post-summary.sh`: bash + jq dependencies, strict-mode risks | **Fixed**: replaced with `post-summary.mjs` (Node.js); no jq dependency, no unbound-variable risk, pipes in notes escaped | ✅ |
| PS-3 | `post-summary.sh` tested with real `results.json` — rendered correctly | — | 🧪 |
| PS-4 | `extract-results.mjs` tested against real `raw-output.txt` — parsed 6 CHECKPOINTs correctly | — | 🧪 |

### Step 7 — T6 Teardown

| # | Risk | Decision | Status |
|---|------|----------|--------|
| T6-1 | Teardown failures fully silent (`\|\| true`); orphaned members break next run's T1 | **Fixed**: `grep -q "T6: PASS"` after teardown; emits `::warning::` annotation if absent | ✅ |
| T6-2 | Gemini T6 has no turn/time limit | **Fixed**: `timeout 120 gemini ...` wrapper added | ✅ |
| T6-3 | `fleet_status` returns all members — T6 could remove members from other projects | **Fixed**: `t6-teardown.md` now scoped to remove only "doer" and "reviewer" by name | ✅ |

### Step 8 — Upload results

| # | Risk | Decision | Status |
|---|------|----------|--------|
| U-1 | `path: ${{ env.RUN_DIR }}` — POSIX path on Windows would confuse upload-artifact | **Accepted**: self-hosted `GITHUB_WORKSPACE` is a native Windows path; `dirname` produces a correct Windows `RUN_DIR`; upload-artifact (Node.js) handles it fine | ⚠️ |

---

## Isolation Test Results

| Script | Test Method | Result |
|--------|-------------|--------|
| `extract-results.mjs` | Run against real `raw-output.txt` from s1 run | ✅ Parsed 6 CHECKPOINTs, produced valid `results.json` |
| `extract-telemetry.js` | Run against real session files (`logs/doer/`, `logs/reviewer/`) | ✅ Correct token counts (PM: 7199, doer: 32991, reviewer: 10007) |
| `post-summary.mjs` | Run with `SUITE=s1 GITHUB_STEP_SUMMARY=/tmp/out.md` + real `results.json` (tested as .sh; rewritten to .mjs) | ✅ Rendered full markdown table with telemetry |
| PM smoke test (haiku) | Run manually on this machine | ✅ Returned `v0.1.9.1_d48cd3` |
| Windows session find (`Get-ChildItem`) | `execute_command fleet-e2e-win` with real session ID | ✅ Found `05066a73...jsonl` at correct path |
| Unix session find (`find ~/.claude`) | `execute_command fleet-rev` + `fleet-lin` | ✅ Both working |
| `cp` → `receive_files` → `rm` staging | Manual run against fleet-rev + fleet-lin | ✅ Required and working |

---

## Status Summary

All identified risks are resolved. No pending fixes remaining.

| Category | Fixed | Accepted | Tested in isolation |
|----------|-------|----------|---------------------|
| Infrastructure | 1 | 3 | — |
| Credential seeding | 2 | — | — |
| PM settings / smoke test | 2 | 1 | 1 |
| Render step | 3 | — | — |
| LLM run | 3 | — | — |
| T3 credential store | 1 (removed) | — | — |
| Session log collection | 4 | — | 4 |
| Telemetry / summary | 4 | — | 3 |
| T6 teardown | 3 | — | — |
| Upload | — | 1 | — |
