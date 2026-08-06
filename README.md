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

[Quick Start](#quick-start-5-minutes) - [Live Demo](#watch-a-fleet-work) - [How It Works](#how-it-works) - [fleet-sprint Getting Started Guide](docs/fleet-sprint-getting-started.md) - [Docs](https://apra-labs.github.io/apra-fleet)

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
| **Any device** | Register any Windows / macOS / Linux machine (local or over SSH) as a fleet member in one command. Cloud members auto-start on demand. |
| **Any model** | Claude, Codex, Gemini, Copilot, Antigravity, local models (any OpenAI-compatible endpoint via OpenCode) -- mixed freely. Tier-based routing (cheap / standard / premium) keeps cost governance built in. Cross-provider review is a quality mechanism: a different model, with different blind spots, checks every change. |
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
apra-fleet                   # installs for Claude Code (default)
apra-fleet --llm agy         # or OpenCode/Codex/Copilot/Gemini
cd ~/.apra-fleet/bin && apra-fleet start             # start the apra-fleet
```

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
> [fleet-sprint Getting Started Guide](docs/fleet-sprint-getting-started.md)
> ([HTML](docs/fleet-sprint-getting-started.html) -
> [PDF](docs/fleet-sprint-getting-started.pdf)) -- a plain-English walkthrough
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

- **Fleet server**: the control plane. Registers members, dispatches commands and prompts, moves files, brokers credentials. Speaks MCP, so any MCP-capable agent can drive a fleet.
- **Members**: real machines running provider CLIs. Composes provider-native permissions before every dispatch; unattended modes are scoped, never blanket.
- **Workflow engine**: runs workflow programs with phases, retries, turn budgets, resumable sessions, and per-activity persistent state.
- **Supervisor**: always-on layer -- launch & stop sprints over HTTP, member reservation ledger, crash watchdog, run history.

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
`{{secure.NAME}}` -- resolved server-side at execution, never visible to
any LLM or log. Credentials scope to members, expire on TTL, and can carry
a network egress policy (allow / deny / confirm). Every member runs with
composed, provider-native permission files -- allow-listed tools, not
god-mode. VCS access is provisioned and revocable per member.

## Email Configuration

The fleet supports sending email via **SendGrid** or **SMTP**. Configure the
transport by setting environment variables on the fleet server, using either
environment variables or the credential-store for secrets.

### SendGrid Setup

Set these environment variables or credential-store entries:

```bash
export EMAIL_TRANSPORT=sendgrid
export EMAIL_FROM="noreply@example.com"
export SENDGRID_API_KEY="SG_..."      # or set via: apra-fleet secret --set sendgrid_api_key
```

Or use the credential-store for the API key:
```bash
apra-fleet secret --set sendgrid_api_key    # Prompts for the API key (masked input)
```

Then reference it in your workflow or configuration:
```bash
export SENDGRID_API_KEY="{{secure.sendgrid_api_key}}"
```

### SMTP Setup

For SMTP (port 587 with STARTTLS, or 465 for implicit TLS):

```bash
export EMAIL_TRANSPORT=smtp
export EMAIL_FROM="noreply@example.com"
export SMTP_HOST="smtp.example.com"
export SMTP_PORT=587
export SMTP_USER="user@example.com"
export SMTP_PASS="..."                # or set via credential-store
export SMTP_SECURE=false               # true for port 465 (implicit TLS)
```

Store the password in the credential-store:
```bash
apra-fleet secret --set smtp_password
```

Then reference it in your configuration:
```bash
export SMTP_PASS="{{secure.smtp_password}}"
```

### Workflow Usage

Use `send_email` in your workflow scripts to send messages:

```javascript
import { sendEmail } from '@apralabs/apra-fleet/tools/send-email.js';

export async function main(context) {
  const { log, phase } = context;

  // Simple text email
  phase('Sending notification');
  const result = await sendEmail({
    to: 'recipient@example.com',
    subject: 'Workflow Notification',
    body: 'This email was sent by an apra-fleet workflow.'
  });
  const parsed = JSON.parse(result);
  log(`Email sent: ${parsed.messageId}`);

  // Email with HTML and attachments
  phase('Sending report');
  const resultWithAttachment = await sendEmail({
    to: ['user1@example.com', 'user2@example.com'],
    cc: ['manager@example.com'],
    subject: 'Sprint Report',
    body: 'Please see the attached report.',
    html: '<p>Please see the <strong>attached report</strong>.</p>',
    attachments: [
      {
        filename: 'report.pdf',
        content: 'JVBERi0xLjQKJeLj...',  // Base64-encoded PDF
        contentType: 'application/pdf'
      }
    ]
  });
  const parsedWithAttachment = JSON.parse(resultWithAttachment);
  log(`Report sent: ${parsedWithAttachment.messageId}`);
}
```

### Configuration Location

Fleet user configuration is stored in:

- **Linux/macOS:** `~/.apra-fleet/`
- **Windows:** `%APPDATA%\apra-fleet\`

Environment variables can be set in:
- Fleet server startup environment
- Workflow scripts (per-execution overrides)
- Per-member environment (via fleet registration)

### send_email Tool Reference

The `send_email` tool accepts:

| Parameter | Type | Required | Description |
|---|---|---|---|
| `to` | string or string[] | yes | Recipient email address(es) |
| `subject` | string | yes | Email subject line |
| `body` | string | yes | Plain-text email body |
| `html` | string | no | HTML email body (optional; if provided, sends both text and HTML) |
| `cc` | string[] | no | CC recipient addresses |
| `bcc` | string[] | no | BCC recipient addresses |
| `attachments` | attachment[] | no | File attachments (base64-encoded content) |

Each attachment object contains:
- `filename` (string, required): Name of the file
- `content` (string, required): Base64-encoded file content
- `contentType` (string, optional): MIME type (defaults to application/octet-stream)

Returns: `{ ok: true, messageId }` on success, or `{ ok: false, error }` on failure.

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

## Documentation

| Topic | Link |
|-------|------|
| **fleet-sprint Getting Started Guide (start here, plain English)** | [Markdown](docs/fleet-sprint-getting-started.md) - [HTML](docs/fleet-sprint-getting-started.html) - [PDF](docs/fleet-sprint-getting-started.pdf) |
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
| Secure credentials and passwords | [docs/features/oob-auth.md](docs/features/oob-auth.md) |
| Member category and tags | [docs/features/member-tags.md](docs/features/member-tags.md) |
| Enabling SSH on a remote machine (if it does not have it yet) | [docs/ssh-setup.md](docs/ssh-setup.md) |
| Git authentication | [docs/design-git-auth.md](docs/design-git-auth.md) |
| Cloud compute | [docs/cloud-compute.md](docs/cloud-compute.md) |
| Architecture | [docs/architecture.md](docs/architecture.md) |
| Hub-spoke cloud migration plan (historical; see tier-3 ownership ADR) | [docs/hub-spoke-master-plan.md](docs/hub-spoke-master-plan.md) |
| Tier-3 ownership decision (fleet-dashboard vs `src/hub-service/`) | [docs/adr-tier3-ownership.md](docs/adr-tier3-ownership.md) |
| Shared hub/dashboard API contract package | [packages/fleet-api-contract/README.md](packages/fleet-api-contract/README.md) |
| Workflow engine internals (`agent()`/`parallel()`/`pipeline()`, journal, budget) | [packages/apra-fleet-workflow/docs/apra-fleet-workflow-architecture.md](packages/apra-fleet-workflow/docs/apra-fleet-workflow-architecture.md) |
| Writing and running workflow scripts | [packages/apra-fleet-workflow/docs/workflow-guide.md](packages/apra-fleet-workflow/docs/workflow-guide.md) |
| Authoring a SEA-embedded `apra-fleet workflow` (manifest, entry contract, launcher env vars) | [docs/authoring-workflows.md](docs/authoring-workflows.md) |
| Workflow launcher fleet-server resolution order (HTTP singleton vs. stdio) | [docs/adr-workflow-server-resolution.md](docs/adr-workflow-server-resolution.md) |
| Running fleet-sprint (full flag reference; identical for npm-install, standalone binary, and git-clone dev checkout) | [packages/apra-fleet-se/fleet-sprint/docs/README.md](packages/apra-fleet-se/fleet-sprint/docs/README.md) |
| Auto-sprint overview (autonomous plan-develop-review-publish loop) | [packages/apra-fleet-se/docs/overview.md](packages/apra-fleet-se/docs/overview.md) |
| Auto-sprint CLI reference | [packages/apra-fleet-se/docs/cli-reference.md](packages/apra-fleet-se/docs/cli-reference.md) |
| Auto-sprint internals (cycle loop, stall detection, budget, topology) | [packages/apra-fleet-se/docs/architecture.md](packages/apra-fleet-se/docs/architecture.md) |
| Auto-sprint agent role contracts | [packages/apra-fleet-se/docs/role-contracts.md](packages/apra-fleet-se/docs/role-contracts.md) |
| MCP client SDK overview (transports, `ApraFleet` API) | [packages/apra-fleet-client/docs/overview.md](packages/apra-fleet-client/docs/overview.md) |
| MCP client SDK API reference | [packages/apra-fleet-client/docs/api-reference.md](packages/apra-fleet-client/docs/api-reference.md) |
| MCP client SDK getting started | [packages/apra-fleet-client/docs/getting-started.md](packages/apra-fleet-client/docs/getting-started.md) |

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

See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute.

## License

Apache 2.0 -- see [LICENSE](LICENSE).

---

<div align="center">

**Stop babysitting agents. Start operating fleets.**

[Quick Start](#quick-start-5-minutes) - [GitHub Issues](https://github.com/Apra-Labs/apra-fleet/issues) - [Apra Labs](https://apralabs.com)

</div>
