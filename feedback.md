# apra-fleet Open-Source Readiness — Code Review

**Reviewer:** fleet-rev  
**Date:** 2026-04-08 01:35:00-04:00  
**Verdict:** CHANGES NEEDED

> See the recent git history of this file to understand the context of this review.

---

## Context

Reviewing PR #20 (feature/open-source → main), the Open-Source Readiness Phase 2 sprint. Five tasks: Apache 2.0 licence switch, CLAUDE.md/AGENTS.md creation, GitHub topics, README badges + keyword pass, and ROADMAP.md. Supporting changes include CI concurrency cancellation, crypto test flaky fix, .gitignore cleanup, and CODE_OF_CONDUCT email correction.

Branch has 41 commits ahead of main. 19 files changed, +1124 / -548 lines.

---

## Task 1 — Apache 2.0 Licence — PASS

- `LICENSE` contains the canonical Apache 2.0 full text with `Copyright 2026 Apra Labs`. Correct.
- `package.json` line 44: `"license": "Apache-2.0"`. Correct.
- `README.md` licence section updated to reference Apache 2.0 with link to LICENSE file. Correct.
- `grep -ri "CC-BY-SA\|CC BY-SA\|Creative Commons" LICENSE README.md package.json SECURITY.md` — zero matches. Clean.

**FAIL — CONTRIBUTING.md line 79** still references the old licence:
```
By contributing, you agree that your contributions will be licensed under the [CC BY-SA 3.0](LICENSE) license that covers this project.
```
This must be updated to Apache 2.0. The requirements explicitly state "no CC BY-SA references remain anywhere" and the PLAN.md verify step includes CONTRIBUTING.md in its grep scope.

---

## Task 2 — CLAUDE.md / AGENTS.md — PASS

- `CLAUDE.md` (committed version on branch) matches the PLAN.md specification: context intro, What is Apra Fleet, Installation, MCP Tools Reference (4 categories), Common Workflows (5 examples), Example User Prompts, and Links section.
- `AGENTS.md` is identical except the header is correctly tailored for non-Claude agents (OpenHands, Codex, Devin, SWE-Agent).
- The `send_files` example was corrected in commit `aee30d6` to reference individual file paths rather than directories, with a note about the limitation. Good catch and fix.

---

## Task 3 — GitHub Topics (20 tags) — PASS

`gh api repos/Apra-Labs/apra-fleet/topics` returns exactly 20 topics matching the PLAN.md specification: `claude-code`, `fleet`, `mcp`, `orchestration`, `ssh`, `ai-agents-2026`, `llm-orchestration`, `autonomous-agents`, `agentic-workflow`, `model-context-protocol`, `multi-agent`, `remote-execution`, `anthropic`, `typescript`, `nodejs`, `developer-tools`, `ai-coding`, `claude`, `devops`, `automation`.

---

## Task 4 — README Badges + Keyword Pass — PASS

- All 6 badges present: CI, License (Apache 2.0), TypeScript 5.5+, Node.js 20+, Platform (macOS | Linux | Windows), MCP compatible.
- Discoverability paragraph present with all 6 required keywords: MCP server, LLM orchestration, agentic workflow, autonomous agents, multi-agent systems, agent memory.
- "Why" section includes the orchestration-layer tagline.
- Roadmap link section present before License section.

---

## Task 5 — ROADMAP.md — PASS

- Three time-horizon sections: Near-term (5 items), Medium-term (5 items), Long-term (6 items).
- 6 items marked with 🌱 (exceeds the minimum of 5): npm publish, Cursor/Windsurf guide, session log export, web dashboard, audit log, and one more.
- Commit `85169ce` trimmed the roadmap per user review — Gemini support removed (already exists), infra targets expanded. Good editorial cleanup.
- Contributing section with link to CONTRIBUTING.md. Correct.

---

## Supporting Changes — PASS

- **CI concurrency** (`e2ac072`): Added `concurrency` block to `.github/workflows/ci.yml` with `cancel-in-progress: true`. Clean and correct — prevents redundant CI runs on rapid pushes.
- **Crypto test fix** (`cb0c688`): XOR first byte with `0xff`, fallback to `0x01` if result is zero. Eliminates the edge case where random bytes could match, making the tamper test deterministic. Good fix.
- **CODE_OF_CONDUCT email** (`d285e8d`): Changed from `opensource@apralabs.com` to `contact@apralabs.com`. Matches SECURITY.md contact.
- **.gitignore cleanup** (`752578f`): Removed CLAUDE.md exclusion so the agent-facing file is tracked. Necessary for Task 2.

---

## Build & Tests — PASS

- `npm run build` (tsc) — clean, zero errors.
- `npm test` (vitest) — 40 test files, 628 passed, 4 skipped, 0 failures.

---

## CI Status — PASS (conditional)

- Latest run (24119498617) is **in_progress** at time of review.
- Previous run (24119262715) completed with **success**.
- The in-progress run covers the latest commits (`85169ce`, `e2ac072`). Once it completes green, CI is confirmed.

---

## progress.json — NOTE

All 5 tasks are marked `"pending"` in `progress.json`. This appears stale — all tasks have been implemented and committed. Non-blocking, but should be updated to reflect actual completion status.

---

## Summary

| Area | Verdict |
|------|---------|
| Task 1 — Apache 2.0 Licence | **FAIL** — CONTRIBUTING.md line 79 still references CC BY-SA 3.0 |
| Task 2 — CLAUDE.md / AGENTS.md | PASS |
| Task 3 — GitHub Topics (20 tags) | PASS |
| Task 4 — README Badges + Keywords | PASS |
| Task 5 — ROADMAP.md | PASS |
| Supporting changes | PASS |
| Build & tests | PASS (628/628) |
| CI | PASS (prior run green; current in-progress) |

**Blocking finding (1):**
1. `CONTRIBUTING.md:79` — Update "CC BY-SA 3.0" → "Apache License 2.0" to satisfy the requirement that no CC BY-SA references remain anywhere in the project.

**Non-blocking note (1):**
1. `progress.json` — All tasks still marked "pending" despite being completed. Should be updated for tracking accuracy.
