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
|  8 MCP tools:             |      |                           |
|  kb_capture               |      |  MCP server: npx gitnexus |
|  kb_query                 |      |  16 tools: context,       |
|  kb_context               |      |  impact, detect_changes,  |
|  kb_invalidate            |      |  query, cypher, ...       |
|  kb_session_prime         |      |                           |
|  kb_promote               |      |                           |
|  kb_harvest               |      |                           |
|  kb_setup                 |      |                           |
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

## Setup Guide

### 1. Quick start (SQLite, local)

No setup required. The KB initializes automatically on first use at:
```
~/.apra-fleet/data/knowledge/kb.sqlite
```

Install the git post-commit hook (one-time per repo) so KB entries are
invalidated automatically when files change:

```
kb_setup
```

Or, run `kb_setup` with no arguments from within the repo directory in Claude Code.

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

### 4. Git hook

The post-commit hook fires after every commit and invalidates KB context-cache
entries for files that changed. Install it:

```
kb_setup
```

The hook is written to `.git/hooks/post-commit`. It calls:

```bash
git diff-tree --no-commit-id -r --name-only HEAD | while IFS= read -r f; do
  [ -n "$f" ] && node dist/index.js kb invalidate "$f" 2>/dev/null || true
done
```

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

The KB Agent is a fleet member whose sole role is maintaining the knowledge
base. It is dispatched by the PM after each sprint phase.

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

### Git hook not firing

**Symptom**: context-cache entries not going stale after commits.

**Check**:
```bash
cat .git/hooks/post-commit
ls -la .git/hooks/post-commit
```

The hook must be executable. Re-install if missing:
```
kb_setup
```

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
