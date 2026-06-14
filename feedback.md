# VERIFY 6 (FINAL) -- Whole-Epic Review

**Verdict: APPROVED**

**Reviewer:** fleet-rev
**Branch:** feat/opencode-pm-epic
**Diff range:** e4f3ebb..00aec18 (entire epic, 59 files changed, ~4053 insertions)
**Date:** 2026-06-14

---

## Criterion 1: Build and Tests

**PASS**

- `npm install && npm run build` (tsc): succeeds, zero errors.
- `npm test`: **1502 passed**, 7 skipped, 0 failures (90 test files, 27.74s).

## Criterion 2: npm pack Contents

**PASS**

- `dist/skills/pm/`: 6 files (SKILL.md, beads.md, doer-reviewer-loop.md, sprint.md, tpl-progress.json, worktrees.md).
- `dist/agents/`: 4 agent definitions (doer.md, plan-reviewer.md, planner.md, reviewer.md).
- `dist/providers/opencode.js` (+ .d.ts, .d.ts.map, .js.map): present.
- No stray files observed. Total packed: 579 files.

## Criterion 3: Provider Installs

**PASS**

Real temp-home installs for all 6 providers:

| Provider | Agents | Install Path | Notes |
|----------|--------|-------------|-------|
| claude   | 4      | ~/.claude/agents/ | Default provider, MCP registration |
| gemini   | 4      | ~/.gemini/agents/ | |
| agy      | 4      | ~/.agy/agents/ | |
| opencode | 4      | ~/.config/opencode/agents/ | Agent transform applied (mode: subagent, permission map) |
| codex    | 0      | n/a | Correctly skips agents |
| copilot  | 0      | n/a | Correctly skips agents |

- OpenCode install writes to `.config/opencode/` paths, configures `opencode.json`, and displays "Restart OpenCode to load the server."
- Agent transform converts Claude frontmatter (name, tools list) to OpenCode frontmatter (description, mode: subagent, permission map). Verified in installed files.

## Criterion 4: No -lite Naming in Shipped Artifacts

**PASS**

- `grep -ri '\-lite' dist/` returns only `gemini-3.5-flash-lite` model name references in provider adapters and config -- these are Google model names, not the historical `-lite` project naming.
- Zero hits for `-lite` in installed files (confirmed across all 6 temp-home installs).
- Process files (design.md, requirements.md, plan.md) do reference the rename history but are not shipped artifacts (see Criterion 7).

## Criterion 5: Docs Correctness

**PASS with one finding (non-blocking)**

- **README.md**: Lists OpenCode in the intro, quick-start install example (`apra-fleet install --llm opencode`), endpoint-is-user's-responsibility note, per-member `model_tiers` documentation. Factually accurate.
- **docs/architecture.md**: Reflects 6 providers, lists `opencode.ts` in provider files, documents apra-pm submodule at `vendor/apra-pm/`, covers agent-transform at install time, model_tiers per-member, OpenCode session resume, and mix-and-match fleet diagram with opencode member.
- **CHANGELOG.md**: Documents all 3 epic parts -- OpenCode provider, per-member model tiers, PM agent installation, and PM skill submodule migration. Clean and accurate.
- **docs/opencode-exploration.md**: Present and updated (T6.2).

**Finding (non-blocking):**
`src/cli/install.ts` lines 446 and 449-450: the `--help` text lists supported providers as `claude, gemini, codex, copilot, agy` -- **opencode is missing** from both the usage line and the Options description. The implementation at line 473 correctly includes `opencode` in the `supported` array, and installs work. This is a help-text omission, not a functional bug. Recommend fixing before the PR is merged but it does not block APPROVED status.

## Criterion 6: Whole-Epic Cohesion

**PASS**

The three parts work together as a cohesive whole:

**(a) Installer installs 4 agents per provider:**
- 4 agents (planner, plan-reviewer, doer, reviewer) installed for claude/gemini/agy/opencode.
- Codex and copilot correctly skip (no agent system).
- OpenCode agents are transformed at install time (frontmatter rewrite).

**(b) PM skill sourced from apra-pm submodule:**
- `vendor/apra-pm/` submodule initialized and populated.
- Build-time vendoring copies skill files to `dist/skills/pm/`.
- Install-time skill copy to `~/.claude/skills/pm/` (or provider equivalent).
- Backward compat test (T5.3) verifies old state file names (PLAN.md, progress.json, feedback.md, status.md) and `/pm` commands.
- Gap-port features (sprint selection, operational rules, provider awareness, fleet addendum, resume rules, documentation harvest) present in the vendored SKILL.md.

**(c) OpenCode is a first-class provider:**
- `parseResponse()`: NDJSON parser with fixture-based tests.
- Permissions: `--dangerously-skip-permissions` flag.
- Install config: `.config/opencode/` paths, `opencode.json` MCP config.
- Per-member `model_tiers`: wired through `register_member` with validation (at least one model required, fallback fill logic).
- Agent transform: Claude frontmatter -> OpenCode frontmatter (tools list -> permission map, mode: subagent).
- Session resume: `--session <id>` / `--continue` support.

**No dead code** observed. No half-wired features. No TODOs/FIXMEs in OpenCode provider or agent-transform code.

**Security:** No secrets committed. Token/password handling is programmatic (encrypted at rest, per existing patterns).

## Criterion 7: Final-Changeset Cleanliness

**Recommendation: (A) -- git rm all 4 process files before the PR**

The net diff includes 4 process files at the repo root:
- `requirements.md` (216 lines)
- `design.md` (700 lines)
- `plan.md` (367 lines)
- `feedback.md` (93 lines)

**Recommendation: Remove all 4 (option A).** Justification:

1. **A production library PR into main should not carry sprint scaffolding at the repo root.** These files are sprint-internal process artifacts -- they served their purpose during development and are preserved in git history and the beads task DB.

2. **design.md and requirements.md have some lasting documentation value**, but they are not maintained documentation -- they are snapshots of the planning phase. The actual lasting documentation is already captured in README.md, CHANGELOG.md, docs/architecture.md, and docs/opencode-exploration.md, which are accurate and up to date. Keeping design.md/requirements.md at the repo root creates confusion about which docs are authoritative.

3. **plan.md and feedback.md are pure process artifacts** with no lasting value beyond their git history. plan.md is the internal sprint plan (task IDs, model assignments, VERIFY checkpoints). feedback.md is the review verdicts (this very document being overwritten now).

4. The apra-pm validation harness's "final-changeset-clean" gate explicitly flags process files leaking into the net diff -- removing them aligns with the project's own quality standard.

**Specific action:** `git rm requirements.md design.md plan.md feedback.md` and commit before raising the PR. (feedback.md will be this file, so commit this review first, then rm all 4.)

---

## Summary

All 7 criteria pass. The epic delivers a cohesive, well-tested, fully documented OpenCode provider integration with PM agent installation and submodule-sourced PM skill.

**One non-blocking finding:** install `--help` text omits `opencode` from the provider list (fix recommended before PR).

**One process recommendation:** Remove all 4 sprint scaffolding files (requirements.md, design.md, plan.md, feedback.md) from the branch before raising the PR.
