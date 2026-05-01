# apra-fleet — bug: send_files / receive_files fail against Windows members

> Fix Linux→Windows file transfers that fail with "No such file" due to `path.posix.resolve` mishandling Windows drive-letter paths in the SFTP transport layer.

---

## Exploration Summary

### Root Cause: `path.posix.resolve` in `sftp.ts`

The bug is in `src/services/sftp.ts`, not in the tool-level files (`send-files.ts`, `receive-files.ts`). Both `uploadViaSFTP` (line 68) and `downloadViaSFTP` (line 109) use `path.posix.resolve()` to compute remote SFTP paths. This function does NOT understand Windows drive letters — it treats `C:/Users/...` as a relative path (not starting with `/`) and prepends the local process CWD:

```
path.posix.resolve('C:/Users/Kashyap/repos', '_staging')
→ '/home/kashyap/repos/apra/apra-fleet/C:/Users/Kashyap/repos/_staging'  ← BROKEN
```

The SFTP server receives this garbage path → "No such file".

### Why NOT PR #97

PR #97 (`d0139ff`) only renamed parameters (`destination_path → dest_subdir`, `local_destination → local_dest_dir`). The `path.posix.resolve` calls in `sftp.ts` were **not touched** by PR #97. The bug likely existed from the initial creation of `sftp.ts` — it was never caught because no Windows member existed to test against until recently.

PR #174 (`98b348f`) partially fixed Windows path handling by adding `isContainedInWorkFolder()` to `platform.ts`, fixing **path validation**. But it did not fix **path resolution in the SFTP transfer layer** (`sftp.ts`).

### Verified assumptions

1. `path.posix.resolve('C:/Users/...', '_staging')` produces a Linux-CWD-prefixed garbage path (confirmed via Node.js REPL)
2. `sftp.ts` uses `path.posix.resolve` in both `uploadViaSFTP` (line 68) and `downloadViaSFTP` (line 109) — confirmed by reading the code
3. `sftp.ts` was NOT modified by PR #97 — confirmed by `git show d0139ff --stat` (sftp.ts not listed)
4. The existing `isContainedInWorkFolder` in `platform.ts` correctly handles Windows drive letters — the same resolution pattern should be applied in `sftp.ts`
5. Linux→Linux works because Linux work folders start with `/`, which `path.posix.resolve` handles correctly
6. The existing tests mock the SFTP layer (`vi.spyOn(sftp, 'downloadViaSFTP')`) — they never exercise the actual path resolution inside `sftp.ts`

### Commits touching file-transfer code since PR #97

| SHA | Description | Impact |
|-----|-------------|--------|
| `d0139ff` | PR #97 — param renames | Changed param names in send-files.ts/receive-files.ts, NOT sftp.ts |
| `98b348f` | PR #174 — Windows path rejection fix | Fixed path validation, did NOT fix sftp.ts path resolution |
| `b1646c4` | PR #175 — collision detection | send-files.ts only, unrelated |
| `86431fc` | PR #171 — deleteFiles escaping | strategy.ts only, unrelated |
| `a6f505a` | PR #183 — session lifecycle | Touched strategy.ts (signal arg), unrelated |
| `8c15862` | PR #202 — JSONL logging | Structural, unrelated |
| `1ee1881` | PR #207 — JSONL parseResponse | Touched sftp.ts but only for logging, not path resolution |

### Bisect commit window

The standard bisect range is `d0139ff~1..HEAD`, but based on code analysis, the bug **predates PR #97**. The actual regression was introduced when `sftp.ts` was first created with `path.posix.resolve` for remote path computation. Bisect (T3) will confirm this by finding when `sftp.ts` was first added and verifying the bug existed from inception.

### Patterns and constraints

- **Path resolution pattern** already exists in two places: `isContainedInWorkFolder` (platform.ts) and lines 52-55 of `send-files.ts`. Both correctly handle Windows drive letters. The fix applies this same pattern in `sftp.ts`.
- **`sftpMkdirRecursive`** handles Windows drive-letter paths acceptably — it tries to mkdir each segment (`C:`, `C:/Users`, etc.) and catches errors for existing dirs.
- **CI** already runs on `ubuntu-latest`, `macos-latest`, `windows-latest` with `npm test` — new test files are picked up automatically.
- **Test infrastructure** uses vitest, mocks via `vi.mock`/`vi.spyOn`, and `test-helpers.ts` for test agents.

---

## Tasks

### Phase 1: Root Cause Identification

**Rationale:** Confirm the root cause before writing any fix. The GH issue needs accurate diagnosis, bisect validates whether this is PR #97 or a pre-existing bug. All tasks share the same domain context.

#### T1: Open GitHub issue

- **Change:** Create GH issue on `Apra-Labs/apra-fleet` with the full repro from `requirements.md`. Title: `bug: send_files / receive_files fail against Windows members from Linux driver (since v0.1.4)`. Labels: `bug, P0, regression`. Link PR #97 as the suspected source. Body includes all 5 failing cases, the working Linux↔Linux contrast, and the suspected root cause area.
- **Files:** None (external — `gh issue create`)
- **Tier:** cheap
- **Done when:** GH issue exists with correct title, labels, and body. Issue number captured for reference in subsequent tasks.
- **Blockers:** None

#### T2: Reproduction test proving the path.posix.resolve bug

- **Change:** Create `tests/sftp-path-resolution.test.ts` with tests demonstrating that `path.posix.resolve` produces incorrect paths for Windows drive-letter work folders. Tests should:
  1. Show `path.posix.resolve('C:/Users/Kashyap/repos', '_staging')` does NOT produce `C:/Users/Kashyap/repos/_staging`
  2. Show the same call with a Linux work folder (`/home/user/repos`) works correctly
  3. Test with all path styles from the 5 repro cases (relative, dotted, absolute Windows)
  4. This test documents the fundamental bug and serves as a bisect oracle
- **Files:** `tests/sftp-path-resolution.test.ts`
- **Tier:** standard
- **Done when:** Test file exists, all tests pass (they demonstrate the bug exists in the current code), `npm test tests/sftp-path-resolution.test.ts` succeeds.
- **Blockers:** None

#### T3: Bisect + root cause documentation

- **Change:**
  1. Run `git log --follow --diff-filter=A -- src/services/sftp.ts` to find when sftp.ts was first added
  2. If the `path.posix.resolve` pattern existed in the initial commit, document that this is a pre-existing feature gap, not a regression from PR #97
  3. If it was introduced later, identify the commit
  4. Write `feedback.md` documenting: root cause commit SHA, one-paragraph diagnosis, whether this is a regression or feature gap
- **Files:** `feedback.md`
- **Tier:** standard
- **Done when:** `feedback.md` exists with root cause commit SHA, diagnosis paragraph, and classification (regression vs. feature gap). The diagnosis matches the code evidence.
- **Blockers:** T2 must be complete (reproduction test confirms the bug)

#### VERIFY: Phase 1 — Root Cause

- GH issue exists on `Apra-Labs/apra-fleet` with correct title, labels, and body
- Reproduction test passes and demonstrates the `path.posix.resolve` bug
- `feedback.md` documents root cause commit, diagnosis, and classification
- Bisect result confirms or refutes PR #97 as the source

---

### Phase 2: Fix + Test Matrix

**Rationale:** The fix and the test matrix are tightly coupled — the tests validate the fix, and both must land together to be meaningful.

#### T4: Implement fix in sftp.ts + platform.ts

- **Change:**
  1. Add `resolveRemotePath(workFolder: string, subPath: string): string` to `src/utils/platform.ts` — normalizes backslashes to forward slashes, detects Windows drive letters (`/^[A-Za-z]:/`), joins paths correctly without `path.posix.resolve`
  2. In `src/services/sftp.ts` `uploadViaSFTP`: replace `path.posix.resolve(workFolderPosix, destinationPath.replace(...))` on line 68 with `resolveRemotePath(agent.workFolder, destinationPath)`. Use `resolveRemotePath` for `workFolderPosix` fallback too.
  3. In `src/services/sftp.ts` `downloadViaSFTP`: replace `path.posix.resolve(workFolderPosix, remotePath.replace(...))` on line 109 with `resolveRemotePath(agent.workFolder, remotePath)`.
  4. Clean up unused `workFolderPosix` locals if no longer needed.
- **Files:** `src/utils/platform.ts`, `src/services/sftp.ts`
- **Tier:** standard
- **Done when:**
  - `resolveRemotePath` exists in `platform.ts` and is exported
  - `sftp.ts` no longer uses `path.posix.resolve` for remote path computation
  - `npm run build` passes
  - Existing tests pass (`npm test`)
- **Blockers:** None

#### T5: Cross-OS file transfer test matrix (G1)

- **Change:** Create `tests/file-transfer-matrix.test.ts` with parameterized tests covering every (driver OS, target member type) combination from the requirements matrix. Tests should:
  1. Mock the SSH/SFTP connection layer and verify the correct remote paths are computed and passed to SFTP operations
  2. Cover: Linux→local Linux, Linux→remote Linux (SFTP), Linux→remote Windows (SFTP), and cloud member paths
  3. Windows→* combinations included as TODO/skip markers for completeness
  4. Include the comment block from G1 requirements at the top of the file
  5. Test both `send_files` and `receive_files` for each combination
  6. Specifically test the 5 repro cases from requirements.md against Windows members
- **Files:** `tests/file-transfer-matrix.test.ts`
- **Tier:** standard
- **Done when:**
  - Test file exists with required comment block header
  - All Linux→* matrix rows are implemented
  - Windows→* rows are marked TODO
  - All implemented tests pass on the fixed code
  - `npm test tests/file-transfer-matrix.test.ts` succeeds
- **Blockers:** T4 must be complete (tests verify the fix)

#### VERIFY: Phase 2 — Fix + Tests

- `npm run build` is clean
- `npm test` passes all tests including new ones
- `resolveRemotePath` correctly handles: relative paths, absolute Linux paths, absolute Windows paths, backslash paths
- File transfer matrix covers all required (driver, target) combinations
- Tests would FAIL on the pre-fix code (verify by temporarily reverting sftp.ts changes)

---

### Phase 3: Guardrails + Final Verification

**Rationale:** Documentation guardrails (G2–G5) are all cheap markdown tasks that share the goal of preventing regression. Final build verification confirms everything works together.

#### T6: tests/README.md documenting the matrix (G2)

- **Change:** Create `tests/README.md` with:
  1. Section explaining the cross-OS test matrix and why it exists
  2. The sftp.ts path resolution incident as cautionary tale (link to GH issue from T1)
  3. The rule: any PR touching `src/tools/send-files.ts`, `src/tools/receive-files.ts`, `src/services/strategy.ts`, or `src/services/sftp.ts` must keep the matrix passing AND must add a new matrix row if a new transport/OS combination is introduced
- **Files:** `tests/README.md`
- **Tier:** cheap
- **Done when:** `tests/README.md` exists with all three required sections. Links the GH issue from T1.
- **Blockers:** T1 must be complete (need issue number for link)

#### T7: Update project CLAUDE.md — File Transfer Tools section (G3)

- **Change:** Add a "File Transfer Tools" section to the tracked project `CLAUDE.md`. Content includes:
  1. Pointer to `tests/file-transfer-matrix.test.ts` as the authoritative test matrix
  2. PR checklist for changes to file-transfer code (5 steps from requirements G3)
  3. The path-style trap warning (Windows backslashes, `path.posix.resolve` pitfall, `resolveRemotePath` as the correct function)
  4. Link to the GH issue for context
- **Files:** `CLAUDE.md` (project, tracked in git via `git add -f`)
- **Tier:** cheap
- **Done when:** `CLAUDE.md` has the "File Transfer Tools" section matching the template from requirements.md G3, with actual issue number substituted.
- **Blockers:** T1 must be complete (need issue number)

#### T8: Update skills/fleet/SKILL.md — cross-OS callout (G4)

- **Change:** In the "File Transfer" section of `skills/fleet/SKILL.md`, add a callout that both tools must work for Linux↔Windows transfers in both directions, and that the test matrix in `tests/file-transfer-matrix.test.ts` is authoritative.
- **Files:** `skills/fleet/SKILL.md`
- **Tier:** cheap
- **Done when:** SKILL.md File Transfer section includes the cross-OS callout and test matrix reference.
- **Blockers:** None

#### T9: Verify CI gate (G5)

- **Change:** Confirm `.github/workflows/ci.yml` runs `npm test` which picks up all vitest test files including the new matrix test. Document confirmation in `feedback.md` (append). If the matrix test isn't automatically included, add it explicitly to the workflow.
- **Files:** `feedback.md` (append), possibly `.github/workflows/ci.yml`
- **Tier:** cheap
- **Done when:** CI gate confirmed or fixed. Documentation appended to `feedback.md`.
- **Blockers:** None

#### T10: Final build + test verification

- **Change:** Run `npm run build && npm test`. Fix any remaining issues. Ensure all tests pass including new ones.
- **Files:** Any files with remaining issues
- **Tier:** cheap
- **Done when:** `npm run build` clean (zero errors), `npm test` all pass.
- **Blockers:** All prior tasks complete

#### VERIFY: Phase 3 — Guardrails + Final

- `tests/README.md` exists with matrix docs and incident reference
- Project `CLAUDE.md` has File Transfer Tools section with PR checklist and path-style warning
- `skills/fleet/SKILL.md` has cross-OS callout in File Transfer section
- CI gate confirmed running the matrix test
- `npm run build` clean, `npm test` all pass
- All guardrail deliverables (G1–G5) landed
- Code pushed to `origin/bug_fix/file-transfer-windows`

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| Bug predates PR #97 — not a regression but a feature gap | low | Fix is the same regardless. Bisect (T3) confirms. GH issue body notes this if confirmed. |
| `sftpMkdirRecursive` also broken for Windows drive-letter paths | medium | Tested in T2/T5 — mkdir builds segments incrementally, catches errors for existing dirs. If broken, fix alongside T4. |
| `resolveRemotePath` doesn't handle edge cases (UNC paths, network shares) | low | Out of scope per requirements — only fixing drive-letter paths. Add TODO for UNC support if needed. |
| Mocked tests don't catch live SFTP server path interpretation differences | medium | T4/T5 test the path resolution logic, not the SFTP server. E2E verification against live Windows member (PM-coordinated) catches server-side issues. |
| The project CLAUDE.md requires `git add -f` due to .gitignore | low | Existing pattern — CLAUDE.md is already tracked. Document in commit message. |

## Notes

- Branch: `bug_fix/file-transfer-windows`
- Base branch: `main`
- Each task results in a git commit
- Verify tasks are checkpoints — stop and report after each one
- Phase 1 tiers: cheap → standard → standard (monotonically non-decreasing)
- Phase 2 tiers: standard → standard (monotonically non-decreasing)
- Phase 3 tiers: cheap → cheap → cheap → cheap → cheap (monotonically non-decreasing)
- E2E verification against live Windows member requires PM coordination — included in Phase 3 VERIFY
