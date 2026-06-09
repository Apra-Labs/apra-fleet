# Knowledge Bank -- Design Document

## Problem Statement

Fleet agents accumulate valuable knowledge as they work -- mistakes, fixes,
gotchas, architecture decisions, operational procedures, and deep understanding
of project files. Today this knowledge is lost between sessions or siloed in
one user's local memory files. There is no shared, persistent store that lets
team members build on each other's discoveries.

The Knowledge Bank adds a persistent, shareable knowledge store to apra-fleet.
It stores four content types, keeps cached context fresh via staleness
detection, and shares knowledge across team members through a central remote
service -- so agents stop re-deriving what the team already knows.

### Four Content Types

| Type | Description | Example |
|------|-------------|---------|
| **Agent learnings** | Mistakes, fixes, gotchas, patterns discovered during work | "Build fails on Windows unless MSVC_CRT is set" |
| **Project knowledge** | Architecture decisions, domain rules, conventions, design rationale | "We chose Dolt over SQLite for version history" |
| **Runbooks / how-tos** | Operational procedures: deploy steps, debug guides, setup | "To provision a new GPU member: ..." |
| **Cached project context** | File/module summaries so agents skip re-reading unchanged files | Summary of src/services/registry.ts at hash a1b2c3 |

---

## Foundation Recommendation

### Options Evaluated

**Option A: Extend the Memory System** (MEMORY.md + memory/*.md)

- Pros: Already exists, simple markdown files, no new deps.
- Cons: Claude Code-internal -- no programmatic API from MCP tools, no
  structured query, no sync/sharing, single-user only. Would require building
  a query engine, sync layer, and schema system from scratch on top of flat
  markdown files. The memory system has no concept of types, metadata, or
  access control.
- Verdict: Foundation is too thin. Extending it into a shared knowledge DB
  would be a rewrite, not an extension.

**Option B: Build a New Standalone Subsystem**

- Pros: Clean-slate design, no legacy constraints.
- Cons: Introduces a new persistence layer (DB choice, schema migrations,
  query engine) when one already exists. Duplicates federation/sync that Beads
  already provides. Adds a new dependency to the single-binary build. Violates
  the project constraint "no unjustified new deps."
- Verdict: High cost, low benefit when Beads already exists.

**Option C: Extend Beads** (RECOMMENDED)

- Pros:
  - **Wisps** map directly to auto-local capture (ephemeral, dolt_ignored,
    fast, no gate).
  - **`bd promote`** maps directly to the review-gated promotion step (wisp
    to permanent Dolt-versioned bead).
  - **Federation** provides the central remote sync layer (Dolt P2P with
    conflict resolution strategies).
  - **`--metadata`** (JSON) stores file hashes, source paths, and other
    structured data per entry.
  - **`--labels`** provides content-type tagging.
  - **`--actor`** provides identity/audit trail.
  - **`bd search`** and **`bd query`** provide full-text and structured search.
  - Beads is already installed by `apra-fleet install`.
  - The PM skill already uses `bd` via Bash -- established pattern.
- Cons: Couples knowledge bank to Beads. If Beads changes its schema or CLI,
  the knowledge bank is affected. Beads is a separate npm package, not inlined
  in apra-fleet's TypeScript code.
- Mitigation: Wrap all Beads interaction in a single service module
  (`src/services/knowledge-bank.ts`) so the coupling surface is narrow and
  swappable.

**Recommendation: Option C -- Extend Beads.**

The existing Beads primitives (wisps, promote, federation, metadata, labels,
actor, search) map one-to-one onto the knowledge bank requirements. Building
on Beads avoids inventing a sync protocol, schema system, and query engine
that already exist and are battle-tested in the PM skill workflow.

---

## Central Remote Service Architecture

### Overview

The Knowledge Bank does NOT introduce a new server process. Instead it uses
Beads' existing Dolt federation layer in a **hub-and-spoke** topology:

```
Fleet Master A                    Central Dolt Remote
(local Beads KB)  ---sync--->  (DoltHub / self-hosted /
                                SSH-accessible Dolt remote)
Fleet Master B    ---sync--->     ^
(local Beads KB)                  |
                                  |
Fleet Master C    ---sync--->-----+
(local Beads KB)
```

Each team member's fleet master maintains a **local Beads database** for the
knowledge bank (separate from the PM task DB). The central remote is a
**Dolt remote** that all members federate with.

### Where It Runs

Three deployment options (team chooses one):

1. **DoltHub** (managed) -- zero-ops, HTTPS transport, DoltHub account for auth.
   Best for distributed teams.
2. **Self-hosted Dolt server** -- runs on any machine with network access.
   MySQL-compatible wire protocol. Best for on-prem teams.
3. **SSH-accessible Dolt remote** -- a bare Dolt repo on any server reachable
   via SSH. Fleet already has SSH infrastructure to every member. Best for
   teams that don't want another service.

### Transport / Protocol

- **DoltHub**: HTTPS (Dolt's native remote protocol).
- **Self-hosted**: MySQL wire protocol (port 3306) or Dolt remote protocol.
- **SSH remote**: SSH + Dolt CLI (same transport fleet already uses for members).

All three are supported by `bd federation add-peer` with different remote URLs.

### How Members Are Pointed at It

```bash
# One-time setup per fleet master:
bd federation add-peer central-kb --url <remote-url> \
  --db <path-to-local-kb-db>
```

A new MCP tool (`kb_setup`) wraps this for the user:
- Accepts the remote URL and optional credentials
- Stores credentials in apra-fleet's credential store (encrypted at rest)
- Configures the Beads federation peer

### AUTH and Access Control

| Layer | Mechanism |
|-------|-----------|
| **Transport auth** | Dolt credentials (username + token) for DoltHub/self-hosted; SSH key for SSH remotes (already managed by fleet) |
| **Credential storage** | Stored in apra-fleet's credential store (`~/.apra-fleet/data/credentials.json`), encrypted with AES-256-GCM |
| **Write control** | Only promoted entries (not wisps) are synced. Promotion = explicit human/agent action |
| **Read control** | Anyone with sync credentials can read the shared bank. Team-internal by design |
| **Identity** | `--actor` flag on every `bd` write. Defaults to git user.name or $USER. Recorded as author of each entry |

### Identity Model

- **Author**: the `--actor` value at write time (typically git user.name / email)
- **Promoter**: the `--actor` value at promote time (who approved the entry)
- **Team membership**: having valid credentials for the central remote = team member
- No per-entry ACLs (out of scope) -- this is team-internal, not cross-org

### Offline / Degraded Behavior

| Scenario | Behavior |
|----------|----------|
| Central remote unreachable | Local KB fully operational. Wisps captured, queries served from local data. Sync queued for retry. |
| First use before any sync | Local KB works immediately. Shared entries appear after first successful sync. |
| Conflict during sync | Dolt merge with configurable strategy (`ours` / `theirs`). Default: `theirs` (team consensus wins). |
| Stale shared data | Agent sees last-synced snapshot. `kb_sync` pull refreshes. |

---

## Two-Tier Capture Model

### Data Flow

```
Agent works on a task
       |
       v
Auto-captures learning/context
       |
       v
Creates a WISP in local Beads KB
(ephemeral, dolt_ignored, fast, no gate)
       |
       v
Agent or user reviews the wisp
       |
       v
PROMOTE: bd promote <wisp-id> --reason "..."
(copies to permanent Dolt-versioned table)
       |
       v
SYNC: bd federation sync
(pushes promoted entry to central remote)
       |
       v
Other team members pull on next sync
```

### Auto Local Layer (No Gate)

- **Trigger**: agent captures a learning, summarizes a file, records a
  procedure during normal work.
- **Mechanism**: `bd create --ephemeral` with appropriate labels and metadata.
  Creates a wisp (stored in `dolt_ignored` -- not version-controlled, not
  synced, fast).
- **Friction**: zero. The agent calls the `kb_capture` MCP tool as part of its
  workflow.
- **Retention**: wisps are subject to TTL-based compaction (Beads built-in).
  Default TTL is configurable. Unpromoted wisps eventually expire.

### Gated Promotion to Shared Bank

- **Trigger**: agent or user decides a local entry is worth sharing.
- **Mechanism**: `bd promote <wisp-id> --reason "..."` copies the wisp to
  the permanent table. A comment is auto-added recording the promotion.
- **Review gate**: the promotion itself IS the gate. It requires explicit
  action. The `kb_promote` MCP tool can optionally require a human
  confirmation (configurable).
- **After promotion**: `bd federation sync` pushes the entry to the central
  remote on the next sync cycle.

---

## Cached Project Context -- Staleness / Invalidation

### Signal: Git Content Hash

**Recommended signal: `git hash-object <file>`** (with SHA-256 content hash
fallback for non-git files).

| Signal | Pros | Cons |
|--------|------|------|
| **mtime** | Fast, no computation | Unreliable across machines (clock skew), git checkout resets mtime, file copy doesn't preserve mtime |
| **Content SHA-256** | Deterministic, portable | Requires reading entire file to compute; duplicates what git already does |
| **Git content hash** (RECOMMENDED) | Fast (git infrastructure), deterministic, portable, already available in any git repo | Requires git; doesn't work for non-git files |

**Justification**: apra-fleet projects are git repos (the tool assumes git for
branch management, VCS auth, etc.). `git hash-object` is fast, deterministic,
and produces the same hash on any machine for the same file content. For the
rare non-git file, fall back to SHA-256 of the file contents.

### Invalidation Flow

1. **On capture**: compute `git hash-object <file>` (or SHA-256), store in the
   entry's `--metadata` as `{"source_file": "<path>", "content_hash": "<hash>"}`.
2. **On query**: for each cached-context result, compute the current hash of
   the source file.
3. **Compare**: if `current_hash != stored_hash`, mark the entry as `stale`.
4. **Return**: stale entries are returned with a `stale: true` flag. The agent
   decides whether to use stale data (with warning) or refresh by re-reading.
5. **Refresh**: agent re-reads the file, captures a new context entry, and the
   old one is superseded.

### Non-Existent Files

If the source file no longer exists (deleted/renamed), the cached context is
marked `stale` with reason `file_missing`. The agent should not use it.

---

## Read / Query Path

### How Agents Retrieve Knowledge

Agents call the `kb_query` MCP tool with:
- **type** (optional): filter by content type (`learning`, `knowledge`,
  `runbook`, `context-cache`)
- **query** (optional): free-text search string
- **tags** (optional): label-based filtering
- **file** (optional): for cached context, query by source file path
- **include_stale** (optional, default false): whether to include stale
  cached context entries

### Retrieval Flow

```
Agent calls kb_query
       |
       v
Search local Beads KB
(bd search / bd query with filters)
       |
       v
For cached-context results:
  compute current file hashes
  mark stale entries
       |
       v
Return results with metadata:
  - content, type, author, created date
  - for cached context: stale flag + stored vs current hash
```

### Relevance Approach

- **Primary**: Beads' built-in full-text search (`bd search`) ranks by
  text relevance.
- **Filtering**: labels narrow results by content type and tags.
- **Recency**: results ordered by creation date (newest first) within
  relevance tiers.
- **Staleness**: stale cached context is deprioritized (returned last or
  excluded by default).

### Local + Shared

The local Beads KB contains both:
- Local wisps (auto-captured, not yet promoted)
- Synced shared entries (pulled from the central remote)

A single `bd search` or `bd query` searches both. The query path does not
distinguish local vs shared -- the agent sees a unified view.

---

## MCP Tools (New)

| Tool | Purpose |
|------|---------|
| `kb_capture` | Auto-capture a knowledge entry (creates a wisp in local KB) |
| `kb_query` | Search/retrieve from the knowledge bank (local + shared) |
| `kb_promote` | Promote a local wisp to the shared bank (review gate) |
| `kb_sync` | Sync local KB with the central remote (push promoted, pull shared) |
| `kb_setup` | One-time setup: configure the central remote peer + credentials |

---

## In Scope vs Deferred

### In Scope

- Four content types (learnings, project knowledge, runbooks, cached context)
- Local Beads KB with wisps for auto-capture
- Promotion gate via `bd promote`
- Central remote sync via Beads federation (hub-and-spoke)
- Git-hash-based staleness detection for cached context
- MCP tools for capture, query, promote, sync, setup
- Agent skill file for knowledge capture guidance
- Access control via Dolt credentials + actor identity
- Security audit of auth/secrets/network egress
- Documentation

### Deferred

- Web UI for browsing the knowledge bank (CLI/MCP tools first)
- Cross-organization / public sharing (team-internal only)
- Migration of existing ad-hoc learnings (greenfield store)
- Automatic periodic sync (manual/on-demand sync first)
- Per-entry ACLs (team-level access is sufficient for v1)
- Semantic/embedding-based retrieval (text search + labels for v1)
- Knowledge bank analytics / usage metrics
