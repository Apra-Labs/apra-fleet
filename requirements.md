# enhancement/skill-reorg -- Skill & Agent Reorganization

**Branch:** `enhancement/skill-reorg`  *  **Base:** `main`  *  **Member:** [PURPLE] apra-fleet-reorg (local, claude)

---

## Why this sprint exists

The `pm` skill has grown to 21 files. Several files (`tpl-doer.md`, `tpl-reviewer.md`, `tpl-reviewer-plan.md`, `plan-prompt.md`, `tpl-deploy.md`) are **role templates** that exist only to be sent to fleet members -- they should not be in PM's context. Today PM reads them every dispatch to perform `{{token}}` substitution before `send_files`, so the rule "PM never loads them" in `SKILL.md` is aspirational, not enforced. This bloats PM's cognitive load and blurs the line between orchestration knowledge and role knowledge.

Separately, Anthropic is restricting `claude -p` (non-interactive prompt mode) for non-enterprise accounts starting **2026-06-15**. Fleet members today rely on `claude -p` via `execute_prompt`. We need to migrate to the long-running agent mode (Claude Code SDK / Agent API) before that date, or fleet members lose the ability to be driven from PM.

This sprint addresses both: it reorganizes the skill surface so PM only loads what it needs, formalizes role definitions as proper Claude/Gemini agents, makes `send_files` aware of templating so PM no longer has to read role files, and lays the foundation for the long-running-agent migration.

---

## Goals

1. PM never reads role template files. Substitution moves into `send_files`. Role files relocate out of the pm skill folder.
2. Role definitions (planner, plan-reviewer, doer, reviewer) become first-class agents -- installable on Claude and Gemini members via the apra-fleet installer.
3. The `pm` skill is split along load-frequency lines so unused sub-docs don't enter PM's context.
4. The fleet installer correctly routes every artifact (user-level agents, project-level agents, skill files, hooks) to its proper destination.
5. A documented migration path exists from `claude -p` (single-shot prompt) to long-running agent mode, validated end-to-end on at least one fleet member, before 2026-06-15.

## Out of scope (this sprint)

- Multi-pair sprint reorganization (separate concern; pm choreography stays as-is)
- Beads/bd workflow changes
- Provider additions beyond Claude + Gemini (Codex, Copilot stay where they are)
- Production rollout of long-running agents to all members (Task 6 produces a working path and validation; mass migration is a follow-up sprint)

---

## Tasks

### Task 1 -- Shared substitution engine for `send_files` and `execute_prompt`

**Status:** locked 2026-05-15. All open questions resolved.

**Motivation.** Today PM has to template files (for `send_files`) and prompts (for `execute_prompt`) **client-side** -- open the source, substitute `{{token}}` values, then call the fleet tool with the rendered content. That client-side step is the reason role templates load into PM's context every dispatch, and the reason PM burns tokens regenerating substituted prompts on every turn. Both tools already write content to the member's filesystem (`.fleet-task.md` for prompts, target files for `send_files`) -- substitution belongs *inside* fleet, on the orchestrator side of the wire, before the write.

**Surface.** This task delivers **one substitution engine** shared by two tool handlers:

1. **`send_files`** -- gains an optional `substitutions: { name: value }` parameter; applies the engine to every file in `local_paths`.
2. **`execute_prompt`** -- gains the same optional `substitutions` parameter; applies the engine to the `prompt` string before staging it as the prompt file on the member.

Both surfaces obey the **same FRs** (1-10 below) and the **same NFRs**. The engine is implemented once and invoked from both tool handlers -- see NFR "Code reuse" below.

**Signature changes.**

- `send_files`: add optional `substitutions: { "<token-name>": "<replacement-string>" }`. `local_paths` and `dest_subdir` unchanged.
- `execute_prompt`: add optional `substitutions: { "<token-name>": "<replacement-string>" }`. `prompt`, `model`, `resume`, timeouts, etc. unchanged.

No existing parameter on either tool is reshaped or renamed. Both new parameters are purely additive and optional.

**Functional requirements (apply identically to both surfaces).**

> "Input" below means: for `send_files`, each file in `local_paths`; for `execute_prompt`, the `prompt` string. The engine works on text; it doesn't care which surface called it.

1. When `substitutions` is **omitted**, both tools behave exactly as today: content unchanged, no token scanning, no errors. **Heuristic warning:** if the input contains text matching the `{{name}}` token pattern, the tool response includes a warning identifying the apparent tokens (and for `send_files`, the file(s) they came from). The call still proceeds. This alerts the caller that templated content appears to have been sent without substitution -- informational only, never an error.

2. When `substitutions` is **present**, the input is read on the fleet host, every occurrence of `{{<token-name>}}` is replaced with the corresponding value, and the **transformed content** becomes the payload (the file written to the member's work folder for `send_files`, the prompt staged for `execute_prompt`). Source files on the fleet host are **never modified**; `prompt` strings passed in are not echoed back.

3. **Token grammar -- lenient.** A token matches `{{ \s* <name> \s* }}` (leading and trailing whitespace inside the braces is tolerated -- `{{branch}}`, `{{ branch }}`, `{{branch }}`, `{{ branch}}` all resolve to the same key `branch`). Names match `[A-Za-z_][A-Za-z0-9_]*`. This matches existing `tpl-*.md` usage and tolerates human typos.

4. **Validate-then-transform.** The implementation scans every input (file content for `send_files`, prompt string for `execute_prompt`) first to enumerate all required token names. It compares that set against the keys in `substitutions`. If **any required token has no entry in `substitutions`**, the call is rejected with a structured error listing every unresolved token and the input it came from. **Nothing is written to the member, no CLI is invoked.** Validation strictly precedes transformation -- side effects never start until the full token set is satisfied.

   **Validation is per-token-needed, not per-input.** An input with zero substitution tokens contributes nothing to the required-token set and is fine -- it passes through unchanged. For `send_files` a mixed batch is perfectly legal: send three files with a single `substitutions` map; if two need `{{branch}}` and the third has no tokens at all, the call succeeds as long as `branch` is in the map. For `execute_prompt` the single-input case is trivially the same rule. Only *missing* tokens that the input actually needs cause rejection.

5. **Extra keys are silently ignored -- not an error, not even a warning.** If `substitutions` contains keys not referenced by any file, they pass through with no effect. This lets the caller pass a superset of keys (e.g. a shared map across multiple files) without having to pre-compute which file uses which. Designed to be easy for an LLM to call.

6. **No recursive substitution.** Replacement values containing `{{...}}` syntax are written as-is -- no second pass. Prevents accidental loops; matches mustache-stache semantics.

7. **Atomicity.** Side effects are all-or-nothing relative to the call. If validation fails (rule 4), zero side effects -- for `send_files` no files are written, for `execute_prompt` no CLI is invoked. For `send_files` batches that pass validation but fail during the file-transfer step (e.g. disk full), partial files are cleaned up best-effort before the error returns.

8. **Mixed batches (`send_files` only -- literal `{{...}}` content).** v1 does not support per-file opt-out. If a file legitimately contains literal `{{...}}` syntax that should not be substituted (e.g., a doc explaining the templating feature itself), send it in a **separate `send_files` call without `substitutions`**. Rule 1's warning will fire -- caller can ignore it knowingly. _(`execute_prompt` has a single input, so this case maps trivially: just don't pass `substitutions` if the prompt has literal braces you want preserved.)_

9. **Error format.** Errors are returned as a single string the LLM can read directly. The first line names the calling tool. For `send_files`:
   ```
   send_files: substitution failed

   Unresolved tokens:
     tpl-doer.md:        branch, base_branch
     tpl-reviewer.md:    member_name
   ```
   For `execute_prompt`:
   ```
   execute_prompt: substitution failed

   Unresolved tokens:
     prompt:             branch, base_branch
   ```
   No side effect is performed when this error returns. No "unused keys" section (extras are not errors).

10. **Secrets boundary (security invariant -- reject, never resolve).** Substitution is explicitly **disjoint** from the credential store on both surfaces. Any attempt to bridge the two is rejected at validation time, before any file is read or any CLI is invoked. Three concrete rules:

    a. **Key grammar.** Keys in `substitutions` must match the same grammar as token names: `[A-Za-z_][A-Za-z0-9_]*`. Any key with a `.`, `:`, `/`, whitespace, or any other character outside that grammar is rejected with a dedicated error. This bars `secure.*` keys outright and catches typos like `branch-name` or `secure:github_pat`.

    b. **Content pass-through.** Because token grammar excludes `.`, the pattern `{{secure.NAME}}` in input content is **never** treated as a substitution token by either tool -- it is written through to the destination verbatim (for `send_files`, into the file on the member; for `execute_prompt`, into the staged prompt file). This is the intended behaviour for templates that contain `execute_command` invocations referencing secrets -- the credential store resolves `{{secure.NAME}}` later when those commands actually run.

    c. **Value pass-through.** Substitution values are written verbatim. The implementation never interprets `{{secure.NAME}}` syntax inside a value -- it lands in the output as literal text. **Callers must never put plaintext secrets into substitution values.** Secrets live in the credential store and are resolved only by `execute_command` and the credential fields listed in fleet `SKILL.md`. If a caller violates this convention, the tool cannot detect it, but the value-non-logging guarantee (NFR) ensures the plaintext is not echoed back.

    **Rejection error format (both tools, first line names the caller):**
    ```
    send_files: invalid substitutions

    Reserved or malformed keys (must match [A-Za-z_][A-Za-z0-9_]*):
      - secure.github_pat
      - branch-name

    Secrets must use {{secure.NAME}} in execute_command -- never substitutions.
    ```

    **[SECURE] Hard invariant -- `{{secure.NAME}}` MUST NOT be resolved in prompts or in substituted content, ever.** Today, secrets only resolve in the credential fields enumerated in fleet `SKILL.md` -- notably `execute_command`'s `command` field. `execute_prompt`'s `prompt` field is **not** a resolution site and **must not become one** through this feature. This is a non-negotiable invariant of the sprint:

    - Prompts staged by `execute_prompt` (with or without `substitutions`) preserve `{{secure.NAME}}` text verbatim. The member's LLM sees the literal token; it does not see the secret value.
    - The new `substitutions` parameter on either tool introduces **zero** new code paths that touch the credential store. The substitution engine has no awareness of `{{secure.*}}` patterns -- it treats them as ordinary text outside its grammar.
    - Any code change in this sprint that touches secret resolution or even *imports* credential-store modules from the substitution engine is grounds for review rejection.

    Done criteria below include explicit regression tests guarding this invariant (see tests q, r).

**Non-functional requirements.**

- **Performance:** substitution adds < 100 ms for typical role-template files / prompts (< 50 KB). Streaming not required at this size class.
- **Atomicity guarantee:** validation phase is strictly before write/dispatch phase -- see FR 4 and FR 7.
- **No value leakage.** Values in the `substitutions` map are never written to logs, error messages, telemetry, or the tool response. Token *names* may appear in warnings and errors (FR 1, FR 9); *values* never do. (Defence-in-depth: secrets should still flow via `{{secure.NAME}}` in `execute_command`, not via `substitutions` -- but if a caller misuses the feature, we don't compound the leak.)
- **Code reuse (mandate).** A single substitution engine module implements scan / validate / transform / emit-warning. Both tool handlers (`send_files` and `execute_prompt`) call into it; neither reimplements any piece of the algorithm. The engine has no awareness of which tool called it -- it takes raw text and a `substitutions` map, returns transformed text or a structured error. PR review must reject any duplicated substitution logic or surface-specific branching inside the engine. Tests for the engine sit in one place; surface tests cover only the integration points.
- **No credential-store coupling.** The substitution engine module **does not import** anything from the credential-store / secrets path, and the credential-store code does not import anything from substitution. This is a hard architectural boundary, enforced by lint or import-cycle check. See FR 10 invariant.

**Done criteria.**

**Engine-level unit tests** (tests against the shared substitution module directly, no tool handler involved):
- (a) happy path -- all tokens resolved, transformed content returned; (b) unresolved-token rejection with multi-input error format; (c) extra keys silently ignored -- no error, no warning, no log line; (d) grammar tolerance -- all four whitespace variants (`{{x}}`, `{{ x}}`, `{{x }}`, `{{ x }}`) resolve to the same key; (e) no-substitutions case -- content unchanged; (f) no-substitutions warning fires when content contains `{{...}}` pattern; (g) no-substitutions warning does NOT fire when content is plain; (h) batch atomicity -- failure in one input -> zero side effects; (i) source content never modified; (j) values never appear in logs or errors.

**Secrets boundary tests (engine):** (k) any key matching `secure.*` is rejected with the dedicated error format -- no content read, no transform; (l) any key containing a `.` (other char outside `[A-Za-z_][A-Za-z0-9_]*`) is rejected the same way; (m) `{{secure.NAME}}` patterns in input content are pass-through -- they don't appear in the "unresolved tokens" set and don't trigger the heuristic warning; (n) `{{secure.NAME}}` syntax inside a substitution value is written verbatim, not interpreted; (o) rejection happens before any content is read (verify via spy / mock).

**Surface-integration tests (`send_files`):** (p) 3-file mixed batch -- two files use tokens that exist in the map, third has zero tokens, all three transfer successfully; (p2) full pipeline -- real `tpl-doer.md`-style template with substitutions, verify transformed content on the member.

**Surface-integration tests (`execute_prompt`):**
- (q) **[SECURE] Invariant guard -- secrets never resolve in prompts.** Dispatch with `prompt: "use {{secure.github_pat}}"` and **no** `substitutions`: prompt is staged verbatim on the member, the LLM CLI is launched with the literal `{{secure.github_pat}}` token in its input, and the credential store is not consulted (verify via spy on credential-store entry points).
- (r) **[SECURE] Invariant guard -- secrets ignored by substitution engine.** Dispatch with `prompt: "use {{secure.github_pat}} and {{branch}}"` AND `substitutions: { branch: "feat/x" }`: `{{branch}}` is replaced, `{{secure.github_pat}}` is pass-through verbatim, credential store is not consulted.
- (s) `execute_prompt` happy path -- prompt with `{{branch}}` plus substitutions, prompt staged with replacement, member CLI launched.
- (t) `execute_prompt` validation rejection -- missing token returns `execute_prompt: substitution failed ...` error, no CLI launched.
- (u) `execute_prompt` no-substitutions warning fires when prompt contains `{{...}}`.
- (v) `execute_prompt` extras silently ignored.

**Code-reuse audit (test or static check):**
- (w) The substitution engine module is imported by both `send_files` and `execute_prompt` handlers. No duplicate scan / validate / transform logic exists elsewhere. Verifiable by grep / AST check.
- (x) Lint or import-graph check enforces: engine module does NOT import from credential-store, and credential-store does NOT import from engine.

**Schema & documentation scope (must all land in Task 1's PR).**

The substitution feature is not "done" until every surface that *describes* the tools reflects the new behaviour. Without this, the new parameter is invisible to LLM callers and the deprecated flag isn't truly removed.

- **MCP tool schemas** (JSON Schema the MCP server exposes -- what the LLM sees via `tools/list`):
  - `send_files`: add optional `substitutions: { [key: string]: string }`. Description references the grammar, validate-then-transform behaviour, and the secrets-boundary invariant.
  - `execute_prompt`: add optional `substitutions: { [key: string]: string }` with the same description shape. **Remove** the `dangerously_skip_permissions` property entirely from the schema.
- **Fleet skill (`skills/fleet/`):**
  - `SKILL.md` "File Transfer" section -- document `substitutions` for `send_files`.
  - `SKILL.md` "Dispatch Rules" / "execute_prompt ..." sections -- document `substitutions` for `execute_prompt`, including the staged-prompt-file detail.
  - `SKILL.md` new sub-section or callout (next to "Secure Credentials"): "[SECURE] Substitution does NOT resolve `{{secure.NAME}}` -- secrets only flow through the credential fields listed above. Token grammar excludes `.` precisely so `secure.*` cannot be a substitution key."
  - `SKILL.md` "Unattended Execution Modes" -- drop any remaining mention of `dangerously_skip_permissions` on the dispatch tool itself; the `update_member(unattended='dangerous')` path is the only documented route.
  - `troubleshooting.md` -- add entries for `substitution failed` (unresolved tokens) and `invalid substitutions` (reserved/malformed keys).
- **PM skill (`skills/pm/`):**
  - `SKILL.md` sub-documents list -- the line *"tpl-*.md -- various templates sent to members via `send_files`, never loaded into PM context -- PM substitutes `{{token}}` placeholders before sending"* is now wrong about who substitutes. Replace with: *"...PM passes a `substitutions` map to `send_files` / `execute_prompt`; fleet performs the substitution server-side. PM never reads the template content."*
  - `SKILL.md` Core Rule 9 -- drop the `dangerously_skip_permissions` sentence; keep the rest of the rule intact.
  - `doer-reviewer.md` -- grep for `dangerously_skip_permissions` and remove. Verify nothing else implies the flag is still valid.
- **Code search audit (gates the PR):**
  - `grep -r dangerously_skip_permissions` across the apra-fleet repo and all skill folders -> expected: zero matches after the PR (except possibly an entry in a CHANGELOG / migration note).
  - `grep -r 'PM substitutes' OR '{{token}}'` across `skills/pm/` -> ensure stale prose about client-side substitution is gone.
- **Caller audit:**
  - Every current `send_files` and `execute_prompt` caller in the apra-fleet repo and its e2e suites still works without modification (the new parameter is optional). Confirmed by running the existing test suite.
  - Any caller that today does *client-side* substitution before calling these tools is left untouched in this sprint -- migration of those callers is a follow-up sprint, not part of Task 1. Task 1's job is to make the feature available; downstream adoption is gated separately.

**Cleanup (bundled into Task 1).**

While we're touching `execute_prompt`'s schema to add `substitutions`, **remove** the deprecated `dangerously_skip_permissions` parameter entirely:

- It's already a documented no-op -- the schema description says "DEPRECATED: use update_member(unattended='dangerous') instead. This field is ignored and will be removed in a future version."
- A `dangerously_*` flag in a public API is a security-readability hazard: a casual reader (or an LLM) might think setting it does what it says.
- The replacement path (`update_member(unattended='dangerous')`) is well-documented in fleet `SKILL.md`.

**Cleanup FRs:**

- Remove `dangerously_skip_permissions` from the `execute_prompt` schema.
- Remove the parameter's handling code (if any beyond ignoring) and the deprecation message in server output.
- Grep audit: no caller in the codebase still passes it. If any does, fix them in the same PR.
- Fleet `SKILL.md` and `pm/SKILL.md` text updated to drop references to the flag.
- One regression test: a caller passing `dangerously_skip_permissions: true` to `execute_prompt` gets a schema-validation error (not a silent no-op).

**Open questions (remaining -- see end of file).**

---

### Task 2 -- Define the 4 role agents (planner, plan-reviewer, doer, reviewer)

**Status:** drafted 2026-05-15.

**Motivation.** Today the four roles live as `skills/pm/tpl-*.md` files inside PM's skill folder, sent to each member as `CLAUDE.md` per dispatch. That couples roles to PM's filesystem, makes them invisible to project-level customization, and forces PM to read them to do substitution (now handled by Task 1). Moving roles to a member-side, version-controlled location at `.claude/agents/<name>.md` gives three benefits:

- Roles live where they execute (on the member).
- Projects override defaults per-repo (audit trail, PR-reviewable rule changes).
- The installer ships them as first-class artifacts.

**The four agents.**

| Agent | Source today | Role |
|---|---|---|
| planner | `skills/pm/plan-prompt.md` | Reads requirements; produces PLAN.md with tiered tasks. |
| plan-reviewer | `skills/pm/tpl-reviewer-plan.md` | Reviews PLAN.md against requirements; writes feedback.md verdict. |
| doer | `skills/pm/tpl-doer.md` | Executes plan tasks; commits; stops at VERIFY. |
| reviewer | `skills/pm/tpl-reviewer.md` | Reviews diff against plan + requirements; writes feedback.md verdict. |

**File format (both providers, same schema).**

```
---
name: <role>
description: <one-line summary the dispatcher reads>
tools: [<tool list>]
---

<system-prompt body: role rules, behaviors, output format>
```

Body content is the current `tpl-*.md` text with `{{token}}` placeholders removed -- runtime parameters now flow via Task 1's `substitutions` on the dispatch prompt.

**No `model:` in frontmatter.** Model tier is chosen by PM at dispatch time from the planner's `tasks[i].tier`. Pinning a model in the agent file would defeat tier-streak batching (where PM groups consecutive same-tier tasks under one cheaper model). The agent body may include guidance like "this role is normally dispatched at premium tier" as informational text, but it does not force a model.

**File layout.** One file per agent at `.claude/agents/<name>.md`. No agent-specific subfolders. If an agent's body needs supporting docs (long examples, error catalogues, etc.), those live elsewhere in the repo and the body references them by relative path -- same pattern skills use for sub-docs. Claude loads them on demand when the body cites them. For the 4 roles in this sprint, a single file each suffices.

**Install paths (decided -- both providers symmetric).**

Claude members (Claude Code native):
- User-level defaults: `~/.claude/agents/<name>.md` -- installed by apra-fleet installer.
- Project overrides: `<repo>/.claude/agents/<name>.md` -- committed per-project when customization is needed.
- Resolution: project beats user (Claude Code's standard precedence).

Gemini members (Gemini CLI native, confirmed at geminicli.com/docs/core/subagents/):
- User-level defaults: `~/.gemini/agents/<name>.md`.
- Project overrides: `<repo>/.gemini/agents/<name>.md`.
- Same precedence: project beats user.

Both providers' agent file format (frontmatter + system-prompt body) is compatible enough that the four shipped agent files can be near-identical between `.claude/agents/` and `.gemini/agents/`. The installer ships both pairs from the same canonical source in the apra-fleet repo (location to be decided in Task 5).

**Role activation mechanism -- native, but asymmetric per provider.**

Both Claude CLI and Gemini CLI support native subagent activation, but via different mechanisms:

| Provider | Mechanism | Surface |
|---|---|---|
| Claude | `claude --agent <name>` -- CLI flag, sets the agent for the whole session at invocation. | Flag |
| Gemini | `@<name>` mention inside the prompt -- selects the agent for that prompt. | In-prompt |

Either way the session is born (or re-asserted) adopting the named agent's system prompt and tool allow-list. No in-prompt "read this file" instruction needed; no risk of the LLM failing to assume the role.

**`execute_prompt` schema extension (Task 2's scope).** Add an optional `agent: string` parameter to `execute_prompt`. When set, fleet absorbs the provider asymmetry: PM passes a single provider-neutral `agent` value, fleet translates per the member's `llmProvider`.

Fleet must:

- **For Claude members:** invoke `claude --agent <name> [--resume <id>] -p "<prompt>"`. The `--agent` flag goes on the CLI; the prompt itself is untouched.
- **For Gemini members:** invoke `gemini -p "@<name> <prompt>"`. Fleet prepends `@<name> ` to the prompt string. **The prepend happens on every dispatch** (not just the first), because each Gemini prompt is independent -- the role must be re-asserted to remain active across turns.
- **Substitution interaction:** the substitution engine (Task 1) runs on the prompt BEFORE provider wrapping. So for Gemini, the order is: substitute `{{tokens}}` -> then prepend `@<name>` -> then pass to CLI. The `@<name>` itself is added by fleet (not by the caller) and is not subject to substitution.
- **Validation before dispatch:** verify the named agent file exists on the member at `<repo>/.<provider>/agents/<name>.md` or `~/.<provider>/agents/<name>.md`. If neither exists, return a clear error and do not invoke the CLI.
- **No collision concern with Gemini's `@`-mention:** our substitution grammar (`{{name}}`, names match `[A-Za-z_][A-Za-z0-9_]*`, no `.`) does not overlap with Gemini's `@<name>` syntax. Fleet's prepend is purely a string concatenation, post-substitution.

**Dispatch flow (how PM uses these).**

PM dispatches at **tier-streak grain** -- a run of consecutive same-tier tasks within a phase, ending at the next tier transition or VERIFY. The doer reads `progress.json` on the member to find the next pending task and works through the streak.

```
execute_prompt(
  member,
  agent="doer",
  prompt="Continue Phase {{phase}}. Read progress.json on each turn for the next pending task. Stop at VERIFY or when the next task's tier differs from the model you were dispatched with. Branch: {{branch}}, base: {{base_branch}}.",
  substitutions={ phase: "3", branch: "feat/x", base_branch: "main" },
  model: "standard",
  resume: true
)
```

The member's CLI is launched as `claude --agent doer --resume <session> -p "<rendered prompt>"`. The session natively adopts the doer role from `.claude/agents/doer.md`. The prompt carries only runtime context (which phase, which branch). PM never opens the agent file.

**Role switch.** One member can play multiple roles across a sprint. Role change = different `agent` value on the next dispatch + `resume=false` (fresh session, since the agent definition is set at session start and switching mid-session is not supported). The fresh session is born as the new role. Existing pm rule about `resume=false` on role switch is unchanged in intent; the mechanism is now CLI-flag-based rather than file-swap-based.

**Tool allow-lists per role (initial defaults).**

| Role | Tools |
|---|---|
| planner | Read, Grep, Glob, Bash (read-only git), Write (PLAN.md only) |
| plan-reviewer | Read, Grep, Glob, Bash (read-only git), Write (feedback.md only) |
| doer | full editor surface (Read, Edit, Write, Bash, Grep, Glob, ...) |
| reviewer | Read, Grep, Glob, Bash (git + test runners), Write (feedback.md only) |

These mirror today's `compose_permissions` profiles but are now declarative in the agent file. **Security boundary remains `compose_permissions`** -- the agent's `tools:` list is informational for the LLM, not enforced. No security regression from this task.

**Content conversion (in Task 2's PR).**

- `skills/pm/plan-prompt.md` body -> `agents/planner.md` body.
- `skills/pm/tpl-reviewer-plan.md` body -> `agents/plan-reviewer.md` body.
- `skills/pm/tpl-doer.md` body -> `agents/doer.md` body.
- `skills/pm/tpl-reviewer.md` body -> `agents/reviewer.md` body.
- Strip `{{token}}` placeholders from the bodies (parameters now flow via dispatch substitutions).
- Add frontmatter per the schema above.
- Delete the four source files in `skills/pm/`. Source of truth moves to the agent files. PM skill files referencing them get updated in Task 3's split.

**Done criteria.**

- 4 agent files committed at `agents/<name>.md` in the apra-fleet repo root (sibling to `skills/`). One source file per agent, used by the installer for both Claude and Gemini members.
- Each file valid YAML frontmatter + body, ASCII-only.
- `execute_prompt` schema gains optional `agent: string` parameter. Per-provider translation implemented and tested:
  - **Claude:** invocation includes `--agent <name>`.
  - **Gemini:** invocation prepends `@<name> ` to the prompt; verified the prepend happens on EVERY dispatch (resume=true continuations included), not just the first.
- Validation: `execute_prompt` with an `agent` value not present on the member returns a clear error before invoking any CLI. Test both providers.
- Dispatch dry-runs end-to-end on real trivial tasks:
  - Claude path: tested on apra-fleet-reorg. Fleet log shows `claude --agent doer ...`.
  - Gemini path: tested on a gemini member (fleet-dev or fleet-dev2). Fleet log shows `gemini -p "@doer ..."`.
  - Neither dry-run reads any PM-side `tpl-*` file.
- The 4 source files in `skills/pm/` deleted.
- Installer ships agent files to both `~/.claude/agents/` and `~/.gemini/agents/` per the member's `llmProvider`. (Implementation handed to Task 5; this task specifies the requirement.)
- Substitution-then-prepend ordering documented and tested: substitutions are applied to the prompt BEFORE Gemini's `@<name>` is prepended.

**Open questions.** None.

**Resolved.**

- **Canonical repo location.** [OK] `agents/<name>.md` at the apra-fleet repo root, sibling to `skills/`. One source file per agent. The installer copies each to the member at `~/.claude/agents/<name>.md` and/or `~/.gemini/agents/<name>.md` depending on the member's `llmProvider`. Task 5 owns the routing implementation.
- **Gemini native agents support.** [OK] Confirmed at geminicli.com/docs/core/subagents/. Path: `~/.gemini/agents/<name>.md` (user) and `<repo>/.gemini/agents/<name>.md` (project). Activation via `@<name>` in prompt. Fleet absorbs the asymmetry vs Claude's `--agent` flag.

---

### Task 3 -- Analyze pm skill splits

**Status:** stub -- needs thinking time, not just decisions.

**Scope hooks.**
- Inventory every file in `skills/pm/` and classify by load frequency (every-session, every-sprint, per-command, rarely).
- Propose split into sibling skills (`pm-init`, `pm-cleanup`, `pm-backlog`, `pm-recover`, ...) versus on-demand sub-docs.
- Decide what stays in `pm` core.
- Evaluate impact on `pm-skill` activation (auto-load via SKILL.md vs. explicit `/pm <cmd>` triggers).

---

### Task 4 -- Deep review: reorganized skills still work

**Status:** stub.

**Scope hooks.**
- End-to-end dry run of a small sprint using the new skill organization.
- Verify every `/pm` command still works.
- Verify recovery flow after PM restart.
- Verify multi-pair sprint still works.
- Cross-check against existing pm-related e2e suites -- must not regress.

---

### Task 5 -- Deep review: installer routes everything correctly

**Status:** stub.

**Scope hooks.**
- Audit `install.cjs` (and any other installer files) for where each artifact lands.
- **Route `agents/*.md` from the repo root to both `~/.claude/agents/<name>.md` and `~/.gemini/agents/<name>.md` based on the member's `llmProvider`.** Single source per agent in the repo; installer fans out to per-provider directories on the member. Decided in Task 2.
- Verify skill files land in `~/.claude/skills/` and don't shadow project-level overrides.
- Verify Beads, hooks, settings.json updates go to correct locations on Win / Linux / macOS.
- Verify uninstall path is clean (including removal of the agents files).

---

### Task 6 -- Long-running agents replacing `claude -p` (deadline: 2026-06-15)

**Status:** stub -- the hardest task.

**Motivation.** Anthropic is removing or restricting `claude -p` for non-enterprise accounts starting 2026-06-15. Fleet's `execute_prompt` provider for Claude relies on `claude -p` and `--resume <sessionId>`. If we don't migrate, fleet members lose the ability to be driven from PM after that date.

**Scope hooks.**
- Research the Claude Code SDK / Agent API as a long-running alternative.
- Map current `execute_prompt` semantics (resume, sessionId, max_total_s, timeout_s, model tiers, stop_prompt) onto the new mode.
- Validate on at least one fleet member end-to-end (a real sprint dispatch + resume + stop, no `claude -p`).
- Surface any features that won't survive the migration (e.g., if `--resume <sessionId>` semantics differ).
- Produce a migration plan for remaining members (not executed this sprint).

---

## Open questions (Task 1 -- needs user input before plan)

### Resolved (2026-05-14)

- **Token grammar.** [OK] Lenient -- `{{ \s* name \s* }}`, names `[A-Za-z_][A-Za-z0-9_]*`. See FR 3.
- **Substitutions map shape.** [OK] Flat global map. `local_paths` shape unchanged. No per-file overrides.
- **Validation policy.** [OK] Validate-then-transform; reject if any required token is missing; no partial writes. See FR 4.
- **Extra keys.** [OK] Silently ignored -- not an error, not even a warning. See FR 5.
- **No-substitutions case.** [OK] Transfer as-is + heuristic warning if file contains `{{...}}` pattern. See FR 1.
- **Secret-leak guard.** [OK] Token *values* never appear in logs, errors, telemetry. Token *names* may. See NFR.
- **Secrets boundary.** [OK] `send_files` substitutions is disjoint from the credential store. Keys must match `[A-Za-z_][A-Za-z0-9_]*` (no `.`, so `secure.*` is rejected). `{{secure.NAME}}` in file content passes through verbatim -- resolved later only by `execute_command`. See FR 10.
- **`execute_command` extension.** [OK] **Not** added -- stays excluded. `execute_command` takes only a `command` string with no file payload to substitute into; it already has `{{secure.NAME}}` resolution and a redaction model. Mixing unredacted `substitutions` into that namespace would muddy the secret-resolution boundary. Future tasks only.
- **`execute_prompt` extension.** [OK] **Added** -- `substitutions` parameter on `execute_prompt` with identical semantics to `send_files`. `execute_prompt` already writes a prompt file to the member (the `.fleet-task.md` staging file from onboarding step 7), so the substitution surface fits naturally. Code is reused -- one shared engine. Decided 2026-05-15. (This supersedes the earlier "not this sprint" closure -- that earlier closure incorrectly lumped `execute_prompt` with `execute_command`.)
- **Raw opt-out (`raw_paths`).** [OK] Not added. v1 supports no per-file opt-out. The rare case of a file with literal `{{...}}` content that should not be substituted is handled by sending that file in a separate `send_files` call without `substitutions`. See FR 8.
- **Substitution location.** [OK] Option A -- inside the MCP tool handlers (server-side TypeScript), via the shared engine. Single MCP call per tool, in-memory transformation, no temp files, unified error path. Decided 2026-05-15.
- **`dangerously_skip_permissions` removal.** [OK] Remove the deprecated `dangerously_skip_permissions` parameter from `execute_prompt` entirely as part of this task -- it's already a no-op (ignored server-side per the schema), and leaving a `dangerously_*` flag in the public API is a security-readability footgun. Scope addition decided 2026-05-15. See Cleanup section below.

### Still open

_None._ Task 1 is locked. Ready to plan.

## Risks

- Task 6 has a hard external deadline (2026-06-15). If research shows the long-running agent path is not viable for our model tiers / permission semantics, we need to escalate early -- not at the end of the sprint.
- Task 1 changes a public fleet tool signature. Any in-flight sprint using `send_files` could be affected during the rollout. Mitigation: strict backward compat (Task 1 Sec.8).
- Tasks 3 and 5 may surface that the installer makes assumptions inconsistent with the new layout -- could expand scope.

## Acceptance (sprint-level)

- [ ] Task 1 merged and `send_files` documented in fleet `SKILL.md`.
- [ ] Task 2 produces 4 agent definitions on disk (Claude + Gemini paths) installable via installer.
- [ ] Task 3 produces a split decision document committed to the repo.
- [ ] Task 4 produces a green dry-run report.
- [ ] Task 5 produces an installer audit report and any necessary fixes merged.
- [ ] Task 6 produces a working long-running-agent dispatch demonstrated on [PURPLE] apra-fleet-reorg, plus a written migration plan.
- [ ] All CI green on `enhancement/skill-reorg` before PR raised to `main`.
