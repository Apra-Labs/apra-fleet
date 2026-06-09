# apra-fleet -- Implementation Plan

> Add a persistent, shareable Knowledge Bank to apra-fleet. Extends Beads
> (wisps for local capture, promote for gating, federation for central sync)
> with five new MCP tools, git-hash staleness detection for cached context,
> and an agent skill for knowledge capture. Front-loads the three riskiest
> assumptions (central service viability, staleness soundness, foundation
> choice) before any feature code.

---

## Tasks

### Phase 1: Risk Validation & Schema Definition

Validates all three riskiest assumptions before writing feature code.
If any spike fails, the plan is re-evaluated before proceeding.

#### Task 1: Spike -- Validate Beads Federation for Central Sync

- **Change:** Initialize two Beads databases in temp directories. Add one as
  a federation peer of the other. Create an entry in DB-A, sync to DB-B,
  confirm the entry appears. This validates that Beads federation can serve
  as the central remote transport. Document results (latency, conflict
  handling, failure modes) in a spike report committed as
  `docs/spikes/federation-sync.md`.
- **Files:** `docs/spikes/federation-sync.md`
- **Tier:** cheap
- **Done when:** Federation round-trip confirmed working; spike report
  committed with observed behavior, latency, and any caveats.
- **Blockers:** `bd` CLI must be installed and functional. Dolt backend
  must be available (bd may fall back to SQLite if Dolt is not installed).

#### Task 2: Spike -- Validate Git-Hash Staleness Detection

- **Change:** Write a small test script that: (a) creates a file in a git
  repo, (b) computes `git hash-object <file>`, (c) modifies the file,
  (d) re-computes the hash, (e) confirms the hashes differ. Also test the
  SHA-256 fallback for a file outside any git repo. Document results in
  `docs/spikes/staleness-detection.md`.
- **Files:** `docs/spikes/staleness-detection.md`
- **Tier:** cheap
- **Done when:** Git-hash staleness detection confirmed reliable across
  modify, rename, and delete scenarios. SHA-256 fallback confirmed.
- **Blockers:** Git must be available (it is -- this is a git repo).

#### Task 3: Define Knowledge Bank Schema & Service Module

- **Change:** Create `src/services/knowledge-bank.ts` with:
  - TypeScript types for the four content types (learning, knowledge,
    runbook, context-cache).
  - Constants for Beads labels (`kb:learning`, `kb:knowledge`, `kb:runbook`,
    `kb:context-cache`), metadata schema, and default configuration.
  - Helper functions: `computeFileHash(filePath)` (git hash-object with
    SHA-256 fallback), `buildBdCreateArgs(entry)`, `parseBdSearchResult(json)`.
  - KB database path constant (`~/.apra-fleet/data/knowledge/.beads`).
  - `ensureKbDatabase()` -- runs `bd init` in the KB directory if needed.
- **Files:** `src/services/knowledge-bank.ts`
- **Tier:** standard
- **Done when:** Types compile. `ensureKbDatabase()` creates a Beads DB.
  `computeFileHash()` returns correct hashes. Unit tests pass.
- **Blockers:** None (Phase 1 spikes inform schema decisions but don't
  block compilation).

#### VERIFY: Phase 1 -- Risk Validation

- Confirm federation spike succeeded (or document alternative if it failed).
- Confirm staleness spike succeeded.
- Confirm knowledge-bank.ts compiles and unit tests pass.
- Run `npm test` -- all existing tests still pass.
- Decision gate: if federation failed, re-evaluate the central service
  architecture before proceeding to Phase 2.

---

### Phase 2: Local Knowledge Capture & Query

Builds the local capture layer. Agents can capture and query knowledge
locally after this phase. No sync yet.

#### Task 4: `kb_capture` MCP Tool

- **Change:** Create `src/tools/kb-capture.ts` and register it in
  `src/index.ts`. Input schema:
  - `type` (required): `learning | knowledge | runbook | context-cache`
  - `title` (required): short description
  - `content` (required): the knowledge entry body
  - `source_file` (optional): path to the source file (required for
    context-cache type)
  - `tags` (optional): additional labels
  The tool calls `ensureKbDatabase()`, then shells out to
  `bd create --ephemeral` with labels, metadata (including file hash for
  context-cache), and actor. Returns the wisp ID.
- **Files:** `src/tools/kb-capture.ts`, `src/index.ts`
- **Tier:** cheap
- **Done when:** Tool registered in MCP server. Calling `kb_capture` with
  type=learning creates a wisp in the local KB. Wisp visible via
  `bd list --db <kb-path>`.
- **Blockers:** Task 3 (schema module).

#### Task 5: Cached Project Context with Staleness

- **Change:** Extend `kb_capture` to handle `context-cache` type:
  - Compute `git hash-object` of the source file (SHA-256 fallback).
  - Store hash in metadata: `{"source_file": "<path>", "content_hash": "<hash>"}`.
  - On capture, check if a non-stale entry already exists for the same file.
    If so, supersede it (close old entry, create new one).
  Add `checkStaleness(entry)` to `knowledge-bank.ts`:
  - Compute current hash of the source file.
  - Compare to stored hash.
  - Return `{stale: boolean, reason?: string}`.
- **Files:** `src/tools/kb-capture.ts`, `src/services/knowledge-bank.ts`
- **Tier:** standard
- **Done when:** Cached context entries include content hash. Modifying the
  source file causes `checkStaleness()` to return `stale: true`. Deleted
  files return `stale: true, reason: "file_missing"`. Unit tests cover
  all three cases (fresh, stale, missing).
- **Blockers:** Task 4 (kb_capture tool).

#### Task 6: `kb_query` MCP Tool

- **Change:** Create `src/tools/kb-query.ts` and register in `src/index.ts`.
  Input schema:
  - `type` (optional): filter by content type
  - `query` (optional): free-text search string
  - `tags` (optional): label filter
  - `file` (optional): source file path (for context-cache lookup)
  - `include_stale` (optional, default false): include stale cached context
  - `limit` (optional, default 20): max results
  The tool:
  - Calls `ensureKbDatabase()`.
  - Builds a `bd search` or `bd query` command with filters.
  - For context-cache results, runs `checkStaleness()` on each.
  - Returns structured JSON: `{results: [{id, type, title, content, author, created, stale?, source_file?, content_hash?}]}`.
- **Files:** `src/tools/kb-query.ts`, `src/index.ts`
- **Tier:** standard
- **Done when:** Querying by type returns filtered results. Querying by
  text returns relevant matches. Context-cache results include staleness
  flags. Empty queries return recent entries.
- **Blockers:** Task 5 (staleness detection).

#### VERIFY: Phase 2 -- Local Capture & Query

- Capture entries of all four types via `kb_capture`.
- Query entries by type, text, and file path via `kb_query`.
- Modify a source file and confirm staleness detection works.
- Run `npm test` -- all tests pass.
- Manual smoke test: start the MCP server, capture a learning, query it back.

---

### Phase 3: Promotion & Central Sync

Builds the shared layer. After this phase, team members can share knowledge.

#### Task 7: `kb_promote` MCP Tool

- **Change:** Create `src/tools/kb-promote.ts` and register in
  `src/index.ts`. Input schema:
  - `wisp_id` (required): the wisp to promote
  - `reason` (optional): why this entry is worth sharing
  The tool:
  - Validates the wisp exists and is in the local KB.
  - Shells out to `bd promote <wisp_id> --reason "..." --db <kb-path>`.
  - Returns the promoted entry ID and confirmation.
- **Files:** `src/tools/kb-promote.ts`, `src/index.ts`
- **Tier:** cheap
- **Done when:** Promoting a wisp moves it to the permanent table.
  The promoted entry is visible in `bd list` (not just wisps).
  Promoting a non-existent wisp returns a clear error.
- **Blockers:** Task 4 (kb_capture creates wisps to promote).

#### Task 8: `kb_sync` MCP Tool

- **Change:** Create `src/tools/kb-sync.ts` and register in `src/index.ts`.
  Input schema:
  - `direction` (optional, default `both`): `push | pull | both`
  - `peer` (optional): specific peer name (default: all peers)
  - `strategy` (optional, default `theirs`): conflict resolution
    (`ours | theirs`)
  The tool:
  - Calls `ensureKbDatabase()`.
  - Shells out to `bd federation sync` with appropriate flags.
  - Parses sync output for success/conflict/error status.
  - Returns structured result: `{synced: boolean, entries_pushed: n, entries_pulled: n, conflicts?: [...]}`.
  Also create `kb_setup` MCP tool (in same file or separate) for one-time
  peer configuration:
  - `remote_url` (required): Dolt remote URL
  - `peer_name` (optional, default `central-kb`): federation peer name
  - Stores Dolt credentials in apra-fleet credential store.
  - Shells out to `bd federation add-peer`.
- **Files:** `src/tools/kb-sync.ts`, `src/index.ts`
- **Tier:** standard
- **Done when:** `kb_sync` pushes promoted entries and pulls shared ones.
  `kb_setup` configures a federation peer. Sync failure returns a clear
  error (not a crash). Offline behavior confirmed: local operations work
  when remote is unreachable.
- **Blockers:** Task 7 (promoted entries to sync). Task 1 spike (federation
  confirmed viable).

#### Task 9: Access Control & Identity Integration

- **Change:** Ensure identity and access control are enforced across all KB
  tools:
  - Set `BEADS_ACTOR` env var from git user.name/email or fleet user config
    on every `bd` command invocation in `knowledge-bank.ts`.
  - Store sync credentials (Dolt token) in apra-fleet credential store with
    `network_policy: 'confirm'` (user confirms on first network egress).
  - Add `author` field to all KB query results.
  - Add `--actor` to all `bd create` / `bd promote` invocations.
  Update `knowledge-bank.ts` with `resolveActor()` helper that determines
  the actor string from available identity sources.
- **Files:** `src/services/knowledge-bank.ts`, `src/tools/kb-sync.ts`,
  `src/tools/kb-capture.ts`, `src/tools/kb-promote.ts`
- **Tier:** standard
- **Done when:** Every KB entry has an author. Sync credentials are stored
  encrypted. `resolveActor()` returns a consistent identity string.
  Network egress requires confirmation on first use.
- **Blockers:** Task 8 (sync tool to integrate with).

#### VERIFY: Phase 3 -- Promotion & Sync

- Capture a wisp, promote it, sync to a test remote, confirm it appears.
- Pull from a remote with existing entries, query locally.
- Confirm identity (author) is recorded on all operations.
- Confirm credentials are stored encrypted.
- Run `npm test` -- all tests pass.

---

### Phase 4: Agent Skill, Security & Documentation

Final phase: skill file for agents, security audit, and documentation.

#### Task 10: Knowledge Bank Agent Skill

- **Change:** Create `skills/fleet/knowledge-bank.md` with guidance for
  agents on when and how to use the knowledge bank:
  - When to capture: after discovering a gotcha, fixing a non-obvious bug,
    summarizing a complex file, writing a procedure.
  - How to capture: call `kb_capture` with appropriate type and content.
  - When to query: at session start, before reading a file (check for
    cached context), when stuck on a problem (search for learnings).
  - When to promote: when a learning proved correct and useful.
  - When to sync: at session start (pull) and after promoting (push).
  Update `skills/fleet/skill-matrix.md` with the new skill entry.
- **Files:** `skills/fleet/knowledge-bank.md`, `skills/fleet/skill-matrix.md`
- **Tier:** cheap
- **Done when:** Skill file is well-structured and actionable. An agent
  following the skill can effectively use all KB tools.
- **Blockers:** All KB tools implemented (Tasks 4-9).

#### Task 11: Security Audit

- **Change:** Review the knowledge bank implementation for security concerns:
  - **Auth**: Dolt credentials stored in credential store -- verify encryption
    at rest, verify no plaintext leaks in logs or error messages.
  - **Network egress**: `bd federation sync` makes network calls -- verify
    `network_policy: 'confirm'` is enforced, verify no unintended egress.
  - **Command injection**: all `bd` invocations use shell arguments built from
    user input (wisp IDs, search queries, file paths) -- verify proper
    escaping/quoting.
  - **Access control**: verify that sync credentials are scoped and not
    accessible to unauthorized members.
  - **Data sensitivity**: knowledge entries may contain code snippets or
    internal details -- verify no accidental exposure outside the team.
  Document findings and remediations in `docs/knowledge-bank-security.md`.
- **Files:** `docs/knowledge-bank-security.md`, potentially any tool/service
  file that needs a fix.
- **Tier:** standard
- **Done when:** Audit report committed. All high/critical findings
  remediated. No plaintext credential exposure. No command injection vectors.
- **Blockers:** All KB tools implemented (Tasks 4-9).

#### Task 12: Documentation

- **Change:** Add knowledge bank documentation:
  - `docs/knowledge-bank.md`: architecture overview, setup guide (configuring
    the central remote), usage guide (capture, query, promote, sync),
    troubleshooting.
  - Update `docs/architecture.md`: add Knowledge Bank as a new layer in the
    architecture diagram and description.
  - Update `README.md`: add Knowledge Bank to the feature list and tool
    reference table.
- **Files:** `docs/knowledge-bank.md`, `docs/architecture.md`, `README.md`
- **Tier:** standard
- **Done when:** A new team member can set up and use the knowledge bank by
  following the docs. Architecture diagram reflects the new layer.
- **Blockers:** Security audit complete (Task 11 may change the setup flow).

#### VERIFY: Phase 4 -- Quality & Release

- Skill file is clear and complete.
- Security audit has no open high/critical findings.
- Documentation is accurate and complete.
- Run `npm test` -- all tests pass.
- Run `npm run build` -- build succeeds.
- Full end-to-end walkthrough: capture -> query -> promote -> sync -> query
  on another instance.

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Beads federation requires Dolt backend** -- bd may use SQLite locally, which doesn't support federation. If Dolt is not installed on the user's machine, sync is unavailable. | High | Task 1 spike validates this. Document Dolt as a prerequisite for team sharing. Local-only mode (capture + query without sync) works on SQLite. Fail gracefully with a clear message. |
| **Command injection via bd CLI arguments** -- user-provided values (titles, queries, file paths) are passed as shell arguments to `bd`. Malicious input could inject shell commands. | High | All arguments must be passed through proper shell escaping. Use `child_process.execFile` (no shell) or the existing OsCommands escaping layer. Security audit (Task 11) specifically covers this. |
| **Central remote credentials exposed** -- Dolt credentials stored in credential store could be leaked via error messages, logs, or MCP tool output. | High | Reuse apra-fleet's existing credential store (AES-256-GCM encryption at rest). Never include credentials in tool output or logs. Security audit verifies this. |
| **Backward compatibility -- new tools don't break existing fleet** -- adding 5 new MCP tools and a new service module must not affect existing tool behavior. | Medium | New tools are additive (new files). The knowledge-bank service is independent of existing services (registry, credential store). No existing type/interface changes. Run full test suite at every phase boundary. |
| **Cached context grows unbounded** -- agents may cache hundreds of files, filling disk. | Medium | Wisps have TTL-based compaction (Beads built-in). Promoted entries are permanent but queryable -- provide a `kb_cleanup` or use `bd stale` to identify old entries. Document recommended practices. |
| **Network egress without user consent** -- `bd federation sync` makes network calls that the user may not expect. | Medium | Store sync credentials with `network_policy: 'confirm'`. First sync requires explicit user confirmation. Subsequent syncs respect the policy. Document clearly. |
| **Beads CLI interface changes** -- bd is a separate package; CLI flags/output format may change across versions. | Low | Wrap all bd interaction in `knowledge-bank.ts` (single coupling surface). Pin bd version in docs. Parse bd output with `--json` flag for structured data. |
| **External dependency -- no new npm deps allowed** -- project constraint. | Low | No new npm dependencies. Beads is already installed by `apra-fleet install`. All new code uses Node.js built-ins (`child_process`, `crypto`, `fs`) and existing apra-fleet utilities. |

---

## Phase Sizing Rules

Phase boundaries follow cohesion: each phase produces a testable increment.

- **Phase 1** (3 tasks: cheap, cheap, standard): risk validation + schema.
  Produces: spike reports + compilable service module.
- **Phase 2** (3 tasks: cheap, standard, standard): local capture + query.
  Produces: working local KB with all four content types.
- **Phase 3** (3 tasks: cheap, standard, standard): promotion + sync.
  Produces: working team sharing via central remote.
- **Phase 4** (3 tasks: cheap, standard, standard): skill + security + docs.
  Produces: production-ready feature.

Tier ordering within each phase is monotonically non-decreasing.

---

## Notes

- Each task should result in a git commit.
- Verify tasks are checkpoints -- stop and report after each one.
- Base branch: main
- Implementation branch: feat/knowledge-bank
