# PM & Fleet Skill Improvement Feedback
# Based on PR #183 Sprint Cycle Review

**Reviewer:** fleet-rev (premium model), verified by fleet-dev source research
**Date:** 2026-04-27
**Source:** Post-PR #183 retrospective — session lifecycle + credential hardening sprint

**Layering principle:** fleet skill documents tool mechanics (what tools do, parameter semantics,
server-side behaviour, provider differences). PM skill documents orchestration patterns that build
on top of those mechanics (when to use which tool, sprint workflows, doer-reviewer loop decisions).
These layers must not bleed into each other.

---

## Summary Table

| # | File | Type | Priority |
|---|------|------|----------|
| 1a | `skills/fleet/SKILL.md` | Document `resume` parameter mechanics and provider support | **High** |
| 1b | `skills/fleet/SKILL.md` | Document `stop_prompt` stopped-flag design and usage | Medium |
| 1c | `skills/fleet/SKILL.md` | Document unattended modes with accurate provider support matrix | **High** |
| 1d | `skills/fleet/SKILL.md` | Fix `monitor_task` description (not cloud-only) | Low |
| 1e | `skills/fleet/SKILL.md` | Document in-flight concurrent dispatch guard | Medium |
| 1f | `skills/fleet/SKILL.md` | Document credential scoping, TTL, rescoping, and wildcard | Medium |
| 1g | `skills/fleet/SKILL.md` | Document network egress policy on credentials | Medium |
| 2a | `skills/fleet/troubleshooting.md` | Distinguish inactivity timeout vs total timeout; clarify cross-provider | **High** |
| 3a | `skills/pm/doer-reviewer.md` | Add `resume` decision table covering all cases including post-stop | **High** |
| 3b | `skills/pm/doer-reviewer.md` | Add when-to-use guidance for `stop_prompt` | Medium |
| 3c | `skills/pm/doer-reviewer.md` | Add `compose_permissions` + unattended mode usage guidance | Medium |
| 3d | `skills/pm/doer-reviewer.md` | Clarify permission denial + inactivity timeout nuance | Low |

---

## Fleet Skill — Tool Mechanics

### 1a. `execute_prompt` — `resume` parameter mechanics undocumented
**File:** `skills/fleet/SKILL.md`
**Priority: HIGH**

**Problem:** The fleet skill documents `timeout_ms` and `max_total_ms` in detail but says nothing
about the `resume` parameter — its semantics, provider support, or automatic stale-session recovery.

**Verified from source:** Session IDs are parsed from CLI output and stored server-side per member
in the agent registry (`agent-helpers.ts`). `resume=true` passes the stored `sessionId` to the
provider CLI (e.g. `claude --resume <sessionId>`). If the session is stale, the tool retries once
automatically with a fresh session.

**Recommended addition** — new section in `skills/fleet/SKILL.md`:

```markdown
## execute_prompt: Session Resume

The `resume` parameter controls whether a prior session is continued:

| Value | Behaviour |
|-------|-----------|
| `true` (default) | If a session ID is stored for this member, continues it. If none exists, starts fresh. |
| `false` | Always starts a fresh session — ignores any stored session ID. |

`resume` is boolean only. There is no way to target a specific session ID by value.
The tool always resumes the most recently stored session for that member.

**Automatic stale-session recovery:** If `resume=true` and the stored session has expired
or the provider returns an error, `execute_prompt` retries once automatically with a fresh
session. This recovery is transparent — no caller intervention required.

**Provider support:**

| Provider | Session resume | Notes |
|----------|---------------|-------|
| Claude | ✅ Full | `claude --resume <sessionId>` |
| Gemini | ✅ Full | Native session support |
| Codex | ⚠️ Partial | `resume` command supported |
| Copilot | ❌ None | Always starts fresh regardless of `resume` value |

Session IDs are parsed from `execute_prompt` output and stored server-side per member.
The output footer contains: `session: <sessionId>` when the provider supports it.
```

---

### 1b. `stop_prompt` — stopped-flag design undocumented
**File:** `skills/fleet/SKILL.md`
**Priority: Medium**

**Problem:** The tool entry mentions it "sets a stopped flag" but neither explains what the flag
does nor when/how to use the tool.

**Verified from source** (`execute-prompt.ts:152-156`):
```typescript
if (isAgentStopped(agent.id)) {
  inFlightAgents.delete(agent.id);
  clearAgentStopped(agent.id);
  return `⛔ Agent "..." was stopped. Stopped flag cleared — call execute_prompt again to resume.`;
}
```
The flag is in-memory only (not persisted). It is a **one-shot error gate** — not a latch or an
interlock. It fires exactly once on the next `execute_prompt` call, surfacing the stop event
explicitly, then self-clears. Without it, the PM might silently re-dispatch a hung agent
in a retry loop; the gate forces the PM to see the cancellation before proceeding.

**Recommended replacement in tool table:**
```markdown
`stop_prompt` | Kill the active LLM process on a member and set a one-shot error gate.

**One-shot error gate:** The next `execute_prompt` call to this member returns a "stopped by PM"
error and clears the gate. All subsequent dispatches proceed normally. No manual clearing needed.

**Use when:** a member is hung, working on the wrong thing, or needs to be cancelled
mid-execution. After stopping, re-dispatch with `resume=false` — the session state after
a kill is unreliable.
```

---

### 1c. Unattended modes — undocumented, and `dangerous` broken on Gemini/Codex
**File:** `skills/fleet/SKILL.md`
**Priority: HIGH**

**Problem:** Not documented in fleet skill. Earlier drafts of this feedback had errors — now
corrected after tracing the full permission flow from source.

**How permissions actually work (verified from source):**

`compose_permissions` writes provider-specific config files to the member's work folder.
The CLI reads them at startup. There is **no `--allowedTools` CLI flag** — auto-approval
is entirely file-based:

| Provider | Config file | Auto-approval mechanism |
|----------|------------|------------------------|
| Claude | `.claude/settings.local.json` — `permissions.allow` array | Claude CLI reads allow list |
| Gemini | `.gemini/settings.json` + `.gemini/policies/fleet.toml` — `mode: 'auto_edit'` | Gemini CLI reads mode |
| Codex | `.codex/config.toml` — `approval_mode = "full-auto"` | Codex CLI reads approval mode |

**`unattended='auto'`** does not add a CLI flag — it means "trust the settings file."
`compose_permissions` already delivers the auto-approval config for all three providers.
`auto` works correctly on all providers today via this file-based mechanism.

**`unattended='dangerous'`** is supposed to bypass all permission checks globally by adding
a skip-all CLI flag at dispatch time. This works for Claude (`--dangerously-skip-permissions`)
but is a bug on Gemini and Codex — both log a warning and fall through, silently failing to
skip permissions even though both providers have the correct flag in `skipPermissionsFlag()`.
See GitHub issue #192.

**Verified provider support:**

| Provider | `auto` | `dangerous` | Config format |
|----------|--------|-------------|--------------|
| Claude | ✅ file-based (`permissions.allow`) | ✅ `--dangerously-skip-permissions` | JSON (settings.local.json) |
| Gemini | ✅ file-based (`mode: auto_edit`) | ❌ bug — should add `--yolo` (issue #192) | JSON + TOML |
| Codex | ✅ file-based (`approval_mode: full-auto`) | ❌ bug — should add skip flags (issue #192) | TOML |
| Copilot | unknown | unknown | — |

**Recommended addition** — new section in `skills/fleet/SKILL.md`:

```markdown
## Unattended Execution Modes

Configured via `register_member` or `update_member` with the `unattended` parameter:

| Mode | Behaviour |
|------|-----------|
| `false` (default) | Interactive — member prompts for permission approvals |
| `'auto'` | Trust the permissions config written by `compose_permissions` — auto-approves tools in the allow list |
| `'dangerous'` | Skip all permission checks globally, bypassing the allow list |

`unattended='auto'` does not add any CLI flag. Auto-approval is delivered via config files
written by `compose_permissions` — call it before every dispatch. `'dangerous'` adds a
provider-specific skip-all flag (`--dangerously-skip-permissions` on Claude, `--yolo` on Gemini,
skip-permissions flags on Codex).

**Prefer `auto` + `compose_permissions` over `dangerous`** — `auto` scopes approval to the
explicitly listed tools; `dangerous` bypasses all checks globally.
```

---

### 1d. `monitor_task` — "cloud members only" description is wrong
**File:** `skills/fleet/SKILL.md`
**Priority: Low**

**Verified from source** (`monitor-task.ts:44`): The only cloud-gated behaviour is GPU utilization
polling. All other functionality (status.json read, PID liveness check, log tail) runs on any
member type unconditionally.

**Current text:**
```
`monitor_task` | Check status of a long-running background command on a cloud member (cloud members only)
```

**Recommended replacement:**
```
`monitor_task` | Check status of a long-running background task on any member.
The `auto_stop` parameter and GPU utilization polling are cloud-only features.
```

---

### 1e. In-flight concurrent dispatch guard — undocumented
**File:** `skills/fleet/SKILL.md`
**Priority: Medium**

**Problem:** `execute_prompt` enforces a server-side guard (module-level `Set<string>`) preventing
two concurrent calls to the same member. Callers hitting this receive an immediate error.

**Recommended addition** — in the dispatch rules section:

```markdown
**Concurrent dispatch guard:** Only one `execute_prompt` can be in-flight per member at a
time (enforced server-side). A second concurrent dispatch returns immediately with:

```
❌ execute_prompt is already running for "<member-name>"
```

Use `stop_prompt` to cancel the in-flight session before re-dispatching.
```

---

### 1f. Credential scoping, TTL, rescoping, and wildcard — not documented
**File:** `skills/fleet/SKILL.md`
**Priority: Medium**

**Verified from source** (`credential-store.ts`, `credential-store-set.ts`):
- Calling `credential_store_set` with the same name **always triggers the OOB dialog again** — there
  is no existence check. The user must re-enter the full secret value even if they only want to fix `members`.
- Full overwrite — no field merging. Every field takes the new values supplied.
- `members="*"` is the default — grants access to all members.
- Comma-separated member friendly names are supported for targeted scoping.
- **There is no `credential_store_update` tool** — updating non-sensitive metadata requires re-entering the secret.
- Persistent credentials supersede session-scoped ones with the same name (old session entry deleted).

**Known gap (high friction):** Correcting a wrong `members` list or `ttl_seconds` requires a full
`credential_store_set` re-call including the OOB secret entry. This is significant user friction.
A `credential_store_update` tool that updates only metadata fields without touching the secret value
has been proposed — see GitHub issue #191.

**Recommended addition** — append to the credential store section:

```markdown
**Access control (scoping):** Credentials can be scoped to specific members.
- `members="*"` (default) — all members can access the credential
- `members="alice,bob"` — only those members can access it
- Scoping is enforced at resolve time — a member outside the allowed set receives an access-denied error
- **Updating scope:** Call `credential_store_set` again with the same name — triggers OOB dialog to re-enter
  the secret, then overwrites all fields. See issue #191 for a planned `credential_store_update` tool.

**TTL (time-to-live):** Set `ttl_seconds` to auto-expire a credential. Expired credentials
are rejected at resolve time with a clear error (not silently empty).

Example: `credential_store_set  name=ci_token  ttl_seconds=3600`
```

---

### 1g. Network egress policy — not documented
**File:** `skills/fleet/SKILL.md`
**Priority: Medium**

**Recommended addition** — append to the credential scoping section:

```markdown
**Network egress policy:** Attach a network policy to a credential to control outbound
network access for commands that use it:

| Policy | Behaviour |
|--------|-----------|
| `'allow'` (default) | No restriction |
| `'deny'` | Commands invoking network tools (curl, wget, ssh, git push, etc.) are blocked |
| `'confirm'` | OOB prompt before the network call is allowed |
```

---

## Fleet Skill — Troubleshooting

### 2a. Inactivity timeout vs total timeout — conflated and incorrectly described as Claude-specific
**File:** `skills/fleet/troubleshooting.md`
**Priority: HIGH**

**Verified from source** (`strategy.ts`, `ssh.ts`): The inactivity timeout is **transport-level**,
not provider-specific. Both `LocalStrategy` and `RemoteStrategy` implement the same rolling-timer
pattern. The timer is reset by any `data` event on stdout or stderr — one byte resets it the same
as 64 KB. It applies equally to Claude, Gemini, and Codex members.

SSH stdout is event-driven chunks from the ssh2 library (not line-by-line), buffered in memory up
to 10 MB then spilled to disk. The inactivity timer detects event absence, not byte/line absence.

**Current text:**
```
Timeout | Increase to 300s (build/test) or 600s (multi-step execution)
```

**Recommended replacement:**

```markdown
| Timeout (inactivity) | `timeout_ms`: fires when no stdout/stderr data event arrives for N ms (default 300000ms / 5 min).
Applies to all members and all providers — it is transport-level, not provider-specific.
Common cause: test runners and build tools that buffer stdout (npm test, vitest, cargo build, etc.)
producing no output for long stretches even while active.
Fix: increase `timeout_ms` to 600000–1200000ms for build/test dispatches. |
| Timeout (total) | `max_total_ms`: fires after N ms of total elapsed time regardless of output activity.
Provider-agnostic. Use for hard ceilings on long-running jobs. Set alongside `timeout_ms`
when you need both a silence guard and a wall-clock cap. |
```

---

## PM Skill — Orchestration Patterns

### 3a. `resume` decision table — missing cases
**File:** `skills/pm/doer-reviewer.md`
**Priority: HIGH**

**Problem:** Resume rule table has no row for after `stop_prompt` or for the session-timed-out-during-grant case.

**Recommended additions to the resume table:**

```markdown
| After `stop_prompt` cancellation | `false` | Session state unreliable after kill; start fresh |
| After session timed out mid-grant | `true` | Fleet auto-recovers (stale-session retry), but member restarts without prior context |
```

---

### 3b. When to use `stop_prompt` — PM orchestration guidance missing
**File:** `skills/pm/doer-reviewer.md`
**Priority: Medium**

**Problem:** `stop_prompt` mechanics are in the fleet skill. The PM skill needs to say when to
apply it in an orchestration context.

**Recommended addition** — new paragraph in the intervention section:

```markdown
**Cancelling a running session:** Use `stop_prompt` when a member is working on the wrong
thing, stuck in a loop, or dispatched with incorrect instructions. The one-shot error gate
fires on the next dispatch then self-clears — no manual cleanup needed. Always follow with
`resume=false` to start a clean session.

Note: stopping a member's LLM process (`stop_prompt`, a fleet MCP tool available to any
PM regardless of provider) is distinct from stopping a background orchestration sub-task
within the PM's own session. The latter mechanism is harness-dependent — Claude Code
PMs have `TaskStop` via the agent SDK; PMs on other providers have no equivalent and
must manage their own sub-tasks through provider-native means.
```

---

### 3c. `compose_permissions` and unattended mode — PM-level usage guidance missing
**File:** `skills/pm/doer-reviewer.md`
**Priority: Medium**

**Problem:** Fleet skill documents what unattended modes do and provider support. PM skill should
say when and how to use them in sprint context. Key orchestration rules: always compose before
dispatch; for Gemini `auto` is not supported so compose is the only lever.

**Recommended addition** — in the pre-flight checklist:

```markdown
- Call `compose_permissions` before every dispatch regardless of unattended mode.
  Unattended mode handles edge cases not covered by the composed config — it is not
  a substitute for composing.
- For Gemini members, `auto` unattended mode has no effect — `compose_permissions`
  is the only available permission mechanism. Compose thoroughly before dispatch.
- Prefer `unattended='auto'` over `'dangerous'` — `auto` scopes bypass to explicitly
  listed operations; `dangerous` skips all checks globally.
```

---

### 3d. Permission denial recovery — inactivity timeout nuance
**File:** `skills/pm/doer-reviewer.md`
**Priority: Low**

**Context:** The inactivity timeout fires based on stdout/stderr silence from the member's process.
If the process is paused waiting for permission approval, no output is produced, so the timer will
eventually fire. This applies to all providers (transport-level).

**Current text** (around line 88):
```
Then resume the member with `resume=true`. Never bypass by running the denied
command yourself via `execute_command`.
```

**Recommended amendment:**
```markdown
Then resume the member with `resume=true`. Never bypass by running the denied
command yourself via `execute_command`. Act on the grant promptly — the inactivity
timer (transport-level, applies to all providers) fires on stdout silence. If it fires
while you are composing permissions, `resume=true` still succeeds via stale-session
auto-recovery, but the member restarts without its in-progress context.
```

---

## Sprint Retrospective Notes

**What caused real failures in this sprint:**
1. `resume=false` dispatched to fleet-rev when it should have been `resume=true` — session context lost
2. `npm test` inactivity timeout fired during long test run (stdout buffered, no data events) — retried with `timeout_ms=1200000`
3. Permission denial for `npm`/`npx` mid-sprint — required `compose_permissions` grant + re-dispatch

**What worked well:**
- Embedding all prior context in the prompt when session resume is not available
- Batching test runs to the end rather than after each fix
- `compose_permissions` with `grant` for mid-sprint permission additions
