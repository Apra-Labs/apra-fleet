# PLAN.md: UX, Quality & Installer Fixes Sprint

## Phase 1 — Front-loaded High Risk Fixes (OOB Terminal & Installer)
**Task 1: Issue #42 — OOB terminal cancellation & paste support**
- **Change:** Refactor `auth-socket.ts` to capture window close, Ctrl+C, or Esc events and return proper cancellation to unblock calling tools (`provision_auth`, `register_member`). Adjust terminal arguments to ensure paste functionality works out-of-the-box.
- **Files:** `src/services/auth-socket.ts`
- **Done when:** The caller unblocks immediately if OOB window is closed or canceled via Esc/Ctrl+C. Paste (Ctrl+V/right-click) successfully inputs text in the terminal.
- **Blockers:** None
- **Tier:** Doer

**Task 2: Issue #78 — Installer versioned MCP key**
- **Change:** Inject version string into the MCP config key (e.g. `apra-fleet_v0.1.3_d10302`). In `install.ts`, identify and delete any older `apra-fleet*` keys from Claude/Gemini/Codex/Copilot configs before registering the new one.
- **Files:** `src/cli/install.ts`, `src/index.ts`
- **Done when:** A fully versioned key is injected. Upgrades correctly rip out legacy unversioned/older keys.
- **Blockers:** None
- **Tier:** Doer

**Task 3: Phase 1 VERIFY Checkpoint**
- **Change:** Ensure no regression in existing auth flows or installer CLI behavior.
- **Files:** N/A
- **Done when:** Tests and `npm run build` pass cleanly.

---

## Phase 2 — State Integrity & Security Testing
**Task 4: Issue #57 — update_task_tokens silent data loss on git commit failure**
- **Change:** Decouple the file write from the git commit. Always write the updated `progress.json` payload to disk successfully. If git commit fails (e.g. outside repo), log error but return successful token update so the ledger remains accurate.
- **Files:** `src/tools/update-task-tokens.ts`
- **Done when:** Re-running the tool outside a git repo strictly accumulates token values and saves to disk.
- **Blockers:** None
- **Tier:** Doer

**Task 5: Issue #67 — .fleet-task* files committed to member repos**
- **Change:** Generate prompt task delivery files in an OS temporary folder instead of the working repo folder, or append `.fleet-task*` dynamically to a repo's `.gitignore` before writing. Also ensure PM templates enforce the rule.
- **Files:** `src/tools/execute-prompt.ts`, `skills/pm/tpl-doer.md`
- **Done when:** Task text files cannot accidentally be committed to member repositories.
- **Blockers:** None
- **Tier:** Doer

**Task 6: Issue #6 — Credential leakage test is a no-op**
- **Change:** Update the unit test in `security-hardening.test.ts` to actually invoke `ensureCloudReady()` with an error condition, rather than simply mocking string `.slice()`.
- **Files:** `tests/security-hardening.test.ts`
- **Done when:** Test meaningfully fails if credential masking logic in `ensureCloudReady` is removed.
- **Blockers:** None
- **Tier:** Doer

**Task 7: Phase 2 VERIFY Checkpoint**
- **Change:** Validate token accumulation under git failure and run tests.
- **Files:** N/A
- **Done when:** Token operations persist. `npm run build` and `npm test` pass.

---

## Phase 3 — Edge Cases & Minor Bugs
**Task 8: Issue #37 — --version reports wrong version**
- **Change:** Hook up proper build-time version string injection (`BUILD_VERSION`) into the CI and build scripts so `--version` dynamically matches the github tag and commit hash.
- **Files:** `src/version.ts`, `.github/workflows/ci.yml`
- **Done when:** The compiled binary emits the injected semver tag + commit hash on `--version`.
- **Blockers:** None
- **Tier:** Doer

**Task 9: Issue #9 — parseGpuUtilization accepts invalid values**
- **Change:** Add bounds checking logic to `parseGpuUtilization` ensuring values fall exclusively between 0 and 100. Write corresponding failure bounds cases in the unit tests.
- **Files:** `src/utils/gpu-parser.ts`, `tests/gpu-parser.test.ts`
- **Done when:** Function returns undefined on negative numbers and >100.
- **Blockers:** None
- **Tier:** Doer

**Task 10: Issue #39 — De-registered member icon persists in UI**
- **Change:** Append manual refresh instructions (`/mcp` -> Reconnect) to the `remove_member` tool's success output message.
- **Files:** `src/tools/remove-member.ts`
- **Done when:** Output explicitly tells users how to refresh the UI.
- **Blockers:** None
- **Tier:** Doer

**Task 11: Issue #10 — update_member silently ignores cloud fields on non-cloud**
- **Change:** Return a specific warning string if a user tries to attach cloud properties (e.g. `cloud_region`) onto a local or standard remote member.
- **Files:** `src/tools/update-member.ts`
- **Done when:** The response includes `Warning: cloud fields (X) are ignored...` for non-cloud members.
- **Blockers:** None
- **Tier:** Doer

**Task 12: Phase 3 VERIFY Checkpoint**
- **Change:** Final sanity check across the whole suite.
- **Files:** N/A
- **Done when:** `npm run build` and `npm test` pass.

---

## Risk Register
1. **OOB Terminal:** Changing the invocation string and waiting behavior might negatively interact with Windows `cmd.exe` vs macOS `osascript`, so careful platform isolation testing is needed.
2. **Version Injection:** Esbuild configuration for `BUILD_VERSION` environment injection needs to be correctly quoted or it will break the compilation step in CI.
