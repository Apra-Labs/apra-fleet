# Apra Fleet

## The Story

It's 11pm. You've had a long day — meetings, architecture decisions, a production incident. Before you close your laptop, you type two paragraphs into a markdown file. Requirements for the next feature. The constraints. The edge cases that keep you up at night. You save, type `/pm plan`, and go to sleep.

At 7am, your phone buzzes. A pull request. You open it over coffee.

Twelve tasks completed across three machines. A phased plan was generated, challenged by a reviewer against 12 quality criteria, revised, and approved — all before a single line of code was written. Then two agents executed in parallel on separate branches while a third independently reviewed each checkpoint — cumulative review, not just the latest diff. 600 tests passing. CI green. Deployed to staging.

You spent 5 minutes writing requirements. Your fleet spent 6 hours executing. You review the PR, click merge, and move on to the next thing.

This is not a demo. This is a Tuesday.

---

## Built on Open Standards

Apra Fleet is built on two open standards governed by the **Linux Foundation's Agentic AI Foundation (AAIF)**:

- **MCP (Model Context Protocol)** — the universal protocol connecting AI agents to external tools and infrastructure. The USB-C of AI.
- **Agent Skills (agentskills.io)** — the open specification for packaging domain expertise that agents can discover, load, and execute. Write once, run on any compliant agent.

Any agentic coding system that implements the [Agent Skills specification](https://agentskills.io/specification) and [MCP](https://aaif.io/) can run Apra Fleet — today that includes Claude Code, GitHub Copilot, OpenAI Codex, Cursor, and every future agent that adopts these standards.

**You are not buying into a vendor. You are buying into an architecture.**

---

## The Command Center

Picture your workspace right now. You have 50 repositories in `c:\git\`. Each one needs maintenance — dependency updates, bug fixes, feature work, security patches. Today, you manage them with a chaos of tools: VS Code windows, TeamViewer sessions, VNC connections, Remote Desktop tabs, SSH terminals. Alt+Tab. Alt+Tab. Alt+Tab. All day. Every context switch costs you 20 minutes. By 5pm you touched 3 repos and neglected 47.

**Now picture a cockpit.**

One terminal. One command center. Fifty agents — each assigned to a repository, each with its own session, its own branch, its own progress tracker. You type a command. An agent spins up, reads the repo's CLAUDE.md, understands the codebase, and starts working. You type another command. Another agent, another repo. You're not alt-tabbing between windows. You're dispatching missions.

```
/pm status fleet              — see all 50 agents at a glance
/pm plan auth-service          — generate a plan for the auth rewrite
/pm start payments-api fix-42  — kick off bug fix on payments
/pm deploy frontend            — ship the latest build
```

The agents are your minions. They work in parallel. They report back. They stop at checkpoints and wait for your approval. You are not managing windows. You are commanding a fleet.

**This is not a metaphor. This is the architecture.**

Local agents share your machine. Remote agents run on cloud VMs, Mac minis, Linux boxes — anywhere SSH reaches. Mix and match. A Windows agent builds the .NET service while a Linux agent runs the Docker integration tests while a Mac agent builds the iOS SDK. All from one terminal. All reporting to one PM.

---
## For Engineers: "You're Not Slow. You're Outnumbered."

You write code all day. But how much of your day is actually writing code?

You set up a branch. You write 200 lines. You open a PR. You wait for review. You address comments. You rebase because main moved. CI breaks on a flaky test. You fix it. You wait for re-review. Three days for 200 lines. Meanwhile, your backlog has 47 items and your manager wants an estimate. You lie.

The problem isn't your speed. It's that you're one person doing the work of a team — writing, reviewing, testing, deploying, context-switching between all of it — and every switch costs you 20 minutes of mental reload.

**What if you had an engineering team that worked while you didn't?**

Apra Fleet turns your laptop into a fleet. Register multiple agents on the same machine — or spread them across a Mac, a Linux box, a cloud VM. Each agent gets its own working directory, its own git branch, its own persistent session that survives crashes and restarts. Ten agents on one laptop? Works. Twenty agents across five machines? Also works.

You describe what you want. The PM generates a phased plan with risk-first ordering. A separate reviewer agent challenges the plan against 12 quality criteria — done criteria, hidden dependencies, riskiest-assumption-first. When the plan passes, doers start executing in parallel on separate branches. A reviewer inspects every checkpoint independently — cold review, no shared context with the doer, no confirmation bias.

You come back. PRs are waiting. Tests are green. You approve and move on.

**10+ agents on a single machine or across Windows, macOS, and Linux. Doer-reviewer pairs that enforce real code review. Git as the transport — crash recovery in one command. You operate at the "what to build" level. Everything below that is handled.**

The engineers who adopt this don't go back. Not because it's faster — because they stop drowning.

---

## For CTOs & VPs of Engineering: "Your Best Engineers Are Doing Their Worst Work."

Your $200K senior engineers — the ones who understand your architecture, your customers, your decade of technical debt — are spending 70% of their time on work that requires zero judgment. Writing CRUD endpoints. Updating test fixtures. Reviewing boilerplate PRs. Rebasing. Waiting for CI. Attending standups about work they could have done in the time the standup took.

The other 30% is the work that actually moves the needle: architecture decisions, system design, requirement negotiation, mentoring. The work you hired them for. The work they never have time for.

**Apra Fleet inverts that ratio.**

It's an open-source MCP server and PM skill that turns AI coding agents into a managed engineering organization. Not a copilot. Not an autocomplete. An organization with structure, process, and accountability:

- A **PM** that plans sprints, decomposes work into phased tasks, assigns doer-reviewer pairs, tracks progress in real-time, handles deployments — and never writes or reads a single line of code. It manages by structured signals: test results, review verdicts, progress metrics. Like the best human PM you've ever worked with, except it never takes a day off.

- **Doers** that execute on your machines, your repos, your CI pipelines. Not in someone else's cloud — on infrastructure you control. Scale to 10, 15, 20 agents — all on one machine or spread across any mix of operating systems. Each agent is an isolated working directory with its own session. Each with role-scoped permissions — a doer can write code but can't merge to main. A reviewer can read and test but can't edit source files.

- **Reviewers** that inspect every change independently. Different machine. Different context. Cumulative review across all phases — not just the latest diff. Tests must pass. CI must be green. APPROVED or CHANGES NEEDED. The PM itself cannot override Rule 12: no reviewer approval, no merge. No exceptions. Ever.

**The economics are devastating — in your favor.** Smart model routing means cheap models handle commands, mid-tier models write code, and premium models handle architecture and review — automatically. A fleet of 10 agents running a full sprint costs less than your team's daily lunch. One sprint that took your team two weeks? The fleet does it overnight. Not because AI is smarter — because AI doesn't attend meetings, doesn't context-switch, and runs 10 streams in parallel while your team works sequentially.

**What's different from everything else on the market?**

Every tool in this space falls into one of two categories:

- **"Better autocomplete"** — Cursor, Windsurf, Copilot. They help one developer type faster. Your organization doesn't have a typing speed problem.
- **"Autonomous task runner"** — Devin, Codex. They take one task and run it in a cloud sandbox you don't control. Your security team said no.

**Apra Fleet is a third category: an AI-native engineering organization that runs on your infrastructure, follows your process, and scales with your ambition.**

- Devin runs in their cloud. Fleet runs on your machines.
- Cursor helps one developer. Fleet is a development team.
- CrewAI is a framework — you build everything from scratch. Fleet is a working system — plan, execute, review, deploy on day one.
- No other tool does doer-reviewer pairs with independent sessions, real git PRs, and mandatory approval gates.

**The paradigm shift:** Your senior engineers become technical directors. They write requirements, approve architectures, and sign off on merges. The AI organization handles implementation. Your $200K engineers finally do $200K work.

---

## For Project Managers: "You Built the Process. Nobody Follows It."

Let's be honest about what happens in your organization.

How many PRs got merged last month without a proper review? How many "quick fixes" bypassed the branch protection rules someone spent a week configuring? How many times did a developer say "I'll add tests later" — and later never came?

You built the process. You documented it in Confluence. You configured Jira workflows. You set up branch protection. You gave the "why we do code reviews" talk at the all-hands. And your team still cuts corners — not because they're bad engineers, but because they're human, they're under pressure, and the process feels like friction against their actual goal of shipping code.

**What if your team physically could not skip a step?**

Apra Fleet is a project management system where the workers are AI agents. And these agents don't cut corners. They can't. The process is their operating system:

- **No plan, no code.** Every sprint starts with a structured plan that gets reviewed by a separate AI against 12 quality criteria. Clear done criteria? Risk-first ordering? Dependencies satisfied? Hidden assumptions exposed? CHANGES NEEDED means back to the drawing board. The doer cannot write a single line until the plan is APPROVED. This has never been skipped. It cannot be skipped.

- **No review, no merge.** Every 2-3 tasks, execution stops at a verify checkpoint. A reviewer agent — running in a separate session with a completely different context, having never seen the doer's reasoning — inspects all code cumulatively. Not just the latest change. Everything from the start. Every test must pass. CI must be green. APPROVED or CHANGES NEEDED. The PM itself cannot override Rule 12: no reviewer approval, no merge. No exceptions. Ever.

- **No standup needed.** `progress.json` shows exactly which task each agent is executing right now. `status.md` shows sprint phase, blockers, pair assignments, session history. You don't chase people for updates. You read the file.

- **No "we lost context."** The PM crashes at 3am? Run `/pm recover`. It inspects every member's git state — commits, working tree, progress tracker — and tells you exactly where things stand. Resume, discard, or re-dispatch. Git is the transport. Nothing is ever lost.

**Scale without chaos.** Run 10 doer-reviewer pairs — on one machine or across 20. Each pair works independently — its own branch, its own scope, its own review cycle. The PM coordinates across all of them. Permissions grow smarter each sprint. Backlogs sync from GitHub issues. Deploy runbooks execute step-by-step with verification at each stage.

**The result nobody expected:** The AI team doesn't just follow your process. It follows your process better than any human team ever has. Every plan reviewed. Every checkpoint verified. Every change audited. Every sprint recoverable. Every rule enforced without exception, without reminder, without nagging.

**Your role transforms.** You stop policing process compliance. You stop chasing updates. You stop being the "did you write tests?" person. You define what to build, prioritize the backlog, and approve the outcomes. For the first time in your career, the process actually runs itself — and it runs perfectly.

---

## Story: The Weekend Rewrite

Friday 6pm. Your CTO says: "We need to migrate the auth module from Express to Fastify. Monday morning."

Old world: You cancel your weekend. You write code Saturday, self-review Sunday, pray the tests pass, push a monster PR Monday morning and hope someone rubber-stamps it.

Fleet world: You write 3 paragraphs of requirements. Constraints, edge cases, backward compatibility rules. You type `/pm plan`. Ten minutes later, a 14-task phased plan comes back. A reviewer agent checks it — finds a hidden dependency in Task 6. Plan revised. Approved.

You type `/pm start`. Four doer agents spin up on your machine. One handles route migration. Another handles middleware. A third writes tests. A fourth updates documentation. A reviewer agent inspects every checkpoint. By midnight, a PR is waiting: 14 tasks completed, 400+ tests passing, reviewer APPROVED.

You spend Saturday with your family. You spend Sunday with your family. Monday morning you review the PR over coffee, merge, and tell your CTO it's done.

**That's not work-life balance. That's leverage.**

---

## Story: The Solo Founder

You're building a SaaS product. Alone. You're the CEO, the PM, the designer, the frontend dev, the backend dev, the DevOps engineer, and the customer support rep. Your to-do list has 200 items. You ship 3 per week. At this rate, your runway runs out before your product is ready.

With Apra Fleet, you write requirements like a PM — because that's what you are. The fleet handles implementation:

- Monday: You describe the billing integration. Fleet ships it overnight. You review Tuesday morning.
- Tuesday: You describe the onboarding flow. Fleet ships it overnight. You review Wednesday morning.
- Wednesday: You describe the admin dashboard. Fleet ships it overnight.

By Friday, you've shipped 5 features. You wrote zero lines of code. You spent your time talking to customers, refining requirements, and approving PRs. The fleet wrote 3,000 lines, ran 500 tests, and got every change independently reviewed.

**You're not a developer who can't hire. You're a founder with an engineering department.**

---

## Story: The Cross-Platform Nightmare

Your product runs on Windows, macOS, and Linux. Every feature needs testing on all three. Today that means: build on your laptop, push, wait for CI, SSH into the Mac, check the build, SSH into the Linux box, check the build. Three machines, three terminals, three mental contexts. When something fails on Linux but passes on Windows, you're debugging in two SSH sessions while your IDE shows the wrong branch.

With Apra Fleet, you register all three machines as fleet members. One command:

`/pm start cross-platform-test`

Three agents spin up simultaneously — one on Windows, one on macOS, one on Linux. Each builds, runs the full test suite, and reports back. The PM aggregates results: "Windows: 500 passed. macOS: 500 passed. Linux: 498 passed, 2 failed — here's the diff." You fix the two Linux failures. The fleet re-runs.

**Three platforms. One terminal. Zero SSH.**

---

## Story: The 3am Recovery

Your PM agent crashes at 3am. It was mid-sprint — 8 of 12 tasks complete, two agents executing, one reviewer waiting.

Old world multi-agent tools: Everything is lost. In-memory state gone. Agents orphaned. Start over.

Fleet world: You wake up. You type `/pm recover focus-app`. The PM inspects every agent's git state — commits, working tree, progress tracker. It reports:

```
focus-dev1: Task 9 committed but not pushed. Resume?
focus-dev2: Task 8 complete, checkpoint reached. Trigger review?
focus-rev2: Waiting for checkpoint. Dispatch?
```

You type "yes, yes, yes." The sprint continues from exactly where it stopped. Nothing lost. Nothing repeated. Git is the transport — every task is a commit, every checkpoint is a push.

**Other tools give you speed. Apra Fleet gives you resilience.**

---
## Competitive Positioning

### What Only Apra Fleet Can Do

1. **Persistent AI Project Manager** orchestrating fleets of AI coding agents — multiple agents on one machine or across many, local or via SSH — at any scale. No other tool has this.

2. **First-class doer-reviewer pairing** where separate agents perform structured code review with real git PRs. No self-review. No simulated QA. Genuine independent verification with mandatory approval gates.

3. **Full infrastructure provisioning** from a single orchestrator — SSH keys, agent credentials, VCS auth (GitHub App short-lived tokens, Bitbucket, Azure DevOps), and role-scoped permissions that grow smarter each sprint.

4. **Persistent project state** that survives sessions, sprints, crashes, and restarts — as version-controlled markdown backed by git. Not in-memory. Not per-session. Durable.

5. **Both the project manager AND the engineering team** — it plans sprints, writes code, reviews changes, and deploys to production. No other tool bridges project management and code execution.

### The Paradigm

| Category | Tools | What They Do | What's Missing |
|----------|-------|-------------|----------------|
| Better autocomplete | Cursor, Windsurf, Copilot, Cline | Help one developer type faster | Organization, process, scale |
| Autonomous task runner | Devin, Codex, OpenHands | Run one task in a sandbox | Your infrastructure, your process, your repos |
| Multi-agent framework | CrewAI, AutoGen, LangGraph, MetaGPT | Framework to build from scratch | Working system, git workflows, real PRs |
| **AI-native engineering org** | **Apra Fleet** | **Runs projects on your infra with process** | — |

### Production Numbers (not benchmarks — real work shipped)

| Metric | Value |
|--------|-------|
| Active users | 4 members across 3 organizations |
| Production duration | 3+ weeks of daily use |
| Projects managed | 5+ simultaneous projects |
| Backlog items processed | 100+ |
| Sprints delivered | ~20 complete sprints |
| Human decisions per sprint | ~3 (approve plan, approve review, approve merge) |
| Plan to production | Same day |

### Languages & Domains in Production

This is not a Node.js demo. Apra Fleet has shipped real work across:

- **C++** — systems programming, CMake builds, cross-platform compilation
- **Node.js** — full-stack web applications, React frontends, Express/Fastify APIs
- **C#/.NET** — enterprise application development
- **Python** — automation, scripting, tooling
- **Machine Learning** — training models on AWS cloud VMs (agent running on remote EC2 instance)
- **Video Processing** — H.265 codecs, WebRTC streaming, video pipeline development
- **Production Debugging** — log analysis on live BBNVR devices via remote agents
- **Cross-platform CI/CD** — GitHub Actions, Azure DevOps pipelines

### Who's Using It

**Akhil (Apra Labs)** — 5+ projects, 100+ backlog items, ~20 sprints. C++, Node.js, C#, Python. Production debugging on live devices. The PM that wrote these pitches while agents shipped code overnight.

**Kashyap** — AWS cloud VM agents training machine learning models. Running agents on EC2 instances via SSH. Pull request pending for cloud VM optimizations.

**Yashraj** — Video processing pipeline development. H.265 codec work, WebRTC streaming, video transcoding. Agents handling codec-level C++ alongside high-level pipeline orchestration.

**4th member** — Active user, onboarded and shipping.

### The Pattern

Every one of these users started the same way: skeptical, then surprised, then dependent. The moment you write requirements at 11pm and wake up to a reviewed PR, you don't go back to writing code yourself. You go back to writing *better requirements*.

---

*Built on AAIF open standards (MCP + Agent Skills). Works with any compliant agentic coding system. No vendor lock-in.*

*Open source. CC BY-SA 3.0 license.*
