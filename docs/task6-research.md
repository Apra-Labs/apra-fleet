# Task 6 Research: Migrating `claude -p` to the Claude Code SDK

**Date:** 2026-05-28
**Status:** Research complete -- migration path identified, validation pending
**Deadline:** 2026-06-15

---

## 1. Current: How `claude -p` Is Used Today

### Command Structure

Fleet's `execute_prompt` builds and executes this command on the member machine (see
`src/providers/claude.ts:buildPromptCommand` and `src/os/os-commands.ts`):

```
# New session:
cd "<workFolder>" && { claude --agent "<agent>" -p "[<inv>] Your task is described in \
  .fleet-task.md in the current directory. Read that file first, then execute the task." \
  --output-format json --max-turns 50 --session-id "<uuid>" \
  --permission-mode auto --model "claude-sonnet-4-6"; } \
  & _fleet_pid=$!; printf 'FLEET_PID:%s\n' "$_fleet_pid"; wait "$_fleet_pid"; exit $?

# Resumed session:
cd "<workFolder>" && { claude --agent "<agent>" -p "[<inv>] ..." \
  --output-format json --max-turns 50 --resume "<uuid>" \
  --permission-mode auto --model "claude-sonnet-4-6"; } \
  & _fleet_pid=$!; printf 'FLEET_PID:%s\n' "$_fleet_pid"; wait "$_fleet_pid"; exit $?
```

### Key Flags

| Flag | Purpose | Default |
|------|---------|---------|
| `-p "<instruction>"` | Headless (non-interactive) prompt mode | (required) |
| `--output-format json` | Structured JSON output; JSONL on newer Claude Code versions | json |
| `--max-turns <n>` | Maximum agentic turns before forced stop | 50 |
| `--session-id "<uuid>"` | Fleet-minted UUID for a new session (enables later resume) | none |
| `--resume "<uuid>"` | Resume a previous session by its UUID | none |
| `--permission-mode auto` | Unattended auto-approve mode (`unattended='auto'`) | user-approval |
| `--dangerously-skip-permissions` | Bypass all permission checks (`unattended='dangerous'`) | off |
| `--model "<name>"` | Model override (haiku / sonnet / opus) | user default |
| `--agent "<name>"` | Activate a named agent from `.claude/agents/<name>.md` | none |

### Session ID Format

Fleet mints a `uuid v4` string (`uuid()`) per new session. The same UUID is passed as
`--session-id` on first call and `--resume` on subsequent calls. Fleet stores the UUID in
the member registry (`agent.sessionId`). Claude Code writes session state to:
`~/.claude/projects/<workFolder-path-encoded>/<uuid>.jsonl`

where path encoding is: every `/`, `\`, `:` replaced with `-`
(e.g. `C:\akhil\git\apra-fleet` -> `C--akhil-git-apra-fleet`).

### Output Parsing

`provider.parseResponse()` (`src/providers/claude.ts:parseResponse`) handles three
output formats emitted by different Claude Code versions:
1. Single JSON object: `{ type, result, session_id, usage, is_error }`
2. JSON array of events: same objects in an array
3. JSONL (one JSON object per line, Claude Code 2.1.113+): reads until `type === 'result'`

Extracts: `result` (text), `session_id` (for resume), `usage` (token counts).

### PID Tracking

The Unix shell wrapper `{ cmd; } & pid=$!; printf 'FLEET_PID:%s\n' "$pid"; wait` emits
the PID on stdout before any LLM output. Fleet captures it and stores it in an in-memory
`Map<agentId, pid>`. `stop_prompt` kills by PID via `kill -9 <pid>` (Unix) or
`taskkill /F /T /PID <pid>` (Windows).

### Stall Detection

The stall detector (`src/services/stall/`) polls the session JSONL log file at
`~/.claude/projects/<encoded>/<sessionId>.jsonl` to check if the `assistant` timestamp
is advancing. It uses this as a proxy for "LLM is still making progress."

### Timeout Semantics

- `timeout_s` (default 300s): rolling inactivity timeout -- kills if no stdout/stderr for
  N seconds. Implemented in `strategy.execCommand`.
- `max_total_s` (optional): hard wall-clock ceiling, never reset. Implemented alongside
  `timeout_s` in `execCommand`.

### Stop Prompt

`stop_prompt` (`src/tools/stop-prompt.ts`) calls `tryKillPid`, which sends the kill
signal to the stored PID on the member machine over SSH (or locally). This immediately
terminates the running `claude` subprocess.

---

## 2. Replacement: The Claude Code SDK (`@anthropic-ai/claude-code`)

### What It Is

The `@anthropic-ai/claude-code` npm package (released late 2024) is the programmatic
TypeScript/JavaScript API for Claude Code. It is the official replacement for
subprocess-based `claude -p` invocations. Instead of spawning a `claude` process,
callers import `query()` and run it in-process on Node.js.

**Key property:** The SDK runs inside the calling Node.js process. It does not spawn a
subprocess. This is the fundamental architectural difference from `claude -p`.

### Core API

```typescript
import { query, type SDKMessage } from "@anthropic-ai/claude-code";

const abortController = new AbortController();

for await (const message of query({
  prompt: "Your task is described in .fleet-task.md...",
  abortController,
  options: {
    maxTurns: 50,
    cwd: "/path/to/workFolder",
    model: "claude-sonnet-4-6",
    permissionMode: "auto",
  },
})) {
  if (message.type === "result") {
    console.log(JSON.stringify(message)); // emit to stdout for fleet to parse
  }
}
```

### Session Resume

```typescript
// First call: capture session ID from the result message
let sessionId: string | undefined;
for await (const message of query({ prompt, options: { cwd } })) {
  if (message.type === "result") {
    sessionId = message.session_id;
    // message.result = final text output
    // message.usage = { input_tokens, output_tokens, ... }
  }
}

// Subsequent call: resume by passing session ID
for await (const message of query({
  prompt: "Continue...",
  options: { cwd, resume: sessionId },
})) {
  // same handling
}
```

### Key Options

| Option | Type | Description |
|--------|------|-------------|
| `maxTurns` | number | Max agentic turns (replaces `--max-turns`) |
| `cwd` | string | Working directory (replaces `cd "<dir>" &&` prefix) |
| `model` | string | Model name (replaces `--model`) |
| `permissionMode` | string | See permission table below |
| `resume` | string | Session UUID to resume (replaces `--resume`) |
| `systemPrompt` | string | Override system prompt |
| `appendSystemPrompt` | string | Append to default system prompt |
| `allowedTools` | string[] | Restrict which tools Claude can call |
| `disallowedTools` | string[] | Block specific tools |
| `mcpServers` | Record | MCP server config to inject |
| `executable` | string | Path to `claude` binary (if non-standard install) |

### Permission Modes

| SDK `permissionMode` | CLI Equivalent | Effect |
|---------------------|----------------|--------|
| `"default"` | (interactive, user approves) | Normal interactive mode |
| `"acceptEdits"` | (no direct equivalent) | Auto-accept file edits only |
| `"auto"` | `--permission-mode auto` | Auto-approve all tool calls |
| `"bypassPermissions"` | `--dangerously-skip-permissions` | No permission checks |

### Result Message Shape

```typescript
{
  type: "result",
  result: string,           // final text output
  session_id: string,       // UUID -- use this for resume
  is_error: boolean,
  subtype: "success"
         | "error_max_turns"
         | "error_during_tool_use"
         | "interrupted",
  usage: {
    input_tokens: number,
    output_tokens: number,
    cache_read_input_tokens?: number,
    cache_creation_input_tokens?: number,
  },
  total_cost_usd?: number,
}
```

### Stopping a Running Session

```typescript
const abortController = new AbortController();

// Start the query
const gen = query({ prompt, abortController, options });
for await (const message of gen) { ... }

// From another context (e.g., signal handler):
abortController.abort(); // graceful interrupt -- Claude finishes its current turn
```

The abort results in a `result` message with `subtype: "interrupted"`.

### Authentication

Identical to the CLI: the SDK reads from `ANTHROPIC_API_KEY` env var or
`~/.claude/.credentials.json` OAuth credentials. No additional auth setup is required.

---

## 3. Mapping: Current Flag -> New Equivalent

| Current (`claude -p` CLI) | SDK Equivalent | Notes |
|--------------------------|----------------|-------|
| `-p "<instruction>"` | `query({ prompt: "<instruction>" })` | Direct replacement |
| `--output-format json` | (automatic) | SDK returns typed objects; no flag needed |
| `--max-turns <n>` | `options.maxTurns: n` | Direct equivalent |
| `--session-id "<uuid>"` | (not needed) | Fleet still mints UUID; use the `session_id` returned in `result` |
| `--resume "<uuid>"` | `options.resume: "<uuid>"` | Direct equivalent |
| `--permission-mode auto` | `options.permissionMode: "auto"` | Direct equivalent |
| `--dangerously-skip-permissions` | `options.permissionMode: "bypassPermissions"` | Direct equivalent |
| `--model "<name>"` | `options.model: "<name>"` | Direct equivalent |
| `--agent "<name>"` | No direct SDK equivalent | See Gaps section below |
| `cd "<folder>" &&` | `options.cwd: "<folder>"` | Direct equivalent |
| `{ cmd; } & pid=$!; ...` | `abortController.abort()` | Process-level PID kill -> in-process abort |
| Exit code 0/non-0 | `result.is_error`, `result.subtype` | More granular than exit code |

### Session ID Handling Change

Today fleet mints a UUID and passes it on the first call as `--session-id`. With the SDK,
the session ID is assigned by Claude Code internally and returned in the `result` message.
Fleet's first call passes no session ID; it captures `result.session_id` and stores it
as `agent.sessionId` for future resume calls. This is a minor but concrete change to
`touchAgent()` call timing.

---

## 4. Gaps: Features That Won't Survive Without New Design Work

### Gap 1: `--agent "<name>"` flag

The CLI `--agent` flag loads a named agent file from `.claude/agents/<agent>.md` or
`~/.claude/agents/<agent>.md`. The SDK does not expose a direct equivalent option.

**Workaround options:**
- Read the agent file in fleet and pass its content as `options.appendSystemPrompt`
- Use `options.mcpServers` to inject agent-specific MCP config
- Rely on the default `CLAUDE.md` and fold agent-specific instructions into it

**Risk:** Medium. Named agents are used in the `agent` parameter of `execute_prompt` and
are relatively new. If not many fleet dispatches use `--agent`, this gap is low-impact.
If the PM dispatch pattern depends on named agents (doer.md, reviewer.md), this is
blocking.

### Gap 2: SSH-remote member execution

The SDK is a Node.js library. Fleet's SSH-based remote strategy (`src/services/strategy/`)
executes shell commands on the remote machine via SSH. It cannot call a local npm package
running on the remote machine.

**This is the biggest architectural gap.** For remote members, fleet cannot use the SDK
directly. Options:

**Option A (Recommended): Thin Node.js runner script deployed to remote members**
- Fleet deploys a `~/.apra-fleet/fleet-runner.mjs` script to each remote member during
  `register_member` or via a new `update_llm_cli` step
- The script `import`s `@anthropic-ai/claude-code`, calls `query()`, and emits a JSON
  result to stdout in a format compatible with `provider.parseResponse()`
- Fleet SSH executes: `node ~/.apra-fleet/fleet-runner.mjs --prompt-file .fleet-task.md
  --session-id <uuid> --model <model> --max-turns <n> --permission-mode <mode>`
- The runner outputs: `{ type: "result", result: ..., session_id: ..., usage: ... }` then
  exits with code 0 or 1

This preserves the entire SSH + execCommand architecture. Only the command changes from
`claude -p ...` to `node ~/.apra-fleet/fleet-runner.mjs ...`.

**Option B: Use the SDK only for local members, keep CLI for remote**
- Local members (agentType === 'local') use the SDK in-process
- Remote members continue using `claude -p` (if still available for enterprise/Anthropic
  internal accounts) or the runner script
- Defers the remote migration to a follow-up sprint

**Option C: SDK-over-SSH using Node.js child process on the fleet server**
- Fleet runs the SDK in-process on the fleet server machine (not the member)
- The SDK's `cwd` and file operations would run locally, not on the remote member
- This only works for cases where the work happens locally -- defeats the purpose for
  remote members

### Gap 3: PID capture and `stop_prompt` over SSH

The shell wrapper today captures the `claude` PID by emitting `FLEET_PID:<pid>` to stdout
before the LLM produces output. With the runner script, the PID is the Node.js process
running the script. `stop_prompt` would kill that PID, which terminates the SDK in-process
execution. This is equivalent behavior -- `AbortController.abort()` is not needed from
fleet's perspective; killing the runner process works.

**Impact:** Low. The kill-by-PID pattern still works with the runner. The PID capture
in the shell wrapper (`printf 'FLEET_PID:%s\n' "$_fleet_pid"`) remains valid because
the runner is just a new process being backgrounded the same way.

### Gap 4: Stall detector log file polling

The stall detector reads `~/.claude/projects/<encoded>/<sessionId>.jsonl` to check
for LLM activity. When the SDK replaces the CLI, the session log may not be written to
the same location, or at all. The JSONL session log is a side-effect of the Claude Code
CLI process; the SDK may or may not write to the same path.

**Investigation needed:** Run the SDK once and confirm whether
`~/.claude/projects/<encoded>/<sessionId>.jsonl` is still created and written.

**Risk:** Medium. If the log file is not written, the stall detector becomes blind and
may fire incorrectly. Fallback: use activity tracking via stdout line count instead of
log file polling. The runner script can emit periodic heartbeat lines.

### Gap 5: `timeout_s` inactivity rolling timer

Today the inactivity timer is implemented inside `strategy.execCommand`: each byte of
stdout/stderr output resets the timer. With the runner script, the same mechanism works
because the runner writes its output stream to stdout.

If fleet adopts the in-process SDK for local members (Approach 2 for Gap 2), the
inactivity timer would need to be reimplemented using the SDK's async iterator: reset
the timer on each message received from the iterator.

**Impact:** Low for runner script approach (no change). Medium for in-process approach
(requires refactoring `executePrompt` timeout logic).

### Gap 6: Session ID ownership

Today fleet mints the UUID and passes it as `--session-id`, which gives fleet strong
control: the session ID is known before the call starts, so `stallDetector.update()` can
be called immediately with the log file path.

With the SDK, the session ID is only known after the first result message. The stall
detector's log file path cannot be resolved until the first `result` arrives.

**Impact:** Low. The stall detector already has a `provisional: true` state for the
initial period before the log path is known. The new flow is: start with provisional,
update when `result.session_id` is received. The only change is that fleet cannot
pre-compute the log path; it must wait for the result.

---

## 5. Risk Assessment

| Risk | Severity | Likelihood | Notes |
|------|----------|------------|-------|
| `claude -p` removed before runner script is deployed | CRITICAL | High (hard deadline) | Migration must complete before 2026-06-15 |
| Runner script approach requires Node.js on remote members | HIGH | Medium | All Claude members already run Node.js (Claude Code CLI requires it). `@anthropic-ai/claude-code` version must be compatible with installed Node.js |
| SDK `query()` API changes incompatibly before we migrate | MEDIUM | Low | SDK is GA; breaking changes would need a major version bump |
| `--agent` flag has no SDK equivalent | MEDIUM | Medium | Named agents in PM dispatch would stop working. Workaround (appendSystemPrompt) degrades context quality |
| Stall detector breaks due to missing session JSONL | MEDIUM | Medium | Need to verify experimentally whether SDK writes JSONL |
| Runner script deployment adds an install step | LOW | High | Every remote member needs `fleet-runner.mjs` + `@anthropic-ai/claude-code` installed. Adds complexity to `register_member` and `update_llm_cli` |
| Token/cost reporting changes | LOW | Low | SDK `result.usage` has extra fields (cache tokens). `provider.parseResponse()` must be updated but is non-breaking |
| Windows remote member compatibility | LOW | Low | Runner script uses Node.js ESM; Windows-compatible if Node.js >= 18 installed |

---

## 6. Recommended Migration Path

### Step 0: Verify the constraint (immediate)

Confirm that `claude -p` is actually being restricted and for which account type.
The restriction "non-enterprise accounts starting 2026-06-15" needs to be validated:
- Does it apply to API-key auth? OAuth auth? Both?
- Is there a grace period for existing sessions?
- Is there a new CLI flag that is not `-p` but achieves the same headless dispatch?

**Check:** Run `claude --help` on a fleet member after 2026-06-01 to see if `-p` still
appears. Monitor Anthropic's changelog for `@anthropic-ai/claude-code` releases.

### Step 1: Build the runner script

Create `src/providers/claude-runner/fleet-runner.mjs`:

```javascript
#!/usr/bin/env node
// fleet-runner.mjs -- Thin SDK wrapper that replaces `claude -p` for fleet members.
// Called by fleet's execute_prompt via SSH: node fleet-runner.mjs [flags]
// Outputs a single-line JSON result to stdout, then exits with code 0 or 1.

import { query } from "@anthropic-ai/claude-code";
import { readFileSync } from "fs";
import { parseArgs } from "util";

const { values } = parseArgs({
  options: {
    "prompt-file": { type: "string" },
    "session-id": { type: "string" },     // for resume
    "model": { type: "string" },
    "max-turns": { type: "string" },
    "permission-mode": { type: "string" }, // "auto" | "bypassPermissions" | "default"
    "agent": { type: "string" },           // reads agent file, appends to system prompt
    "inv": { type: "string" },             // invocation tag for log correlation
  },
});

const cwd = process.cwd();
const promptFile = values["prompt-file"] ?? ".fleet-task.md";
const prompt = `[${values["inv"] ?? "no-inv"}] Your task is described in ${promptFile} ` +
  `in the current directory. Read that file first, then execute the task.`;

let agentSystemPrompt = undefined;
if (values["agent"]) {
  // Try project-level agent file then user-level
  const providerDir = ".claude";
  try {
    agentSystemPrompt = readFileSync(
      `${cwd}/${providerDir}/agents/${values["agent"]}.md`, "utf8");
  } catch {
    try {
      const home = process.env.HOME ?? process.env.USERPROFILE;
      agentSystemPrompt = readFileSync(
        `${home}/${providerDir}/agents/${values["agent"]}.md`, "utf8");
    } catch { /* agent not found -- caller validated this already */ }
  }
}

const abortController = new AbortController();
process.on("SIGTERM", () => abortController.abort());
process.on("SIGINT", () => abortController.abort());

let result = null;
try {
  for await (const message of query({
    prompt,
    abortController,
    options: {
      cwd,
      model: values["model"],
      maxTurns: values["max-turns"] ? parseInt(values["max-turns"]) : 50,
      permissionMode: values["permission-mode"] ?? "default",
      resume: values["session-id"],
      ...(agentSystemPrompt ? { appendSystemPrompt: agentSystemPrompt } : {}),
    },
  })) {
    if (message.type === "result") {
      result = message;
    }
  }
} catch (err) {
  process.stderr.write(err.message + "\n");
  process.exit(1);
}

if (!result) {
  process.stderr.write("No result message received\n");
  process.exit(1);
}

// Emit in fleet-parseable format (compatible with provider.parseResponse JSONL path)
console.log(JSON.stringify({
  type: "result",
  result: result.result,
  session_id: result.session_id,
  is_error: result.is_error || result.subtype !== "success",
  subtype: result.subtype,
  usage: result.usage,
}));

process.exit(result.is_error ? 1 : 0);
```

### Step 2: Update `ClaudeProvider.buildPromptCommand`

Change the command from `claude -p ...` to `node ~/.apra-fleet/fleet-runner.mjs ...`:

```typescript
// In src/providers/claude.ts buildPromptCommand():
// Old:
// cmd += ` -p "${instruction}" --output-format json --max-turns ${turns}`;
// if (resuming && sessionId) cmd += ` --resume "${sessionId}"`;
// else if (sessionId) cmd += ` --session-id "${sessionId}"`;

// New:
cmd = `node "~/.apra-fleet/fleet-runner.mjs"`;
cmd += ` --prompt-file "${promptFile}"`;
cmd += ` --max-turns ${turns}`;
if (resuming && sessionId) cmd += ` --session-id "${sanitizeSessionId(sessionId)}"`;
if (model) cmd += ` --model "${escapeDoubleQuoted(model)}"`;
if (unattended === 'auto') cmd += ' --permission-mode auto';
else if (unattended === 'dangerous') cmd += ' --permission-mode bypassPermissions';
if (agentName) cmd += ` --agent "${escapeDoubleQuoted(agentName)}"`;
if (inv) cmd += ` --inv "${inv}"`;
```

Note: `--session-id` is now always for resume (no new-session minting in the flag). The
runner will let Claude Code assign the session ID, and fleet captures it from the result.

### Step 3: Update session ID capture in `executePrompt`

The current code mints a UUID before the call:
```typescript
const mintedId = resuming ? agent.sessionId! : uuid();
```

After migration, for new sessions, `mintedId` is `undefined` and fleet captures the
session ID from `parsed.sessionId` (returned by the runner in the result JSON). The
existing `touchAgent(agent.id, parsed.sessionId)` path handles this correctly.

For resumed sessions, pass the existing `agent.sessionId` as `--session-id` to the
runner. The runner passes it to `options.resume`.

### Step 4: Deploy the runner to all fleet members

Add to `register_member` flow and `update_llm_cli`:
1. Check that Node.js >= 18 is installed on the member
2. Run `npm install -g @anthropic-ai/claude-code` on the member (or use the version
   bundled with the Claude Code CLI binary)
3. Copy `~/.apra-fleet/fleet-runner.mjs` to the member
4. Verify it works: `node ~/.apra-fleet/fleet-runner.mjs --max-turns 1 \
   --prompt-file .fleet-task.md` (with a trivial task)

### Step 5: Validate end-to-end on [PURPLE] apra-fleet-reorg (local member)

Test sequence:
1. `execute_prompt`: new session dispatch, capture session ID
2. `execute_prompt` with `resume=true`: resume with captured session ID
3. `stop_prompt`: interrupt a running session (PID kill of the node process)
4. `execute_prompt` after stop: confirm clean re-dispatch
5. Stall detector: confirm session JSONL is still written by the SDK

### Step 6: Roll out to remote members

Requires Step 4 to have been run on each member. Test with one remote member before mass
rollout. The SSH-layer is unchanged; only the command string changes.

### Fallback Plan

If the runner approach is blocked (e.g., npm install blocked by corporate proxy, or SDK
is incompatible), the fallback is:

1. Check whether Claude Code's CLI gains a new non-`-p` headless flag before 2026-06-15
2. If `claude -p` restriction only applies to OAuth (not API key): provision all fleet
   members with `ANTHROPIC_API_KEY` and continue using the CLI flag
3. Escalate to the sprint owner if neither option is viable -- the June 15 deadline is
   hard and external

---

## Open Questions for Validation

1. **Does `@anthropic-ai/claude-code` write the session JSONL log?** Run the SDK once
   and check `~/.claude/projects/<encoded>/`. If not, stall detection needs rework.

2. **Does `--agent` actually require the SDK workaround?** Test whether the runner script
   `appendSystemPrompt` approach produces equivalent quality results to `--agent`.

3. **What is the exact restriction?** Is `claude -p` removed entirely or just rate-limited
   differently for non-enterprise? The Anthropic changelog for `@anthropic-ai/claude-code`
   and the Claude Code CLI should clarify this.

4. **Is there a new CLI flag that is not `-p`?** Run `claude --help` after June 2026 to
   check if there is a new headless/non-interactive mode added to the CLI (as opposed to
   using the SDK). If such a flag exists, migration is simpler (just flag rename).

5. **Windows runner path resolution:** The `~/.apra-fleet/fleet-runner.mjs` path needs
   tilde expansion on Windows. The existing `resolveTilde()` utility in
   `src/tools/execute-command.ts` handles this for local members.
