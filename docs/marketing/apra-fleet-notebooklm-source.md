# Apra Fleet — Source Document for Video Overview

## What Is Apra Fleet?

Apra Fleet is an open-source system that transforms AI coding agents into a managed engineering organization. Instead of one AI assistant helping one developer type faster, Apra Fleet gives you a complete AI engineering team — with a project manager, multiple developers, and independent code reviewers — all orchestrated from a single terminal.

Think of it this way: every other AI coding tool falls into one of two categories. "Better autocomplete" tools like Cursor and Copilot help one developer type faster. "Autonomous task runners" like Devin run one task in someone else's cloud. Apra Fleet is a third category entirely: an AI-native engineering organization that runs on your own machines, follows your own process, and scales with your ambition.

## The Problem It Solves

Senior software engineers — the ones who understand your architecture, your customers, your decade of technical debt — spend 70% of their time on work that requires zero judgment. Writing CRUD endpoints. Updating test fixtures. Rebasing branches. Waiting for CI pipelines. Attending standup meetings. The remaining 30% is the work that actually moves the needle: architecture decisions, system design, requirement negotiation, mentoring. That's the work you hired them for. That's the work they never have time for.

The typical engineer's day looks like this: set up a branch, write 200 lines of code, open a pull request, wait for review, address comments, rebase because main moved, CI breaks on a flaky test, fix it, wait for re-review. Three days for 200 lines. Meanwhile the backlog has 47 items and the manager wants an estimate.

The problem isn't the engineer's speed. It's that one person is doing the work of a team — writing, reviewing, testing, deploying, context-switching between all of it — and every switch costs 20 minutes of mental reload.

## How Apra Fleet Works

Apra Fleet has three core components that work together:

First, there is the PM Agent. This is a persistent AI project manager that plans sprints, decomposes work into phased tasks with risk-first ordering, assigns doer-reviewer pairs, and tracks progress in real time. The PM orchestrates every phase of the development lifecycle — requirements gathering, architecture design, implementation, testing, integration, and deployment — but it never writes or reads a single line of code itself. It manages by structured signals: test results, review verdicts, progress metrics. It's like the best human PM you've ever worked with, except it never takes a day off.

Second, there are Doer Agents. These execute code on your machines, your repositories, your CI pipelines. Not in someone else's cloud — on infrastructure you control. You can run 10, 15, even 20 agents simultaneously, all on one machine or spread across any mix of Windows, macOS, and Linux. Each agent gets its own working directory, its own git branch, and its own persistent session that survives reboots and session changes. Permissions are role-scoped — a doer can write code but cannot merge to main.

Third, there are Reviewer Agents. This is where the core mental model becomes clear: every AI agent is noisy by nature. Left unchecked, a single bot will drift, make assumptions, and cut corners — just like a human under pressure. The doer-reviewer pattern is Apra Fleet's answer to this fundamental reality. Every doer is paired with an independent reviewer that acts as a counterbalancer, bringing rigor to the process.

And this applies to everything, not just code. The reviewer challenges the plan before a single line is written — are the requirements clear? Are the done criteria testable? Are dependencies satisfied? Is the architecture sound? During execution, the reviewer inspects code cumulatively across all phases, not just the latest diff. During integration testing, the reviewer verifies end-to-end behavior, not just unit tests. The verdict is always binary: APPROVED or CHANGES NEEDED. The PM itself cannot override the mandatory approval rule. No exceptions. Ever.

This is the fundamental insight: one bot planning and one bot reviewing the plan produces dramatically better results than one bot doing both. One bot writing code and a different bot reviewing it — with completely separate context, no shared memory, no confirmation bias — catches the errors that self-review always misses. The doer-reviewer loop is not a feature. It is the architecture.

## A Typical Day with Apra Fleet

Here's what a real Tuesday looks like for an Apra Fleet user:

At 5pm, you wrap up your last meeting. Before heading out, you spend five minutes typing two paragraphs into a markdown file. Requirements for the next feature. The constraints. The edge cases you've been thinking about all day. You save, type the plan command, and leave for the evening.

By 5:10pm, the PM has generated a 14-task phased plan. A reviewer agent challenges it against 12 quality criteria — not just the plan itself, but the requirements, the architecture assumptions, and the risk ordering. The plan is revised and approved — all automatically.

By 5:15pm, four doer agents are dispatched in parallel on separate branches. A reviewer agent is on standby. You're at dinner with your family.

Overnight, the fleet works. At some point, a Windows update reboots one of your machines — Murphy's Law in action. But that's fine. Every task is a git commit, every checkpoint is a push. The project state is fully persistent. When the machine comes back, the agent picks up exactly where it left off.

At 7am, your phone buzzes. A pull request is waiting. You open it over coffee. Twelve tasks completed across three machines. 600 tests passing. CI green. Reviewer APPROVED.

At 7:05am, you review the PR, click merge, and move on to the next thing. You spent 5 minutes writing requirements. Your fleet spent 14 hours executing. You spent the evening with your family. That's leverage.

## Production Numbers

These are real production numbers from daily use, not benchmarks:

Four active users across three organizations have been using Apra Fleet for over three weeks of daily production use. The system has managed five simultaneous projects and processed over 100 backlog items through approximately 20 complete sprints. Each sprint requires only about three human decisions: approve the plan, approve the review, approve the merge. Work goes from plan to production on the same day.

The system has been battle-tested across C++, Node.js, C-sharp and .NET, Python, machine learning training on AWS cloud VMs, video processing with H.265 codecs and WebRTC streaming, production debugging on live devices, and CI/CD across GitHub Actions and Azure DevOps.

## Built on Open Standards

Apra Fleet is built on two open standards governed by the Linux Foundation's Agentic AI Foundation: MCP (Model Context Protocol), which is the universal protocol connecting AI agents to external tools, and Agent Skills, which is the open specification for packaging domain expertise that agents can discover and execute.

Any agentic coding system that implements these specifications can run Apra Fleet — today that includes Claude Code, GitHub Copilot, OpenAI Codex, Cursor, and every future agent that adopts these standards. You are not buying into a vendor. You are buying into an architecture.

## The Paradigm Shift

Apra Fleet inverts the ratio of how senior engineers spend their time. Instead of 70% implementation and 30% strategy, engineers become technical directors. They write requirements, approve architectures, and sign off on merges. The AI organization handles implementation. Your $200K engineers finally do $200K work.

The engineers who adopt this don't go back. Not because it's faster — because they stop drowning.

## About Apra Labs

Apra Fleet was created by Apra Labs, a 54-person company specializing in video processing, computer vision, AI, and edge computing. With offices in Bedford New Hampshire, Bangalore, and Dubai, the team has over 30 years of experience in embedded systems, biometrics, and enterprise software. Their open-source framework ApraPipes is used in production NVR systems on NVIDIA Jetson devices. They built Apra Fleet because they manage 50+ repositories across Windows, Linux, macOS, and Jetson, and needed a system that could orchestrate AI agents across all of them from one terminal. They built it for themselves. It worked. Now they're sharing it.

Apra Fleet is open source under the CC BY-SA 3.0 license.
