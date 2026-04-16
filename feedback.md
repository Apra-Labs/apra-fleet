# PR #101 Review: feat: first-run onboarding experience and user engagement nudges

**Reviewer:** Claude Code (automated review)
**Date:** 2026-04-18
**Verdict:** APPROVED (with one non-blocking note)

## Summary

This PR adds a first-run onboarding experience (ASCII banner + getting started guide), contextual nudges (post-registration, post-first-prompt, multi-member milestone), and a welcome-back preamble on subsequent server starts. The implementation uses a well-thought-out three-channel defense-in-depth delivery strategy to ensure onboarding text reaches the user verbatim despite the LLM intermediary.

## What was reviewed

- `src/onboarding/text.ts` — all user-facing text constants
- `src/services/onboarding.ts` — state management (load, save, milestones, session flags)
- `src/index.ts` — `wrapTool`, `sanitizeToolResult`, `sendOnboardingNotification`, McpServer construction
- `src/tools/register-member.ts` — input validation (angle bracket regex)
- `src/tools/update-member.ts` — input validation (angle bracket regex)
- `src/types.ts` — `OnboardingState` interface
- `src/cli/install.ts` — data directory comment
- `docs/adr-onboarding-ux-delivery.md` — architecture decision record
- `tests/onboarding.test.ts` — 57 tests covering state, milestones, nudges, sanitization, integration
- `tests/onboarding-text.test.ts` — 21 tests for text constants
- `tests/onboarding-smoke.mjs` — end-to-end smoke test
- `.gitignore` — CLAUDE.md addition

## Findings

### Architecture & Design — Excellent

- Three-channel delivery (notifications, markers+instructions, audience annotations) is well-reasoned. The ADR documents the failure modes, token costs, and tradeoffs clearly.
- Sanitization defense (both output-boundary `sanitizeToolResult` and input-boundary Zod regex) is defense-in-depth done right. The ADR honestly documents the `update_member` gap and notes it was closed in this PR.
- The `wrapTool` abstraction replaces 21 inline wrappers with a single function — cleaner and easier to maintain.
- Passive-tool guard (`version`, `shutdown_server`) prevents silent consumption of the banner by auto-called tools.
- First-run banner bypasses JSON check while welcome-back/nudges respect it — correct design for different urgency levels.

### Code Quality — Clean

- State management is well-structured: in-memory singleton loaded once, atomic file writes, forward-compatible merge with defaults, corruption recovery.
- `_resetForTest()` is a clean test-only escape hatch.
- Token cost analysis in the text.ts header is thorough and reproducible.
- The sanitizer regex handles case variants, attributes, unterminated tags, and multiple occurrences.

### Testing — Thorough

- 722 tests pass, zero failures (4 skipped, pre-existing).
- Build compiles cleanly with no TypeScript errors.
- Tests cover: fresh install, upgrade path, corruption recovery, milestone progression, idempotency, passive-tool guard, JSON bypass, full session sequence, notification emission, sanitization edge cases, schema validation.
- Smoke test provides an additional end-to-end verification layer.

### Non-blocking note

- `.gitignore` adds `CLAUDE.md`. Since CLAUDE.md is already tracked by git, this has no immediate effect — git only ignores untracked files. However, if someone ever removes CLAUDE.md from tracking, this gitignore entry would prevent re-adding it. This looks like a development artifact. Low risk, can be cleaned up in a follow-up.

## Verdict

**APPROVED.** The implementation is well-designed, thoroughly tested, security-conscious, and clean. The three-channel delivery strategy with injection defense is a thoughtful solution to the real problem of delivering verbatim content through an LLM intermediary.

# Install UX, Bug Fixes & Docs — Plan Review

**Reviewer:** fleet-rev
**Date:** 2026-04-16 00:56:23-0400
**Verdict:** APPROVED

> See the recent git history of this file to understand the context of this review.

---

## 1. Clear done criteria per task — PASS

Every task carries a `Done:` block whose bullets are verifiable by test, grep, or file-byte inspection:

- **1.1**: "config.toml parses cleanly with smol-toml.parse"; `getProvider('nonsense')` throws; existing Codex matrix cases still green.
- **1.2**: Register → writeStatusline → remove → file-empty assertion in a new test.
- **1.3**: Claude command asserts ` -c` present AND `--resume` absent when sessionId supplied.
- **2.1**: Eight-row matrix; `--help` reflects table.
- **2.2**: Busy-server error block shown; `--force` issues kill; final message includes restart reminder.
- **3.1**: `llms.txt` + `llms-full.txt` present; generator idempotent; CI commits on tag push.
- **3.2**: Section present, dev-mode command test-run.
- **3.3**: No stray `--skill` in example commands; paths grep-verified against `install.ts`.

Task 1.1's Done is softer than the others because it is explicitly a diagnostic ("reproduce first, then fix") — the softness is deliberate and the Blocks clause names the escalation path. Acceptable.

## 2. High cohesion within tasks, low coupling between — PASS

Phase boundaries are semantic: bugs → install UX → docs/CI. Cross-phase coupling is minimal and explicit: 3.3 blocks on 2.1; 2.1 sequences before 2.2 since both touch `install.ts`. Within Phase 1, the three bugs are independent — different files, different test files. No drive-by cross-cutting.

The one real coupling (#96 + #139 both editing `runInstall`) is resolved by explicit sequencing on the same branch, with the arg-parser refactor first. Risk register row 7 restates this.

## 3. Abstractions in earliest tasks — PASS

No new abstractions introduced speculatively. Tasks reuse existing machinery:
- `smol-toml.stringify` already exists in `writeConfig` (install.ts:39–42); 1.1 consolidates rather than adds.
- `buildResumeFlag` stays for Gemini; 1.3 only changes Claude's caller (claude.ts:40 → switch to `-c`).
- `writeStatusline` at statusline.ts:42 gets a one-line fix, not a rewrite.
- `paths.*` constants in `install.ts` are reused, not re-derived, by 3.3's doc update.

The riskiest work (#115) is a diagnostic, not a framework.

## 4. Riskiest assumption validated in Task 1 — PASS

Risk register row 1 names the unknown directly: the reporter's `model = \gpt-5.3-codex` output does not obviously map to any current writer. `writeConfig` at install.ts:36–45 uses `smol-toml.stringify`, which would not emit that form — so either a different writer produced it, the reporter saw an older build, or smol-toml misbehaves on a specific input. Task 1.1 requires Windows reproduction before code change, and Blocks escalates if mocked `fs` cannot reproduce.

Task 1.2 applies the same discipline to #39 — write a failing test first; if it passes on main, close the issue without a patch. This protects against wasted work on an already-fixed bug.

## 5. Later tasks reuse early abstractions (DRY) — PASS

- Task 2.2 builds on 2.1's arg parser rather than forking its own.
- Task 3.3 consumes 2.1's new default behavior; does not re-derive it.
- Task 3.1's `scripts/gen-llms-full.mjs` reads the five docs listed in `llms.txt` — single source of truth.
- Task 3.3 grep-verifies paths against `install.ts` constants rather than hand-writing them.

No helper is reinvented.

## 6. 2–3 work tasks per phase with VERIFY checkpoints — PASS

Four checkpoints:
- **VERIFY 1**: three tests green, build passes, Codex config round-trips, statusline smoke, grep for `--resume`.
- **VERIFY 2**: matrix test green, force test green, Windows three-step manual smoke, `--help` match.
- **VERIFY 3**: `llms.txt`/`llms-full.txt` committed, generator idempotent, CONTRIBUTING section present, user-guide examples clean.
- **VERIFY FINAL**: 13-item walk of requirements acceptance criteria.

Checkboxes are concrete (grep-able, runnable) — not aspirational. Phase sizes are 3/2/3 work tasks; none exceeds the "3 tasks then verify" ceiling.

## 7. Each task completable in one session — PASS (Task 1.1 is the watch-item)

Tasks 1.2 (1 file + 1 test), 1.3 (2 providers + 1 test file), 3.2 (doc section), 3.3 (doc edits) are cheap/standard. Tier tagging aligns.

Task 1.1 is the largest: audit six writers, fix the broken path, change `getProvider` contract, update two test files, and reproduce on Windows. Tagged `premium` correctly. If Windows reproduction is blocked, the TypeScript fix portion still fits in a session. Acceptable.

## 8. Dependencies satisfied in order — PASS

- Bugs → install UX → docs reflects the actual dependency graph (docs describe new installer behavior).
- 2.1 → 2.2 is explicit (arg-parser before busy-check).
- 3.3 blocks on 2.1 (new defaults must ship first).
- 3.1, 3.2 are independent and could run in parallel with Phase 1 or 2 — plan does not forbid it.

I also verified one requirement line the plan is silent on: the `cherry-pick 0b9c2f7` item from requirements.md §cherry-pick is already landed as commit `6e48ece` on this branch. The plan's silence is correct, not an omission.

## 9. Vague tasks — PASS

The plan cites:
- Line numbers: `src/services/statusline.ts:42`, `src/providers/claude.ts` buildPromptCommand, `execute-prompt.ts:140-144`.
- Function names: `writeConfig`, `mergeCodexConfig`, `writeDefaultModel`, `mergeHooksConfig`, `configureStatusline`, `mergePermissions`, `deliverConfigFile`, `buildResumeFlag`, `touchAgent`.
- Exact commands: `taskkill /F /IM apra-fleet.exe`, `pgrep -f apra-fleet`, `pkill -f apra-fleet`, `claude mcp add --scope user`.
- Concrete flag values: `--skill all|fleet|pm|none`, `--no-skill`, bare `--skill` → `all`.
- Test-matrix enumeration (Task 2.1: 8 rows).

Task 1.1 uses "Likely candidates: (a)…(b)…" which is appropriate diagnostic language. No task reads as "investigate X."

**NOTE — small scope ambiguity in 1.1.** Step 2 says "Route `config.toml` writes through `smol-toml.stringify` consistently (fix `deliverConfigFile` to stringify structured data rather than pass raw strings through PowerShell Set-Content)." But `composePermissionConfig` for Codex (codex.ts:136–149) returns a pre-built TOML string, not structured data — so "stringify structured data" would require changing that contract too. The doer will hit this mid-audit and need to choose between (a) refactoring `composePermissionConfig` to return an object, or (b) keeping the raw-string path but fixing the Windows writer (e.g. base64 PowerShell, as `execute-prompt.writePromptFile` does per the plan's own hint). This is a small judgment call, not a blocker, because step 2 also provides the (b) alternative. Flagging so the doer does not spend time trying to force (a) if reproduction points at the Windows writer.

## 10. Hidden dependencies — PASS

Explicit dependencies surfaced:
- Windows host for #115 reproduction (risk row 1, task 1.1 Blocks).
- `parseResponse` + `touchAgent(agent.id, parsed.sessionId)` must stay intact when switching Claude resume to `-c` (risk row 3, task 1.3 step 3). Verified at `execute-prompt.ts:137` — the stale-session retry path at lines 140-144 is acknowledged.
- `--skill` backwards-compat: bare `--skill` → `all` (risk row 5, task 2.1 step 1).
- Release job tag-gating for `llms-full.txt` regeneration (risk row 6, task 3.1 step 4). Verified that `.github/workflows/ci.yml:226` gates the release job on `startsWith(github.ref, 'refs/tags/v')`.

**NOTE — one implicit dependency worth calling out.** Task 2.2's `pgrep -f apra-fleet` / `pkill -f apra-fleet` pattern will, in SEA mode, match the *currently running installer process itself* (the installer is the apra-fleet binary). Risk register row 4 names this ("Scope kill to exact binary name … exact full path match with `pkill -f`; verify with unit test") but the task body (step 1/step 2) still specifies the loose `pgrep -f apra-fleet` form. Result: unmitigated, the busy-check always fires on SEA installs, and `--force` would kill the installer mid-install. Mitigation is required during implementation — use `pgrep -x apra-fleet` (exact process name) or `pgrep -f apra-fleet | grep -v "^$$\$"` (exclude self PID), or match on the installed path `~/.apra-fleet/bin/apra-fleet` rather than the bare token. Step 4's "mock execSync" tests cannot catch this — an integration check (spawn a decoy process, run the detection function with the installer's own PID in the environment) is worth adding.

Not a blocker because the risk register does acknowledge the mitigation intent; raising as a NOTE so the doer tightens the pattern rather than copy-pasting `pgrep -f apra-fleet` verbatim.

## 11. Risk register — PASS

Seven rows, each with a concrete mitigation mapped to a task or step. Risks are specific:
- #115 reproduction unknown — mitigated by audit-first.
- #39 may already be fixed — mitigated by failing-test-first.
- #108 session-ID capture regression — mitigated by "keep parseResponse unchanged."
- #96 process-kill friendly-fire — mitigated by exact-name matching.
- #139 backwards-compat — mitigated by bare `--skill` = `all`.
- `llms-full.txt` bloat — mitigated by five-doc allow-list.
- `install.ts` merge conflict — mitigated by in-branch sequencing.

Not included but low-severity:
- **Legacy `llmProvider` values.** The change in 1.1 step 3 from `providers[llmProvider ?? 'claude']` (current behavior: returns Claude for any unknown value) to "throw for unknown string" could error on registrations with a stale `llmProvider` string like `'anthropic'`. Plan step 3 preserves `undefined`/`null` → claude, which covers the migration case for old agents without the field; but if any agent was ever registered with a typo'd provider name, it would now fail. Mitigation: the same audit can log a one-time migration warning on load, or the throw message can name both the offending value and "run update_member to fix." Low priority because provider values have always been validated at register_member time.
- **CI race on `main` push** (Task 3.1 step 4): the existing version-bump step at `ci.yml:286-298` already does `git fetch origin main && git checkout main && … git push origin main`. Appending the `llms-full.txt` regeneration to the same commit inherits the same race window; plan does not add a new risk. Acceptable.

I consider the register complete. Adding the two observations above via this review, per review-check-11 instructions.

## 12. Alignment with requirements intent — PASS

All eight scoped issues are addressed and requirement-level constraints honored:

- "Both #96 and #139 touch `install.ts` — must be done in the same phase" → Phase 2 does exactly that.
- "#136 depends on #139 shipping first" → 3.3 blocks on 2.1.
- "All doc changes must be verified against actual code behavior — no speculative documentation" → 3.1 step 1 verifies the five docs exist; 3.2 step 1 verifies `package.json` scripts; 3.3 step 3 grep-verifies paths against `install.ts` constants.
- "`llms-full.txt` CI step: the existing `release` job in `.github/workflows/ci.yml` is the target; add a step, do not create a new workflow" → 3.1 step 4 amends the existing job.
- "Never commit CLAUDE.md, permissions.json, or progress control files" — not restated in plan body. Low risk because no task touches those files, but worth restating as a header-level constraint for the doer.
- Out-of-scope items (#27, #95, PR #128) are untouched by any task.
- Acceptance criteria (13 items) map 1:1 to VERIFY FINAL.

Intent and scope alignment is tight. The plan solves the right problem — not a "technically clean" adjacent problem.

---

## Summary

**APPROVED.** Twelve checks pass. The plan is specific (line numbers, function names, exact flags and commands), phased sensibly (bugs → install UX → docs), and reuse-oriented (extends `install-multi-provider.test.ts`, reuses `smol-toml.stringify`, preserves `buildResumeFlag` for Gemini). The risk register is high-quality with mitigations mapped to tasks.

Two low-severity NOTEs for the doer — neither blocks kickoff:

1. **Task 1.1 step 2 scope.** "Route through smol-toml.stringify" collides with Codex's `composePermissionConfig` contract that returns a raw TOML string. Step 2 also offers a simpler alternative (base64-encoded PowerShell for the Windows writer, matching `execute-prompt.writePromptFile`). Pick after reproduction points at a specific writer; do not force an upstream `composePermissionConfig` refactor pre-emptively.

2. **Task 2.2 pgrep/pkill pattern.** Risk row 4 calls for exact-name matching; task body still shows loose `pgrep -f apra-fleet` / `pkill -f apra-fleet`. In SEA mode this will match the installer itself — causing always-busy false positives and self-kill on `--force`. Tighten to `pgrep -x apra-fleet` or exclude current PID, and add an integration test that runs the detection under the installer's own process.

One plan-hygiene note (deferred, not required for this sprint): restate the "never commit CLAUDE.md / permissions.json / sprint-control files" requirement in a header-level constraints section so each doer sees it without re-reading requirements.md.

Proceed to execution.

---

## Re-review — Task 2.3 (#142) addition

- **Reviewer:** fleet-rev
- **Date:** 2026-04-16
- **Verdict:** APPROVED

Re-reviewed the PLAN.md update from commit `f1a9d01` which adds Task 2.3 (#142 — `install --help` executes install instead of printing help) to Phase 2, along with the matching requirements.md update.

### 1. Clear done criteria — PASS (one soft bullet)

Task 2.3 Done: "`apra-fleet install --help` and `apra-fleet install -h` print help and exit with no side effects; existing tests pass; new test added."

The first clause is behavioral and test-verifiable. "New test added" is softer — it doesn't specify the assertions (e.g. "asserts no `fs.writeFile` and no `execSync` call when args include `--help`"). Acceptable for a cheap task; VERIFY 2's new checkbox ("`apra-fleet install --help` and `-h` print help and exit 0 with no side effects") tightens the phase-gate.

### 2. Placement before VERIFY checkpoint — PASS

Task 2.3 sits at PLAN.md:124, immediately before VERIFY 2 at line 132. VERIFY 2 was updated in the same commit to add the `--help` / `-h` no-side-effects checkbox — phase-gate evidence is aligned with the new task. Placement is correct.

Task 2.3 sits after 2.2 in the plan but is structurally independent of both 2.1 (arg-parser refactor) and 2.2 (force/busy prompt). The Phase 2 preamble ("Order matters: #139 refactors the `--skill` parser; #96 adds a pre-check before binary copy") does not need updating because 2.3 is a guard at the top of the handler — it does not touch the parser or the process-detection code, so implementation order among the three is flexible. Runtime order is enforced by task 2.3 step 1 ("At the very top of the install command handler").

### 3. Tier assignment (cheap) — PASS

Correct. The change is a single-digit LoC guard (arg scan + usage print + `process.exit(0)`) plus a mocked-fs test. Matches the `cheap` tier used for pure doc task 3.2. No diagnostics, no multi-file refactor, no provider-layer reasoning.

### 4. Guard ordering — PASS

Task 2.3 step 1: "At the very top of the install command handler, before any file writes, config reads, or process detection." This correctly precedes:
- 2.1's `--skill` parsing (so no skill-dir writes before help short-circuits)
- 2.2's `pgrep`/`tasklist` probe (so no process detection before help short-circuits)
- The existing binary-copy step in `runInstall`

Matches requirements §#142 verbatim ("Must be the **first** thing checked in the install command handler"). The guard is before all side-effectful work.

### Minor findings (non-blocking)

1. **Soft file target.** Task 2.3 Files field reads "whichever file contains the install command entry point (likely `src/cli/install.ts`)." Every other task in the plan names exact files. A quick grep would confirm the entry point. Cheap to tighten; not blocking since the doer will grep anyway.

2. **Scope narrowing vs. requirements.** Requirements §#142 ends with "Apply consistently to all subcommands." Task 2.3 only covers the `install` subcommand. The requirements' own acceptance criteria are scoped to `install --help` / `install -h`, so the task matches what will be verified, but the broader "all subcommands" directive is dropped silently. Flag for the doer: if other subcommands have side effects, reuse the guard pattern (a small `hasHelpFlag(args)` helper would make this natural). Not blocking for this sprint.

3. **Test shape not specified.** "New test added" could be tightened to "asserts no write to mocked `fs` and no call to `execSync` when args include `--help` or `-h`, and asserts exit code 0." Would give the doer an exact target and the reviewer an exact assertion to grep.

### Other plan-level check

VERIFY FINAL (Phase 4) should also include the new acceptance-criteria checkbox ("`apra-fleet install --help` / `-h` prints help and exits — no side effects"). Currently only VERIFY 2 has it; the requirements.md acceptance list was updated to include it (line +190) but PLAN.md's VERIFY FINAL section was not. Recommend adding one line to Phase 4 for end-of-sprint audit completeness. Trivial edit, non-blocking.

The requirements diff also adds the `cherry-pick 0b9c2f7` section (line +168). This is already landed on the branch as commit `6e48ece` (flagged in the original review, section 10). The plan correctly does not re-list it as a task. Consistent.

### Verdict

**APPROVED** — proceed with Task 2.3 as written. The three minor findings above are doer-side tightenings, not plan defects. Recommend the one VERIFY FINAL mirror-edit as a low-effort plan-hygiene improvement.
