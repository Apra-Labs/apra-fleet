# Apra Fleet — Competitive Landscape (February 2026)

## The Problem

AI-assisted coding has gone from autocomplete to autonomous agents. But every solution today forces a tradeoff: either you get a single agent locked to one machine, or you get a general-purpose orchestration framework that knows nothing about real infrastructure. None of them give you a fleet of agents running on actual hardware across your network, coordinated through a standard protocol, with persistent state across sessions.

Apra Fleet does.

## The Landscape

### Single-Agent Solutions

**Devin** (Cognition Labs, ~$500/mo) runs a fully autonomous agent inside its own sandboxed VM. Impressive end-to-end autonomy — but opaque orchestration, single-agent only, and you don't own the infrastructure. When you need five agents working in parallel across different machines and operating systems, Devin doesn't have an answer.

**GitHub Copilot Coding Agent** scopes work to a single PR in a cloud container. Good for isolated tasks, but no multi-agent coordination and no access to your own machines. It runs where GitHub decides, not where your code lives.

### Same-Machine Parallelism

**Claude Code Agent Teams** (Anthropic, research preview) is the closest conceptual cousin. A lead agent spawns teammates that work in parallel on the same codebase. But "same codebase" means same machine — there's no SSH, no cross-platform support, no persistent agent registry. Teammates coordinate via task files on disk and disappear when the session ends. For local parallelism on a single workstation, it works. For a distributed fleet running around the clock, it doesn't scale.

### General-Purpose Orchestration Frameworks

**CrewAI** and **MetaGPT** model multi-agent workflows with role-based coordination (PM, developer, QA). They're popular and open source, but they operate at the framework layer — you still need to wire them to actual machines, shells, file systems, and SSH connections yourself. They don't know how to talk to a Windows box via PowerShell or provision OAuth credentials on a remote Linux server.

**LangGraph** takes a graph-based approach to agent orchestration with conditional logic and multi-team coordination. Fast (2.2x faster than CrewAI in benchmarks), but again — no infrastructure layer. It orchestrates abstract agents, not real machines.

**Microsoft Agent Framework** (public preview) merges AutoGen and Semantic Kernel into a unified SDK with A2A protocol and MCP support. Enterprise-grade and well-resourced, but general-purpose. Building a coding-specific fleet on top of it would mean reimplementing most of what Apra Fleet already provides.

### Claude Code Swarm Tools

**Ruflo**, **Gas Town**, and **Multiclaude** are community-built orchestrators for running Claude Code in parallel. They vary in maturity and are typically single-machine tools that wrap Claude Code's CLI — not distributed systems with cross-platform infrastructure, persistent state, and protocol-level integration.

## Where Apra Fleet Sits

| Capability | Apra Fleet | Agent Teams | Devin | CrewAI / MetaGPT | MS Agent Framework |
|---|---|---|---|---|---|
| Distributed agents via SSH | Yes | No | No (own VMs) | No | No |
| Cross-platform (Win / Mac / Linux) | Yes | Same-machine | Linux | N/A | N/A |
| Direct shell execution | Yes | Via Claude only | Yes | Varies | Varies |
| MCP-native (is a server) | Yes | Consumes MCP | No | No | Consumes MCP |
| Persistent agent registry | Yes | No | Yes | No | No |
| Open source | Yes | Built-in | No | Yes | Yes |
| Coordinated multi-agent work | Yes (Project Manager) | Yes (lead/teammate) | No | Yes (roles) | Yes (A2A) |
| Run on your own hardware | Yes | Yes | No | Yes | Yes |
| Auth provisioning (OAuth/API key) | Yes | N/A | N/A | N/A | N/A |

## The Differentiation

Apra Fleet is the only solution that combines:

1. **Real infrastructure** — SSH connections to actual machines you own, with connection pooling, TOFU host key verification, and cross-platform command abstraction (bash, zsh, PowerShell).

2. **MCP-native architecture** — Apra Fleet is an MCP server, not a wrapper around one. Any MCP client (Claude Code, Copilot, custom tooling) can drive the fleet through a standard protocol. This means the fleet is composable with every other MCP tool in the ecosystem.

3. **Persistent state** — Agents are registered once and persist across sessions. Work folders, session IDs, OS detection, auth credentials — all stored and reusable. No re-setup on every run.

4. **Dual execution model** — `execute_prompt` for tasks that need Claude's reasoning (code analysis, architecture decisions, multi-step problem solving) and `execute_command` for direct shell operations (installs, builds, tests, deploys). Use the right tool for the job without paying Claude API costs for `npm install`.

5. **Project Manager coordination** — A dedicated orchestration layer that decomposes work, assigns tasks to agents based on capability, tracks progress, and synthesizes results. Not a generic agent framework — purpose-built for coordinated software development across a fleet.

6. **Heterogeneous fleets** — A single fleet can span Windows workstations, Linux servers, and macOS build machines. The OsCommands strategy pattern handles platform differences transparently. No other multi-agent coding tool supports this.

## The Vision

The trajectory of AI-assisted development points clearly toward teams of agents working continuously on well-decomposed tasks, with human oversight at the architectural level. The infrastructure for this needs to be distributed (agents on real machines), persistent (state survives sessions), protocol-native (composable with the MCP ecosystem), and cross-platform (the real world isn't all Linux).

Apra Fleet is that infrastructure.
