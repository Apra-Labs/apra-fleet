# Review: Skill File Improvements (commit 947bdf7)

**Branch:** `sprint/session-lifecycle-oob-fix`
**Reviewed:** 2026-04-27
**Scope:** 3 files — skills/fleet/SKILL.md, skills/fleet/troubleshooting.md, skills/pm/doer-reviewer.md
**Verdict:** REQUEST CHANGES — 1 blocking (factual inaccuracy), 2 non-blocking

---

## 1. Accuracy — Verified Against Source Code

### 1a. stop_prompt one-shot error gate (SKILL.md:37) — ACCURATE ✅

Verified against `src/utils/agent-helpers.ts:89-106` and `src/tools/execute-prompt.ts:150-156`:
- `_stoppedAgents` is a `Map<string, boolean>` — in-memory only ✅
- `clearAgentStopped()` called immediately after returning the error ✅ (one-shot)
- Comment on line 89 confirms: "transient, lives only for the server process lifetime" ✅

### 1b-1e. Credential scoping, TTL, network policy, update (SKILL.md:66-84) — ACCURATE ✅

- `credential_store_update` exists at `src/tools/credential-store-update.ts`, accepts `members`, `ttl_seconds`, `network_policy` ✅
- Registered as MCP tool in `src/index.ts:201` (commit 08d0273) ✅
- TTL rejection at resolve time (not silent): confirmed in credential store resolve logic ✅

### 1f. Concurrent dispatch guard (SKILL.md:101-107) — ACCURATE ✅

Verified `src/tools/execute-prompt.ts:90,108-111`:
- `inFlightAgents` is `Set<string>` at module level ✅
- Error message matches doc: `execute_prompt is already running for "<member-name>"` ✅

### 1g. Session resume (SKILL.md:154-180) — ACCURATE ✅

Verified `src/tools/execute-prompt.ts:26,144,171-177`:
- `resume` is boolean-only in schema (`.default(true)`) ✅
- Stale-session retry: on error with sessionId, kills process and retries fresh ✅
- Provider table verified:
  - Claude: `supportsResume()=true`, uses `--resume` / `-c` flag ✅
  - Gemini: `supportsResume()=true`, uses `--resume` ✅
  - Codex: `supportsResume()=true` but `parseResponse()` returns `sessionId: undefined` — partial ✅
  - Copilot: `parseResponse()` returns `sessionId: undefined`, `--continue` with no ID — effectively none ✅

### ❌ BLOCKING: Unattended modes (SKILL.md:192) — INACCURATE

**SKILL.md line 192 states:**
> `unattended='auto'` does not add any CLI flag.

**Verified against source — this is wrong for 2 of 4 providers:**

| Provider | `'auto'` behaviour | Source |
|----------|--------------------|--------|
| Claude | Adds `--permission-mode auto` | `claude.ts:42-43` |
| Gemini | No flag added (config-file only) | `gemini.ts:39` — only handles `'dangerous'` |
| Codex | Adds `--ask-for-approval auto-edit` | `codex.ts:40-41` |
| Copilot | Warns "not supported", no flag | `copilot.ts:44-45` |

The blanket claim "does not add any CLI flag" is only true for Gemini. Claude and Codex both add provider-specific auto-approval flags. Additionally, Copilot's lack of unattended support is not mentioned at all.

**Fix:** Replace the blanket statement with a provider table, e.g.:

```markdown
`unattended='auto'` behaviour is provider-specific:

| Provider | `'auto'` flag | `'dangerous'` flag |
|----------|--------------|-------------------|
| Claude | `--permission-mode auto` | `--dangerously-skip-permissions` |
| Gemini | None (config-file only via `compose_permissions`) | `--yolo` |
| Codex | `--ask-for-approval auto-edit` | `--sandbox danger-full-access --ask-for-approval never` |
| Copilot | ⚠️ Not supported (runs interactively) | ⚠️ Not supported (runs interactively) |
```

### 2a. Timeout troubleshooting split (troubleshooting.md:6-7) — ACCURATE ✅

Verified against `src/services/strategy.ts:99-119`:
- Inactivity timer resets on stdout/stderr data events (lines 131, 146: `resetInactivityTimer()`) ✅
- Default 300000ms: `src/tools/execute-prompt.ts:42` ✅
- max_total_ms never resets (lines 113-119) ✅
- Both transport-level (in strategy.ts, not provider-specific) ✅

### 3a-3d. doer-reviewer.md additions — ACCURATE ✅

- Resume rules for stop_prompt and timeout-mid-grant are correct per the mechanics ✅
- Inactivity timer warning in mid-sprint denial section is factually accurate ✅
- stop_prompt vs PM sub-task distinction is a useful clarification ✅

---

## 2. Completeness

### Missing from tools table: `credential_store_update`

SKILL.md Core Fleet Tools table (lines 34-36) lists `credential_store_set`, `credential_store_list`, `credential_store_delete` but **not** `credential_store_update`. The tool is referenced in prose (line 70) and exists in the codebase (commit 08d0273, registered in `src/index.ts:201`).

**Fix:** Add row to tools table:
```
| `credential_store_update` | Update credential metadata (members, TTL, network policy) without re-entering the secret |
```

### Feedback file not found

`skill-improvement-feedback.md` referenced in `.fleet-task.md` does not exist in the repo, git history, or work folder. I verified completeness by mapping each diff hunk to an inferred feedback item (1a-1g, 2a, 3a-3d) and cross-checking against source code directly.

---

## 3. Layering

### Mostly clean

- **SKILL.md** contains tool mechanics only (stop_prompt gate, resume semantics, unattended flags, timeout parameters, credential scoping, concurrent guard) ✅
- **doer-reviewer.md** contains orchestration patterns (when to resume, how to handle denials, when to cancel) ✅
- **troubleshooting.md** contains symptom→action mappings with mechanic context ✅

### Minor bleed (advisory)

**doer-reviewer.md:10** — "For Gemini members, auto-approval is delivered entirely by `compose_permissions` (no CLI flag is added for `auto` mode)" is a provider-specific mechanic. The orchestration pattern ("compose thoroughly before dispatch") is appropriate for the PM doc, but the flag implementation detail belongs in SKILL.md's unattended section.

This is partially moot — once the SKILL.md unattended section gets the provider table fix (blocking item above), the Gemini detail in doer-reviewer.md could be simplified to a cross-reference.

---

## 4. Consistency

- stop_prompt description in SKILL.md (one-shot gate, resume=false after kill) is consistent with doer-reviewer.md Resume Rule table entry ("Session state unreliable after kill; start fresh") ✅
- Timeout description in SKILL.md matches troubleshooting.md expanded rows ✅
- Credential scoping prose references `credential_store_update` which exists in code ✅
- Model tier names (cheap/standard/premium) consistent across SKILL.md and doer-reviewer.md safeguards ✅

---

## 5. Correctness of #191 Reference

SKILL.md:70 references `credential_store_update` — tool was implemented in commit 08d0273 (`feat(#191,#192): credential_store_update tool`). The description ("change members, ttl_seconds, or network_policy without re-entering the secret") matches the tool's schema in `src/tools/credential-store-update.ts`. ✅

---

## 6. Formatting (advisory)

**doer-reviewer.md:8-11** — Lines 9-11 are intended as sub-bullets under item 4 but are formatted as top-level dashes. Line 11 also concatenates two unrelated instructions: the `unattended` preference and the `context-file.md` / planning-phase note. These should be separate items or properly indented.

---

## Summary

| Finding | Severity | File:Line |
|---------|----------|-----------|
| `'auto'` does not add any CLI flag — wrong for Claude and Codex | **BLOCKING** | SKILL.md:192 |
| `credential_store_update` missing from tools table | Non-blocking | SKILL.md:34-36 |
| Copilot unattended unsupported not mentioned | Non-blocking | SKILL.md:182-202 |
| Gemini-specific mechanic in PM doc (minor layering bleed) | Advisory | doer-reviewer.md:10 |
| Sub-bullet formatting under setup checklist item 4 | Advisory | doer-reviewer.md:8-11 |

---

REQUEST CHANGES
