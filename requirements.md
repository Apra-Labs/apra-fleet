# Requirements -- apra-fleet Knowledge Bank (shared, persistent learning store)

## Base Branch
`main` -- branch to fork from and merge back to.
Sprint branch: `feat/knowledge-bank`.

## Goal
Add a persistent, shareable knowledge bank to apra-fleet so that learnings,
project knowledge, runbooks, and cached project context accumulated by fleet
agents are stored durably, kept fresh, and shared across team members through a
central remote service -- instead of living only in one user's local files or
being re-derived every session.

## Background / Existing Systems (the doer must investigate these first)
apra-fleet already ships two persistence layers. The design must explicitly
decide how the knowledge bank relates to each (reuse, extend, or stand alone):
- **Beads** (`bd` CLI) -- a Dolt-backed persistent task DB shared across sprints
  and members. Already supports versioned data and potential push/pull sync.
- **Memory system** -- per-user `MEMORY.md` + `memory/*.md` files (Claude Code
  memory). Currently local and single-user; not team-shared.
The `/learn` skill (gstack) also manages project learnings across sessions --
review for overlap.

## Scope
1. **Knowledge content types** -- the bank must hold all of:
   - **Agent learnings** -- mistakes, fixes, gotchas, and patterns agents
     discover while working (e.g. "build fails on Windows unless X").
   - **Project knowledge** -- architecture decisions, domain rules, conventions,
     design rationale (durable facts about the codebase/product).
   - **Runbooks / how-tos** -- operational procedures (deploy steps, debug
     procedures, setup).
   - **Cached project context** -- a representation of files/modules an agent has
     already read and understood, so agents can AVOID re-reading unchanged files
     every session. Must include a staleness/invalidation mechanism: when the
     underlying file changes (mtime/hash/commit), the cached context for it is
     marked stale and must be refreshed before reuse.

2. **Central remote DB/service for sharing** -- the shared bank lives in a
   central remote service that all fleet members can read from and write to, so
   team members share one knowledge base. Design must cover: the backend choice,
   connection/transport, and how members are pointed at it.

3. **Two-tier capture model (auto local + gated to share)**:
   - **Auto local layer** -- agents capture learnings/context automatically into
     a local store as they work, no gate (fast, low-friction).
   - **Gated shared layer** -- promotion of a local entry into the central shared
     bank requires a review/approval step (quality gate) before it is visible to
     the team.

4. **Read/query path** -- agents must be able to query the bank (local + shared)
   to retrieve relevant knowledge and cached context at the start of / during a
   task. Retrieval relevance approach is part of the design.

5. **Access & identity** -- who can read vs. write vs. approve promotions; how a
   member/team is identified against the central service.

## Out of Scope (unless the design justifies otherwise)
- A full web UI for browsing the knowledge bank -- CLI/programmatic access first.
- Cross-organization/public sharing -- this is team-internal.
- Migrating historical learnings from existing ad-hoc notes -- greenfield store;
  migration can be a follow-up.

## Constraints
- ASCII only: never write non-ASCII characters to any file (project rule).
- Branch naming: feat/<topic>; never push to main directly; open a PR.
- Commit style: <type>(<scope>): <description>.
- Must fit apra-fleet's architecture (TypeScript, single-binary build, MCP
  server) -- see docs/architecture.md.
- Definition of done includes a security audit (central service => auth,
  secrets, network egress, access control) and documentation.

## Riskiest Assumptions (validate FIRST in the plan -- front-loaded)
1. **Central remote service is viable within apra-fleet's deployment model.**
   apra-fleet members are local/remote machines using an MCP stdio server. A
   shared central service implies networked backend + auth + availability. Task 1
   of the plan MUST validate the architecture: where the service runs, transport,
   auth, and offline/degraded behavior -- before any feature code.
2. **Cached project context with reliable staleness invalidation is achievable.**
   Stale context served as fresh is a correctness hazard (agent acts on outdated
   file understanding). The invalidation signal (hash vs mtime vs git) must be
   proven sound early.
3. **Foundation choice (extend Beads vs memory system vs new).** Picking wrong
   means rework. The doer must investigate and justify the recommendation in
   design.md with trade-offs, before implementation.

## Acceptance Criteria
- [ ] design.md recommends a foundation (Beads / memory / new) with explicit
      trade-offs, and an architecture for the central remote service (backend,
      transport, auth, offline behavior).
- [ ] Knowledge bank stores all four content types (agent learnings, project
      knowledge, runbooks, cached project context).
- [ ] Cached project context is invalidated automatically when source files
      change (demonstrated staleness detection).
- [ ] Two-tier capture works: auto local capture + a review-gated promotion to
      the shared central bank.
- [ ] Agents can query and retrieve relevant knowledge/context from local+shared.
- [ ] Access control + identity model defined and enforced for the central
      service.
- [ ] Security audit completed; documentation added.
