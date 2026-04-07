# Documentation Harvest — Code Review

**Reviewer:** fleet-rev  
**Date:** 2026-04-06 23:30:00-04:00  
**Verdict:** CHANGES NEEDED

> See the recent git history of this file to understand the context of this review.

---

## Scope

Commit `0ea09e8` ("docs: extract long-term knowledge from sprint into docs/") adds one new ADR and updates three existing tool docs. Four files changed:

- `docs/adr-provider-agnostic-api.md` (new — 97 lines)
- `docs/tools-infrastructure.md` (heading rename + auth error guidance)
- `docs/tools-observability.md` (provider-neutral language + token display)
- `docs/tools-work.md` (run_from rename + token accumulation section)

---

## Methodology

All tool names, parameter names, and behavior descriptions were verified against the source code (12 claims checked). Build passes (`tsc --noEmit`). All 628 tests pass (4 skipped).

---

## ADR Quality — PASS (with 1 NOTE)

`adr-provider-agnostic-api.md` is well-structured: 5 decisions, each with what/why/trade-offs. Content is durable architecture knowledge — design rationale, race condition analysis, guard-vs-template reasoning. Issue numbers tie back to the tracker. No task lists, debug notes, or implementation steps.

**NOTE — transient sprint reference (line 35):** "The skill doc sweep (Phase 5 of the plan) updated all known internal callers." Future readers won't have context for "Phase 5." Suggest replacing with "A skill doc sweep updated all known internal callers." Non-blocking.

---

## Tool Docs — Factual Accuracy

### Finding 1 (BLOCKING) — `tools-infrastructure.md:43` — stale `provision_auth` reference

The commit renamed the heading on line 5 from `provision_auth` to `provision_llm_auth`, but line 43 still reads:

> **Token validation:** Before deploying, `provision_auth` checks the OAuth token's expiry.

Should be `provision_llm_auth`. This is in a file that was explicitly updated by this commit — same class of miss that was caught in tests during the Phase 5 review.

### Finding 2 (BLOCKING) — `tools-work.md:108` — inaccurate tilde expansion description

Line 108 reads:

> Tilde (`~`) at the start of either path is expanded to the member's home directory server-side before the command runs.

The code (`resolveTilde` in `execute-command.ts:13-18`) uses `os.homedir()`, which resolves to the **master/server** machine's home directory, not the member's. The ADR (line 61) correctly states: "The resolution uses Node's `os.homedir()` on the master machine, which is correct because the master constructs the command string."

The tool doc should align with the ADR. Suggested fix: "Tilde (`~`) at the start of either path is expanded server-side to the master machine's home directory before the command runs."

---

## Tool Docs — Durable Knowledge Check — PASS

No transient content found in the three updated tool docs. All additions are reference material: table columns, parameter descriptions, error handling behavior, section descriptions. No code-line references, debug notes, or task lists.

---

## Stale References in Non-Updated Docs (NOTE — out of scope but flagged)

The harvest updated 4 files but did not sweep the broader `docs/` directory. Grep reveals `provision_auth` (old name) still appears in 7 other docs:

- `tools-lifecycle.md:31`
- `cloud-compute.md:114`
- `learnings.md:135-142` (4 occurrences)
- `architecture.md:124, 170`
- `gemini-lifecycle-walkthrough.md:92`
- `provider-matrix.md:75`
- `requirements/cloud-compute-reqs.md:14`

These pre-date this commit and are not blocking this review, but should be addressed in a follow-up sweep. The `work_folder` references in `tools-lifecycle.md` and `design-git-auth.md` refer to the member registration property (which is still `workFolder` internally), so those are correct — only the `execute_command` parameter was renamed.

---

## Build & Tests — PASS

- `tsc --noEmit` — clean
- `npx vitest run` — 40 test files, 628 passed, 4 skipped, 0 failures

---

## Summary

| Item | Verdict |
|------|---------|
| ADR structure & durability | PASS |
| ADR factual accuracy | PASS |
| Tool doc updates — factual accuracy | **FAIL** — 2 findings |
| Tool doc updates — no transient content | PASS |
| Build & tests | PASS |

**Must fix before approval:**
1. `tools-infrastructure.md:43` — `provision_auth` → `provision_llm_auth`
2. `tools-work.md:108` — tilde expansion uses master's homedir, not member's

**Non-blocking notes:**
- ADR line 35: replace "Phase 5 of the plan" with sprint-agnostic phrasing
- 7 other doc files still reference `provision_auth` (pre-existing, separate sweep recommended)
