# Gemini Member Lifecycle Walkthrough

Traces the complete PM workflow for a Gemini member. Each step is marked with its status:
- ✅ Works — implemented and tested
- ⚠️ Works with caveat — functional but with documented limitations
- ❌ Not supported — feature unavailable for Gemini provider

---

## 1. Registration

**PM action:** `register_member` with `llm_provider: 'gemini'`

| Check | Status | Notes |
|-------|--------|-------|
| `llmProvider: 'gemini'` stored in registry | ✅ | `register_member` accepts `llm_provider` param; stored in `Agent.llmProvider` |
| `member_detail` shows `llmProvider: gemini` | ✅ | `member-detail.ts` displays `llmProvider` field |

---

## 2. Onboarding (onboarding.md Steps 1–7)

| Step | Status | Notes |
|------|--------|-------|
| Step 1: SSH Key Auth | ✅ | Provider-agnostic; same for all members |
| Step 1.5: Verify CLI Installation | ✅ | Runs `gemini --version`; installs via `npm install -g @google/gemini-cli` if missing |
| Step 2: Disable AI Attribution | ✅ | Skipped for Gemini — Claude-only step |
| Step 3: Detect VCS Provider | ✅ | Provider-agnostic (`git remote -v`) |
| Step 4: Determine Roles | ✅ | Provider-agnostic |
| Step 5: Setup VCS Auth | ✅ | Provider-agnostic; Gemini uses `GEMINI_API_KEY` for LLM auth (separate from VCS auth) |
| Step 6: Install Skills | ✅ | Provider-agnostic; same skill matrix applies |
| Step 7: Member Status File | ✅ | Profile template now includes `LLM Provider: Gemini` field |

---

## 3. Permission Config

**PM action:** `compose_permissions` with `member_id`, `role: 'doer'`, `project_folder`

| Check | Status | Notes |
|-------|--------|-------|
| Detects Gemini provider | ✅ | `getProvider(agent.llmProvider)` → `GeminiProvider` |
| Delivers `.gemini/settings.json` | ✅ | Mode: `auto_edit` (doer), `default` (reviewer) |
| Delivers `.gemini/policies/fleet.toml` | ✅ | TOML policy rules with tool allow list |
| Mid-sprint grant | ✅ | Reactive path calls `composePermissionConfig('doer', grants)` and re-delivers |
| Role switch (doer→reviewer) | ✅ | Re-run `compose_permissions` with `role: 'reviewer'` |

---

## 4. Task Harness Dispatch

**PM action:** Send `tpl-doer.md` as `GEMINI.md` + PLAN.md + progress.json via `send_files`, then `execute_prompt`

| Check | Status | Notes |
|-------|--------|-------|
| Instruction file named `GEMINI.md` | ✅ | `GeminiProvider.instructionFileName = 'GEMINI.md'` |
| `execute_prompt` uses `gemini -p "..."` | ✅ | `GeminiProvider.buildPromptCommand()` produces Gemini CLI invocation |
| `--output-format json` flag applied | ✅ | `GeminiProvider.jsonOutputFlag()` |
| `--model <tier>` resolved from `cheap`/`standard`/`premium` | ✅ | `modelTiers()` maps: `cheap→gemini-3.1-flash-lite-preview`, `standard→gemini-3-flash-preview`, `premium→gemini-3.1-pro-preview` |
| `max_turns` parameter | ⚠️ | `GeminiProvider.supportsMaxTurns()` returns false — Gemini CLI has no equivalent flag. Sessions rely on Gemini's own turn management. **Mitigation:** PM's retry limit (3×) and PM's cycle limit still apply. |
| Response parsed correctly | ✅ | `GeminiProvider.parseResponse()` extracts `response` or `result` field from JSON |

---

## 5. Session Resume

| Check | Status | Notes |
|-------|--------|-------|
| Resume supported | ✅ | `GeminiProvider.supportsResume()` returns true |
| Resume flag | ✅ | `--resume` appended when `sessionId` is set in registry |
| Session ID tracking | ⚠️ | Gemini uses flag-based resume (no UUID). Server stores a boolean (`sessionId` field set to member name as marker). If the Gemini CLI's local session cache is cleared, `--resume` may silently start a fresh session. **Mitigation:** PM always checks `progress.json` for last known state during recovery. |

---

## 6. Doer–Reviewer Loop

| Check | Status | Notes |
|-------|--------|-------|
| Doer executes, commits, pushes | ✅ | Gemini CLI executes tasks like any other provider |
| VERIFY checkpoint — doer stops | ✅ | Instruction file (`GEMINI.md`) contains the same checkpoint protocol |
| PM dispatches reviewer | ✅ | Reviewer is a separate member; provider-agnostic |
| Reviewer instruction file (`GEMINI.md` or other) | ✅ | Each member uses their own provider's instruction filename |
| `tpl-reviewer.md` content is provider-agnostic | ✅ | No Claude-specific content |
| Pre-merge cleanup removes `GEMINI.md` | ✅ | Cleanup command: `rm -f CLAUDE.md GEMINI.md AGENTS.md COPILOT.md` |

---

## 7. Auth Provisioning

| Check | Status | Notes |
|-------|--------|-------|
| API key flow (`GEMINI_API_KEY`) | ✅ | `GeminiProvider.authEnvVar = 'GEMINI_API_KEY'`; `provision_llm_auth` sets this env var |
| OAuth copy flow | ❌ | `GeminiProvider.supportsOAuthCopy()` returns false — no OAuth copy for Gemini |

---

## 8. Deploy

| Check | Status | Notes |
|-------|--------|-------|
| Deploy steps via `execute_command` | ✅ | Provider-agnostic; deploy.md steps are shell commands |

---

## Gap Summary

| Gap | Severity | Follow-up |
|-----|----------|-----------|
| `max_turns` not enforced | Low | Gemini CLI has no `--max-turns` equivalent. PM retry/cycle limits still apply. File follow-up issue to monitor runaway Gemini sessions. |
| Session resume is flag-based, no UUID | Low | Gemini `--resume` relies on CLI-local session cache. Loss of cache = silent fresh start. PM recovery (`/pm recover`) handles this via `progress.json` inspection. |

**Zero critical gaps.** All core PM workflow steps (register, onboard, permissions, dispatch, resume, review, deploy) function correctly for Gemini members. The two non-critical gaps degrade gracefully.
