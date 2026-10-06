<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/marketing/hero-banner-dark.svg">
  <img src="assets/marketing/hero-banner-light.svg" alt="apra-fleet: run a fleet of AI agents across your devices, your providers, your workflows." width="100%">
</picture>

# apra-fleet

**Run a fleet of AI agents across your devices, your providers, your workflows.**

What Kubernetes did for containers, apra-fleet does for AI agents:
scheduling, credentials, isolation, and observability for an agentic
workforce -- on any machine, anywhere, using every LLM provider at once.

[![CI](https://github.com/Apra-Labs/apra-fleet/actions/workflows/ci.yml/badge.svg)](https://github.com/Apra-Labs/apra-fleet/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg)](https://github.com/Apra-Labs/apra-fleet/releases)
[![MCP](https://img.shields.io/badge/MCP-compatible-8A2BE2.svg)](https://modelcontextprotocol.io)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/Apra-Labs/apra-fleet)

[Quick Start](#quick-start-5-minutes) - [Live Demo](#watch-a-fleet-work) - [How It Works](#how-it-works) - [fleet-sprint Getting Started Guide](docs/fleet-sprint-getting-started.md) - [Website](https://apra-labs.github.io/apra-fleet)

</div>

---

<img src="assets/marketing/dashboard-demo.gif" alt="apra-fleet fleet-sprint dashboard, real recording: the sprint's own integration tester finds two real bugs, files them against itself, then a second cycle plans, fixes, and closes them -- captions burned in." width="100%">

> **This repository is built by the product you are looking at.** An
> autonomous apra-fleet workflow plans, codes, reviews, tests, and ships
> this codebase in multi-hour sprints -- filing bugs against itself and
> fixing them. The recording above is a real run, not a mockup.

---

## Why a fleet?

Running one AI agent is a demo. Running fifty -- across a MacBook in the
office, a GPU box in the lab, three cloud VMs, and your CI -- is an
operations problem nobody else has solved:

- **Which machine runs which agent?** Real devices, not throwaway sandboxes:
  registered, credentialed, health-checked members you already own.
- **Which model does which job?** Claude for review, a cheap tier for
  mechanical edits, a local vLLM model for private data -- all in one fleet,
  routed by cost tier, switchable per task.
- **Who watches the agents?** Durable workflows with supervisors, watchdogs,
  reservations, and live dashboards. Agents that die get detected. Work that
  stalls gets resumed. Nothing runs silently.
- **Who holds the keys?** Secrets entered out-of-band, never visible to any
  model. Per-provider permission composition. Network egress policy per
  credential.

One control plane. Any device. Any model. Any workflow. Any domain.

## What you get

| Pillar | Concretely |
|---|---|
| **Any device** | Register any Windows / macOS / Linux machine (local or over SSH) as a fleet member in one command. Cloud members auto-start on demand. Windows members are fully supported for dispatch, command execution, and background long-running tasks (launched detached via WMI). |
| **Any model** | Claude, Codex, Copilot, Antigravity, local models (any OpenAI-compatible endpoint via OpenCode) -- mixed freely. Tier-based routing (cheap / standard / premium) keeps cost governance built in. Cross-provider review is a quality mechanism: a different model, with different blind spots, checks every change. |
| **Any workflow** | Workflows are durable programs, not prompt chains: multi-hour, resumable, observable, with member reservations and atomic state. Write your own; ship it to the fleet. |
| **Any domain** | Not just software development. The pattern fits wherever work decomposes into agent-sized pieces that need orchestration and an audit trail: nightly retail replenishment (reconcile inventory deltas, draft purchase orders for sign-off), logistics exception handling (triage a delayed shipment, re-book, notify), healthcare intake (summarize referrals, check completeness, route), back-office runs (invoice matching, compliance evidence collection). Software engineering is the vertical running today -- your domain is a workflow away. |

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/marketing/fleet-topology-dark.svg">
  <img src="assets/marketing/fleet-topology-light.svg" alt="apra-fleet topology: one control plane dispatching to six heterogeneous member devices across providers and operating systems" width="100%">
</picture>

## Watch a fleet work

Our flagship workflow, **fleet-sprint**, develops software autonomously:
plan -> develop -> review -> deploy -> integration-test -> harvest, in
cycles, until the goal is met or the evidence says stop.

It is not a toy. It builds apra-fleet itself:

- Multi-cycle sprints running for hours, unattended
- 2,300+ unit tests and an 81-file integration suite against real backends
- Files bugs against itself, decomposes them, fixes them, and blocks its
  own release until quality gates pass
- Every dispatch, verdict, and dollar visible live on the dashboard
- Every sprint's raw child stdout/stderr is captured to a per-sprint log
  and linked from the dashboard, so a run's output is traceable even if it
  crashes before reporting anything back

A fleet that has run in production:

```
pm-1      Opus (premium)      orchestrator
doer-1    Sonnet (standard)   feature work
doer-2    Antigravity         large-context tasks
reviewer  Opus (premium)      final review
```

The engine does not know what a "sprint" is; it knows how to run your
workflow reliably across your fleet (see **Any domain** above).

## Quick start (5 minutes)

**1. Install** -- one command via npm (Node.js 22+), or grab the
standalone installer binary for your platform from
[Releases](https://github.com/Apra-Labs/apra-fleet/releases) and
double-click it (installation is the default action):

```bash
npm install -g @apralabs/apra-fleet
apra-fleet install           # installs for Claude Code (default)
apra-fleet install --llm agy # or --llm opencode / codex / copilot
cd ~/.apra-fleet/bin && apra-fleet start             # start the apra-fleet
```

The standalone installer binary needs no Node.js at all for the core console
and MCP server. Sprint automation (`fleet-sprint`, the always-on supervisor,
and `bd`) is the one part that needs Node.js 22.16+ and npm; `install` checks
for them up front and fails loudly with the fix if they're missing, or you
can pass `--workflows none` for a Node-free, core-only install. See
[docs/install.md](docs/install.md#prerequisites).

**2. Connect your agent.** Load the fleet server in Claude Code with
`/mcp` (or restart your provider CLI). Your agent now has a fleet.

**3. Register members -- in plain language.** apra-fleet is driven
conversationally through any MCP-capable agent:

> "Register a local member called `doer`. Register another called
> `reviewer`. Pair them."

> "Register 192.168.1.10 as `build-server`. Username akhil, work folder
> `/home/akhil/projects/myapp`."

Remote passwords are collected out-of-band -- typed into a separate
terminal, never the chat -- used once to set up SSH keys, then forgotten.

**4. Run your first workflow:**

```bash
apra-fleet workflow hello-world
```

Then point the fleet at real work:

```bash
apra-fleet workflow fleet-sprint \
  --issue my-project-epic --members doer \
  --branch fleet-sprint/first-run --base main
```

Open the dashboard, watch your fleet PLAN->BUILD->REVIEW->TEST->SHIP in a loop till closure

> **New to fleet-sprint?** Read the
> [fleet-sprint Getting Started Guide](https://apra-labs.github.io/apra-fleet/fleet-sprint-getting-started.html)
> ([Markdown](docs/fleet-sprint-getting-started.md) if you're reading this on
> GitHub -- [PDF](docs/fleet-sprint-getting-started.pdf)) -- a plain-English walkthrough
> of what it does, what you need to prepare (beads backlog, `deploy.md`,
> test playbooks, member registration), how to launch and monitor a sprint,
> and what's automated versus what's still your call.

**Running fleet-sprint after npm install:** the `apra-fleet workflow
fleet-sprint ...` command above is the same one command for everyone --
whether you installed via `npm install -g @apralabs/apra-fleet`, the
standalone binary, or a git-clone dev checkout. There is no separate
`fleet-sprint` command to install or remember. See
[the full flag reference](packages/apra-fleet-se/fleet-sprint/docs/README.md)
for every option.

## How it works

### Layered Architecture

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/marketing/fleet-stack-dark.svg">
  <img src="assets/marketing/fleet-stack-light.svg" alt="apra-fleet layered architecture stack: dependencies from OS primitives up to autonomous engineering orchestrators" width="100%">
</picture>

**Component Docs:** [fleet-sprint](packages/apra-fleet-se/fleet-sprint/docs/README.md) | [auto-sprint.js](packages/apra-fleet-se/apra-pm/docs/sprint-workflow.md) | [apra-fleet-client](packages/apra-fleet-client/docs/overview.md) | [apra-pm](packages/apra-fleet-se/apra-pm/README.md) | [apra-fleet-mcp](docs/mcp-tools.md) | [Agent Roles](packages/apra-fleet-se/docs/role-contracts.md)

### Fleet Dispatch Topology

```mermaid
flowchart LR
    CP["Control Plane<br/>(Server, Engine, Supervisor)"] -->|Dispatch & Sync| M1["MacBook<br/>(Claude)"] & M2["Linux GPU<br/>(vLLM)"] & M3["Cloud VM<br/>(AGY)"] & M4["Windows<br/>(OpenCode)"]
```

- **Fleet server**: the control plane. Registers members, dispatches commands and prompts, moves files, brokers credentials. Speaks MCP, so any MCP-capable agent can drive a fleet. `execute_prompt` supports session forking (`fork`) on fork-capable providers -- branch a new, independent session from an existing one's context (e.g. a primed session reused across per-task dispatches) without continuing to write into the source session. See [docs/mcp-tools.md](docs/mcp-tools.md#execute_prompt) for the parameter contract.
- **Members**: real machines running provider CLIs. Composes provider-native permissions before every dispatch; unattended modes are scoped, never blanket. A consumer package (e.g. a fleet-sprint project) can tag a member with its own `owner {package, ref}` binding (`member_owner`) and read live git status for a member's work folder -- branch, dirty files, ahead/behind, worktrees, origin identity -- without assuming the folder is even a checkout (`member_git_status`). A member's stored `env` name-value map is now actually injected at every dispatch site (synchronous exec, prompt launch and its retries, and the long-running task wrapper), merged with the member's own auth credentials and rendered for whichever shell the member is actually registered as speaking -- see [docs/cross-shell-command-construction.md](docs/cross-shell-command-construction.md). See [docs/mcp-tools.md](docs/mcp-tools.md#1-lifecycle-tools).
- **Workflow engine**: runs workflow programs with phases, retries, turn budgets, resumable sessions, per-activity persistent state, and a cooperative pause/resume gate any workflow can hook into.
- **Supervisor**: always-on layer -- launch, pause/resume, & stop sprints over HTTP, member reservation ledger (an object holder record with a process id and timestamp, lazily reaped once its holder's process is gone -- see [docs/member-reservation-design.md](docs/member-reservation-design.md)), crash watchdog (including a live "paused" state and base-branch-drift indicator), run history, and a supervisor-owned LLM-less backlog member that every launch is pinned to. The dashboard and backlog read a cached, tip-checked beads view and show when it was last refreshed ("Beads as of"); launch always forces a fresh beads check and answers 503, without reserving members or starting a sprint, when beads cannot be verified. Binds loopback-only (`127.0.0.1`) and guards its `/api/` surface and mutating live-sprint routes with a per-host bearer token (source is the shared `~/.apra-fleet/fleet.key` when present, falling back to a token minted under `<supervisor-data-root>/private/token` otherwise; the source is logged, the token value never is; sent as `Authorization: Bearer <token>`); read-only dashboard/live views stay open on loopback. See [packages/apra-fleet-se/docs/architecture.md](packages/apra-fleet-se/docs/architecture.md#supervisor-loopback-bind--bearer-token-auth-guard). It is also gaining a project domain -- binding a member to a console project, adding a new checkout on a machine, a health panel, a per-member git drawer, and a project export/import CLI -- built as domain logic and JSON routes ahead of the console UI that will render it. See [packages/apra-fleet-se/docs/project-overview-domain.md](packages/apra-fleet-se/docs/project-overview-domain.md). Separately, each supervisor instance now resolves a single persisted project folder (`supervisor.config.json`) -- an explicit `--beads-dir` flag, else that persisted setting, else the legacy `.beads` walk-up -- so an installed supervisor's Backlog/Sprints pages reach a real project instead of only whatever `.beads` happens to be found walking up from the service's own installed engine path; set it at install time (`apra-fleet install --project-dir <path>`) or later from the console's Projects page, and see it on Health. See [packages/apra-fleet-se/docs/project-model.md](packages/apra-fleet-se/docs/project-model.md) and [docs/install.md](docs/install.md)'s "Project folder" note.
- **Owed triage**: a PASS verdict is not the same as clean. The sprint PR body lists what is still owed (unclaimed follow-ups, all-children-closed rollups still open, rejected findings, `blocked:` closures, and features stranded when Integration Test is skipped) and says "PASS is NOT clean" when anything is. It only reports; it never closes beads. The Tasks view and Backlog keep opened descriptions and collapsed nodes across refreshes. See [docs/owed-triage-report.md](docs/owed-triage-report.md).

## Knowledge Layer

Every agent session starts by calling `kb_session_prime`. The KB checks which
files have changed since last read and returns exactly those. Unchanged files
are served from cached summaries -- no re-read, no wasted tokens.

```
Cold session:  kb_session_prime returns stale_files=[a.ts, b.ts, c.ts]
               Agent reads all three, calls kb_capture for each.
Warm session:  kb_session_prime returns stale_files=[], session_warm=true
               Agent works from KB summaries. Zero file reads.
```

MCP tools that ship with the KB:

| Tool | What it does |
|------|--------------|
| `kb_session_prime` | Prime a session: stale files, fresh summaries, GitNexus call list |
| `kb_capture` | Store a learning, context-cache, runbook, or knowledge entry |
| `kb_query` | Two-level FTS retrieval (L1: title+summary, L2: full content) |
| `kb_list` | Audit-list entries by confidence/type/module/symbol (read-only, no use_count bump) |
| `kb_context` | Batch file freshness check (single git call for N files) |
| `kb_invalidate` | Mark files stale immediately (also called by the git hook), or discard own entries by `ids` |
| `kb_promote` | Advance confidence: UNVERIFIED -> INFERRED -> CONFIRMED |
| `kb_harvest` | Extract learnings from a session transcript (auto-fires after execute_prompt) |
| `kb_export` | Additively merge live CONFIRMED entries whose cited files still match their recorded hashes into `.fleet/kb-canonical.json` -- the git-shareable team bible |
| `kb_bible_commit` | Merge confirmed entry ids into the bible and commit locally with base-branch provenance (used by the sprint kb_maintainer) |
| `kb_setup` | Install git hook, write provider config, store remote token encrypted |

`code_*` tools resolve the calling session's own folder, refuse with typed
`E-CODE-INDEX-NOT-READY` / `E-CODE-INTEL-DISABLED` errors when the index is not
usable, and report `indexedCommit` on every result; `code_reindex` and
`code_status` drive and inspect the index (see
[docs/code-index-readiness.md](docs/code-index-readiness.md)). Registering a
remote member also installs a member-mode apra-fleet on it and wires a
per-folder MCP entry, recorded as `fleetMcp` (see
[docs/member-fleet-mcp-wiring.md](docs/member-fleet-mcp-wiring.md)).
`session_stats` reports each member's `kb_*` / `code_*` call counts, which
fleet-sprint shows per dispatch in its Knowledge & Code Intel viewer tab.

`kb_setup --remote <url> --token <key>` takes effect immediately: the next
KB tool call resolves its project provider from this config, so a stock build
points at a remote KB server by configuration alone, with no code change and
no separate "server mode" build. A config with no remote, or any config the
reader cannot parse, always falls back to the local SQLite provider -- see
[Client-side provider selection](docs/knowledge-layer-design.md#client-side-provider-selection)
for the exact selection rule and its fallback-construction invariant.

A remote-configured install can also opt into a strict offline mode
(`offline_fallback: "error"` on `kb_setup`): every read/write that would
otherwise silently fall back to local data instead throws, naming the
unreachable remote, for a team that needs every KB call to reflect
team-shared truth rather than a possibly-stale local copy. The default
(`"local"`) keeps today's silent-degrade behavior. See
[docs/knowledge-layer-design.md](docs/knowledge-layer-design.md#adr-002-central-service-architecture----http-relay).

**The provider config is install-wide, not per repo.** There is one
`knowledge/config.json` per fleet install, so pointing it at a remote KB
points EVERY repo that install serves -- every member, every project -- at
that server. `kb_setup` only places the git post-commit hook (in the calling
session's own repo); it does not scope the config. On a shared fleet server,
treat `kb_setup --remote` as a change for all of its users.

Every KB tool call is scoped to the calling session's own repo -- a fleet
server handling many members across many repos never lets one repo's
learnings land in another repo's KB. No `kb_*` tool takes a scope argument:
a member session uses its registered work folder and any other session uses
the fleet server's working folder, and a folder that is not a git repository
with an origin remote is refused with a typed `E-SELF-*` error. Member
sessions get a reduced tool list (`kb_*`, `code_*` and a few self-reporting
tools), and the `apra-fleet call` verb lets a process call tools as a member.
KB reads default to CONFIRMED, undisputed entries. See
[Per-repo KB isolation](docs/knowledge-layer.md#per-repo-kb-isolation) for
the resolution, anchor and cache-keying rules.

The backend is swappable: start with local SQLite, add a central HTTP server for
a team, or plug in Postgres later -- all via a one-line config change.

See [docs/knowledge-layer.md](docs/knowledge-layer.md) for the full guide.

## Explore with agents. Operate with programs.

There are two ways to orchestrate agents, and apra-fleet is built on the
observation that you need both -- at different stages of a workflow's life:

- **Exploration mode.** While a workflow is still being discovered, let an
  LLM orchestrate: flexible, adaptive, and token-hungry -- every step is a
  decision, and every decision costs thinking.
- **Operation mode.** Once you know what must happen, the control flow
  becomes a deterministic workflow program. Shell, git, and file steps run
  through `execute_command` -- zero tokens. The model is invoked only at
  the corners that genuinely require judgment (`execute_prompt`): review
  this diff, plan this backlog, decide this exception.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/marketing/cost-collapse-dark.svg">
  <img src="assets/marketing/cost-collapse-light.svg" alt="Cost per apra-fleet e2e run: four real LLM-driven runs ranging $0.46-$3.05, then ~$0.00 / run forever after switching to a deterministic workflow." width="100%">
</picture>

That is not a projection -- it is this repository's own e2e setup+teardown
step, before and after we hardened it. Development tokens are not
operating tokens: pay once to discover the workflow, then run it free.

| | LLM-orchestrated (explore) | Workflow-orchestrated (operate) |
|---|---|---|
| Control flow | the model decides each step (tokens) | deterministic program (free) |
| Shell / git / file steps | narrated through the model | `execute_command`, zero tokens |
| Where the model runs | everywhere | judgment nodes only (`execute_prompt`) |
| Cost curve | scales with every step | scales with thinking only |
| Failure mode | drift and silent retries | typed errors, resumable state |

The collapse is two-dimensional. As a workflow hardens, control flow moves
from model to program -- and the judgment nodes that remain move from
frontier models to cheaper ones, because a well-specified task no longer
needs discovery-grade reasoning. **Develop a workflow with Claude;
operationalize it on OpenCode against a local or OpenRouter model.** Same
fleet, same workflow -- swap the members. Tier routing makes it a
registration change, not a rewrite.

Only a fleet makes that trade possible. Single-provider tools cannot leave
their vendor; in-process frameworks cannot move orchestration out of the
token path. Because apra-fleet's unit of execution is the member -- a
machine plus a provider, swappable at registration -- the same hardened
workflow runs on frontier models the day you design it and on commodity
models every day after.

fleet-sprint is this principle, lived: it began as LLM-orchestrated
exploration; each discovered pattern was hardened into the deterministic
engine; today the engine drives hour-long autonomous runs in which models
are consulted only as planner, doer, reviewer, tester, and harvester.

## Compare to alternatives

| Tool | Overlap | Where apra-fleet differs |
|------|---------|--------------------------|
| Single-agent coding assistants | AI writes code | A fleet adds agents that review, test, and deploy each other's work -- across vendors. |
| CI self-hosted runners | Runs work on other machines | Conversational and stateful, not pipeline-triggered; agents carry context between phases. |
| SkyPilot / dstack | Multi-machine compute | Coordinates agents and their context, credentials, and permissions -- not just jobs. |
| Google A2A | Agent-to-agent messaging | An opinionated orchestration and operations layer, not just a transport. |
| Agent frameworks (LangGraph, CrewAI, ...) | Multi-agent logic | Those compose agents inside one process; apra-fleet operates agents across real machines, providers, and days-long workflows. |

When NOT to use it: a one-off single-file change needs no fleet.

## Security model, in one paragraph

Secrets are entered out-of-band into a credential store and referenced as
`{{secret.NAME}}` -- resolved server-side at execution, never visible to
any LLM or log; see [docs/secret-variables.md](docs/secret-variables.md).
Credentials scope to members, expire on TTL, and can carry
a network egress policy (allow / deny / confirm). Every member runs with
composed, provider-native permission files -- allow-listed tools, not
god-mode. VCS access is provisioned and revocable per member, across GitHub,
Bitbucket, and Azure DevOps -- host differences (URL shape, PR REST dialect,
auth pattern, error vocabulary) are hidden behind a per-provider descriptor
rather than leaking into shared code; see
`docs/design-azure-devops-vcs-auth.md` for the Azure DevOps provider's
credential-assembly and PAT-lifetime details. A credential-requiring VCS
command can be handed to the server for execution (`vcs_credential_exec`)
rather than the orchestrator learning the plaintext token itself: the
server substitutes the credential into the command, runs it on the member,
and redacts the token from every field of the result -- the plaintext never
transits an orchestrator-readable output. Permission
composition verifies its own delivery: a grant is read back off the target
member and structurally compared against what was intended before it is
reported as applied, so a failed or partial write is surfaced as an
explicit failure rather than a false success.

## Email Configuration

The fleet `send_email` tool sends email via **SendGrid** or **SMTP**. Secrets
are stored in the fleet credential store. Non-secret config (provider, host,
port, from address) is passed by the workflow in each call.

### Storing secrets (one-time setup)

Store email secrets via the CLI:

```bash
# SendGrid API key
apra-fleet secret --set sendgrid_api_key --persist

# SMTP password
apra-fleet secret --set smtp_password --persist
```

Or via the MCP tool (the path an LLM agent uses):

```json
{ "name": "sendgrid_api_key", "prompt": "Enter your SendGrid API key", "persist": true }
```

Secrets are encrypted in the fleet credential store. They never appear in
workflow code, config files, or environment variables.

On a headless server (no terminal attached), or by passing `return_url:
true` explicitly, `credential_store_set` returns a one-time, console-hosted
browser URL (`{url, expiresAt, absoluteUrl}`) instead of blocking on
terminal input -- open the URL to submit the secret; it is stored
automatically, with no follow-up call needed. The URL works from wherever a
browser can reach the console (LAN, an SSH tunnel, a remote install), not
only from the server's own machine. See
[docs/secret-variables.md](docs/secret-variables.md) for the full behavior.

### Sending email from a workflow

The workflow passes non-secret config inline and calls `send_email`. Load
your config however you prefer (JSON file, hardcoded, etc.):

```javascript
import { parseToolJson } from '@apralabs/apra-fleet-client';
import { connectFleet } from '@apralabs/apra-fleet-client/server-resolution';

const { fleetApi } = await connectFleet({ env: process.env });

// fleetApi wrappers return the raw MCP tool result ({ content: [...] });
// parseToolJson extracts the JSON payload.
const result = parseToolJson(await fleetApi.sendEmail({
  provider: 'smtp',
  host: 'smtp.example.com',
  port: 587,
  user: 'notifications@example.com',
  from: 'noreply@example.com',
  to: 'team@example.com',
  subject: 'Sprint Report',
  body: 'All tasks completed.'
}));
console.log(`Sent: ${result.messageId}`);
```

The SMTP password resolves from the credential store automatically. It never
appears in the workflow. See `examples/workflows/email-notify/` for a
complete runnable example and `docs/email-workflow-guide.md` for the full
walkthrough.

### send_email Tool Reference

| Parameter | Type | Required | Description |
|---|---|---|---|
| `provider` | `"sendgrid"` or `"smtp"` | no (default: `"sendgrid"`) | Email provider |
| `from` | string | yes | Sender email address |
| `host` | string | SMTP only | SMTP server hostname |
| `port` | number | no (default: 587, or 465 when `secure` is true) | SMTP server port |
| `user` | string | SMTP only | SMTP username |
| `secure` | boolean | no (default: false) | Implicit TLS (port 465). When false, STARTTLS is required. |
| `to` | string or string[] | yes | Recipient email address(es) |
| `subject` | string | yes | Email subject line |
| `body` | string | yes | Plain-text email body |
| `html` | string | no | HTML email body |
| `cc` | string[] | no | CC recipient addresses |
| `bcc` | string[] | no | BCC recipient addresses |
| `attachments` | attachment[] | no | File attachments (base64-encoded) |

Each attachment: `filename` (string), `content` (string, base64), `contentType` (string, optional).

Secrets are resolved from the credential store by name:
- **SendGrid:** `sendgrid_api_key`
- **SMTP:** `smtp_password`

Returns: `{ ok: true, messageId }` on success, `{ ok: false, error }` on failure.

## The packages

| Package | What it is |
|---|---|
| `apra-fleet` | The fleet platform: server, CLI, member management, credentials, workflows runtime |
| `packages/apra-fleet-se` | The software-engineering vertical: fleet-sprint engine, agent contracts, integration suites |
| `packages/apra-fleet-workflow` | Workflow authoring runtime: state, viewer, checkpointing |
| `packages/fleet-api-contract` | Typed API contract shared by server and clients |

## Status and roadmap

apra-fleet is under active development -- by its own fleet. Current focus:
hardening autonomous sprint execution (the toughest workflow we know of),
supervisor-orchestrated multi-sprint operation, and the workflow SDK for
third-party verticals.

A small web console (a `/ui` shell backed by `/api/fleet/*`) is taking shape
behind its own seam so it can grow one route module at a time. It now serves
Members, Secrets and Health pages with drawer actions and an add-member
wizard, built on a shared `@apralabs/apra-fleet-ui-kit` primitives package,
and is guarded end to end: every `/api/*` request and every mutating
`/ext/*` request requires the fleet key (bearer) or the console cookie,
adding a credential from the Secrets page opens a one-time, single-use entry
page hosted on the console itself (not a separate loopback listener), so
submitting a secret value works from any browser that can reach the console
-- see [docs/console-architecture.md](docs/console-architecture.md)'s
"Console-hosted secret entry" section,
third-party workflow packages can be registered and reached through a
`/ext/<package id>/*` reverse proxy (SSE included) using a per-package
derived upstream credential rather than the raw fleet key, and
`compose_permissions` refuses to auto-grant a member curl access to the
console or supervisor's own control-plane ports. The fleet-supervisor is now
one such package: it self-registers on boot with an unscoped "Sprints" nav
entry, and the console embeds its real dashboard (Sprint Stack, backlog,
launch form, per-sprint live view and history) in an iframe under
`/ext/se/*` -- every page it renders resolves its own links correctly whether
opened directly or embedded, and the dashboard, the console and a running
sprint's live viewer cross-link back to each other (console origin, and a
shared per-sprint card anchor) with no hardcoded host or port. The member
drawer now has an in-place edit form (name, category, tags, icon, unattended
mode, LLM provider, and host/port/username for remote members) and
compose-permissions inputs (role, tags, grant list, grant reason), both
submitting only the fields the operator actually changed rather than the
whole record. It now serves from every distribution channel -- a dev
checkout, the npm-installed package, and the SEA binary all answer
`GET /ui`. Known gaps: the Members table's owner column and the
member-detail drawer action need further work before every screen action in
the design's action table has both a tested route and a tested UI control,
and the edit form's re-sync-on-background-refresh behavior has a known
defect where an operator's untouched fields can be spuriously resubmitted
after another operator's concurrent change lands mid-edit -- see
[docs/console-architecture.md](docs/console-architecture.md) for the
dirty-diff design and the invariant this defect violates. See also
[docs/npm-packaging.md](docs/npm-packaging.md) (console shell packaging) and
[packages/apra-fleet-se/docs/architecture.md](packages/apra-fleet-se/docs/architecture.md).
The Health page's data directory now comes from an explicit `dataDir` field
the server always includes in the `fleet_status` JSON payload, and
`apra-fleet status`/the OS service managers report a genuinely three-state
`enabled` (armed / disabled / unknown) rather than collapsing "the platform
can't tell" into a false "disabled" claim -- see
[docs/transport-and-service-mode.md](docs/transport-and-service-mode.md#reported-service-state-installed--enabled--running).
Launching a sprint from the console now works reliably whether the
supervisor is running as a plain Node process or as the installed
single-executable binary (a dedicated resolver picks a real Node.js
runtime instead of trusting the supervisor's own execPath), and a launch
that fails before producing a terminal state file is now visible in
Finished Sprints with its reason and a raw-log link, instead of silently
vanishing -- see
[docs/features/sprint-runner-resolution.md](docs/features/sprint-runner-resolution.md)
and [docs/features/supervisor-dashboard-live-refresh.md](docs/features/supervisor-dashboard-live-refresh.md).
An installed supervisor now also resolves and records the absolute paths of
`node` and `bd` at install time, so a service manager that hands its child a
minimal or PATH-less environment (macOS launchd, a Windows scheduled task)
still launches sprints and runs `bd` with the exact toolchain the operator
installed with (including a Node.js runtime managed by nvm/fnm/volta),
instead of failing to resolve either on the service's own PATH. The
recording is re-validated at every supervisor start (never blocking startup,
never silently hiding a stale recording) and surfaced on the Health endpoint
and the dashboard header -- see
[docs/features/recorded-toolchain.md](docs/features/recorded-toolchain.md).

## Documentation

| Topic | Link |
|-------|------|
| **fleet-sprint Getting Started Guide (start here, plain English)** | [Website](https://apra-labs.github.io/apra-fleet/fleet-sprint-getting-started.html) - [Markdown](docs/fleet-sprint-getting-started.md) - [PDF](docs/fleet-sprint-getting-started.pdf) |
| Codebase wiki (architecture, internals, AI Q&A) | [DeepWiki](https://deepwiki.com/Apra-Labs/apra-fleet) |
| Install, uninstall, the `--llm` flag | [docs/install.md](docs/install.md) |
| Choosing a provider (roles, gotchas, mixing providers, OpenCode/local models) | [docs/provider-guide.md](docs/provider-guide.md) |
| Transport, service mode, and supported interfaces | [docs/transport-and-service-mode.md](docs/transport-and-service-mode.md) |
| Cost model (tiering, shell-over-prompts, measured token spend) | [docs/cost-model.md](docs/cost-model.md) |
| The PM skill (doer-reviewer sprints, `/pm` commands) | [docs/pm-skill-overview.md](docs/pm-skill-overview.md) |
| FAQ | [docs/FAQ.md](docs/FAQ.md) |
| Troubleshooting | [docs/troubleshooting.md](docs/troubleshooting.md) |
| Keeping Fleet updated (`apra-fleet update`) | [docs/features/update.md](docs/features/update.md) |
| Live member activity (`apra-fleet watch`, `logging.previewChars`) | [docs/features/watch.md](docs/features/watch.md) |
| Secret variables and passwords | [docs/secret-variables.md](docs/secret-variables.md) - [docs/features/oob-auth.md](docs/features/oob-auth.md) |
| Member category and tags | [docs/features/member-tags.md](docs/features/member-tags.md) |
| Enabling SSH on a remote machine (if it does not have it yet) | [docs/ssh-setup.md](docs/ssh-setup.md) |
| Git authentication | [docs/design-git-auth.md](docs/design-git-auth.md) |
| GitHub App setup (exact permissions per git_access level) | [docs/github-app-setup.md](docs/github-app-setup.md) |
| Cloud compute | [docs/cloud-compute.md](docs/cloud-compute.md) |
| Architecture | [docs/architecture.md](docs/architecture.md) |
| Console server (`/ui` shell, `/api/fleet/*`, seam design) | [docs/console-architecture.md](docs/console-architecture.md) |
| Sprint-runner resolution (how the supervisor picks a Node.js runtime to launch sprints with) | [docs/features/sprint-runner-resolution.md](docs/features/sprint-runner-resolution.md) |
| Recorded toolchain (installer-recorded node/bd paths for a service-mode supervisor, startup re-validation, Health/dashboard surfacing) | [docs/features/recorded-toolchain.md](docs/features/recorded-toolchain.md) |
| Supervisor dashboard live refresh (launch-failed visibility, selection-hint binding) | [docs/features/supervisor-dashboard-live-refresh.md](docs/features/supervisor-dashboard-live-refresh.md) |
| Dispatch and orchestration reliability design (Windows completion-on-exit, stall detector, test-runner wall-clock bound) | [docs/dispatch-reliability-hardening.md](docs/dispatch-reliability-hardening.md) - [docs/stall-detector-resilience.md](docs/stall-detector-resilience.md) |
| Windows shell selection (probe order, gitbash/pwsh7/powershell5, shell vs os) | [docs/windows-shell-selection.md](docs/windows-shell-selection.md) |
| Cross-shell command construction for member-bound commands | [docs/cross-shell-command-construction.md](docs/cross-shell-command-construction.md) |
| Member reservation design (object model, dead-holder reaping, owner-tag refusal) | [docs/member-reservation-design.md](docs/member-reservation-design.md) |
| Knowledge Layer (setup, usage, provider swap) | [docs/knowledge-layer.md](docs/knowledge-layer.md) |
| Code intelligence provider abstraction | [docs/code-intelligence-providers.md](docs/code-intelligence-providers.md) |
| Hub-spoke cloud migration plan (historical; see tier-3 ownership ADR) | [docs/hub-spoke-master-plan.md](docs/hub-spoke-master-plan.md) |
| Tier-3 ownership decision (fleet-dashboard vs `src/hub-service/`) | [docs/adr-tier3-ownership.md](docs/adr-tier3-ownership.md) |
| Shared hub/dashboard API contract package | [packages/fleet-api-contract/README.md](packages/fleet-api-contract/README.md) |
| Workflow engine internals (`agent()`/`parallel()`/`pipeline()`, journal, budget, pause/resume) | [packages/apra-fleet-workflow/docs/apra-fleet-workflow-architecture.md](packages/apra-fleet-workflow/docs/apra-fleet-workflow-architecture.md) |
| Cooperative workflow pause/resume (engine, viewer, supervisor, fleet-sprint) | [docs/features/workflow-pause-resume.md](docs/features/workflow-pause-resume.md) |
| Sprint run summary (`GET /state?summary=1`, published once per state, pulled by supervisor rows) | [docs/sprint-run-summary.md](docs/sprint-run-summary.md) |
| Supervisor dashboard live-refresh (`/state` + `/events` SSE, tab-activation refresh, in-memory scope expansion) | [docs/features/supervisor-dashboard-live-refresh.md](docs/features/supervisor-dashboard-live-refresh.md) |
| Writing and running workflow scripts | [packages/apra-fleet-workflow/docs/workflow-guide.md](packages/apra-fleet-workflow/docs/workflow-guide.md) |
| Authoring a SEA-embedded `apra-fleet workflow` (manifest, entry contract, launcher env vars) | [docs/authoring-workflows.md](docs/authoring-workflows.md) |
| Workflow launcher fleet-server resolution order (HTTP singleton vs. stdio) | [docs/adr-workflow-server-resolution.md](docs/adr-workflow-server-resolution.md) |
| Running fleet-sprint (full flag reference; identical for npm-install, standalone binary, and git-clone dev checkout) | [packages/apra-fleet-se/fleet-sprint/docs/README.md](packages/apra-fleet-se/fleet-sprint/docs/README.md) |
| Auto-sprint overview (autonomous plan-develop-review-publish loop) | [packages/apra-fleet-se/docs/overview.md](packages/apra-fleet-se/docs/overview.md) |
| Auto-sprint CLI reference | [packages/apra-fleet-se/docs/cli-reference.md](packages/apra-fleet-se/docs/cli-reference.md) |
| Auto-sprint internals (cycle loop, stall detection, budget, topology; supervisor OS-service registration and binary-subcommand launcher) | [packages/apra-fleet-se/docs/architecture.md](packages/apra-fleet-se/docs/architecture.md) |
| The fleet project model (supervisor, members, beads, and how they relate) | [packages/apra-fleet-se/docs/project-model.md](packages/apra-fleet-se/docs/project-model.md) |
| Auto-sprint agent role contracts | [packages/apra-fleet-se/docs/role-contracts.md](packages/apra-fleet-se/docs/role-contracts.md) |
| fleet-supervisor skill (start/stop/restart/auto-start-on-boot, sprint launch via HTTP API) | [packages/apra-fleet-se/fleet-sprint/skills/fleet-supervisor/SKILL.md](packages/apra-fleet-se/fleet-sprint/skills/fleet-supervisor/SKILL.md) |
| fleet-integrator merge gate (read-only PR status script + agent merge/repair/wait/skip loop for an integration branch) | [packages/apra-fleet-se/fleet-sprint/skills/fleet-integrator/SKILL.md](packages/apra-fleet-se/fleet-sprint/skills/fleet-integrator/SKILL.md) |
| Scoped in-cycle replan findings threading, and the wrapper-injection role KB contract | [docs/scoped-replan-and-planner-kb-contract.md](docs/scoped-replan-and-planner-kb-contract.md) |
| MCP client SDK overview (transports, `ApraFleet` API) | [packages/apra-fleet-client/docs/overview.md](packages/apra-fleet-client/docs/overview.md) |
| MCP client SDK API reference | [packages/apra-fleet-client/docs/api-reference.md](packages/apra-fleet-client/docs/api-reference.md) |
| MCP client SDK getting started | [packages/apra-fleet-client/docs/getting-started.md](packages/apra-fleet-client/docs/getting-started.md) |
| Memory contract v1 inventory findings and invariants (`kb_*`/`code_*` tool surface) | [docs/memory-contract-v1-inventory-notes.md](docs/memory-contract-v1-inventory-notes.md) |
| Memory contract v1 schema generation design (zod -> JSON Schema 2020-12) | [docs/memory-contract-v1-generator-design.md](docs/memory-contract-v1-generator-design.md) |
| Memory contract v1 round-trip validation, drift guard, and T1/T2/T3/T7 handoff design | [docs/memory-contract-v1-roundtrip-and-handoff.md](docs/memory-contract-v1-roundtrip-and-handoff.md) |

## Community

- Questions and ideas: [GitHub Discussions](https://github.com/Apra-Labs/apra-fleet/discussions)
- Releases: [GitHub Releases](https://github.com/Apra-Labs/apra-fleet/releases)
- Issues: [GitHub Issues](https://github.com/Apra-Labs/apra-fleet/issues)
- What is planned next: [ROADMAP.md](ROADMAP.md)

If Apra Fleet helped you ship faster with better quality, please
[star the repo](https://github.com/Apra-Labs/apra-fleet) -- it helps others
find it.

## Development

Build from source (also the path for Intel Macs):

```bash
git clone https://github.com/Apra-Labs/apra-fleet && cd apra-fleet
npm install && npm run build && npm test
```

`npm test` runs the full local suite: the root vitest suite, the
`apra-fleet-se` workspace suite, and the `apra-pm` suite (which is not an npm
workspace and is otherwise only reachable via an explicit `--prefix`
invocation) -- so a green local run and a green CI run see the same tests.

On a fresh clone, `npm test` first builds what the tests need (the API contract
and the console UI workspaces) via its `pretest` step, so no manual
`build:ui` is required.

The root vitest run is split into `APRA_TEST_VITEST_SHARDS` shards (default 3,
via vitest's `--shard=i/N`), each a separately bounded suite with its own
`APRA_TEST_TIMEOUT_MS` budget, so one slow runner (notably Windows CI) does not
exhaust a single budget. Set it to `1` for the legacy single run; an invalid
value fails loudly. The summary prints `name=status(elapsed/budget)` per suite
and a WARNING for any suite above 70% of its budget.

See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute.

## License

Apache 2.0 -- see [LICENSE](LICENSE).

---

<div align="center">

**Stop babysitting agents. Start operating fleets.**

[Quick Start](#quick-start-5-minutes) - [GitHub Issues](https://github.com/Apra-Labs/apra-fleet/issues) - [Apra Labs](https://apralabs.com)

</div>
