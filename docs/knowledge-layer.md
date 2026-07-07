# Knowledge Layer

The Knowledge Layer gives every agent a persistent, structured memory across
sessions. Instead of re-reading the same files at the start of each run, an
agent primes its session from the KB and only reads files that have changed.

---

## Architecture Overview

The layer has two planes:

```
+---------------------------+      +---------------------------+
|   KB Service (Memory)     |      |  Codebase Plane (GitNexus)|
|                           |      |                           |
|  MemoryProvider interface |      |  AST-level codebase graph |
|  - SqliteProvider (local) |      |  - symbol definitions     |
|  - HttpKbProvider (http)  |      |  - call graphs            |
|                           |      |  - file impact analysis   |
|  16 MCP tools, incl:      |      |  MCP server: npx gitnexus |
|  kb_capture  kb_query     |      |  16 tools: context,       |
|  kb_context  kb_invalidate|      |  impact, detect_changes,  |
|  kb_session_prime         |      |  query, cypher, ...       |
|  kb_promote  kb_harvest   |      |                           |
|  kb_setup    kb_export    |      |                           |
|  kb_import                |      |                           |
|  kb_freshness_sweep       |      |                           |
|  kb_reconcile_prefilter   |      |                           |
|  kb_resolve_contradiction |      |                           |
+---------------------------+      +---------------------------+
            |                                   |
            +-------------- LLM --------------- +
                      (orchestrates both planes)
```

**KB Service (Memory plane)**: stores learned knowledge -- context-cache entries,
learnings, runbooks, and knowledge -- in a SQLite database. The `MemoryProvider`
interface lets the backend be swapped with no code change.

**Codebase Plane (GitNexus)**: an AST-level graph of the repository. Provides
structural context that the KB does not store: symbol definitions, call graphs,
file impact chains. GitNexus is an MCP server the LLM calls directly.

The two planes are **independent**. `kb_session_prime` returns a list of
`recommended_gitnexus_calls` that the LLM should dispatch after priming the KB.
Neither plane calls the other -- the LLM orchestrates both.

---

## MemoryProvider Abstraction

All KB tools operate through the `MemoryProvider` interface
(`src/services/knowledge/types.ts`):

```typescript
interface MemoryProvider {
  init(): Promise<void>;
  capture(input: KBEntryInput): Promise<{ id: string; audn_decision: AudnDecision }>;
  query(opts: QueryOptions): Promise<KBResult>;
  context(files: string[]): Promise<FileContextResult[]>;
  invalidate(files: string[]): Promise<{ invalidated: number }>;
  getLinked(id: string): Promise<KBEntry[]>;
  prime(opts: PrimeOptions): Promise<PrimedContext>;
  promote(id: string, reason?: string): Promise<...>;
  sync(opts?: SyncOptions): Promise<SyncResult>;
}
```

Two concrete implementations exist:

| Provider | Module | Use case |
|----------|--------|----------|
| `SqliteProvider` | `src/services/knowledge/sqlite-provider.ts` | Default. Local SQLite, zero config. |
| `HttpKbProvider` | `src/services/knowledge/http-provider.ts` | Shared central server for a team. |

`KBService` (`src/services/knowledge/kb-service.ts`) is the singleton factory.
It reads `~/.apra-fleet/data/knowledge/config.json` and instantiates the right
provider. Run `kb_setup` to write the config.

---

## Trust model (enforced)

Every entry carries a confidence tier and moves up a one-way ladder:

```
UNVERIFIED  ->  INFERRED  ->  CONFIRMED
```

- `UNVERIFIED` -- extracted but unchecked (auto-harvested from a transcript, a
  raw session insight). Lowest trust.
- `INFERRED` -- verified by reading source, or captured deliberately. Default,
  and the ceiling for `kb_capture`.
- `CONFIRMED` -- the reviewer approved the code the entry describes. Highest.

**The clamp is enforced at two layers.** `kb_capture` clamps any incoming
`CONFIRMED` down to `INFERRED` in the tool handler (returning
`confidence_clamped: true` and appending a note to content -- the user-facing
signal). But the HTTP route `POST /api/kb/capture` calls `provider.capture()`
directly and bypasses the handler, so the same clamp is ALSO enforced inside
`SqliteProvider.capture()` -- the choke point every route shares. The handler
clamp is UX; the provider clamp is enforcement. No route can mint `CONFIRMED`
through capture.

**`kb_promote` is the sole path to `CONFIRMED`.** It steps an entry up exactly
one rung and appends the reason as an evidence trail. The workflow is therefore
always capture-at-INFERRED, then promote-after-review.

**User directives are the one exemption, and they are quarantined.** A
`type='user-directive'` entry (a standing instruction: "always do X", "we
decided Z") is the only type that can hold `CONFIRMED` without promotion. But
the directive gate in `capture()` forces every incoming directive to a pending
proposal first -- UNVERIFIED + `flagged_for_review` + tag `directive:pending` +
scope `project`, never surfaced by default retrieval. Activation is CLI-only
(`apra-fleet kb approve-directive`); no MCP/HTTP route and no bible import can
activate a directive. This is the unforgeable tier.

The two capture-level exemptions to the clamp are: (1) `kb_promote` (a separate
method, not capture), and (2) import mode inside `capture()` for the bible
channel -- an INTERNAL parameter that no deserialized route can set (the HTTP
route passes exactly one argument; the MCP handler builds input from zod-parsed
fields). `capture()` additionally NORMALIZES the `source` field: a
caller-supplied `source='import'` or `'promotion'` arriving via a deserialized
body is overwritten unless the internal import mode is actually engaged, so
forged trusted-channel provenance is impossible.

See [kb-trust-model.md](kb-trust-model.md) for the ladder in full.

---

## The canonical bible

The SQLite database is one developer's private, warm working memory. The
**canonical bible** is the team's shared, git-native slice of it:

- `kb_export` writes all `CONFIRMED`, non-superseded, non-stale PROJECT entries
  to `<repo>/.fleet/kb-canonical.json` (a stable field set --
  `{id, type, title, summary, symbols, source_files, confidence, updated_at}`
  -- id-sorted for meaningful diffs, ASCII-escaped so it honours the repo's
  ASCII-only rule).
- With `scope='global'` it exports the GLOBAL KB to
  `.fleet/kb-canonical-global.json` (committed in the platform repo so the
  installer can distribute team-wide conventions).
- **Cold-seed:** when a KB is nearly empty (`kb_session_prime` under
  `COLD_KB_MAX=3`), prime reads the bible for OUTPUT only to warm the session.
  Cold-seed never writes the database and never activates a directive; the write
  path into a warm KB is `kb_import` (see below).

### Why the DB is central and the bible is in-repo

The SQLite database is the source of truth deliberately, and the bible is a
projection of it, for a merge-cost reason. A binary SQLite file committed to git
would make branch merges painful -- two branches writing rows produce an opaque
binary conflict git cannot resolve, and the file churns on every read
(use-count bumps, freshness bits). The bible is instead a git-native, diffable,
per-project JSON artifact: a text file that merges like source, reviews like
source, and carries only the durable, CONFIRMED slice. Branch confusion -- the
bible on branch B describing files as they are on B -- is handled AFTER the
merge by `kb_import` (write the merged bible into the local DB) and
`freshnessSweep` + the reconcile flow (re-hash against the merged worktree so
wrong-branch claims go stale and contradictions are arbitrated). See
[kb-reconcile-architecture.md](kb-reconcile-architecture.md).

### Auto-commit at export

`kb_export` COMMITS the bible itself after writing it, so the reviewer-verdict
-> promote -> export chain reaches git with zero manual steps. This is code, not
agent discretion (the KB Agent is MCP-only and has no git access). The commit
is deliberately narrow:

- **Dedicated identity** `pm-kb <kb@pm.local>` -- distinct from the human author
  and from the KB Agent's git-less session.
- **Pathspec-only:** `git add <bible-path>` then `git commit -- <bible-path>`,
  so unrelated staged or dirty working-tree state is never swept in.
- **Content-gated:** it commits only when `git status --porcelain` shows the
  bible actually changed; re-exporting an identical bible is a no-op.
- **Non-fatal:** any git failure (not a repo, no git binary, hook rejects, index
  lock) is logged and swallowed -- the export already succeeded.
- **Off-switch:** `{ "bible": { "autoCommit": false } }` in the KB config
  disables it. Missing/malformed config degrades to the default (ON).
- **No push.** The commit rides the branch's existing push flow; `kb_export`
  never pushes.

---

## Bidirectional staleness

A `context-cache` entry stores a per-file hash basis (`source_file_hashes`, a
JSON map) at capture time. Staleness is detected by re-hashing that basis
against the current worktree -- not by any git event -- so it is correct across
branch switches and rebases.

- **At prime,** `checkFreshness()` re-hashes the primed candidate set in BOTH
  directions: mark `stale=1` on basis mismatch, and clear `stale=0` where the
  entry is revivable and its full basis matches again.
- **`freshnessSweep()`** runs the same predicate over ALL entries with a
  non-empty basis (one bounded batched hash). It is the branch-switch REVIVAL
  surface, because prime's candidate set excludes stale rows by definition --
  prime alone can never revive a staled entry. The sweep is invoked by
  `kb_import` and `/pm kb-reconcile` (and standalone as `kb_freshness_sweep`),
  never wired into per-prime. It returns `{checked, staled, unstaled}`.

**The revival predicate (`freshnessRevivable`).** `stale=1` is set by four
distinct actors, and only ONE population may be revived -- freshness mismatch.
An entry is revivable only when all hold:

```
stale = 1
AND superseded_at IS NULL              (not retired by an AUDN update)
AND flagged_for_review = 0             (not a live feedback downvote)
AND content_hash != 'invalidated'      (not explicitly invalidated)
AND content has no "[feedback ..." marker  (durable downvote record)
AND the full stored basis re-hashes to a match
```

The two content-based conjuncts are the durable discriminators: a
feedback-downvoted entry must stay retired even if a later flow clears its flag
bit (the `[feedback ...]` marker survives), and an explicitly invalidated entry
must never auto-revive. This predicate is implemented ONCE and reused by
`checkFreshness()`, `freshnessSweep()`, and the reconcile winner path.

---

## Branch-merge reconcile

When branches merge, learnings must merge too, and contradictions are decided
by the merged code. That flow -- `kb_import` (write path) ->
`kb_freshness_sweep` -> `kb_reconcile_prefilter` -> reconciler agent ->
`kb_export` -- and its single `resolveContradiction` write path are documented
separately in
[kb-reconcile-architecture.md](kb-reconcile-architecture.md). The PM entry
point is `/pm kb-reconcile`.

---

## Setup Guide

### 1. Quick start (SQLite, local)

No setup required. The KB initializes automatically on first use at:
```
~/.apra-fleet/data/knowledge/kb.sqlite
```

Staleness needs no git hook: `context-cache` entries store a per-file hash
basis and are re-checked by content hash at prime (and by `freshnessSweep`),
so changes are detected across commits, branch switches, and rebases alike --
see [Bidirectional staleness](#bidirectional-staleness) above. Running
`kb_setup` writes the provider config (and, for teams, encrypts the remote
token); it is optional for the local SQLite default.

### 2. Central server (HTTP, team-shared)

On the server machine, generate a token and start the server:

```bash
node dist/index.js kb-server --generate-token
# Prints: KB server token: <64-hex-chars>
node dist/index.js kb-server
# Prints: KB server listening on port 7878
```

On each client machine, configure the provider:

```
kb_setup with provider=http, remote=http://<host>:7878, token=<token>
```

Or equivalently via CLI:

```bash
node dist/index.js kb-server --port 7878
```

The client writes this to `~/.apra-fleet/data/knowledge/config.json`:

```json
{
  "provider": "http",
  "url": "http://<host>:7878",
  "token_encrypted": "<AES-256-GCM ciphertext>"
}
```

The token is stored AES-256-GCM encrypted. It is never written in plaintext.

### 3. GitNexus (optional, codebase plane)

Install GitNexus as an MCP server in `.mcp.json` (already done if you used the
Knowledge Layer setup):

```json
{
  "mcpServers": {
    "gitnexus": {
      "command": "npx",
      "args": ["-y", "gitnexus", "mcp"]
    }
  }
}
```

Build the initial graph:

```bash
npx gitnexus analyze
```

Verify by calling `context` with a symbol name in Claude Code.
`kb_session_prime` degrades gracefully when GitNexus is absent.

### 4. Keeping the KB in sync with git

There is no post-commit hook driving KB state. Two mechanisms keep the KB and
git aligned, both described in the architecture sections above:

- **Staleness is hash-based, not hook-based.** `context-cache` entries store a
  per-file hash basis and are re-checked at prime and by `freshnessSweep`. This
  detects changes regardless of how they arrived (commit, branch switch,
  rebase, or an uncommitted edit), which a commit-triggered hook could not.
  See [Bidirectional staleness](#bidirectional-staleness).
- **The bible reaches git via `kb_export`'s auto-commit**, not a hook -- a
  narrow, pathspec-only commit under the `pm-kb` identity, content-gated,
  non-fatal, with a config off-switch. See
  [Auto-commit at export](#auto-commit-at-export).

(`kb_setup` still writes a legacy `.git/hooks/post-commit` invalidation hook,
but it is not load-bearing: it calls a repo-relative `node dist/index.js` path
and swallows all errors, so it is effectively inert outside the apra-fleet
source tree. Hash-based freshness is the mechanism to rely on.)

---

## Usage Guide

### Session prime workflow

At the start of every session, call `kb_session_prime` with the task description
and the files you expect to touch:

```
kb_session_prime with task="add rate limiting to kb-server", hint_files=["src/commands/kb-server.ts"], hint_symbols=["startKbServer"]
```

The tool returns:
- `session_warm`: `true` if all hint_files have fresh KB entries
- `stale_files`: list of files the agent MUST read (changed since last capture)
- `fresh_summaries`: cached summaries for files that have not changed
- `top_entries`: relevant learnings from the KB
- `recommended_gitnexus_calls`: GitNexus tool calls to dispatch next

If `session_warm=true` and `stale_files=[]`, the agent can skip reading those
files and work from KB summaries directly. Token cost: ~60-100 tokens per file
(summary only) vs. reading the full file.

### Capture guide

After reading or writing a file, call `kb_capture` to store what you learned:

```
kb_capture with type="context-cache", title="kb-server.ts: HTTP entry point", summary="Starts an HTTP server on port 7878 using node:http. Bearer token auth. Rate limiting: 100 req/min per IP (in-memory token bucket). No external deps.", content="...", source_files=["src/commands/kb-server.ts"]
```

Content types:
- `context-cache` -- one file's content/structure. Staleness checked on prime.
- `learning` -- something you discovered while working (bugs, gotchas).
- `knowledge` -- architectural facts, design decisions.
- `runbook` -- step-by-step procedures.

The AUDN system deduplicates automatically:
- `add` -- new entry stored
- `none` -- exact duplicate, existing entry returned
- `update` -- same topic, supersedes old entry
- `flagged` -- contradiction detected, both entries flagged for human review

### When to promote

Entries start at `INFERRED` confidence. The reviewer promotes verified facts:

```
kb_promote with id="<entry-id>", reason="Confirmed correct after code review"
```

Confidence ladder: `UNVERIFIED` -> `INFERRED` -> `CONFIRMED`

`CONFIRMED` entries are never auto-deleted by the dream cycle.

### Dream cycle

The KB Agent (dispatched by the PM) runs a dream cycle to maintain quality:
1. Dedup pass: find near-duplicate entries and supersede older ones.
2. Contradiction scan: flag entries with contradiction keywords.
3. Salience prune: mark old, low-use entries as superseded.
4. Stale link repair: re-wire links for entries with changed source_files.

The dream cycle is not triggered automatically. Dispatch it when the KB grows
large or after a major refactor.

---

## Provider Swap

Switch providers without code changes by rewriting config.json.

### SQLite (default)

```json
{ "provider": "sqlite" }
```

All data is local. No token. `kb_sync` is a no-op.

### HTTP (central server)

```json
{
  "provider": "http",
  "url": "http://<host>:7878",
  "token_encrypted": "<ciphertext from kb_setup>"
}
```

Run `kb_setup` with `remote` and `token` to write this. Do not write
`token_encrypted` by hand.

`HttpKbProvider` proxy behavior:
- **Reads** (query, context, prime): if server unreachable, fall back to local
  SqliteProvider. Session continues uninterrupted.
- **Writes** (capture, invalidate): if server unreachable, queue in memory
  (max 1000 entries). On reconnect, queue is flushed before the next request.
- **Queue overflow**: if 1000 pending writes accumulate, the oldest is dropped
  and a warning is printed to stderr.
- **Process exit**: if the queue is non-empty on exit, a warning is emitted.

### Future: Postgres

To add a Postgres backend, implement `MemoryProvider` in a new class and update
`KBService.getProvider()` to instantiate it when `config.provider === 'postgres'`.
No KB tool changes are required.

---

## KB Agent

The KB Agent is a fleet member whose role is CURATING the knowledge base -- not
authoring it. Knowledge enters the KB in-flight: the working agent captures at
the moment of discovery (`kb_capture` with descriptive tags, e.g. a sprint and
phase label), so entries land as they are learned rather than in a single
post-hoc pass. Auto-harvest backstops this by scanning the transcript when a
prompt completes, so nothing discovered mid-session is lost even if the agent
forgot to capture it.

The KB Agent then curates that raw stream: it promotes entries the reviewer
confirmed (`kb_promote`), dedups and reconciles, exports the bible, and runs the
branch-merge reconcile flow. It is dispatched by the PM after each sprint phase.

Skills file: `skills/fleet/knowledge-agent.md`

### Dispatch

```
/pm dispatch knowledge-agent to <member> for harvest and dream cycle
```

Or on-demand:

```
execute_prompt to <member>: "You are the KB Agent. Run kb_harvest on the last session transcript, then run a dedup pass on the KB."
```

### What it does

1. **Harvest**: scans the session transcript for learning patterns, captures
   UNVERIFIED entries via AUDN.
2. **Promote**: promotes entries the reviewer confirmed.
3. **Dream cycle**: dedup, contradiction scan, salience prune, stale link repair.

### Auto-harvest

`kb_harvest` fires automatically (fire-and-forget) when `execute_prompt`
completes successfully. The PM does not need to dispatch it manually.

---

## Troubleshooting

### GitNexus graph stale

**Symptom**: `kb_session_prime` returns empty `recommended_gitnexus_calls` or
GitNexus tools return outdated results after a refactor.

**Fix**: rebuild the graph:
```bash
npx gitnexus analyze
```

Run this after large refactors or after renaming many files. The graph update
is incremental on subsequent runs.

### SQLite lock errors (SQLITE_BUSY)

**Symptom**: `SQLITE_BUSY: database is locked` in KB tool output.

**Cause**: multiple agent sessions writing simultaneously. WAL mode allows
concurrent reads but serializes writes.

**Fix**: the SQLite provider is configured with `busy_timeout=5000` (5 seconds).
If errors persist, only one agent should write at a time. Consider the HTTP
provider for multi-agent setups.

### Stale entries not reviving after a branch switch

**Symptom**: switching back to a branch whose files are unchanged still shows
its `context-cache` entries as stale.

**Cause**: `kb_session_prime` cannot revive stale entries -- its candidate set
excludes stale rows by definition. Revival only happens in a full-KB sweep.

**Fix**: run `kb_freshness_sweep` (or `/pm kb-reconcile`, which runs it as part
of the ladder). It re-hashes every entry's basis against the current worktree
and revives freshness-staled entries whose files match again. Superseded,
feedback-downvoted, and invalidated entries stay retired by design -- see
[Bidirectional staleness](#bidirectional-staleness).

### Offline queue warning on exit

**Symptom**: at process exit you see:
```
[KB] WARNING: offline queue has N unsaved captures. Reconnect to the KB server and run kb_harvest to recover from the session transcript.
```

**Cause**: the HTTP KB server was unreachable while captures were made. The
queue is in-memory and not persisted.

**Recovery**: start the KB server, then run:
```
kb_harvest with session_output="<paste session transcript>"
```

AUDN deduplication ensures entries from the harvest do not create duplicates
if some were already sent before the server went offline.

### Token rejected (401)

**Symptom**: KB server returns 401 for all requests.

**Fix**: the token in the client config must match the server's token. Regenerate
on the server:
```bash
node dist/index.js kb-server --generate-token
```

Then re-run `kb_setup` on each client with the new token.
