# Bug — `send_files` / `receive_files` fail when transferring to/from Windows members

**Reporter:** kashyapj@apra.in (PM, observed during a separate sprint)
**Date observed:** 2026-05-01
**Suspected version:** v0.1.4 (PR #97 — `d0139ff fix: rename send_files/receive_files params...`)
**Severity:** P0 — blocks all file transfer to/from Windows members; only workaround is base64-over-execute_command
**Branch:** `bug_fix/file-transfer-windows`
**Base branch:** `main`

## Goal

1. **Open a GitHub issue** on `Apra-Labs/apra-fleet` documenting the bug with full repro details (this requirements file is the source).
2. **Identify when the regression was introduced** — bisect to the offending commit / PR.
3. **Diagnose root cause** — read the code, identify the broken branch.
4. **Fix the bug** — make `send_files` and `receive_files` work end-to-end against Windows members from a Linux driver.
5. **Add a regression test** that would have caught this — must run in CI.
6. **Verify the fix** by running the exact failing repros from this document and confirming success.

---

## Bug Summary

The `send_files` and `receive_files` MCP tools both fail with `❌ ... No such file` when the driver is a Linux machine and the target is a Windows member, even when the file demonstrably exists on disk on the relevant side. Linux↔Linux transfers (between the local driver and a local Linux member) appear unaffected.

The error message is misleading — the file *does* exist; the tool just can't find it. Whatever path-resolution / SFTP-listing path the tool is taking for Windows members is broken.

## Repro environment

- **Driver:** kashyap@apra-linux — local Linux, apra-fleet `v0.1.8.0_1ee188`
- **Target:** `regenmed-dev` member — Windows on `100.84.84.20:22` (Tailscale), `work_folder = C:\Users\Kashyap\bkp\source\repos\incytes-app-30`
- **Adjacent Windows member on same host:** `apra-fleet-reviewer` — same `100.84.84.20:22`, `work_folder = C:\Users\Kashyap\bkp\source\repos\apra-fleet`. **Use this for local repro from the doer side.** (Both should fail identically.)

## Failing cases (verbatim, captured 2026-05-01)

### Case 1 — receive_files with dotted path
```json
{
  "member_name": "regenmed-dev",
  "remote_paths": [".claude/skills/fhir-regenmed-mapper/SKILL.md"],
  "local_dest_dir": "/tmp/regenmed-skill-update"
}
```
**Result:** `❌ Failed to download 1 file(s): SKILL.md: No such file`
**Verified the file exists:** PowerShell `Get-Item` on the doer reports `Length: 20727 bytes, LastWriteTime: 16-04-2026 12:38:50`.

### Case 2 — receive_files with non-dotted path (relative to work_folder)
```json
{
  "member_name": "regenmed-dev",
  "remote_paths": ["_staging/SKILL.md"],
  "local_dest_dir": "/tmp/regenmed-skill-update"
}
```
**Result:** `❌ Failed to download 1 file(s): SKILL.md: No such file`
**Verified the file exists:** `Get-ChildItem C:\Users\Kashyap\bkp\source\repos\incytes-app-30\_staging` returned `SKILL.md, Length: 20727 bytes`.

### Case 3 — receive_files with absolute Windows path
```json
{
  "member_name": "regenmed-dev",
  "remote_paths": ["C:\\Users\\Kashyap\\bkp\\source\\repos\\incytes-app-30\\_staging\\SKILL.md"],
  "local_dest_dir": "/tmp/regenmed-skill-update"
}
```
**Result:** `❌ Failed to download 1 file(s): SKILL.md: No such file`

### Case 4 — send_files with absolute local path
```json
{
  "member_name": "regenmed-dev",
  "local_paths": ["/tmp/regenmed-skill-update/SKILL.md"],
  "dest_subdir": "_staging"
}
```
**Result:** `❌ Failed to upload 1 file(s): SKILL.md: No such file. Destination: C:/Users/Kashyap/bkp/source/repos/incytes-app-30/_staging`
**Verified source exists:** `ls -la /tmp/regenmed-skill-update/SKILL.md` → `28769 bytes`.

### Case 5 — send_files with a freshly named copy (rules out caching)
```json
{
  "member_name": "regenmed-dev",
  "local_paths": ["/tmp/regenmed-skill-update/SKILL_v2.md"],
  "dest_subdir": "_staging"
}
```
**Result:** `❌ Failed to upload 1 file(s): SKILL_v2.md: No such file. Destination: C:/Users/Kashyap/bkp/source/repos/incytes-app-30/_staging`

### Working case for contrast (Linux↔Linux)
- `send_files` from the Linux driver to the local Linux apra-edge-vision-doer (`/home/kashyap/repos/apra/apra-edge-vision`) works — confirmed earlier this session via direct file ops.

The only common factor in the failures is that the **target / source member is Windows**.

## Suspected source of regression

**PR #97** (`d0139ff fix: rename send_files/receive_files params and fix skill doc inconsistencies`) — merged 2026-04-08 by Akhil Kumar. The PR explicitly renamed:
- `destination_path → dest_dir → dest_subdir` (send_files)
- `local_destination → local_dest_dir` (receive_files)

Plus other "drop redundant directory hint from schema descriptions" and small refactors. This PR is the most recent change to `src/tools/send-files.ts` and `src/tools/receive-files.ts` based on `git log --oneline -- src/tools/send-files.ts src/tools/receive-files.ts`.

**Hypothesis to verify (DO NOT trust without bisect):** the rename touched a path-resolution code path that handles Windows-style remote paths differently from Linux-style ones, and the rename broke either:
- The remote SFTP path resolution (Windows uses backslashes natively, but the PR may have introduced a forward-slash-only assumption), or
- The local path validation (the schema rename may have introduced a new validator that rejects valid paths), or
- The error reporting layer (could be a real success but a wrong "No such file" string from the failure path being taken when it shouldn't be).

**Bisect range:** `git log --oneline d0139ff~1..main` (between the parent of PR #97 and current main) gives the candidate commit window. Bisect the commits that touch `src/tools/send-files.ts`, `src/tools/receive-files.ts`, `src/services/strategy.ts`, or `src/services/sftp.ts`.

## Risk register

| ID | Risk | Severity | Mitigation |
|----|------|----------|------------|
| R1 | Other PR-#97-style refactors may have introduced silent behavior changes in adjacent file-transfer paths | HIGH | Run the full file-transfer test suite after fix; add a Windows-target SFTP integration test if missing |
| R2 | The bug may also affect remote Linux members (rport/SSH targets) — only Windows is confirmed broken because that's what was tested | MEDIUM | Doer must test against a remote Linux member (e.g., `edge-mos-srv` via rport) as part of the repro phase; expand fix scope if it also fails there |
| R3 | The reviewer's working tree at sprint kickoff has 11 files showing 763+/763- diffs that look like a CRLF mass-flip from a Windows checkout — discard with `git checkout .` after confirming with `git diff -w` (whitespace-only diff) returns empty | LOW | Doer instructs PM to run discard on reviewer; verify post-discard that working tree is clean |
| R4 | A fix that "works" but doesn't address the real root cause (e.g., catches the error and silently retries) ships a band-aid | HIGH | Reviewer must validate the fix addresses the diagnosed root cause, not just the symptoms |

## Acceptance criteria

1. **GH issue opened** on `Apra-Labs/apra-fleet` with this requirements file's content as the body, labeled `bug, P0, regression`. Link the suspected PR #97. Title: `bug: send_files / receive_files fail against Windows members from Linux driver (since v0.1.4)`.
2. **Bisect commit identified** — root-cause commit SHA + PR # documented in `feedback.md` (or sprint output) with a one-paragraph diagnosis.
3. **Code fix** in `src/tools/send-files.ts` and/or `src/tools/receive-files.ts` and/or shared layer (`strategy.ts`, `sftp.ts`) — minimal change, addresses the diagnosed root cause, no incidental refactoring.
4. **Regression test** in `tests/` that exercises the failing path against a mocked Windows-style remote agent. Must fail on the buggy code, pass on the fixed code. CI must run it.
5. **End-to-end verification** — run all 5 failing repro cases above against `regenmed-dev` (PM will assist if doer can't reach it directly) and confirm all 5 succeed.
6. **Build green:** `npm run build` clean, `npm test` all pass.
7. **PR raised** against `main` referencing the GH issue. Reviewer APPROVES via fleet review process.

## Additional in-scope deliverables — guardrails so this regression never lands silently again

The user explicitly added scope: **"update the documentation and CLAUDE.md and unit tests in apra-fleet so that any other feature or issue regarding send/receive files also considers Linux sending and receiving from Windows."** The bug-fix PR must also include the following guardrails so a future PR cannot silently re-break Linux↔Windows transfers without it being caught at review time, in tests, or by the agent context file.

### G1 — Cross-OS test matrix in `tests/`

Add a documented test matrix that covers **every supported (driver, target) OS combination** for both `send_files` and `receive_files`. At minimum the matrix must enumerate:

| Driver OS | Target member type | send_files | receive_files |
|-----------|-------------------|------------|---------------|
| Linux | local Linux member | required | required |
| Linux | remote Linux member (SFTP) | required | required |
| Linux | remote Windows member (SFTP, work_folder is Windows path) | **required — this is what was missed** | **required — this is what was missed** |
| Windows | local Windows member | required | required |
| Windows | remote Linux member (SFTP) | required | required |
| Windows | remote Windows member (SFTP) | required | required |
| any | cloud member (auto-start path) | required (existing) | required (existing) |

Implement these as parameterized vitest cases that mock `agentType`, `workFolder` style (forward slash vs backslash), and the SFTP transport. They must FAIL on the buggy code and PASS on the fix. Place the matrix in `tests/file-transfer-matrix.test.ts` (or extend `tests/send-files.test.ts` / `tests/receive-files.test.ts` if those are the natural homes — judgment call, document choice in PR description).

The matrix file must include a comment block at the top:

```
// File-transfer cross-OS matrix.
// Any change to src/tools/send-files.ts, src/tools/receive-files.ts,
// src/services/strategy.ts, or src/services/sftp.ts MUST keep this matrix passing.
// If you add a new (driver, target) combination, add a row here first.
// Bug history: PR #97 silently broke Linux→Windows transfers because no
// test in this matrix existed for that combination — see issue #<n>.
```

### G2 — `tests/README.md` (or equivalent) documents the matrix

Add a short section in the test docs (`tests/README.md` if it exists, otherwise add it) that explains:
- What the cross-OS matrix is and why it exists
- The PR #97 incident as the cautionary tale (link to the GH issue this sprint opens)
- The rule: any PR touching the four files above must keep the matrix passing AND must add a new matrix row if a new transport / OS combination is introduced

### G3 — Project-level `CLAUDE.md` in apra-fleet repo

Add a section to the project's `CLAUDE.md` (the *project* one in `apra-fleet/CLAUDE.md`, not the agent-context one — the latter is .gitignored) under a heading like "File Transfer Tools" with these explicit instructions for any future agent / contributor working on `send_files` / `receive_files`:

```markdown
## File Transfer Tools (`send_files`, `receive_files`)

Both tools must work bidirectionally across all supported OS combinations. The
authoritative test matrix is in `tests/file-transfer-matrix.test.ts` — it
enumerates every (driver OS, target member type) combination and the strategy
each must use.

**Before any change to `src/tools/send-files.ts`, `src/tools/receive-files.ts`,
`src/services/strategy.ts`, or `src/services/sftp.ts`:**

1. Read `tests/file-transfer-matrix.test.ts` and confirm you understand which
   cases your change affects.
2. Run the matrix: `npm test tests/file-transfer-matrix.test.ts` — it must pass
   before AND after your change.
3. If you are adding a new transport, OS combination, or path-style assumption,
   add a new row to the matrix BEFORE writing the code.
4. **Path style is the trap.** Windows members report `work_folder` with
   backslashes (e.g. `C:\Users\...`). The path-resolution code must normalize
   to forward slashes only on the SFTP path side, never on the local side.
   The bug fixed by issue #<n> was a Linux-side validator rejecting Windows
   absolute paths because of this — do not reintroduce it.
5. Path validation must use `agentType` to choose between
   `path.resolve` (local agents) and `path.posix.resolve` (remote SFTP agents) —
   never assume the local Node `path` API matches the remote OS.

PRs that don't follow this checklist will be rejected at review.
```

The exact wording can be tightened — what matters is that the project CLAUDE.md captures (a) the test matrix exists and is authoritative, (b) a PR checklist for changes to file-transfer code, (c) the specific path-style trap that caused this incident.

### G4 — Update `skills/fleet/SKILL.md` file-transfer section

In the apra-fleet repo's `skills/fleet/SKILL.md` "File Transfer" section, add an explicit callout that both tools must work for Linux↔Windows transfers in both directions, and that the test matrix in `tests/file-transfer-matrix.test.ts` is authoritative. This callout reaches every PM/fleet user — not just contributors to the apra-fleet repo.

### G5 — CI gate (if not already in place)

Confirm the test matrix runs in CI (`.github/workflows/*.yml` — likely already covered by `npm test`, but verify). If not, add it. CI must fail any PR that breaks the matrix.

### Acceptance criteria for guardrails (in addition to the original 7)

8. `tests/file-transfer-matrix.test.ts` exists, contains every row in the matrix above, fails on the original buggy code, passes on the fixed code, and runs in CI.
9. `tests/README.md` documents the matrix and the PR #97 incident.
10. Project `apra-fleet/CLAUDE.md` has the File Transfer Tools section with the PR checklist + path-style warning.
11. `skills/fleet/SKILL.md` file-transfer section has the cross-OS callout.
12. The reviewer explicitly verifies (in feedback.md) that all 5 guardrail deliverables (G1–G5) landed and would prevent a re-occurrence of this regression.

## Out of scope

- Any work on the broader Extract Org-Prefix sprint (paused for this bug).
- Refactoring of file-transfer code beyond what the fix + guardrails require.
- Changing the `send_files` / `receive_files` API signatures (the v0.1.4 rename stays — we're fixing behavior, not re-renaming).
- The reviewer-side `error: cannot run ssh: No such file or directory` from `git fetch` — adjacent issue, log it as a separate GH issue but do NOT fix in this sprint.
- Implementing the matrix for OS combinations that aren't supported today (e.g., macOS as driver) — leave a TODO row for them only if they're documented as future work elsewhere.
