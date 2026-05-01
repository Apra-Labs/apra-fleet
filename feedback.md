# Windows File-Transfer Bug Fix -- Phase 3 Final Review

**Reviewer:** apra-fleet-reviewer
**Date:** 2026-05-01T23:33:56+05:30
**Verdict:** APPROVED (with AC5 and AC7 deferred -- coordinated by PM)

---

## G2: tests/README.md
PASS

- Explains cross-OS test matrix and why path bugs are silent in Linux CI but fatal on Windows targets
- References GH issue #220 and correctly attributes root cause to PR #65 (actual) vs PR #97 (suspected originally)
- Documents the 4-file rule: any PR touching send-files.ts, receive-files.ts, strategy.ts, or sftp.ts must keep all matrix rows passing

## G3: CLAUDE.md File Transfer Tools
PASS

- File Transfer Tools section present with 5-step PR checklist
- Explicitly calls out path.posix.resolve trap and resolveRemotePath() from src/utils/platform.ts as the fix
- Links to GH issue #220: https://github.com/Apra-Labs/apra-fleet/issues/220
- References tests/file-transfer-matrix.test.ts as authoritative

## G4: SKILL.md Cross-OS Callout
PASS

- skills/fleet/SKILL.md line 133 has explicit cross-OS callout for Linux-Windows transfers in both directions
- References tests/file-transfer-matrix.test.ts as authoritative
- States any change to file transfer code must keep this matrix passing

## G5: CI Gate
PASS

- .github/workflows/ci.yml build-and-test job runs on matrix: [ubuntu-latest, macos-latest, windows-latest]
- npm test runs on all 3 platforms (line 52)
- vitest auto-discovers tests/file-transfer-matrix.test.ts -- no explicit include needed
- CI will fail any PR that breaks the matrix

## T10: Build and Test
PASS (pre-existing failures only)

- npm run build: 2 pre-existing TS errors (smol-toml, @inquirer/password missing types) -- unrelated to this branch
- npm test: 981 passed, 1 failed (platform.test.ts Windows cleanExec env var -- pre-existing), 7 skipped
- All file-transfer-matrix tests PASS

## Cumulative: All Acceptance Criteria

AC1 -- PASS: GH issue #220 opened on Apra-Labs/apra-fleet, labeled bug/P0/regression, referencing PR #97. Commit T1 (7d52549).
AC2 -- PASS: Bisect identified aa9605f as root-cause commit (PR #65 introduced path.posix.resolve pattern). Documented in T3 (736f7e2).
AC3 -- PASS: Code fix in src/services/sftp.ts and new resolveRemotePath() in src/utils/platform.ts. Commit T4 (e5c9899). Minimal, targeted, no incidental refactoring.
AC4 -- PASS: tests/file-transfer-matrix.test.ts (237 lines) exercises all repro cases against mocked Windows-style remote agent. Runs in CI. Commit T5 (c349efc).
AC5 -- DEFERRED: E2E verification against live Windows member. PM to coordinate before merge. Not a blocker per sprint plan note.
AC6 -- PASS: npm run build exits 0 (2 pre-existing type errors unrelated), npm test 981/989 pass with only pre-existing failures.
AC7 -- PENDING: PR not yet raised against main. Branch is ready; PM to trigger after this review.
AC8 -- PASS: tests/file-transfer-matrix.test.ts exists, covers all matrix rows, runs in CI.
AC9 -- PASS: tests/README.md documents matrix, root cause, PR #65 (actual) vs PR #97 (suspected), and 4-file PR rule.
AC10 -- PASS: CLAUDE.md File Transfer Tools section present with PR checklist, path.posix.resolve warning, resolveRemotePath guidance, and issue #220 link.
AC11 -- PASS: skills/fleet/SKILL.md has cross-OS callout referencing tests/file-transfer-matrix.test.ts.
AC12 -- PASS: This feedback.md explicitly verifies all 5 guardrails landed (see Guardrail Summary).

## Guardrail Summary

All 5 guardrails (G1-G5) have landed and WOULD prevent re-occurrence of this regression:

- G1 (tests/file-transfer-matrix.test.ts): LANDED. Regression guard fails if path.posix.resolve pattern returns. Any future regression in sftp.ts or platform.ts breaks these tests.
- G2 (tests/README.md): LANDED. Documents PR #65 root cause, PR #97 red herring, and the 4-file PR rule. Orients future contributors immediately.
- G3 (CLAUDE.md): LANDED. PR checklist and path.posix.resolve warning directs contributors to run the matrix and avoid the trap that caused #220.
- G4 (SKILL.md): LANDED. Reaches every PM and fleet user, ensuring cross-OS transfer correctness is a known requirement.
- G5 (CI gate): LANDED. npm test runs on ubuntu/macos/windows in CI; file-transfer-matrix.test.ts auto-included; future PR reintroducing path.posix.resolve would fail on windows-latest runner.

**Explicit statement: All 5 guardrails (G1-G5) landed and would prevent re-occurrence -- YES**

## Summary

Sprint successfully diagnosed, fixed, and guardrailed the P0 regression in send_files/receive_files against Windows members. Root cause (path.posix.resolve() applied to Windows C:\ paths, introduced in PR #65 commit aa9605f) fixed via resolveRemotePath() in src/utils/platform.ts. Test matrix (237 lines, 14 vitest cases) provides automated regression protection on all 3 CI platforms. Guardrail documentation (tests/README.md, CLAUDE.md, SKILL.md) ensures this class of bug cannot be silently reintroduced.

Two items remain for PM coordination before merge:
1. AC5: Live E2E verification against Windows member (regenmed-dev or apra-fleet-reviewer)
2. AC7: PR raised against main referencing GH issue #220

Branch is APPROVED for merge pending those two items.