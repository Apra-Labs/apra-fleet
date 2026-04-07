# ADR: Provider-Agnostic API Surface & Token Accumulation

**Status:** Implemented
**Date:** 2026-04-06
**Issues:** #83, #84, #85, #87, #88

## Context

The fleet server's public API (MCP tool names, parameter names, and output keys) originally reflected Claude-specific naming. As multi-provider support matured, the API started to look inconsistent and confusing to users — `provision_auth` only worked for LLM auth, `claude.version` appeared even for Gemini members, and `work_folder` was used both as a member property and as a tool parameter for something entirely different.

Separately, the PM role was burdened with manually calling `update_task_tokens` to report token usage — a fragile process that was easy to forget and produced incomplete data.

This ADR records the design decisions made to address these issues.

---

## Decision 1: Provider-Agnostic Naming

### What changed

| Old name | New name | Surface |
|----------|----------|---------|
| `provision_auth` | `provision_llm_auth` | MCP tool name |
| `claude.version` / `claude.auth` | `llm_cli.version` / `llm_cli.auth` | `member_detail` output key |
| `work_folder` | `run_from` | `execute_command` parameter |

### Why

- `provision_auth` implied a general concept but was actually an LLM credential provisioning tool — renaming to `provision_llm_auth` removes the ambiguity.
- `claude` as an output key in `member_detail` was misleading when the member uses Gemini, Codex, or Copilot. The key `llm_cli` describes *what* the section covers (the LLM CLI on this member) rather than *which* provider it is.
- `work_folder` as an `execute_command` parameter conflicted conceptually with the `work_folder` member registration property. The new name `run_from` describes the intent (override directory) and its rarity — the default (member's registered folder) is correct in almost all cases.

### Trade-offs

**Breaking change, intentional.** No backward-compat shims were added — callers must update to the new names. The skill doc sweep (Phase 5 of the plan) updated all known internal callers.

**`run_from` is rarely needed.** Both `execute_command` and `execute_prompt` default to the member's registered `workFolder`. The parameter exists only for unusual cases. Skill docs should not instruct the PM to pass the registered path explicitly.

---

## Decision 2: Server-Side Version String Normalization

### What changed

`member_detail` strips the provider prefix from version strings. `"Claude Code 2.1.92"` → `"2.1.92"`. The same normalization applies to any other provider that includes a prefix.

### Why

Consumers of `llm_cli.version` (skill docs, tooling, scripts) should not need to parse provider-specific prefixes. A bare semver is unambiguous and provider-neutral.

---

## Decision 3: Server-Side Tilde Expansion

### What changed

The server resolves `~` at the start of any path (both the `run_from` parameter and the member's registered `workFolder`) before constructing shell commands. This prevents paths like `/Users/akhil/~/git/foo` from appearing on macOS when `~` is passed literally.

### Scope

Only the current user's home directory is expanded (`~/` and bare `~`). The `~user/foo` form (another user's home) is **not** expanded — this is not a fleet use case. The resolution uses Node's `os.homedir()` on the master machine, which is correct because the master constructs the command string.

---

## Decision 4: Automatic Token Accumulation

### What changed

The server auto-accumulates token usage from provider responses in `execute_prompt`. Totals are stored on the agent record (`tokenUsage: { input, output }`) and surfaced by `member_detail` and `fleet_status`. The `update_task_tokens` tool was removed.

### Why

Manual token reporting via `update_task_tokens` put burden on the PM to call it after every prompt, was frequently skipped, and added noise to the PM's plan. The server has all the information it needs to accumulate tokens automatically — the provider's JSON response always includes usage metadata.

### Race condition analysis

Token accumulation does a read-modify-write on the in-memory agent record. This is safe without locking because:
- The registry is stored in a `Map` in a single-threaded Node.js process.
- Fleet members typically run one prompt at a time.
- No concurrent mutation is possible within one event loop turn.

If a future use case involves genuinely concurrent prompts for the same member (e.g. multiple PM instances using one fleet server), this assumption must be revisited.

---

## Decision 5: Guard-Based `permissions.json` Handling

### What changed

`compose_permissions` previously crashed with `"ledger.granted is not iterable"` when `permissions.json` contained `{}` (empty object). The fix adds a null-coalescing guard: `{ stacks: raw.stacks ?? [], granted: raw.granted ?? [] }`.

### Why the guard, not a template fix

The requirements originally suggested shipping a template `permissions.json` with `{ "granted": [] }`. No template file exists in the repo. Rather than create one, the guard approach was chosen because:
- It defends against any malformed JSON on disk, not just a missing `granted` key.
- It requires no change to onboarding or documentation about initial file contents.
- It matches the existing pattern: `loadLedger` already returns `{ stacks: [], granted: [] }` when the file is missing — the guard makes file-present behavior consistent with file-absent behavior.
