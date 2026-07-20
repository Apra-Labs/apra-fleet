<!-- llm-context: Next-major-evolution architecture for apra-fleet: cloud-hosted multi-tenant fleet server (fleets.apralabs.com), persistent interactive member sessions replacing claude -p, auth model, hooks as control plane, migration path from current one-shot model. Read before planning any work on the cloud fleet server, interactive session migration, or fleets.apralabs.com deployment. -->
<!-- keywords: cloud fleet, fleets.apralabs.com, interactive sessions, multi-tenant, SSE, MCP, hooks, credential vault, behavioral contract, no-LLM members, migration path -->
<!-- see-also: architecture.md (current local model), provider-guide.md (provider strengths and gotchas) -->

> **Revision note (apra-fleet-us9.13):** `docs/hub-spoke-master-plan.md` supersedes
> this document's **2-tier direct-CLI-to-hub model** (this doc assumed the member's
> LLM CLI talks to `fleets.apralabs.com` directly) with a **3-tier** topology
> (`LLM-CLI -> apra-fleet.exe (local spoke) -> fleet.apralabs.com`), and reverses
> this doc's **"SSH as permanent control plane"** stance -- SSH is being migrated to
> hub-relayed `execute_command` (`apra-fleet-us9.7`). Sections 6 ("How Interactive
> Sessions Complement claude -p") and 11 ("No-LLM Members") still hold and were the
> basis for `apra-fleet-2xs.7/.8/us9.8` and `apra-fleet-us9.14` respectively. Where
> the two disagree, `hub-spoke-master-plan.md` wins (see that document's own header).

# Cloud Fleet Architecture

## 1. Why This Architecture Exists

### The current model

Fleet today dispatches tasks via `execute_prompt`, which builds a shell command using
`ClaudeProvider.buildPromptCommand()` (see `src/providers/claude.ts:35`) and spawns it
as a subprocess over SSH (remote members) or via `child_process` (local members). The
command is `claude -p "<instruction>" --output-format json --max-turns <n>`, optionally
with `--resume <sessionId>`. Fleet reads the PID from stdout, watches for JSONL output,
manages the process lifecycle, and applies a stall detector to kill hung processes
(`src/services/stall/index.ts`). For AGY members, `agy -p "<instruction>"` is used
instead, with a transcript-reader script capturing output from disk because AGY writes
its response to CONOUT$ rather than stdout.

This one-shot model has five structural problems:

**P1 -- Anthropic -p pricing change.** Anthropic is moving `claude -p` to enterprise
pricing starting 2026-06-15. Fleet's Claude dispatch path currently relies on this flag.
After that date, `ClaudeProvider.buildPromptCommand()` remains functional but becomes
significantly more expensive for non-enterprise members. The interactive session model
is the cost-preferred alternative at scale -- not a forced migration, but a strong
financial incentive. AGY (`agy -p`) is not affected by this pricing change --
Antigravity controls their own CLI, and there is no announced pricing change on that path.

**P2 -- Cold start per task.** Each `execute_prompt` call is a new process. Even with
`--resume <sessionId>`, the Claude process starts cold, reads the conversation log from
disk, and re-establishes context. This adds latency on every dispatch. There is no
persistent process holding warm context between tasks.

**P3 -- SSH-only transport.** Members must be SSH-accessible (or local). The remote
strategy (`src/services/strategy.ts`) uses `ssh2` for command execution and SFTP for
file transfer. Machines behind NAT, cloud VMs without public IPs, or machines on
corporate networks without inbound SSH access cannot be fleet members.

**P4 -- Local-only fleet server.** The fleet server today binds to `127.0.0.1` only
(`src/services/http-transport.ts:221`). It is a singleton service on the PM's machine.
A PM on machine A cannot orchestrate members on machine B's local fleet instance. There
is no cross-machine or cross-internet orchestration path.

**P5 -- Isolated PM and members.** PM dispatches a task and blocks waiting for the
subprocess to exit. There is no bidirectional channel during execution. The member
cannot send interim updates, ask questions, or notify the PM of sub-results without
writing to a shared file and waiting for PM to poll it.

### The new model

The next major evolution addresses all five problems. Members run persistent interactive
sessions that connect outbound TO fleet as MCP clients. Fleet is the hub -- a permanently
running cloud MCP server at fleets.apralabs.com. PM dispatches via message-passing over
SSE. Members respond via the same channel.

The key design insight: the HTTP+SSE transport already built in `src/services/http-transport.ts`
is structurally correct for this -- one singleton server, per-session McpServer instances,
event bus for pub/sub, SSE for server-initiated delivery. The cloud model extends this
transport for multi-tenancy and makes it internet-accessible rather than localhost-only.

**Both paths coexist.** The pricing change applies to Claude's `-p` flag only. The
interactive session model (HTTP+SSE) is the preferred path for both Claude and AGY --
it is architecturally cleaner, supports bidirectional communication, and avoids per-task
cold starts. For Claude, the interactive path is the cost-preferred option starting
2026-06-15; the SSH+`-p` path remains valid for short one-shot tasks or environments
where interactive session management adds unnecessary overhead. For AGY, the interactive
path is the preferred direction now; `agy -p` over SSH remains fully supported as an
alternative. Neither provider's `-p` path is removed.

---

## 2. Market Context and Positioning

### The product landscape

The AI-assisted software development market has grown rapidly into several distinct
categories. Understanding where fleet sits requires distinguishing between them.

**AI coding assistants.** Tools that work alongside a developer in an editor, suggesting
completions, explaining code, and answering questions. The developer remains in the loop
for every action. These tools do not run autonomously -- they assist.

**Single-agent autonomous platforms.** Platforms that deploy one AI agent per task.
The agent is given a codebase and a goal and works toward it without per-step human
approval. Results are returned when the task completes or the agent asks for input.
Most commercially available autonomous coding platforms fall into this category today.

**Multi-agent orchestration frameworks.** Libraries and frameworks that let developers
compose multiple AI agents into pipelines or teams in code. These typically run in
cloud sandboxes or containerized environments and require the developer to write the
orchestration logic themselves.

**Fleet.** Fleet occupies a different position: a multi-agent orchestration platform
built around real machines, real SSH, real git workflows, and provider choice. The PM
member is itself an AI agent that drives a team of doer and reviewer members. Fleet is
not a sandbox -- it runs on the same machines where the work lives.

### What makes fleet architecturally distinct

Several design decisions separate fleet from other approaches:

**Provider-agnostic dispatch.** Fleet members can run Claude, AGY (Antigravity),
Gemini, or other LLM providers. The PM dispatches to members using the same tool
regardless of which provider the member uses. This means cost, capability, and
provider risk are all manageable at the orchestration layer rather than being fixed
at build time.

**Real machines over SSH.** Fleet members are real machines -- developer laptops,
remote servers, CI runners, or cloud VMs -- reachable via SSH. Tasks run in the
actual environment where the code lives: the same file system, the same git history,
the same network topology. There is no environment parity gap between where fleet
runs and where the code will be deployed.

**Persistent session + SSH control plane.** Fleet separates two concerns: process
lifecycle (SSH execute_command) and task dispatch (HTTP+SSE). Both paths coexist.
This means fleet can manage long-running interactive sessions while retaining the
simplicity of SSH for process management.

**Cost as a design principle.** Fleet's planning layer splits tasks by model tier
(cheap, standard, premium) and groups consecutive same-tier tasks into streaks to
minimize expensive model switches. The PM prefers execute_command over execute_prompt
wherever possible, spending zero LLM tokens on deterministic operations. The playbook
and runbook model amortizes exploration cost over repeated executions of the same
task class.

**Self-hostable with identical protocol.** The same codebase that runs at
fleets.apralabs.com can be self-hosted on an organization's own infrastructure.
Members connect to the self-hosted instance using the same protocol. There is no
feature difference between the hosted and self-hosted deployments.

### The economic alignment argument

Most AI platforms are priced per token or per compute unit consumed. This creates a
structural tension: the platform benefits from more consumption, while the customer
benefits from less. A platform with this pricing model has limited incentive to
optimize for token efficiency or to route work to cheaper models when they are
sufficient.

Fleet's design makes cost discipline a first-class concern at the architecture level:
tier routing, execute_command preference, playbook amortization, and context management
are built into the orchestration layer, not left to the user to implement. Fleet's
business model is intended to be outcome-based (per seat or per result) rather than
consumption-based, which aligns fleet's incentives with the customer's.

### What fleet is not optimized for

Fleet is designed for software development and engineering workflows running on real
machines. It is not a general-purpose cloud compute platform, a streaming media
processor, or a real-time inference service. Workloads that require millisecond
latency, GPU-intensive inference, or stateless horizontal scaling are better served
by infrastructure designed for those requirements.

---

## 3. The Omnipresent Fleet Server (fleets.apralabs.com)

### Role

fleets.apralabs.com is a permanently-running cloud MCP server. It is the hub that all
members and PMs connect to. It is not tied to any single machine, project, or user
session. When a member's machine reboots and Claude restarts, the member connects back
to the same fleets.apralabs.com instance and picks up where it left off. When the PM's
machine sleeps, the fleet server remains reachable for other members.

### Internal structure

The fleet server extends `createHttpTransport()` (`src/services/http-transport.ts`) with
seven additional subsystems:

**MCP HTTP+SSE server.** The existing transport implementation becomes the protocol
foundation. The per-session McpServer model (one McpServer instance per connected client)
already enforces session isolation. Multi-tenancy adds a project-scoping layer above it.

**Tenant registry.** Persistent store of projects and their members. Survives server
restarts. Each project is a namespace: its members, credentials, and event bus are
fully isolated from other projects. The registry tracks member definitions (name, type,
capabilities, role) independently of session state.

**Member session registry.** Volatile layer tracking which members are currently
connected. States: `online` (connected, idle), `busy` (connected, executing a task),
`awaiting_human` (connected, blocked on fleet_request_human), `offline` (not connected).
The registry is rebuilt from announce_self calls on server restart. Members that do not
reconnect within a configurable grace period are marked offline.

**Event bus.** Project-scoped pub/sub. Routes messages between PM sessions and member
sessions within the same project. Messages cannot cross project boundaries -- the
routing layer enforces this at the data structure level. This extends the existing
`fleetEvents` mechanism (`src/services/event-bus.ts`) which already carries
`credential:stored`, `task:completed`, `member:status-changed`, and `stall:detected`
events within a local server.

**Credential vault.** Encrypted per-project store for LLM tokens, VCS tokens, and SSH
keys. Each credential is encrypted under a per-project key. The per-project key is
wrapped by the fleet server's HSM/KMS master key. Credentials are never stored
in plaintext anywhere in the system and are never logged.

**Audit log.** Every tool call, every message, every session event -- immutable
append-only. The audit log is the authoritative record for compliance, incident
investigation, and cost accounting. It cannot be modified after the fact.

**Auth layer.** Four-layer authentication covering fleet access, LLM provider auth,
VCS auth, and member-to-member auth. Described in Section 9.

### Multi-tenancy model

Each project is a fully isolated namespace. The project boundary is enforced at every
MCP tool handler: each request carries a session JWT that encodes the project_id, and
every handler validates the project_id before accessing the tenant registry, event bus,
or credential vault. Projects cannot see each other's members, messages, or credentials.

A member belongs to exactly one project. A member cannot claim membership in multiple
projects within a single session. A PM is a special member role within a project --
it is itself a fleet MCP client with elevated permissions to send messages and read
the member session registry.

### Hosted vs. self-hosted

fleets.apralabs.com is the Apra Labs hosted instance. Organizations with air-gapped
environments or data sovereignty requirements can self-host their own fleet server.
The self-hosted instance runs the same codebase and implements the identical protocol.
Members and PMs connect to the self-hosted URL instead of fleets.apralabs.com. No
code changes are required on members for self-hosted deployments -- only the server URL
changes.

---

## 4. Project and Member Model

### Hierarchy

```
fleets.apralabs.com
+-- project: apra-fleet
|   +-- member: fleet-dev          (Claude, interactive, local Windows)
|   +-- member: fleet-dev2         (AGY, -p mode or interactive, local Windows)
|   +-- member: fleet-rev          (Claude, interactive, macOS)
|   +-- member: fleet-ci           (no-LLM, Linux CI runner)
|   +-- PM: orchestrator           (Claude, dispatches to the above)
+-- project: customer-core
|   +-- member: bb-dev1            (Claude, cloud VM)
|   +-- member: bb-dev2            (AGY, on-prem)
|   +-- PM: orchestrator
+-- project: customer-xyz
    ...
```

This hierarchy extends the existing two-level model (fleet -> members) with a project
isolation layer above it. The existing `Agent` type (`src/types.ts`) carries the
per-member fields; the cloud model adds a `projectId` and `role` field to distinguish
PM from doer/reviewer members.

### Member types

**LLM-Claude.** Supports two dispatch paths: (a) interactive mode -- `claude` with no
`-p` flag, MCP config pointing to fleets.apralabs.com/<project-id>, tasks received via
SSE message injection, hooks configured by the fleet installer (see Section 7); and
(b) SSH+`-p` mode -- the existing `ClaudeProvider.buildPromptCommand()` subprocess
dispatch. The interactive path is preferred starting 2026-06-15 (lower per-task cost
at scale, bidirectional communication, persistent session state). The SSH+`-p` path
remains available as an alternative for short one-shot tasks, simpler environments,
or cost/complexity tradeoffs.

**LLM-AGY.** Supports two dispatch paths: (a) interactive mode -- `agy` with MCP config
pointing to fleets.apralabs.com/<project-id>, tasks received via SSE message injection,
same interactive model as Claude; and (b) SSH+`-p` mode -- the existing
`AgyProvider.buildPromptCommand()` (`src/providers/agy.ts:50`) which produces
`agy -p "<instruction>"` over SSH. The interactive path is architecturally preferred
(cleaner, bidirectional, no transcript reader needed). The SSH+`-p` path remains fully
supported as an alternative. There is no pricing deadline pressure on AGY's `-p` path.

**LLM-Gemini.** Same pattern as AGY. The `-p` path continues to work. Interactive
mode is a future option.

**No-LLM.** No AI model running. The fleet-service daemon (the existing apra-fleet
binary in service mode) is installed on the machine and connects outbound to
fleets.apralabs.com at startup. Only `execute_command` is available. Useful for build
servers, test runners, CI machines, and database servers where AI decision-making is
not needed. Described in detail in Section 11.

### PM as a member

PM is itself a member of the project -- a Claude or AGY session with the `pm` role.
The PM session connects to fleet MCP and uses fleet tools (send_message, execute_command,
send_files, etc.) to orchestrate other members. The PM is not external to the fleet --
it is inside it, with elevated permissions. This makes PM orchestration auditable:
every PM tool call goes through the audit log, and every message PM sends to a member
is routed through the event bus with a verifiable sender identity.

---

## 5. Process Lifecycle Management

The HTTP+SSE interactive session model (Section 6) is the data plane: it carries task
dispatch, prompt injection, and response delivery. Process lifecycle is a separate
concern handled by the control plane. These two planes are orthogonal -- an interactive
session cannot exist until a process is running, and the process can be managed
independently of any active session.

### The two-plane model

**Control plane (SSH + execute_command).** Responsible for starting, stopping,
restarting, and monitoring the LLM process (`claude`, `agy`, `gemini`) on the member
machine. This is the existing fleet capability -- SSH-based `execute_command` already
handles remote process management. No new infrastructure is needed for this plane.

**Data plane (HTTP+SSE).** Responsible for delivering task prompts to a running session
and receiving responses. Requires the LLM process to already be running and connected
to the fleet MCP server.

The fleet server coordinates both planes but does not collapse them. Process lifecycle
events (crash detected, restart needed, update available) come in on the control plane
and may trigger data plane actions (re-announce, re-deliver pending message). Data plane
events (session idle too long, behavioral contract violation) may trigger control plane
actions (kill and restart the process).

### Launching member processes

**Local members.** The fleet installer registers a per-user service (using the service
manager built in `src/services/service-manager/`) that starts the LLM process on login.
On Windows this is a Scheduled Task; on Linux a systemd --user unit; on macOS a
LaunchAgent plist. The service manager already exists from the apra-fleet-svc sprint
(`src/services/service-manager/windows.ts`, `linux.ts`, `macos.ts`).

**Remote members.** SSH `execute_command` launches the LLM process on the remote
machine. This is no different from any other remote command fleet already runs:

```
execute_command: ssh <member> "cd <workFolder> && claude &"
```

For the interactive session model, `claude` starts with no `-p` flag and its MCP config
already points to the fleet server (configured by the installer). The process daemonizes
(or runs in a screen/tmux session) so it survives the SSH session ending.

Fleet's `register_member` and install flows can be extended to optionally launch the
process after installation. The launch is a single `execute_command` -- no new
infrastructure required.

### /clear and /resume

These scenarios are process restart operations, not protocol operations.

**/clear** (fresh context, drop conversation history):
Kill the current process and relaunch without `--resume`. In fleet terms:

```
execute_command: pkill -f "claude"  (or equivalent for agy/gemini)
execute_command: cd <workFolder> && claude &
```

The member's interactive session reconnects to fleet MCP, calls `announce_self`, and
fleet treats it as a fresh session. PM can trigger this via a new fleet tool:
`fleet_restart_member(member_name, clear=true)`.

**/resume** (reconnect to a previous conversation):
Kill and relaunch with `--resume <sessionId>`:

```
execute_command: pkill -f "claude"
execute_command: cd <workFolder> && claude --resume <sessionId> &
```

The `sessionId` is stored in the fleet member registry. PM can trigger this via
`fleet_restart_member(member_name, resume_session_id=<id>)`.

**Magical /clear via SSE (future option).** Instead of killing the process, inject a
special fleet message into the running session that causes it to summarize completed
work, discard conversation history, and continue from the summary. This avoids the
reconnect latency of a full process restart. Requires Claude to support context-window
reset without process exit -- not currently available, but worth building as
`fleet_clear_context` tool if it becomes possible. For now, kill and relaunch is the
reliable path.

### Crash recovery

**Graceful exit (Stop hook fires).** When the LLM process exits cleanly, the Stop hook
calls fleet to mark the member offline and deliver any pending response. Fleet marks
the member offline in the session registry. PM is notified via the event bus.

**Ungraceful crash (Stop hook does not fire).** Fleet detects the crash via SSE
connection drop -- the HTTP+SSE connection from the member's process closes. Fleet marks
the member offline immediately and notifies PM. No polling required; the SSE disconnect
is instantaneous.

Auto-restart policy is configurable per member: `none` (PM decides), `immediate` (fleet
triggers `execute_command` restart automatically), or `backoff` (fleet retries with
exponential delay up to N attempts). Auto-restart uses the same SSH `execute_command`
path as a manual restart.

### Updates

When a new `claude`/`agy`/`gemini` binary is available:

1. Fleet sends `update_llm_cli` command to the member (existing tool in
   `src/tools/update-member.ts`).
2. `update_llm_cli` downloads and installs the new binary via `execute_command`.
3. Fleet kills the current process (`execute_command: pkill`).
4. Fleet relaunches the process (`execute_command: cd <workFolder> && claude &`).
5. The new process connects to fleet MCP and announces itself.

The existing `update_llm_cli` tool handles steps 1-2. Steps 3-5 are a
`fleet_restart_member` call. No changes to the update flow beyond adding the restart
step.

### The beyond-SSH future

SSH handles the control plane today and will continue to do so for all reachable
members. The beyond-SSH requirement arises only when a member machine cannot accept
inbound SSH connections (NAT, corporate firewall, cloud VM without public IP).

For those cases, the no-LLM fleet-service daemon (Section 11) is the answer. The daemon
connects outbound to fleet and can execute process lifecycle commands on behalf of fleet:
start the LLM process, kill it, restart it, check its status. The daemon is the SSH
replacement for control plane operations on unreachable machines -- same operations,
different transport.

Until a genuine beyond-SSH requirement appears in production, SSH `execute_command`
remains the control plane transport. Do not over-engineer this.

---

## 6. How Interactive Sessions Complement claude -p

### Current mechanism (SSH+claude -p path, preserved as alternative)

`executePrompt()` (`src/tools/execute-prompt.ts:123`) builds a shell command via
`ClaudeProvider.buildPromptCommand()`, which produces:

```
cd "<workFolder>" && claude -p "<instruction>" --output-format json --max-turns <n> [--resume <sessionId>]
```

Fleet spawns this via the member strategy (SSH for remote, child_process for local),
captures stdout as JSONL, and parses the result with `ClaudeProvider.parseResponse()`.
The process exits when the task completes. Session state is persisted via the
`sessionId` field in the member registry, which is passed as `--resume` on the next
call.

### New mechanism (Claude interactive path)

**Step 1 -- Member starts an interactive Claude session.**
The fleet installer configures the member's Claude to run in interactive mode with
an MCP server entry pointing to fleets.apralabs.com/<project-id>. The member runs
`claude` (no `-p`), which connects to fleet MCP on startup. This connection uses the
existing HTTP+SSE protocol in `src/services/http-transport.ts`.

**Step 2 -- Claude's hooks are configured.**
The installer writes hook definitions for `PreToolUse`, `PostToolUse`, `Stop`,
`Notification`, and `UserPromptSubmit` events into the member's Claude settings. These
hooks are the behavioral contract between the autonomous session and fleet (see Section 7).

**Step 3 -- Announce self.**
Claude's MCP client calls `announce_self(member_name, role, capabilities)` via fleet's
MCP tool interface. Fleet registers the session as online in the member session registry.

**Step 4 -- PM dispatches a task.**
PM calls `send_message(to=member_name, type=task, content=<prompt>, reply_to=pm_session_id)`.
Fleet validates the sender's PM role, routes the message to the member's SSE channel,
and queues it in the member's message queue in case delivery fails.

**Step 5 -- UserPromptSubmit hook fires.**
Fleet delivers the message via SSE notification to the member's connected Claude session.
Claude's `UserPromptSubmit` hook fires with the injected prompt. The hook validates the
message signature (fleet signs messages with a project key, the hook verifies) and
optionally prepends runtime context (project, branch, task ID) before Claude sees it.

**Step 6 -- Claude executes.**
Claude runs the task using its normal tool suite. Every tool call triggers the
`PreToolUse` hook (audit logging, risk interception) and `PostToolUse` hook (duration,
token usage). There is no subprocess PID to manage and no stall detector watching a
log file -- the session is a long-lived interactive process.

**Step 7 -- Response delivery.**
When done, Claude calls `send_message(type=response, content=<summary>, reply_to=original_msgid)`.
Fleet routes the response to the PM session's SSE channel. PM receives it and continues
orchestration.

**Step 8 -- Stop hook.**
When Claude's session ends (timeout, explicit stop, or crash), the `Stop` hook fires.
It calls fleet to mark the member offline and flush any pending response to PM. If the
session ended with an error, fleet marks it as failed and notifies PM via the event bus.

### Session resumption

When Claude restarts and reconnects to fleet, it calls `announce_self` again. Fleet
matches the `member_name` to the existing registration. If there is a pending message
(PM dispatched while the member was offline), fleet delivers it immediately on
reconnect. Session history is maintained by Claude's own conversation file (as today),
not by fleet. Fleet's role is message routing, not conversation storage.

### execute_prompt compatibility

`execute_prompt` continues to exist as the PM-facing API. For Claude members in the
cloud model, `execute_prompt` routes via `send_message` + wait-for-response instead of
spawning a subprocess. The PM-facing API is identical -- the routing difference is
entirely internal to the fleet tool handler. This preserves backward compatibility
for all PM skills and prompt templates.

### AGY and the dual-path model

For AGY members, `execute_prompt` supports both paths. The SSH+`-p` path uses
`AgyProvider.buildPromptCommand()` which produces `agy -p "<instruction>"`, with the
transcript reader script (`agy-transcript-reader.js`) capturing output. The interactive
path uses the same SSE-based routing as Claude: `execute_prompt` routes via
`send_message` + wait-for-response over the member's SSE channel. The interactive path
is the preferred direction for AGY (architecturally cleaner, no transcript reader
needed), but the SSH+`-p` path remains fully supported as an alternative.

The `claude -p` subprocess path for Claude is similarly preserved as an alternative.
For Claude members, the interactive path is the cost-preferred option at scale; `claude -p`
remains valid for short one-shot tasks or environments where interactive session
management is not worth the overhead.

---

## 7. Hooks as the Control Plane

Hooks are shell commands that fire at specific points in a Claude session. The fleet
installer writes hook definitions into the member's Claude settings during member
registration. These hooks are the behavioral contract between the autonomous session
and the fleet server. Every hook call goes through fleet -- fleet is the enforcement
point, not the member's local configuration.

### UserPromptSubmit hook

Fires when a new prompt arrives at the Claude session.

Fleet uses this hook to validate that the prompt came from a legitimate fleet message
and not from an injection attack. The hook calls a fleet CLI tool (`fleet validate-prompt`)
that checks the message signature against the project key. If validation fails, the hook
rejects the prompt and fleet logs the attempt to the audit trail.

On successful validation, the hook optionally prepends runtime context to the prompt:
the project name, the current branch, the task ID from the originating `send_message`
call. The member's Claude sees an enriched prompt without PM having to manually include
this boilerplate in every dispatch.

### PreToolUse hook

Fires before every tool call (Bash, Edit, Write, Read, Grep, and so on).

This hook has two functions: audit logging and risk interception.

Audit logging: every tool call is recorded to the immutable audit trail with the tool
name, arguments, calling member, and timestamp. This happens regardless of whether the
call is approved or blocked.

Risk interception: the hook classifies the operation and applies policy:

- LOW risk (read-only operations, creating new files, local git commits, running tests):
  auto-approved, logged.
- MEDIUM risk (modifying existing files, installing packages, creating branches):
  auto-approved, logged.
- HIGH risk (deleting files, force operations, pushing to shared branches, modifying
  config): fleet `risk_check` required. Fleet evaluates the operation against project
  policy and either approves, blocks, or escalates.
- CRITICAL risk (dropping databases, production deployments, force-pushing to main,
  credential operations): `fleet_request_human` required. No auto-approval possible.

The hook implementation calls fleet's risk API synchronously -- Claude waits for the
verdict before the tool call proceeds. For LOW and MEDIUM operations, the round-trip
is negligible. For HIGH and CRITICAL operations, latency is intentional: these are
operations that warrant scrutiny.

### PostToolUse hook

Fires after every tool call completes.

Captures: tool name, duration in milliseconds, success/failure status, and output size.
This data feeds two consumers: cost accounting (token usage per tool call per member)
and the fleet observability dashboard.

The `member:status-changed` and `task:completed` events on the existing event bus
(`src/services/event-bus.ts`) continue to function via this hook.

### Stop hook

Fires when the Claude session ends for any reason: clean exit, `stop_prompt` cancellation,
timeout, or crash.

The hook calls fleet to:
1. Mark the member as offline in the session registry.
2. Deliver any pending response to PM (if Claude completed a task but did not call
   `send_message` before stopping, the hook reads Claude's last output from the
   conversation log and delivers it).
3. Flush the audit log buffer to durable storage.

If the session ended with an error (non-zero exit, crash signal), fleet marks the
session as `failed` and emits a `member:status-changed` event on the project event bus.
PM receives this via its SSE channel and can decide whether to retry, escalate, or
abandon the task.

### Notification hook

Fires when Claude wants to surface a notification to the user.

In a local interactive session, notifications appear in the terminal. In an unattended
fleet member, "the user" is the PM. The hook intercepts the notification and routes
it to PM via fleet's `send_message` with `type=notification`. PM receives it on its
SSE channel.

This is how member warnings and progress updates surface to humans during long-running
tasks without blocking on stdin. It is the non-blocking complement to `fleet_request_human`.

---

## 8. The fleet_request_human Tool

`fleet_request_human` is a new fleet MCP tool that enables selective human escalation
from any autonomous member session. It is the bridge between fully autonomous operation
and the rare case where a human decision is genuinely required.

### Invocation

A member session calls:

```
fleet_request_human(
  question: string,
  context: string,
  risk_level: "high" | "critical",
  options: string[]
)
```

`question` is the specific decision needed. `context` is the relevant state (what the
member was doing, what it found, what it was about to do). `options` is a list of
suggested choices the human can select from. `risk_level` is the member's assessment
of why human input is needed.

### Escalation flow

1. Fleet marks the member session as `awaiting_human` in the session registry.
2. Fleet broadcasts a `human_input_required` event on the project event bus.
3. PM session receives the event via its SSE channel.
4. PM surfaces the question to the human -- either via PM's own interactive terminal
   session, or via a configured notification channel (Slack, email, etc.).
5. Human types a response into the PM session.
6. PM calls `fleet_respond_human(session_id, answer)`.
7. Fleet injects the answer into the waiting member session via `UserPromptSubmit`.
8. `fleet_request_human` returns with the human's answer. The member session resumes.

### Session isolation during wait

The member session that called `fleet_request_human` is paused. Other member sessions
in the same project continue running unaffected. PM continues to orchestrate other
members. Only the one session waiting on human input is blocked -- and only that
session's execution thread is blocked, not the fleet server process.

### Timeout behavior

If no human response arrives within the configured timeout (default: 30 minutes, PM can
override per-project), `fleet_request_human` returns a structured timeout response:

```json
{
  "timed_out": true,
  "message": "No human response within 30 minutes. Proceed with the most conservative option."
}
```

The member's behavioral contract (Section 10, Rule 6) defines what to do on timeout:
abort the risky operation, document what was blocked, stop cleanly. The session does
not crash -- it receives the timeout response and executes the abort path.

---

## 9. Auth Architecture

The cloud fleet server requires four distinct auth layers. Each layer is independent --
a credential that grants access at one layer does not grant access at another.

### Layer 1 -- Fleet server auth

Controls who can connect to fleets.apralabs.com.

**Project API key.** Issued per project at creation time. Used by no-LLM members and
CI machines that authenticate without an OAuth flow. Long-lived but revocable. Scoped
to a single project.

**Member OAuth token.** Issued per member via an OAuth flow at registration. Fleet
validates the token on every MCP `initialize` request (the first POST to `/mcp` in
the existing `http-transport.ts` flow). Token refresh is handled transparently by the
fleet client library installed on the member.

**Session JWT.** Issued by fleet when `announce_self` completes. Short-lived (1 hour),
auto-refreshed by the fleet client library. Encodes: `member_id`, `project_id`, `role`,
`issued_at`, `expires_at`. Every subsequent MCP tool call within the session carries
this JWT. The tool handler validates the JWT before executing, ensuring that a member
cannot call tools for a different project or impersonate a different role.

**PM auth.** PM members have elevated tokens that grant access to `send_message`,
`fleet_respond_human`, and fleet management tools. PM elevation is assigned at project
configuration time, not claimed by the member (see Layer 4).

### Layer 2 -- LLM provider auth

Controls the member's AI model credentials.

**Claude.** `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` stored in the fleet
credential vault. Delivered to the member machine at session start via an encrypted
channel. The member stores the credential in its local environment for the session
duration. At session end (Stop hook), the injected credential is removed from the
environment.

**AGY.** `ANTIGRAVITY_API_KEY`, same vault-and-inject pattern. AGY's OAuth credentials
(`~/.gemini/oauth_creds.json`, `~/.gemini/google_accounts.json`) can also be vaulted
and delivered, matching the existing `AgyProvider.oauthCredentialFiles()` paths.

**Gemini.** OAuth credentials, same vault-and-inject pattern.

**Vault encryption.** Each credential is encrypted with a derived key. The derived key
is wrapped by a per-project master key. The per-project master key is wrapped by the
fleet server's HSM or cloud KMS master key. This is envelope encryption: compromising
one layer does not expose the layer above it.

**provision_llm_auth workflow.** PM calls `provision_llm_auth` -> fleet vaults the
credential under the project's encryption key -> fleet delivers the credential to the
member via an encrypted channel at the member's next session start. Fleet never logs
LLM credentials. The credential is only decrypted on the member machine, at session
start, in memory.

### Layer 3 -- VCS auth

Controls git access for code operations.

**SSH key pair.** Fleet generates a key pair on behalf of the member. The public key
is registered with GitHub/GitLab (via the GitHub App or manual upload). The private
key is stored in the fleet vault. At session start, fleet delivers the private key to
the member machine via encrypted channel; at session end, the Stop hook removes it.

**Personal access token.** User-provided, vaulted per member. Delivered at session
start, removed at session end.

**GitHub App.** For organization-wide VCS auth, fleet registers as a GitHub App per
organization. This enables scoped, revocable, per-repo access without sharing personal
tokens.

**provision_vcs_auth workflow.** Same vault-and-deliver pattern as LLM auth. Ephemeral
injection: VCS credentials exist on the member machine only while the session is active.

### Layer 4 -- Member-to-member auth

Controls PM dispatching to members.

PM cannot directly invoke tool calls on a member. It can only call `send_message`.
`send_message` validates that the sender's session JWT carries the `pm` role in the
current project. The member's `fleet_request_human` and response tools validate the
sender identity on every call.

No member can impersonate another member. Session JWTs are member-bound: the `member_id`
in the JWT is set at `announce_self` time from the member's registered identity, not
from the member's claim. Fleet validates the `member_id` against the tenant registry
before issuing the JWT.

No member can claim the PM role. The PM role is assigned in the tenant registry at
project configuration time by an administrator. The `announce_self` call cannot request
a role elevation -- role is looked up from the registry, not from the session's claim.

---

## 10. The "Almost Never Ask" Behavioral Contract

Autonomous remote sessions run without a human on stdin. The behavioral contract baked
into agent definitions (`vendor/apra-pm/agents/doer.md`, `vendor/apra-pm/agents/reviewer.md`,
`vendor/apra-pm/agents/planner.md`, `vendor/apra-pm/agents/plan-reviewer.md`) addresses the
tension between autonomy and safety.

The core principle: questions are expensive. A question blocks the session, interrupts
PM, and surfaces to a human who may not be available. An autonomous session must make
decisions, not ask questions.

### Rules for autonomous sessions

**Rule 1 -- No clarifying questions.** Make a reasonable, conservative assumption. State
the assumption at the start of the response. Proceed. The assumption is visible in the
audit log and in the response delivered to PM. If the assumption was wrong, PM can
correct it on the next dispatch.

**Rule 2 -- Choose the most reversible option.** When multiple valid approaches exist,
choose the one that is easiest to undo. Document the alternatives considered and why
this one was chosen. Prefer creating a new file over modifying an existing one.
Prefer a new branch over pushing to an existing branch.

**Rule 3 -- 80% confidence is enough.** Proceed when 80% confident and flag the
uncertainty in the response. Do not wait for 100% confidence -- 100% confidence is
rarely achievable and always expensive. The reviewer role exists to catch mistakes that
slip through at 80% confidence.

**Rule 4 -- Hard blockers are facts, not questions.** If a prerequisite is missing (file
not found, broken environment, auth failure, missing dependency): state the blocker as
a fact. Do NOT phrase it as a question. Stop cleanly. Fleet's Stop hook delivers the
blocker description to PM via the event bus. PM decides the next step.

**Rule 5 -- High-risk operations go to fleet_request_human.** Do not proceed with
CRITICAL risk operations and do not ask on stdin. Call `fleet_request_human` with a
description of the risk, what the session was about to do, and a recommendation. Wait
for the response or the timeout.

**Rule 6 -- Timeout means abort.** If `fleet_request_human` times out with no human
response, abort the risky operation. Document what was blocked and why. Stop cleanly.
Do not attempt the risky operation unilaterally.

### Risk classification

This classification applies both to the `PreToolUse` hook (automated enforcement) and
to the agent's own judgment when deciding whether to call `fleet_request_human`.

| Level | Examples | Policy |
|-------|----------|--------|
| LOW | read-only operations, creating new files, local git commits, running tests | auto-approve + audit log |
| MEDIUM | modifying existing files, installing packages, creating branches | auto-approve + audit log |
| HIGH | deleting files, force operations, pushing to shared branches, modifying config | fleet risk_check required |
| CRITICAL | dropping databases, production deployments, force-pushing to main, credential operations | fleet_request_human required, no auto-approval |

---

## 11. No-LLM Members

Not every fleet member needs an AI model. No-LLM members are pure execution workers --
they run commands, produce output, and return results. They are ideal for deterministic
workloads where LLM decision-making adds cost without value.

### Use cases

- CI runner: runs test suites, returns pass/fail output.
- Build server: compiles binaries, produces artifacts.
- Database server: runs migrations, queries, backups.
- IoT/edge device: executes scripts, reports sensor data.
- Staging environment: PM drives deployments entirely via `execute_command`.
- Code quality server: runs linters, formatters, and static analysis on pushed branches.

### How they work

The fleet-service daemon -- the existing apra-fleet binary in service mode -- is
installed on the machine. The daemon connects outbound to fleets.apralabs.com at startup
and authenticates with the project API key (no LLM auth needed). No SSH inbound is
required -- the daemon initiates the connection.

PM dispatches `execute_command` calls to the no-LLM member. The daemon executes the
command in the member's work folder and returns output. Files flow via the fleet file
relay (`send_files` / `receive_files`). No announce_self call -- the daemon is always
online as long as the service is running. The member session registry shows the member
as `online` whenever the daemon is connected.

### Permissions and auth

No-LLM members authenticate with a project API key only. No LLM credentials. VCS
credentials are optional -- only if the machine needs git access for its work.

No-LLM members have a restricted tool set by default: `execute_command` only. PM can
extend the tool set via `compose_permissions` for members that need file operations
or specific shell capabilities. The `execute_command` allowlist (commands the daemon
will accept) is configured per-member via `compose_permissions` and enforced by a local
policy check before execution -- analogous to the `PreToolUse` hook for LLM members.

API keys have machine-scoped permissions. A key issued for `fleet-ci` cannot be used
to send commands to `fleet-dev`. This prevents an attacker who compromises a CI
machine's API key from gaining access to other members.

---

## 12. Operations Carried Forward (Semantics Preserved)

All current fleet capabilities are preserved in the cloud model. The PM-facing tool API
is unchanged. Routing and delivery mechanisms differ internally for Claude members;
everything else is identical.

### compose_permissions

PM composes a permission set before dispatching. In the cloud model, the permission set
is sent as metadata with the task message. The member's `PreToolUse` hook enforces it
at execution time. Hooks are the policy enforcement point -- the hook reads the
permission set from the message metadata and applies it before every tool call. The
existing `compose_permissions` tool API is unchanged.

### send_files / receive_files

Files are transferred via fleet's file relay (S3-backed or direct encrypted channel).
Source and destination members both connect to fleet; fleet brokers the transfer. No
direct SSH file copy is required. For local members, the relay uses the existing local
file system path. The `substitutions` parameter (Task 1, requirements.md) continues to
work -- substitution happens inside the fleet tool handler before the file is sent to
the relay.

### credential_store_set / credential_store_get

The credential store API is unchanged. The backend is now the fleet vault instead of
the local encrypted file at `~/.apra-fleet/data/`. The `credential:stored` SSE event
already implemented in the event bus continues to deliver notifications to connected
clients when a credential is vaulted.

### execute_prompt

For AGY and Gemini members, semantics are unchanged: SSH-based dispatch via
`AgyProvider.buildPromptCommand()` and the transcript reader. For Claude members in the
cloud model, `execute_prompt` routes via `send_message` + wait-for-response over the
member's SSE channel. The PM-facing parameters (`prompt`, `resume`, `timeout_s`,
`max_total_s`, `model`, `substitutions`, `agent`) are identical. The internal routing
difference is transparent to PM.

### monitor_task / stop_prompt

For interactive Claude sessions, `stop_prompt` sends a cancel message to the member
via the SSE channel. The member's Claude session handles it: either the session
processes the cancel message between tool calls, or the Stop hook fires on a forced
termination. PM can still call `monitor_task` to poll the member's current status from
the session registry.

### member_detail / fleet_status

These tools read from the cloud session registry instead of the local state file. The
output format is unchanged. For no-LLM members, connectivity status reflects daemon
connection state rather than SSH reachability.

---

## 13. Risks and Mitigations

### R1 -- fleets.apralabs.com is a single point of failure

**Impact.** If fleets.apralabs.com goes down, all active member sessions lose their
dispatch channel. No-LLM member daemons stop accepting commands. PM cannot reach any
member.

**Mitigations.**
(a) Self-hosted fleet for critical workloads. Organizations can run their own instance
and avoid the hosted service dependency.
(b) Offline queue. Members that lose fleet connectivity can continue executing the
current task and re-sync with fleet when the connection is restored. The task being
executed was already delivered before the outage.
(c) HA deployment. fleets.apralabs.com runs in an active-passive or active-active
configuration. SSE connections use sticky sessions (connection to the same server
instance) so reconnects land on the same server and pick up the session JWT.

### R2 -- Multi-tenant isolation breach

**Impact.** Project A reads project B's messages, credentials, or member sessions.

**Mitigations.**
(a) Project namespace enforced at every MCP tool handler. The session JWT carries
`project_id`; every handler validates it before accessing any registry, event bus, or
vault operation.
(b) Event bus is project-scoped. There is no cross-project routing path in the protocol.
A message addressed to project A's event bus cannot be delivered to project B.
(c) Credential vault uses per-project encryption keys. Compromising one project's vault
key does not expose other projects' credentials.
(d) Penetration testing before any external customer onboarding.

### R3 -- Credential vault breach

**Impact.** All LLM API keys, VCS tokens, and SSH keys for all projects are exposed.

**Mitigations.**
(a) Credentials encrypted at rest with per-project keys. The database stores only
ciphertext.
(b) Per-project keys wrapped by HSM/KMS master key. The master key never leaves the
HSM. Auditing the HSM access log is part of the incident response plan.
(c) Credential access logged to the immutable audit trail. Every decryption event is
recorded with member identity and timestamp.
(d) Short-lived delivery tokens. Credentials are delivered to members via time-limited
tokens, not as plaintext in a response body.
(e) Credential rotation support. If a credential is suspected compromised, it can be
revoked in the vault and re-provisioned without changing the member's registered
configuration.

### R4 -- SSE injection attack

**Impact.** An attacker injects a crafted prompt into a member session, causing the
member to execute malicious commands.

**Mitigations.**
(a) `UserPromptSubmit` hook validates the message signature. Fleet signs every message
with a per-project key. The hook verifies the signature before Claude sees the prompt.
An unsigned or forged message is rejected and logged.
(b) Messages include sender identity. The sender must have the `pm` role in the same
project. A message from an unknown sender or a member without PM role is rejected.
(c) Audit log captures every injected prompt with full provenance: sender, timestamp,
message ID, project ID.

### R5 -- Member behavioral drift

**Impact.** Autonomous sessions ask questions at a rate that overwhelms the human
on the PM end (`fleet_request_human` storms).

**Mitigations.**
(a) `fleet_request_human` rate limit per member per session. A member that calls
`fleet_request_human` more than N times per session has its escalations queued and
batched.
(b) PM can configure `auto-deny` mode per project. In this mode, `fleet_request_human`
returns `proceed-conservative` without surfacing to a human. Useful for low-oversight
batch workloads.
(c) Behavioral contract violations are logged. Post-session review can identify members
that are not adhering to the "almost never ask" contract and trigger agent file updates.

### R6 -- Long-running SSE connection instability

**Impact.** A member session loses its fleet connection mid-task. Task state is lost.

**Mitigations.**
(a) SSE reconnect with exponential backoff. The fleet client library (installed on the
member by the fleet installer) reconnects automatically on connection loss.
(b) Fleet maintains a message queue per member. In-flight messages (delivered but not
acknowledged) are re-delivered on reconnect.
(c) Session checkpoint mechanism. Members can call `fleet_checkpoint(progress_summary)`
at VERIFY points in the task. If the session disconnects and resumes, fleet delivers the
last checkpoint as context. Work completed before the disconnect is not re-done.

### R7 -- AGY -p restriction in the future

**Impact.** Antigravity restricts `agy -p`, eliminating AGY's current dispatch path.

**Mitigations.**
(a) AGY already connects to fleet MCP using the same HTTP+SSE transport as Claude.
(b) The interactive session model is provider-agnostic. Applying it to AGY requires
adding an `announce_self` call and hook configuration -- no protocol changes.
(c) The behavioral contract and hook system work identically for AGY if the AGY CLI
gains hook support equivalent to Claude Code's hook system.

### R8 -- No-LLM member compromised

**Impact.** An attacker who obtains a no-LLM member's project API key can execute
arbitrary commands on that machine.

**Mitigations.**
(a) `execute_command` allowlists configured via `compose_permissions`. The daemon
rejects commands outside the allowlist.
(b) Local policy check before every `execute_command`. Analogous to `PreToolUse` hook
for LLM members.
(c) API keys are machine-scoped. A key for `fleet-ci` cannot issue commands to
`fleet-dev1`.

### R9 -- Cost explosion

**Impact.** PM drives many members simultaneously; API token costs mount unexpectedly.

**Mitigations.**
(a) Per-project token budget configured in fleet. Dispatch is rejected when the budget
is exhausted.
(b) `PreToolUse` and `PostToolUse` hooks capture per-task token usage. The audit log
provides a per-task cost breakdown.
(c) Fleet exposes a `cost_per_task` metric in the observability API.
(d) PM behavioral guidance: tier-streak dispatch (grouping consecutive same-tier tasks)
already minimizes model-switching overhead. The PM agent can be instructed with an
explicit token budget.

### R10 -- Session identity spoofing

**Impact.** A malicious member claims to be PM and issues commands to real members.

**Mitigations.**
(a) PM role is assigned in the tenant registry at project configuration time by an
administrator -- it is not claimed by the member.
(b) Fleet validates the role from the member's registered profile in the tenant registry,
not from any claim made in the `announce_self` call.
(c) `announce_self` sets the `member_name` only. Role is looked up from the registry.
A member cannot request a role elevation via any fleet API.

---

## 14. Migration Path from Current Model

Migration is phased so that no capability is lost before a replacement is ready, and
so that the mandatory change (Claude `-p` restriction) is addressed before its deadline.

### Phase 1 -- Now (current sprint)

The current model is unchanged for AGY and Gemini. Claude members can optionally use
the interactive session model as an opt-in -- the installer configures MCP connection
and hooks, but `execute_prompt` still works in subprocess mode as a fallback.
fleets.apralabs.com is not required. The local fleet server at `127.0.0.1:7523` remains
the default. Task 6 in this sprint validates the interactive session path end-to-end
on at least one Claude member.

### Phase 2 -- Before 2026-06-15

Interactive sessions become the production-ready default for Claude members.
`execute_prompt` for Claude routes via `send_message` + wait-for-response on the local
fleet server. The subprocess path (`ClaudeProvider.buildPromptCommand()` with `-p`)
remains available as a supported alternative -- it is not removed. Both paths coexist:
the interactive path is preferred for cost and capability reasons; the SSH+`-p` path
is retained for short one-shot tasks, simpler environments, or cases where interactive
session management is not worth the overhead. AGY interactive sessions can also be
enabled in Phase 2. All existing `execute_prompt` call sites continue to work without
modification -- the routing change is internal.

### Phase 3 -- Post-2026-06-15

fleets.apralabs.com is deployed. Multi-tenant project support goes live. Members can
connect to the cloud server in addition to the local server. The credential vault
migrates from the local encrypted file to the cloud vault. PM gains the ability to
orchestrate members across machines without SSH.

### Phase 4 -- Later

No-LLM member support via the fleet-service daemon goes live. Remote members connect to
fleets.apralabs.com over the internet without requiring inbound SSH. The PM-as-member
model is fully realized: PM's session is itself a fleet MCP client, not just a consumer
of a locally-running fleet MCP server. Self-hosted fleet server packaging is published
for organizations with sovereignty requirements.

---

## 15. The Dashboard (fleets.apralabs.com Web UI)

See also: GitHub Discussion #188 (https://github.com/Apra-Labs/apra-fleet/discussions/188) --
original dashboard + VS Code extension proposal. The cloud architecture described in this
document extends that proposal from a local binary-served dashboard to a cloud-hosted
multi-tenant service at fleets.apralabs.com.

fleets.apralabs.com hosts both the fleet MCP server and a web-based dashboard at the
same domain. The dashboard is the human interface to the fleet server -- it is how
users create projects, register members, enter secrets, monitor activity, and respond
to human escalations without ever touching the CLI.

### Project and member management

The dashboard provides a full project lifecycle UI:

- Create and configure projects. Set project name, description, token budget, and
  auto-restart policy. Invite team members by email (each gets a scoped project token).
- Register fleet members. Enter the member name, machine address, SSH credentials,
  LLM provider, and role (doer, reviewer, pm, no-LLM). The dashboard runs the same
  register_member and install flows that the CLI does today, but through a guided wizard.
- View member status in real time. The session registry (Section 3) feeds a live status
  panel: each member shows as online/busy/awaiting_human/offline with the current task
  name and elapsed time. Status updates arrive via SSE from the fleet server -- the
  dashboard itself is an SSE client.
- Restart, stop, or update a member from the dashboard. These trigger the same SSH
  execute_command flows described in Section 5 (process lifecycle), initiated server-side.

### Secure secret management

The dashboard is the primary entry point for secrets. Secrets entered here go directly
into the credential vault (Section 9) and are never visible again after submission.

Secret entry surfaces:
- LLM provider tokens: CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, ANTIGRAVITY_API_KEY,
  Gemini OAuth. Each has a dedicated input with provider-specific instructions.
- VCS tokens: GitHub personal access token, GitLab token, SSH key pair upload or
  server-side generation. The dashboard can trigger a GitHub App authorization flow
  for organization-wide VCS access.
- Custom secrets: any named key-value pair stored in the vault and referenced by name
  in execute_command calls using the {{secure.NAME}} syntax.

Security invariants for the dashboard secret UI:
- All secret input fields are write-only: once submitted, the value is never shown again.
  The UI shows only 'set' or 'not set' for each secret slot.
- Secret values are encrypted in the browser before submission (client-side encryption
  using the project's public key). The fleet server receives ciphertext only. Plaintext
  never appears in server logs, browser history, or network intermediaries beyond the
  TLS layer.
- The dashboard never exposes a 'reveal secret' function. Rotation is the only recovery
  path if a secret needs to change -- enter the new value, which overwrites the vault
  entry.

### Human escalation surface

The dashboard is the preferred surface for fleet_request_human escalations (Section 8).
When an autonomous member session calls fleet_request_human, the escalation appears in
the dashboard as a notification panel:

- The question, context, and options provided by the member are displayed.
- The human selects one of the suggested options or types a free-form response.
- Submitting the response calls fleet_respond_human server-side, which injects the
  answer into the waiting member session via SSE.
- The member's session resumes. The dashboard shows the member status change from
  awaiting_human back to busy.

Multiple escalations from different members can be queued simultaneously. Each is
addressed independently. The dashboard shows a badge count of pending escalations.

This replaces the current model where the PM surfaces questions to the human via
a terminal session -- the terminal path remains available for CLI-first workflows,
but the dashboard provides a cleaner surface for humans who are not watching a terminal.

### Audit log and cost visibility

The dashboard exposes the immutable audit log (Section 3) in a searchable, filterable
view:
- Filter by member, tool name, time range, risk level, and outcome (approved/blocked/escalated).
- Each audit entry shows: member, tool, arguments (redacted for secrets), duration,
  token cost, and outcome.
- Export to CSV for billing reconciliation or compliance review.

The cost dashboard aggregates the PostToolUse hook data (Section 7) into per-member
and per-task views:
- Cost per task (tokens x provider rate).
- Cost per member per day/week/month.
- Budget consumption gauge: current spend vs. the project token budget.
- Alert configuration: notify when budget exceeds N% consumed.

### Permissions management

The compose_permissions workflow (currently a PM-side tool call) has a dashboard
equivalent:
- Define named permission profiles (e.g., 'doer-standard', 'reviewer-readonly').
- Assign profiles to members or roles.
- The dashboard generates the compose_permissions call parameters that PM will use
  at dispatch time. PM still calls compose_permissions -- the dashboard is a
  configuration and visualization layer, not a bypass of the permission model.

### VS Code extension

The dashboard is also embeddable as a VS Code webview extension. The extension opens
the fleets.apralabs.com dashboard inside a VS Code panel, giving developers direct
visibility into fleet activity without leaving the editor.

One capability that is unique to the editor context: local filename resolution. When
fleet logs or audit entries reference a file path (for example, src/api/auth.ts:42
in a command output or error message), the extension intercepts those strings and
makes them clickable -- opening the file at the correct line in the editor. This
eliminates the manual navigation step when reading fleet output.

The extension and the web dashboard share the same React application and the same
fleets.apralabs.com API. The extension adds only the filename-resolution bridge (a
message-passing layer between the VS Code webview and the extension host, required
because VS Code webviews run under a strict content security policy).

Read-only mode is the safe default for the extension (observe member status, cost,
audit log, live activity). Interactive dispatch (send a prompt, cancel a session,
respond to fleet_request_human escalations) is opt-in, gated behind a project
permission setting to prevent accidental interruption of running agents.

A UI prototype is available at: https://majestic-biscuit-bef096.netlify.app/

### What the dashboard is not

The dashboard does not replace the PM skill or the fleet CLI. It does not dispatch
tasks, run sprints, or orchestrate members. Orchestration is the PM's job. The
dashboard is the administrative and monitoring layer -- it is how a human manages
the fleet, not how the fleet does its work.

The dashboard does not store secrets in the browser. No secret value persists in
localStorage, sessionStorage, or the browser cache. Secret entry is a one-way
write into the vault; the browser discards the value immediately after encryption
and transmission.

---

## Appendix -- Relationship to Existing Code

| Cloud concept | Current codebase location | Change required |
|---|---|---|
| HTTP+SSE transport | `src/services/http-transport.ts` | Extend for multi-tenancy, internet binding, tenant JWT validation |
| Event bus | `src/services/event-bus.ts` | Add project scoping, message queue per member |
| Member registry | `src/services/registry.ts` | Add session registry (online/offline/busy/awaiting_human) |
| execute_prompt | `src/tools/execute-prompt.ts` | Add send_message routing for Claude; subprocess path stays for AGY/Gemini |
| ClaudeProvider | `src/providers/claude.ts` | buildPromptCommand() kept for SSH path; interactive routing added as alternative |
| AgyProvider | `src/providers/agy.ts` | buildPromptCommand() kept for SSH path; interactive session support added |
| Strategy pattern | `src/services/strategy.ts` | Third strategy: cloud SSE (joins remote/SSH and local/child_process) |
| Service manager | `src/services/service-manager/` | Extend for fleet-service daemon (no-LLM members) |
| compose_permissions | `src/tools/compose-permissions.ts` | Permissions sent as task message metadata; hook enforcement replaces local settings.local.json |
| credential_store | `src/tools/credential-store.ts` | Backend switches from local file to fleet vault; API unchanged |
