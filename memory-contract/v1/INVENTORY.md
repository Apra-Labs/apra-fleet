# memory-contract/v1 -- Contract Surface Inventory

Status: authoritative inventory of the memory/code-intelligence contract surface
as it exists in this repository. This document is the ARBITER OF THE TOOL COUNT
for the v1 contract work: downstream schema generation, binding generation and
round-trip fixtures cite the number stated here rather than re-deriving it.

Tree inventoried: branch `u1_contract_v1_skeleton`, HEAD `3a19a9d9`; re-verified
after merging main at `97877f5e` (kb_*/code_* surface unchanged; server total
57 -> 58 from the non-memory `vcs_credential_exec` tool).

## 1. Verified tool count

**26 tools: 17 `kb_*` + 9 `code_*`.**

Update: `code_reindex` and `code_status` (rebuild / report the calling
session's own code index) were added as the 8th and 9th `code_*` tools, taking
the surface from 24 to 26.

Earlier update: `kb_bible_commit` (the kb_maintainer's per-round, entry-level bible
commit with target-base-branch provenance) was added as the 17th `kb_*` tool,
taking the surface from 23 to 24. The verification below was the original
23-tool count and stands as stated for that tree; the same runtime registration
dump now records 17 `kb_` and 7 `code_` tools.

The source plan claimed 24 (17 `kb_*` + 7 `code_*`). That claim is WRONG by one
`kb_*` tool. The verified number is 23.

How it was verified (two independent methods, agreeing):

1. **Static** -- every `server.tool` call site with a `kb_` or `code_` prefixed
   name in `src/services/tool-registry.ts` (the single registration function
   `registerAllTools`). No `kb_*`/`code_*` tool is registered anywhere else, and
   no registration is conditional: all 23 calls are unguarded statements in the
   body of `registerAllTools`.
2. **Runtime** -- `registerAllTools` was driven with a 4-line fake `McpServer`
   (an object with a `tool()` method and `server.sendLoggingMessage()`) that
   records every registration. Result: 58 tools registered in total, of which 16
   carry the `kb_` prefix and 7 carry the `code_` prefix.

The runtime method is the stronger evidence and is reproducible: it exercises the
real registration path including the dynamic `await import(...)` of every tool
module, so a tool registered behind a lazy import cannot hide from it.

## 2. Tool surface -- request and response

Response column notation:

- `text(JSON): {...}` -- the handler returns a JSON-stringified object, so the MCP
  text content is machine-parseable and the listed keys are the observed
  top-level shape.
- `text(JSON): opaque` -- the handler JSON-stringifies a value typed
  `Promise<unknown>`, i.e. a provider payload this repo does not define.

No tool in this surface declares a response zod schema; see section 3.

### 2.1 kb_* tools (17)

| # | Tool | Request schema | Request fields | Response (observed) | Description (summarized) |
|---|------|----------------|----------------|---------------------|---------------------------|
| 1 | `kb_capture` | `kbCaptureSchema` (`src/tools/kb-capture.ts`) | type, title, summary, content, source_files, symbols, module, tags, source_file, role, confidence, scope, supersedes | `text(JSON): {id, audn_decision, confidence_clamped}` | Capture a learning/fact/file summary into the KB. Confidence is capped at INFERRED (CONFIRMED is minted only via `kb_promote`). Returns `audn_decision` (add/none/update/flagged); `supersedes` retires a prior entry only if AUDN independently matches it. |
| 2 | `kb_invalidate` | `kbInvalidateSchema` (`src/tools/kb-invalidate.ts`) | files, ids (exactly one) | `text(JSON): {invalidated, files}` (files) or `{discarded, not_found, already_discarded}` (ids) | Mark context-cache entries stale for the given file paths. Call after modifying files so the KB reflects current state. |
| 3 | `kb_context` | `kbContextSchema` (`src/tools/kb-context.ts`) | files | `text(JSON): {fresh, stale, missing}` | Check freshness of files against the KB. Fresh files can be skipped; stale/missing files must be re-read. |
| 4 | `kb_session_prime` | `kbSessionPrimeSchema` (`src/tools/kb-session-prime.ts`) | session_files, hint_symbols, hint_modules | `text(JSON): PrimedContext {session_warm, stale_files, top_entries, fresh_summaries, recommended_code_calls, token_estimate}` | Prime a session with KB context: session_warm status, stale files needing re-read, top KB entries, and recommended GitNexus calls. |
| 5 | `kb_query` | `kbQuerySchema` (`src/tools/kb-query.ts`) | query, type, tag, limit, include_stale, flagged_only, expand_related, confidence, exclude_disputed | TWO shapes -- default: `text(JSON): {l1_results, l2_expanded, related_claims?}`; with `flagged_only` true: `text(JSON): {flagged_entries, total, note}` | Two-level KB search: L1 FTS5 on title+summary (up to 20 hits), L2 full content for top 5. `tag` alone lists all entries with that tag; `flagged_only` lists contradiction pairs; `expand_related` adds refines/contradiction_of links; `confidence`/`exclude_disputed` restrict every returned entry (related_claims included) to trusted knowledge. |
| 6 | `kb_list` | `kbListSchema` (`src/tools/kb-list.ts`) | confidence, type, module, symbol, tag, limit | `text(JSON): {results, total}` | List KB entries by confidence/type/module/symbol/tag, excluding superseded/stale, without touching FTS ranking or use_count telemetry. |
| 7 | `kb_harvest` | `kbHarvestSchema` (`src/tools/kb-harvest.ts`) | session_transcript, session_id | `text(JSON): {entries_captured, entries_updated, entries_skipped, entries_rejected}` | Scan a session transcript for learnings and capture them into the KB. Extracted entries are UNVERIFIED with author/source=harvest. |
| 8 | `kb_promote` | `kbPromoteSchema` (`src/tools/kb-promote.ts`) | id, reason | `text(JSON): {id, previous_confidence, new_confidence}` | Upgrade KB entry confidence UNVERIFIED -> INFERRED -> CONFIRMED, appending a promotion note as evidence trail. No-op on an already-CONFIRMED entry. |
| 9 | `kb_freshness_sweep` | `kbFreshnessSweepSchema` (`src/tools/kb-freshness-sweep.ts`) | (none) | `text(JSON): {checked, staled, unstaled}` | Bounded full-KB bidirectional freshness sweep: re-hash every entry's stored basis against the current worktree, stale mismatches, revive stale entries whose basis matches again (superseded/downvoted/invalidated stay retired). |
| 10 | `kb_import` | `kbImportSchema` (`src/tools/kb-import.ts`) | path, scope, skip_sweep | `text(JSON): KbImportReport {imported, skipped, linked, flagged, rejected, sweep:{checked, staled, unstaled}}` | Import a merged bible (`.fleet/kb-canonical.json`) into the warm local KB via the AUDN choke point (dup/refine/contradiction routing); directive entries are forced to pending proposals. Runs a freshness sweep after import unless `skip_sweep`. |
| 11 | `kb_resolve_contradiction` | `kbResolveContradictionSchema` (`src/tools/kb-resolve-contradiction.ts`) | winnerId, loserId, evidence | `text(JSON): {winnerId, loserId}` | Resolve a KB contradiction pair: winner goes to CONFIRMED with evidence appended, loser is superseded+stale. Refuses (writes nothing) if either id is missing, already superseded, not a genuine pair, or involves an ACTIVE directive. |
| 12 | `kb_reconcile_prefilter` | `kbReconcilePrefilterSchema` (`src/tools/kb-reconcile-prefilter.ts`) | (none) | `text(JSON): {pairs, resolved[], left_for_agent[], skipped_directive}` | Mechanical hash-basis prefilter over flagged contradiction pairs: a pair with exactly one side hash-matching the current worktree is auto-resolved via `kb_resolve_contradiction`; the rest are left for the reconciler agent. |
| 13 | `kb_setup` | `kbSetupSchema` (`src/tools/kb-setup.ts`) | provider, remote, token | `text(JSON): {success, steps}` | Set up the KB: install the git post-commit hook, write provider config, store remote credentials encrypted. Run once per repo. |
| 14 | `kb_export` | `kbExportSchema` (`src/tools/kb-export.ts`) | scope, baseBranch, baseCommit | `text(JSON): {exported, path, scope, committed}` | Export CONFIRMED/non-superseded/non-stale entries to a canonical bible file. Project scope: only entries whose cited files match their recorded hash basis, merged additively (existing entries never removed; nothing new -> no rewrite, no commit). Global scope: unchanged. Auto-commits the bible file by default when content changed. provenance.branch is the target base branch (baseBranch, else the export folder HEAD branch); provenance.commit is the base commit (baseCommit, else HEAD). |
| 15 | `kb_stats` | `kbStatsSchema` (`src/tools/kb-stats.ts`) | symbols | `text(JSON): ProviderStats spread plus bible` -- `{supported?, reason?, totals, stale, flagged, superseded, retrieval, promote_ratio, coverage?, bible}` | Read-only KB health aggregation: totals by confidence/type, stale/flagged/superseded counts, retrieval hit_rate, promote_ratio, and canonical-bible presence/drift. Never bumps use_count/last_accessed. |
| 16 | `kb_feedback` | `kbFeedbackSchema` (`src/tools/kb-feedback.ts`) | id, reason, role | `text(JSON): {id, stale, flagged_for_review, confidence}` | Downvote a KB entry that proved wrong in practice: marks stale+flagged_for_review and appends a feedback note. Never deletes or touches confidence, except an ACTIVE directive is flagged but not staled. |
| 17 | `kb_bible_commit` | `kbBibleCommitSchema` (`src/tools/kb-bible-commit.ts`) | ids, baseBranch, baseCommit | `text(JSON): {path, merged, skipped, entry_count, committed}` | Merge exactly the given live CONFIRMED ids into the bible at ENTRY level (existing entries kept, never dropped), write provenance from baseBranch (the target base branch) and baseCommit, and make a local pathspec-scoped commit (pm-kb). Never pushes. Unknown/non-CONFIRMED ids are skipped (not_confirmed_or_unknown); CONFIRMED ids failing the shared kb_export basis predicate are skipped (basis_mismatch); no mergeable ids or an unchanged entry set makes no commit. |

Scope-field note: no `kb_*` request schema declares a live scope field. The
removed pre-redesign keys (`repo`, `repo_path`, `repo_remote_url`) are declared
on every `kb_*` request schema only as REMOVED markers, so they reach the tool
wrapper, which refuses any call carrying one with `E-SCOPE-KEY-REMOVED`
(never silently stripped). Every `kb_*` call operates on the CALLING
SESSION's own KB -- a member session's registered work folder, any other
session the fleet server's working folder -- resolved by
`src/services/knowledge/kb-self.ts`. A folder that cannot carry a KB identity is
refused with `E-SELF-NO-WORKFOLDER`, `E-SELF-NOT-A-REPO` or `E-SELF-NO-REMOTE`.
`kb_import`'s `path` names a bible file only. `kb_setup` installs its hook into
the session's folder and writes a single global config; it skips the hook (with
the typed reason) rather than refusing when that folder cannot carry a KB
identity.

### 2.2 code_* tools (9)

| # | Tool | Request schema | Request fields | Response (observed) | Description (summarized) |
|---|------|----------------|----------------|---------------------|---------------------------|
| 18 | `code_graph` | `codeGraphSchema` (`src/tools/code-intelligence.ts`) | symbol | `text(JSON): opaque` (provider payload) | Trace the call graph for a symbol. Returns callers and callees across the codebase for structural analysis (symbol lookup, call chains, impact). |
| 19 | `code_impact` | `codeImpactSchema` (`src/tools/code-intelligence.ts`) | target, direction, file_path | `text(JSON): opaque` (provider payload) | Find what is affected by changes to a symbol. Analyzes the blast radius of modifications across the codebase for impact assessment. |
| 20 | `code_query` | `codeQuerySchema` (`src/tools/code-intelligence.ts`) | query | `text(JSON): opaque` (provider payload) | Search the codebase for symbols, patterns, or concepts using natural language or code patterns. Pre-indexed for instant answers. |
| 21 | `code_context` | `codeContextSchema` (`src/tools/code-intelligence.ts`) | name | `text(JSON): opaque` (provider payload, KB-enriched by `enrichContextWithKb`) | Get callers, callees, and execution flows for a symbol. Enriched with KB context for full understanding of symbol role and dependencies. |
| 22 | `code_map` | `codeMapSchema` (`src/tools/code-intelligence.ts`) | top | `text(JSON): opaque` (provider payload) | Get the architectural map of a repository: module communities with their key symbols and files, ranked by size. |
| 23 | `code_flow` | `codeFlowSchema` (`src/tools/code-intelligence.ts`) | from, to, name | `text(JSON): opaque` (provider payload) | Find process flows (entry -> steps -> exit) matching a name or specific endpoints. Pre-indexed alternative to manual call chain tracing. |
| 24 | `code_tests` | `codeTestsSchema` (`src/tools/code-intelligence.ts`) | symbol | `text(JSON): opaque` (provider payload) | Find the test files and test functions that exercise a symbol (transitive callers, depth 2). Faster than grep for test discovery. |
| 25 | `code_reindex` | `codeReindexSchema` (`src/tools/code-intelligence.ts`) | (none) | `text(JSON)`: {outcome, reason?, indexedCommit, ...} (typed; `provider-not-supported` for a non-gitnexus provider) | Rebuild the calling session's own code index (gitnexus analyze, detached, output captured); returns after the first tick with a typed outcome. Provider `none` fails with E-CODE-INTEL-DISABLED. |
| 26 | `code_status` | `codeStatusSchema` (`src/tools/code-intelligence.ts`) | (none) | `text(JSON)`: {last run, readiness, indexedCommit} (typed; `provider-not-supported` for a non-gitnexus provider) | Report the calling session's own code index state: last analyze run, live readiness, indexed commit. Provider `none` fails with E-CODE-INTEL-DISABLED. |

No `code_*` tool takes a repo/scope argument (`repo`, `repo_path`,
`repo_remote_url`): like `kb_*`, the repo a call is about is the calling
session's own folder (`resolveCodeSelf()`, `src/tools/code-intelligence.ts`,
over the shared `resolveSelfSession()` / `validateSelfRepoFolder()` in
`src/services/knowledge/kb-self.ts`), refused with `E-SELF-NO-WORKFOLDER` /
`E-SELF-NOT-A-REPO`. No origin remote is required. `code_context` enriches from
the KB of that same resolved folder.

Registration descriptions for all 26 tools are reproduced verbatim in Appendix A.

## 3. Decision rule: responses that are not schema-shaped

Observed facts about the response side of this surface:

- Every one of the 26 tools is registered through the shared `wrapTool` helper in
  `src/services/tool-registry.ts`, which converts the handler return value into
  MCP `content: [{type: 'text', text}]` blocks.
- NO tool in this surface declares a response zod schema. The registration call
  is given a name, a description and a REQUEST shape only.
- NO tool in this surface returns `structuredContent`. `wrapTool` forwards
  `structuredContent` only when the handler returns `{text, structuredContent}`;
  all 23 handlers return a bare `string`, so the channel is unused here. (In the
  wider 58-tool server, only non-memory tools use it, e.g. `execute_command`
  and `execute_prompt`.)
- All 23 handlers return a JSON-stringified value. So every response is
  JSON-parseable in practice, even though none is schema-declared.

**Decision rule (v1):** a response is NEVER left un-schema'd, and a missing shape
NEVER blocks contract generation. Every tool response is modelled as a minimal
text-content envelope:

```
ToolTextResponse = { content: [ { type: "text", text: string } ] }
```

On top of that envelope, each tool gets one of two response bodies:

- **Body known** -- the handler stringifies an object whose top-level keys are
  observable in this repo (all 17 `kb_*` tools). The generated response schema is
  the text envelope PLUS the documented parsed-body object.
- **Body opaque** -- the handler stringifies a value this repo types as `unknown`
  because it is a pass-through from an external code-intelligence provider (all 7
  `code_*` tools). The generated response schema is the text envelope ONLY, with
  the parsed body typed as unconstrained JSON. This is a deliberate permissive
  schema, not a gap to be filled by guessing the provider payload.

### 3.1 Findings (tools whose response cannot be tightened in v1)

Each of the following is a finding, not a blocker. The reason is the same in all
seven cases: the `handleCode*` functions in `src/tools/code-intelligence.ts`
return `Promise<unknown>` and merely proxy to the active
`CodeIntelligenceProvider` (`codebase-memory`, `gitnexus`, or `none`), so the
payload shape is owned by the provider, differs between providers, and is not
validated at the fleet boundary.

- F-1 `code_graph` -- opaque provider payload.
- F-2 `code_impact` -- opaque provider payload.
- F-3 `code_query` -- opaque provider payload.
- F-4 `code_context` -- opaque provider payload, further merged with KB data by
  `enrichContextWithKb`, so its shape is provider-shape-plus-enrichment.
- F-5 `code_map` -- opaque provider payload.
- F-6 `code_flow` -- opaque provider payload.
- F-7 `code_tests` -- opaque provider payload.

Additional response-shape findings on the `kb_*` side:

- F-8 `kb_query` returns TWO different top-level shapes from one tool: the
  `flagged_only` branch returns `{flagged_entries, total, note}` and the normal
  branch returns `{l1_results, l2_expanded}` plus a conditional `related_claims`
  key that is ABSENT (not null) unless `expand_related` is true. A v1 response
  schema must be a union with an optional key, not a single fixed object.
- F-9 `kb_stats` builds its response by SPREADING `ProviderStats` and adding
  `bible`. `ProviderStats` itself has optional `supported`/`reason` fields that
  appear only on a provider which cannot compute stats at all, and an optional
  `coverage` field. The response schema must allow those optionals.

## 4. Provider method surface

### 4.1 MemoryProvider interface -- declared methods (12)

Declared in `src/services/knowledge/types.ts` (line 230). The "tools routing
through it" column lists only the `kb_*`/`code_*` tools in this surface.

| # | Method | Signature | Tools routing through it | Effect | Idempotent |
|---|--------|-----------|--------------------------|--------|------------|
| P-1 | `init` | `init(): Promise<void>` | none directly -- called during provider resolution before any tool call | write (schema/pragma setup) | yes |
| P-2 | `capture` | `capture(input: KBEntryInput): Promise<{id, audn_decision}>` | `kb_capture`, `kb_harvest`, `kb_import` | write, plus mutate-trust (directive gate, confidence clamp, contradiction flagging) | no (new row per call unless AUDN dedupes to `none`) |
| P-3 | `query` | `query(opts: QueryOptions): Promise<KBResult>` | `kb_query`, `kb_session_prime` | read plus telemetry write (bumps `use_count`/`last_accessed`) | no (telemetry side effect) |
| P-4 | `context` | `context(files: string[]): Promise<FileContextResult[]>` | `kb_context` | read | yes |
| P-5 | `invalidate` | `invalidate(files: string[]): Promise<{invalidated}>` | `kb_invalidate` | mutate-trust (marks context-cache entries stale) | yes |
| P-6 | `getLinked` | `getLinked(id: string): Promise<KBEntry[]>` | none in this surface (internal link inspection) | read | yes |
| P-7 | `prime` | `prime(opts: PrimeOptions): Promise<PrimedContext>` | `kb_session_prime` | read | yes |
| P-8 | `promote` | `promote(id, reason?): Promise<{id, confidence_before, confidence_after}>` | `kb_promote` | mutate-trust (confidence tier up, appends evidence note) | at the CONFIRMED ceiling yes (no-op); below it NO -- each call advances one tier |
| P-9 | `sync` | `sync(opts?: SyncOptions): Promise<SyncResult>` | none in this surface | read/write (remote transfer) | no |
| P-10 | `stats` | `stats(opts?: {symbols?}): Promise<ProviderStats>` | `kb_stats` | read, explicitly NO telemetry bump | yes |
| P-11 | `touch` | `touch(ids: string[]): Promise<number>` | `kb_session_prime` | telemetry write (`use_count`/`last_accessed`), existence-tolerant | no (counter advances) |
| P-12 | `relatedClaims` | `relatedClaims(ids: string[], limit?): Promise<KBEntry[]>` | `kb_query` (only when `expand_related` is true) | read | yes |

### 4.2 Provider members reached by tools but NOT declared on MemoryProvider (7 methods + 1 property)

These are `SqliteProvider` members (`src/services/knowledge/sqlite-provider.ts`)
that registered tools call directly. They are part of the real contract surface
even though the interface does not declare them -- a generated binding typed only
against `MemoryProvider` would not cover them.

| # | Member | Signature | Tools routing through it | Effect | Idempotent |
|---|--------|-----------|--------------------------|--------|------------|
| X-1 | `list` | `list(opts: {confidence?, type?, module?, symbol?, tag?, limit?}): Promise<KBEntry[]>` | `kb_list`, `kb_stats` (bible drift comparison), `kb_export` (`src/tools/kb-export.ts:337`, `source.list({confidence: 'CONFIRMED'})` to select entries to export), `kb_bible_commit` (`src/tools/kb-bible-commit.ts`, `list({confidence: ['CONFIRMED']})` to resolve the given ids to live CONFIRMED entries) | read, no telemetry bump | yes |
| X-2 | `feedback` | `feedback(id, reason, author): Promise<KBEntry>` | `kb_feedback` | mutate-trust (sets `stale` plus `flagged_for_review`, appends note; never deletes, never touches confidence) | no (each call appends another note) |
| X-3 | `freshnessSweep` | `freshnessSweep(root?): Promise<{checked, staled, unstaled}>` | `kb_freshness_sweep`, `kb_import` (post-import unless `skip_sweep`) | mutate-trust (bidirectional stale/unstale) | yes for a fixed worktree |
| X-4 | `resolveContradiction` | `resolveContradiction(winnerId, loserId, evidence): Promise<{winnerId, loserId}>` | `kb_resolve_contradiction`, and internally from `reconcilePrefilter` | mutate-trust (winner to CONFIRMED with flags cleared; loser superseded plus stale) | NO -- a second call REFUSES, because the loser is now superseded |
| X-5 | `reconcilePrefilter` | `reconcilePrefilter(): Promise<{pairs, resolved[], left_for_agent[], skipped_directive}>` | `kb_reconcile_prefilter` | mutate-trust (writes only via `resolveContradiction`) | yes in effect (resolved pairs are no longer flagged) |
| X-6 | `hasEntry` | `hasEntry(id: string): boolean` -- SYNCHRONOUS (non-Promise) | `kb_import` | read | yes |
| X-8 | `getSourceFileBases` | `getSourceFileBases(ids: string[]): Map<string, Record<string, string> \| null>` -- SYNCHRONOUS (non-Promise); stored per-file hash basis per id, null when unknown/empty | `kb_export` (project-scope bible filter) | read | yes |
| X-7 | `repoPath` | property, not a method | NOT read by `kb_freshness_sweep` -- `src/tools/kb-freshness-sweep.ts:30` calls `providers.project.freshnessSweep()` with NO argument; the tool only names `repoPath` in a comment at line 27, and the sweep root defaults inside `freshnessSweep()` itself (`SqliteProvider`'s own stored anchor), not from a value the tool passes in | read (by the provider internally, not by this tool) | n/a |

Also off-interface and reachable, but CLI-only rather than tool-reachable (listed
so the v1 contract does not mistake them for MCP surface): `approveDirective`,
`rejectDirective`, `addDirective`, `flaggedPairs`. `approveDirective` and
`addDirective` are the only CONFIRMED-minting paths besides `promote`, and all of
them bypass `capture()`.

### 4.3 CodeIntelligenceProvider interface (7 methods)

Declared in `src/tools/code-intelligence.ts`. Every method has the signature
`(params: Record<string, unknown>) => Promise<unknown>`; each is a pure proxy, so
effect and idempotency belong to the ACTIVE PROVIDER, not to this repo. Three
implementations are registered in `PROVIDERS`: `codebase-memory`, `gitnexus`, and
`none` (`NullProvider`).

| # | Method | Tool routing through it | Effect |
|---|--------|------------------------|--------|
| C-1 | `graph` | `code_graph` | read (proxy) |
| C-2 | `impact` | `code_impact` | read (proxy) |
| C-3 | `query` | `code_query` | read (proxy) |
| C-4 | `context` | `code_context`, and `kb_session_prime` for neighbor-symbol expansion | read (proxy) |
| C-5 | `map` | `code_map` | read (proxy) |
| C-6 | `flow` | `code_flow` | read (proxy) |
| C-7 | `tests` | `code_tests` | read (proxy) |

`NullProvider` throws `E-CODE-INTEL-DISABLED` from every method (one line, with a
`Remediation:` clause), so a disabled member's call is an error result, never an
ok payload that merely says "disabled". A missing or still-building index throws
`E-CODE-INDEX-NOT-READY` from the adapters' pre-flight (`codeIndexReadiness`,
`src/tools/code-intelligence-readiness.ts` -- the one readiness check).

### 4.4 Implementation-coverage cross-check: SqliteProvider vs HttpKbProvider

Both `MemoryProvider` implementations in `src/services/knowledge/` were checked
against the section 4.1/4.2 tables. Finding up front, load-bearing for
everything below: **`HttpKbProvider` is never constructed anywhere in `src/`
outside its own class body and stray comments** (grep confirms this). `kb-providers.ts`
types `KbProviders.project`/`.global` as `SqliteProvider` explicitly (not
`MemoryProvider`), and `getKbProviders`/`createKbProvidersForSlug` only ever
`new SqliteProvider(...)`. `kb_setup` can write `{provider: 'http', ...}` to
its config file, but nothing under `src/services/knowledge` reads that config
back to select a provider class. So every one of the divergences below is
currently **dead code**, not a live behavioral difference an agent can hit --
this is itself the coverage finding this section exists to record (F-10).

**4.4.1 -- The 12 `MemoryProvider` interface methods (section 4.1): both classes
implement all 12 (TypeScript enforces this via `implements MemoryProvider`).
Per-method comparison of what each one actually DOES:**

| # | Method | SqliteProvider (section 4.1) | HttpKbProvider (`src/services/knowledge/http-provider.ts`) | Divergence | Verdict class |
|---|--------|-------------------------------|--------------------------------------------------------------|------------|----------------|
| P-1 | `init` | schema/pragma setup, write | delegates to `this.fallback.init()` (an internal `SqliteProvider`) -- no remote init call at all | HttpKbProvider's "init" is really just its embedded fallback's init; the remote server is assumed already initialized | different signature/behavior |
| P-2 | `capture` | full AUDN pipeline locally (clamp, directive-quarantine, contradiction-flagging) | POSTs `/api/kb/capture`; on connection error (`isConnectionError`, http-provider.ts:28-39), enqueues to `offlineQueue` and returns a fabricated `{id: "offline-<random>", audn_decision: 'add'}` WITHOUT running any AUDN logic; on any other error -- remote HTTP >=400 (`rawRequest` rejects with code `HTTP_<status>`, http-provider.ts:114-122) or a malformed remote body (plain `Error('Invalid JSON response from KB server')`, http-provider.ts:124-126) -- the error is RETHROWN, not degraded | offline capture always reports `audn_decision: 'add'` regardless of what the server would actually have decided -- the true decision is deferred until `tryFlushQueue` succeeds, and the caller is never told it changed; separately, a remote 500 or bad JSON propagates as a throw instead of falling back, unlike the connection-error path | different signature/behavior |
| P-3 | `query` | full `QueryOptions` support (`types.ts:108-135`, 13 optional fields: `query`, `fts_terms`, `type`, `symbols`, `source_files`, `tags`, `tag`, `include_stale`, `include_superseded`, `flagged_only`, `l1_only`, `limit`, `ids`) including `ids`, `tag`, `flagged_only`, `symbols`, `source_files`, `tags`, `fts_terms` | GETs `/api/kb/query` forwarding only `query, type, limit, l1_only, include_stale, include_superseded` (http-provider.ts:181-190) -- SEVEN of the 13 optional fields are silently dropped client-side: `ids`, `symbols`, `source_files`, `tags`, `tag`, `flagged_only`, and `fts_terms` (13 - 6 forwarded = 7); on connection error falls back to `this.fallback.query(opts)` (full local support); on a non-connection error (remote HTTP >=400 or bad JSON, http-provider.ts:114-126) it RETHROWS instead of falling back | Two mechanisms, not one blame: (a) `ids`, `symbols`, `source_files`, `tags`, `tag`, `flagged_only` (six fields) are dropped because `http-provider.ts:181-190` simply never reads them -- an ordinary omission, and `ids` is the load-bearing one of the six -- `kb-query.ts:93` and `:97` call `query({ids})` for L2 hydration and cross-scope fill, and `SqliteProvider.query` (sqlite-provider.ts:965-969) treats `ids` as a direct exact-id lookup bypassing FTS entirely, so an HTTP-backed L2 hydration would degrade to a parameter-less remote GET instead of fetching the requested rows. (b) `fts_terms` (the seventh) is dropped for a DIFFERENT, deliberate reason: `types.ts:113-119` declares it INTERNAL ONLY, structurally excluded from `kbQuerySchema` and the `/api/kb/query` route, with an explicit do-not-add directive -- it has a live in-process caller (`kb_session_prime`: `kb-session-prime.ts:221` passes it to `providers.global.query`, `:276` to `providers.project.query`, and `SqliteProvider` honors it via `orJoinFtsTerms`, `sqlite-provider.ts:1019-1024`), so it IS reachable in-process, just never over the wire; forwarding it is NOT the implied remedy, unlike the other six. (c) Server-side narrowing, independent of the client: the only in-tree `/api/kb/query` handler (`kb-server.ts:146-155`) reads just `query, type, limit, l1_only` from the query string, so `include_stale` and `include_superseded` are dropped SERVER-side even though the client forwards them -- net four filters survive a live remote round trip (`query`, `type`, `limit`, `l1_only`), not six. Also: the SAME options object degrades to full support only when offline, which is backwards from what a caller would expect; and a remote 500/malformed body throws rather than degrading, the same rethrow gap as P-2 | different signature/behavior |
| P-4 | `context` | read | GET `/api/kb/context`, fallback to local on connection error (`isConnectionError`, http-provider.ts:28-39); on a non-connection error -- remote HTTP >=400 or a malformed JSON body (http-provider.ts:114-126) -- `context` (http-provider.ts:201-214) RETHROWS instead of falling back to `this.fallback.context(files)` | net-equivalent only on the connection-error path; on a remote 500 or bad JSON, `context` throws where `SqliteProvider.context` would have returned data | different signature/behavior |
| P-5 | `invalidate` | marks context-cache entries stale (real mutate) | POSTs `/api/kb/invalidate`; on connection error enqueues the op and returns `{invalidated: 0}` -- the local cache is NOT actually marked stale while offline; on a non-connection error (remote HTTP >=400 or bad JSON, http-provider.ts:114-126) it RETHROWS instead of enqueuing | offline `invalidate` is a no-op report, not a degraded-but-real local mutation, despite `capture`'s offline path at least queuing for eventual replay; and a remote 500/bad JSON throws rather than degrading, the same rethrow gap as P-2/P-3 | different signature/behavior |
| P-6 | `getLinked` | read | ALWAYS delegates to `this.fallback.getLinked(id)` -- no remote route exists at all | not a proxy method for this provider; purely local regardless of connectivity | different signature/behavior |
| P-7 | `prime` | read | POST `/api/kb/prime`, fallback to local on connection error (`isConnectionError`, http-provider.ts:28-39); on a non-connection error -- remote HTTP >=400 or a malformed JSON body (http-provider.ts:114-126) -- `prime` (http-provider.ts:257-267) RETHROWS instead of falling back to `this.fallback.prime(opts)` | net-equivalent only on the connection-error path; on a remote 500 or bad JSON, `prime` throws where `SqliteProvider.prime` would have returned data | different signature/behavior |
| P-8 | `promote` | mutate-trust, one-tier-per-call | ALWAYS delegates to `this.fallback.promote(id, reason)` -- no remote route exists at all | promotion is local-only even when the remote server is reachable; a promoted-over-HTTP entry never reaches the remote KB | different signature/behavior |
| P-9 | `sync` | read/write (remote transfer) | hardcoded `return {synced: false, reason: 'local-only provider'}` -- ignores `opts` entirely, never contacts the remote server | ironic given the class name: the one method whose name promises remote transfer is the one HttpKbProvider refuses to perform at all. Same shape as P-10/E-STATS-UNSUPPORTED: a documented `{synced: false, reason}` result returned instead of a throw, so callers get a decision-coded outcome rather than an exception | documented not-supported degradation (same pattern as E-STATS-UNSUPPORTED, section 5.1) |
| P-10 | `stats` | read, full computation | hardcoded not-supported result (already documented as E-STATS-UNSUPPORTED in section 5.1) | confirmed consistent with section 5.1; no new finding | documented not-supported degradation (E-STATS-UNSUPPORTED, section 5.1) |
| P-11 | `touch` | telemetry write | ALWAYS delegates to `this.fallback.touch(ids)`; catches and swallows any error, returning `0` | no remote telemetry route exists; comment in the source explicitly says a telemetry write must never fail a prime | different signature/behavior |
| P-12 | `relatedClaims` | read | ALWAYS delegates to `this.fallback.relatedClaims(ids, limit)`; catches and swallows any error, returning `[]` | no remote route exists; same never-fail rationale as `touch` | different signature/behavior |

Pattern across P-6, P-8, P-11, P-12: four of the twelve interface methods on
`HttpKbProvider` have NO remote code path whatsoever -- they are pure
pass-throughs to the embedded `fallback: SqliteProvider`, connectivity
notwithstanding. Only `capture`, `query`, `context`, `invalidate`, and `prime`
(five methods) actually attempt an HTTP request first.

**4.4.2 -- The 7 methods + 1 property reachable-but-undeclared on `MemoryProvider`
(section 4.2): none of them exist on `HttpKbProvider` at all.**

| # | Member | On `HttpKbProvider`? | Consequence | Verdict class |
|---|--------|----------------------|--------------|----------------|
| X-1 | `list` | absent | `kb_list` calls `providers.project.list(...)` where `providers.project` is typed `SqliteProvider` (section 4.4 preamble) -- structurally could not target an `HttpKbProvider` even if one were ever returned | missing member |
| X-2 | `feedback` | absent | same shape of gap; `kb_feedback` -> `SqliteProvider.feedback` only | missing member |
| X-3 | `freshnessSweep` | absent | `kb_freshness_sweep`, `kb_import` -> `SqliteProvider.freshnessSweep` only | missing member |
| X-4 | `resolveContradiction` | absent | `kb_resolve_contradiction` -> `SqliteProvider.resolveContradiction` only | missing member |
| X-5 | `reconcilePrefilter` | absent | `kb_reconcile_prefilter` -> `SqliteProvider.reconcilePrefilter` only | missing member |
| X-6 | `hasEntry` | absent | `kb_import` -> `SqliteProvider.hasEntry` only | missing member |
| X-8 | `getSourceFileBases` | absent | `kb_export` -> `SqliteProvider.getSourceFileBases` only | missing member |
| X-7 | `repoPath` | absent (property) | `kb_freshness_sweep` reads `SqliteProvider.repoPath` directly; no analogous property on `HttpKbProvider` | missing member |

None of these are "missing" in the sense of an incomplete HTTP implementation
that should be filled in -- per the 4.4 preamble, the seven tools in this table
never receive anything except a `SqliteProvider` instance in this tree, so the
gap is currently unreachable rather than a live bug. It is recorded here
because a v1 contract binding generated only from `MemoryProvider` +
`HttpKbProvider`'s declared surface would still miss these seven tools' true
provider dependency, same root cause as section 4.2's existing finding.

**4.4.3 -- Asymmetries outside the `MemoryProvider` interface itself.** These are
not covered by 4.4.1 (which only compares the 12 declared interface methods'
BEHAVIOR) or 4.4.2 (which only lists tool-reachable members absent from
`HttpKbProvider`): they are members that exist on one implementation under a
different name, or with a different signature, than the other.

| # | Member | SqliteProvider | HttpKbProvider | Divergence | Verdict class |
|---|--------|-----------------|-----------------|------------|----------------|
| X-8 | teardown | `close(): void` (sqlite-provider.ts:1887) | `dispose(): void` (http-provider.ts:65) | different method names for the same teardown responsibility -- a generated binding cannot call teardown polymorphically across both implementations without a name-mapping shim | missing member (name mismatch) |
| X-9 | `capture` extra parameter | `capture(input: KBEntryInput, opts?: CaptureOpts): Promise<{id, audn_decision}>` (sqlite-provider.ts:792) | `capture(input: KBEntryInput): Promise<{id, audn_decision}>` (http-provider.ts:166) -- no second parameter | `SqliteProvider.capture` accepts an optional second `opts: CaptureOpts` argument that neither the `MemoryProvider` interface (section 4.1, P-2) nor `HttpKbProvider.capture` declares; a caller that passes `opts` through the interface type would not type-check against `HttpKbProvider` | different signature/behavior |

Neither `close`/`dispose` nor the `capture` `opts` parameter is declared on
`MemoryProvider` (section 4.1), so both are additional, implementation-specific
surface a v1 contract binding must account for on top of the interface.

**F-10 (new finding, added to the running list; numbering continues from
section 3.1's F-9):** `HttpKbProvider` is fully implemented and type-checks
against `MemoryProvider`, but is dead code in this tree -- no call site
constructs one, and `kb_setup`'s `provider: 'http'` config value is never read
back to select it. Of the 12 interface methods it does implement, 4 (`getLinked`,
`promote`, `touch`, `relatedClaims`) have no remote code path at all, and one
(`query`) drops seven of QueryOptions' 13 optional fields on the remote path
while supporting all 13 fully on its local fallback path: six by omission
(`ids`, `symbols`, `source_files`, `tags`, `tag`, `flagged_only`) plus
`fts_terms`, which is dropped deliberately as internal-only rather than as an
oversight (section 4.4.1, P-3). The server side narrows the surviving set
further still, to four. A v1 contract
binding must not assume the two `MemoryProvider` implementations are
behaviorally interchangeable merely because both compile against the same
interface. Every row of the 4.4.1 and 4.4.2 tables now carries an explicit
"Verdict class" naming one of: missing member, different signature/behavior,
consistent (no divergence), or documented not-supported degradation. `sync`
(P-9) is classified in the same "documented not-supported degradation" class
as `stats`/E-STATS-UNSUPPORTED (P-10, section 5.1): both return a designed
`{..., reason}`-shaped result on the not-supported path rather than throwing,
so a v1 contract binding should treat them with the same non-throwing,
decision-coded-outcome handling.

## 5. Error and refusal paths

Provisional names are assigned here so downstream schema and binding work has a
stable vocabulary. Grouping is by mechanism, because several of these paths do not
throw at all and a throw-site scan cannot find them.

Completeness audit (T1.0.2d): a grep of `throw new` across
`src/services/knowledge/*.ts` and `src/tools/kb-*.ts` returns 28 hits (22 in
`src/services/knowledge/` -- 20 in `sqlite-provider.ts`, 2 in
`path-validation.ts` -- plus 6 in `src/tools/kb-*.ts`), reconciled below
against section 5.2's provisional names. All 28 map onto an existing or
newly-added row; none is out-of-contract-surface. `src/tools/code-
intelligence.ts` (the `code_*` side) is swept separately in 5.5 since its two
throw sites are not part of the `kb_*` grep set above.

### 5.1 Non-throwing paths (silent transformation or decision-coded outcome)

| Provisional name | Where | Mechanism | Observable signal |
|------------------|-------|-----------|-------------------|
| `E-CLAMP` | `src/tools/kb-capture.ts:102-105` (UX copy) and `SqliteProvider.capture`, `src/services/knowledge/sqlite-provider.ts:889-893` (enforcement copy) | an incoming `CONFIRMED` on a non-directive type is DOWNGRADED to `INFERRED`, with a bracketed note appended to content | `confidence_clamped: true` in the `kb_capture` response, plus the content note. The flag is derived as "stored confidence differs from requested" (requested defaults to `INFERRED`; `src/tools/kb-capture.ts:127-133`), so it is not specific to this branch. NOT an error |
| `E-DIRECTIVE-QUARANTINE` | `SqliteProvider.capture` directive gate, `src/services/knowledge/sqlite-provider.ts:806-818` | a `user-directive` capture is forced to a PENDING PROPOSAL: confidence to `UNVERIFIED`, `flagged_for_review` set, `directive:pending` tag added, scope forced to `project` | the stored entry differs from the requested one; activation is CLI-only. On the `kb_capture` path the forced `UNVERIFIED` makes stored confidence differ from requested, so the response reports `confidence_clamped: true` -- the same flag as `E-CLAMP`, which names neither the quarantine nor the forced tag/flag/scope. NOT an error |
| `E-CONTRADICTION-FLAGGED` | `makeAudnDecision`, `src/services/knowledge/audn.ts:196-206` | symbol overlap PLUS a contradiction signal (keyword hit or opposite polarity); cross-type allowed, file overlap not required | `audn_decision: flagged` in the capture response, and a `contradiction_of` link. NOT an error |
| `E-SUPERSEDE-CONSENT-MISSING` | `makeAudnDecision` explicit-supersede branch, `src/services/knowledge/audn.ts:145-157` | a `supersedes` request takes effect ONLY if AUDN independently matches that candidate under the dedup gates (same type, symbol overlap, file overlap, target not an ACTIVE user-directive). Otherwise the request silently falls through to the ordinary paths | the named target is NOT retired and `audn_decision` is whatever the fallthrough decided. NO error is raised -- the most easily missed refusal in the surface |
| `E-DEDUP-NONE` | `makeAudnDecision`, `src/services/knowledge/audn.ts:180-183` (exact-match pre-pass) and `:231-233` (loop) | exact content equality, or a same-topic match with no contradiction signal | `audn_decision: none` -- the capture is skipped, not failed |
| `E-ACTIVE-DIRECTIVE-SUPERSEDE-GUARD` | `makeAudnDecision`, `src/services/knowledge/audn.ts:224` | an ACTIVE (CONFIRMED) user-directive candidate can never be superseded or updated by any `capture()` path; the loop skips past it | the candidate degrades to `flagged` (if a contradiction signal was present) or is skipped. NOT an error |
| `E-STATS-UNSUPPORTED` | `ProviderStats.supported === false` (HTTP provider, per design D4), `src/services/knowledge/http-provider.ts:284-287` | a provider that cannot compute stats returns a documented not-supported result rather than throwing | `{supported: false, reason}` in the `kb_stats` response |
| `E-BIBLE-READ-DEGRADED` | `src/tools/kb-stats.ts:116-122` (nested `catch` blocks) | any failure reading or comparing the canonical bible is swallowed | the response falls back to the absent/drift-zero bible shape. `kb_stats` never throws over the bible file |
| `E-RELATED-CLAIMS-DEGRADED` | `src/tools/kb-query.ts:113-118` | `relatedClaims` throws | caught; `related_claims` becomes `[]` and the query result still returns |

### 5.2 Throwing paths (refusals)

| Provisional name | Where | Trigger |
|------------------|-------|---------|
| `E-NO-BASIS` | `SqliteProvider.assertCheckableBasis`, `src/services/knowledge/sqlite-provider.ts:339`, raising `KbCaptureRejected('no_source_files')` | an entry cites zero source files. Exempt: `user-directive`, which is not a claim about code. Rationale: the freshness sweep builds its work set only from entries with a parsed basis, so a basis-less entry is structurally unfalsifiable |
| `E-BASIS-MISSING-FILES` | `SqliteProvider.assertCheckableBasis`, `src/services/knowledge/sqlite-provider.ts:349`, raising `KbCaptureRejected('missing_source_files')` | cited source files do not resolve in this worktree. NO exemption for harvest-sourced entries or for import mode |
| `E-PROVIDER-UNINITIALIZED` | `SqliteProvider.getDb`, `src/services/knowledge/sqlite-provider.ts:197` | any method called before `init()` |
| `E-ENTRY-NOT-FOUND` | `promote` (`sqlite-provider.ts:1340`), `feedback` (`sqlite-provider.ts:1431`) | the id has no row |
| `E-PROMOTE-SUPERSEDED` | `promote`, `src/services/knowledge/sqlite-provider.ts:1343` | the target entry is already superseded |
| `E-PROMOTE-REFUSED-DIRECTIVE` | `promote` guard block, `src/services/knowledge/sqlite-provider.ts:1353-1357` | promotion of a `user-directive` entry; activation is CLI-only |
| `E-PROMOTE-REASON-REQUIRED` | `promote`, `src/services/knowledge/sqlite-provider.ts:1366-1370` (newly named -- not previously listed) | `reason` fails `isNonTrivialPromoteReason` (absent or shorter than `MIN_PROMOTE_REASON_LENGTH`); a CONFIRMED promotion must carry a recorded evidence string |
| `E-PROMOTE-BASIS-UNRESOLVED` | `promote`, `src/services/knowledge/sqlite-provider.ts:1377-1384` (newly named -- not previously listed) | the entry has zero `source_files`, or one or more cited files no longer resolve in this worktree; an unfalsifiable/stale basis cannot earn CONFIRMED |
| `E-RESOLVE-MISSING-ENTRY` | `resolveContradiction`, `src/services/knowledge/sqlite-provider.ts:1554-1555` | either id does not exist. Writes NOTHING |
| `E-RESOLVE-ALREADY-SUPERSEDED` | `resolveContradiction`, `src/services/knowledge/sqlite-provider.ts:1560-1561` | either entry is already superseded. Writes NOTHING |
| `E-RESOLVE-NOT-A-PAIR` | `resolveContradiction`, `src/services/knowledge/sqlite-provider.ts:1564-1566` | the ids do not form a genuinely linked contradiction pair. Writes NOTHING |
| `E-RESOLVE-DIRECTIVE-PAIR` | `resolveContradiction`, `src/services/knowledge/sqlite-provider.ts:1569-1571` | the pair involves an ACTIVE user-directive; directives are never auto-resolved. Writes NOTHING |
| `E-DIRECTIVE-NOT-FOUND` | `approveDirective` (`sqlite-provider.ts:1723`), `rejectDirective` (`sqlite-provider.ts:1746`) | the id has no row (CLI-only surface) |
| `E-DIRECTIVE-WRONG-TYPE` | `approveDirective` (`sqlite-provider.ts:1725`), `rejectDirective` (`sqlite-provider.ts:1748`) | the entry is not a `user-directive` (CLI-only surface) |
| `E-DIRECTIVE-ALREADY-DECIDED` | `approveDirective` (`sqlite-provider.ts:1726` already-rejected, `:1727` already-active), `rejectDirective` (`sqlite-provider.ts:1749` already-rejected) | already active, or already rejected (CLI-only surface) |
| `E-PATH-TRAVERSAL` | `validateFilePaths`, `src/services/knowledge/path-validation.ts:6` (absolute path) and `:10` (parent-directory traversal) | an absolute path, or a parent-directory traversal, in a file list |
| `E-QUERY-NO-SELECTOR` | `src/tools/kb-query.ts:34` | none of `query`, `tag`, `flagged_only` was supplied |
| `E-REPO-PATH-INVALID` | `requireLocalFolder` in `src/tools/kb-export.ts` (also used by `src/tools/kb-bible-commit.ts`), `src/tools/kb-import.ts` | the calling session's folder is not a directory on this host (a remote member session). All three write into it, so all three refuse rather than writing anywhere else |
| `E-SELF-NO-WORKFOLDER` | `resolveSelfAnchor` / `validateSelfFolder`, `src/services/knowledge/kb-self.ts` | the calling session's folder (member work folder, or the server's working folder) is missing, unset, or not a directory |
| `E-SELF-NOT-A-REPO` | `validateSelfFolder`, `src/services/knowledge/kb-self.ts` | the calling session's folder is not a git repository |
| `E-SELF-NO-REMOTE` | `validateSelfFolder` / `resolveSelfAnchor`, `src/services/knowledge/kb-self.ts` | the calling session's folder has no origin remote (remote member: no single known origin remote), so it has no KB identity |
| `E-SCOPE-KEY-REMOVED` | `assertNoRemovedKbScopeKeys`, `src/services/knowledge/kb-removed-scope-keys.ts` (called from the kb_* tool wrapper in `src/services/tool-registry.ts`) | a kb_* request carries a removed pre-redesign scope key (`repo_path`, `repo`, `repo_remote_url`); refused before any KB is resolved. Writes NOTHING |
| `E-MEMBER-VIEW-READ-ONLY` | `src/tools/kb-feedback.ts` | `kb_feedback` was called in a MEMBER session; the member's bible view is read-only. Writes NOTHING |
| `E-BIBLE-NOT-FOUND` | `src/tools/kb-import.ts:143` | the resolved bible file does not exist |
| `E-BIBLE-NOT-JSON` | `src/tools/kb-import.ts:150` | the bible file is not valid JSON |
| `E-BIBLE-WRONG-SHAPE` | `src/tools/kb-import.ts:168` | the bible parses but is neither an entry array nor the v2/v3 envelope |

Reconciliation: the 28 `throw new` hits map onto the 19 pre-existing names plus
the 2 newly-added names above (`E-PROMOTE-REASON-REQUIRED`,
`E-PROMOTE-BASIS-UNRESOLVED`) -- `sqlite-provider.ts:1367` and `:1379` were
unlisted throw sites inside `promote()` found by this audit, not covered by
any prior row. Every other throw site maps to an existing name; several names
cover more than one throw site (e.g. `E-ENTRY-NOT-FOUND` covers both
`promote` and `feedback`; `E-DIRECTIVE-ALREADY-DECIDED` covers three sites
across `approveDirective`/`rejectDirective`). No throw site was found to be
out-of-contract-surface.

### 5.3 Import-time entry rejection (counted, not thrown)

| Provisional name | Where | Mechanism |
|------------------|-------|-----------|
| `E-IMPORT-ENTRY-REJECTED` | `src/tools/kb-import.ts:222-234`, surfaced as `KbImportReport.rejected` | a single bible entry that fails `E-NO-BASIS` or `E-BASIS-MISSING-FILES` (via a caught `KbCaptureRejected` from `provider.capture(...)`) is counted in `rejected` and skipped; the import as a whole still succeeds. Per-entry SHAPE validation failures are a SEPARATE counter: `isValidBibleEntry` (`src/tools/kb-import.ts:98-109` -- bad/empty id, type, title, summary or confidence; non-array `symbols`/`source_files`) and the pre-existing-id check (`kb-import.ts:193-196`) are counted in `skipped`, not `rejected` -- correcting this row's prior claim that they were counted alongside the basis rejections and correcting the prior function name `isBibleEntry` (no such symbol exists; the actual name is `isValidBibleEntry`) |

### 5.4 Author/role validation

`validateAuthor` exists in BOTH `src/tools/kb-capture.ts:16-20` and
`src/tools/kb-feedback.ts:12-16` (duplicated, not shared). It never throws: an
unrecognised `role` degrades to the literal `unknown`. Provisional name
`E-ROLE-UNKNOWN-DEGRADED`.

### 5.5 `code_*` side: provider configuration refusals

The `code_*` tools route through `getProvider()` in
`src/tools/code-intelligence.ts`, which is the only throwing surface on this
side for provider configuration (the seven `handleCode*` wrappers never throw
themselves). The other `code_*` throws are (self) resolution
(`E-SELF-NO-WORKFOLDER`, `E-SELF-NOT-A-REPO`), a missing or still-building index
(`E-CODE-INDEX-NOT-READY`) and provider `none` (`E-CODE-INTEL-DISABLED`, thrown by
every `NullProvider` method); see `taxonomy.json`.

| Provisional name | Where | Trigger |
|------------------|-------|---------|
| `E-CODE-PROVIDER-UNCONFIGURED` | `getProvider`, `src/tools/code-intelligence.ts:131-135` (per-member `codeIntelProvider` override names a key absent from `PROVIDERS`) and `:151-155` (global `config.json`'s `provider` field, read from `CONFIG_PATH`, names a key absent from `PROVIDERS`; the `codebase-memory` default itself IS registered, so this site only fires when the config file names something else unregistered) | the resolved provider key has no entry in the `PROVIDERS` map (`codebase-memory`, `gitnexus`, `none`). Both sites throw the same message shape naming the bad key and pointing at `apra-fleet install` |

## 6. Downstream notes

- The tool count to propagate is **24** (17 `kb_*`, 7 `code_*`), since
  `kb_bible_commit` was added. (The original plan's 24 was unverified for its
  tree, which had 23.)
- A generated binding typed against `MemoryProvider` alone is INCOMPLETE: the six
  methods plus one property in section 4.2 are tool-reachable but undeclared.
- Response-schema generation must handle three irregularities: `kb_query`'s
  two-shape union with an absent-vs-null `related_claims`, `kb_stats`'s
  spread-plus-optionals, and the seven permissive `code_*` bodies.
- `HttpKbProvider` (section 4.4, F-10) is dead code in this tree: never
  constructed, four of its twelve interface methods have no remote path, and
  its `query` silently drops SEVEN of QueryOptions' 13 optional fields on the
  client side -- `ids`, `symbols`, `source_files`, `tags`, `tag`,
  `flagged_only` (dropped by omission; `ids` is the load-bearing one, since it
  is how `kb_query`'s L2 hydration and cross-scope fill work) plus `fts_terms`
  (dropped deliberately -- internal-only, excluded from the transport surface
  by design, reachable only in-process via `kb_session_prime`; see section
  4.4.1, P-3 for the full mechanism). The server side narrows further: the
  only in-tree `/api/kb/query` handler drops `include_stale` and
  `include_superseded` too, so only four filters (`query`, `type`, `limit`,
  `l1_only`) survive a live remote round trip. Do not model
  `HttpKbProvider` as a behaviorally-equivalent second implementation.

## Appendix A -- registration descriptions (verbatim)

Each block is the description string passed to the tool registration call in
`src/services/tool-registry.ts`, captured from the runtime registration dump so it
is byte-exact. No entry is blank.

### kb_capture

```text
Capture a learning, fact, or file summary into the knowledge bank. Confidence is capped at INFERRED: any CONFIRMED passed here is downgraded to INFERRED, and a user-directive is stored UNVERIFIED as a pending proposal until a human approves it; confidence_clamped:true whenever the stored confidence differs from the requested one (default INFERRED). CONFIRMED is minted ONLY via kb_promote. Returns {id, audn_decision, confidence_clamped}. audn_decision: add=new entry, none=duplicate skipped, update=same-topic predecessor linked (refines; both entries stay live), flagged=contradiction flagged for review. Pass supersedes:<id> to retire that entry instead (only takes effect if AUDN independently matched it). Scope: always the calling session's own KB -- a member session uses its registered work folder, any other session the fleet server's working folder; there is no repo/path scope argument (the removed repo_path, repo and repo_remote_url keys fail with E-SCOPE-KEY-REMOVED). Fails with E-SELF-NO-WORKFOLDER, E-SELF-NOT-A-REPO or E-SELF-NO-REMOTE (each with a one-line remediation) when that folder cannot carry a KB identity (it must be a git repository with an origin remote).
```

### kb_invalidate

```text
Mark context-cache entries stale for the given file paths. Call after modifying files to ensure the KB reflects the current state. Scope: always the calling session's own KB -- a member session uses its registered work folder, any other session the fleet server's working folder; there is no repo/path scope argument (the removed repo_path, repo and repo_remote_url keys fail with E-SCOPE-KEY-REMOVED). Fails with E-SELF-NO-WORKFOLDER, E-SELF-NOT-A-REPO or E-SELF-NO-REMOTE (each with a one-line remediation) when that folder cannot carry a KB identity (it must be a git repository with an origin remote).
```

### kb_context

```text
Check freshness of files against the knowledge bank. Returns {fresh, stale, missing} -- fresh files can be skipped, stale/missing files must be re-read. With no confidence filter the default is confidence ["CONFIRMED","INFERRED"] plus exclude_disputed (a context-cache entry is verified by its content hash); UNVERIFIED only when listed explicitly. In a MEMBER session the default read merges the member's checkout bible (CONFIRMED) with the member's own CONFIRMED/INFERRED captures (tagged member:<caller uuid>). Scope: always the calling session's own KB -- a member session uses its registered work folder, any other session the fleet server's working folder; there is no repo/path scope argument (the removed repo_path, repo and repo_remote_url keys fail with E-SCOPE-KEY-REMOVED). Fails with E-SELF-NO-WORKFOLDER, E-SELF-NOT-A-REPO or E-SELF-NO-REMOTE (each with a one-line remediation) when that folder cannot carry a KB identity (it must be a git repository with an origin remote).
```

### kb_session_prime

```text
Prime a session with KB context. Returns session_warm status, stale files needing re-read, top KB entries, and recommended GitNexus calls. Scope: always the calling session's own KB -- a member session uses its registered work folder, any other session the fleet server's working folder; there is no repo/path scope argument (the removed repo_path, repo and repo_remote_url keys fail with E-SCOPE-KEY-REMOVED). Fails with E-SELF-NO-WORKFOLDER, E-SELF-NOT-A-REPO or E-SELF-NO-REMOTE (each with a one-line remediation) when that folder cannot carry a KB identity (it must be a git repository with an origin remote).
```

### kb_query

```text
Two-level knowledge bank search. L1: FTS5 on title+summary (up to 20 results). L2: full content for top 5 hits (max 800 tokens each). Excludes stale/superseded by default. Optional tag filter (exact match) ANDs alongside other filters without touching FTS/OR-join logic, and may be used alone (no query) to list all entries carrying the tag. Pass flagged_only: true to list all contradiction-flagged entry pairs for resolution. Pass expand_related: true to also receive related_claims -- entries joined to the top hits by a refines or contradiction_of edge. Those record the KB own judgements about its contents (there is a newer framing of this; something disputes this) and cannot be reached by a text match. shares_file/shares_symbol edges are deliberately not traversed, since FTS over those same fields already surfaces them. Default false, in which case related_claims is absent and the result shape is unchanged. With no confidence filter the default is confidence ["CONFIRMED"] plus exclude_disputed: true, so only CONFIRMED entries outside any unresolved contradiction are returned (related_claims included). Pass an explicit confidence list (e.g. ["CONFIRMED","INFERRED","UNVERIFIED"]) to opt into other tiers; exclude_disputed then defaults off unless set true. flagged_only is exempt. Scope: always the calling session's own KB -- a member session uses its registered work folder, any other session the fleet server's working folder; there is no repo/path scope argument (the removed repo_path, repo and repo_remote_url keys fail with E-SCOPE-KEY-REMOVED). Fails with E-SELF-NO-WORKFOLDER, E-SELF-NOT-A-REPO or E-SELF-NO-REMOTE (each with a one-line remediation) when that folder cannot carry a KB identity (it must be a git repository with an origin remote).
```

### kb_list

```text
List KB entries by confidence/type/module/symbol/tag -- audit the KB. With no confidence filter, returns only CONFIRMED, undisputed entries; pass an explicit confidence list (e.g. ["INFERRED","UNVERIFIED"]; a single tier string such as "INFERRED" is accepted as a one-element list) to see other tiers without touching FTS ranking or use_count telemetry. Excludes superseded/stale entries. Returns {results, total} with each entry as {id, type, confidence, title, summary, symbols, source_files}. Scope: always the calling session's own KB -- a member session uses its registered work folder, any other session the fleet server's working folder; there is no repo/path scope argument (the removed repo_path, repo and repo_remote_url keys fail with E-SCOPE-KEY-REMOVED). Fails with E-SELF-NO-WORKFOLDER, E-SELF-NOT-A-REPO or E-SELF-NO-REMOTE (each with a one-line remediation) when that folder cannot carry a KB identity (it must be a git repository with an origin remote).
```

### kb_harvest

```text
Scan a session transcript for learnings and capture them into the KB. Returns {entries_captured, entries_updated, entries_skipped}. Extracted entries are UNVERIFIED and author=harvest, source=harvest. Scope: always the calling session's own KB -- a member session uses its registered work folder, any other session the fleet server's working folder; there is no repo/path scope argument (the removed repo_path, repo and repo_remote_url keys fail with E-SCOPE-KEY-REMOVED). Fails with E-SELF-NO-WORKFOLDER, E-SELF-NOT-A-REPO or E-SELF-NO-REMOTE (each with a one-line remediation) when that folder cannot carry a KB identity (it must be a git repository with an origin remote).
```

### kb_promote

```text
Upgrade KB entry confidence: UNVERIFIED -> INFERRED -> CONFIRMED. Appends promotion note to content as evidence trail. CONFIRMED entries are no-op. Scope: always the calling session's own KB -- a member session uses its registered work folder, any other session the fleet server's working folder; there is no repo/path scope argument (the removed repo_path, repo and repo_remote_url keys fail with E-SCOPE-KEY-REMOVED). Fails with E-SELF-NO-WORKFOLDER, E-SELF-NOT-A-REPO or E-SELF-NO-REMOTE (each with a one-line remediation) when that folder cannot carry a KB identity (it must be a git repository with an origin remote).
```

### kb_freshness_sweep

```text
Bounded full-KB bidirectional freshness sweep: re-hash every entry that has a stored per-file basis against the CURRENT worktree, mark mismatches stale, and revive stale entries whose full basis matches again (superseded, feedback-downvoted, and invalidated entries stay retired). This is the branch-switch revival surface kb_session_prime cannot be (prime excludes stale entries). Returns {checked, staled, unstaled}. Scope: always the calling session's own KB -- a member session uses its registered work folder, any other session the fleet server's working folder; there is no repo/path scope argument (the removed repo_path, repo and repo_remote_url keys fail with E-SCOPE-KEY-REMOVED). Fails with E-SELF-NO-WORKFOLDER, E-SELF-NOT-A-REPO or E-SELF-NO-REMOTE (each with a one-line remediation) when that folder cannot carry a KB identity (it must be a git repository with an origin remote).
```

### kb_import

```text
Import a merged bible (.fleet/kb-canonical.json) into the warm local KB -- the post-merge write path (the prime-time cold-seed is output-only). Reads the repo-resolved bible, or an explicit --path file. Each entry routes through the AUDN choke point (duplicate -> skipped, refinement -> linked, contradiction -> flagged); non-directive entries KEEP their bible confidence (the bible is a git-reviewed, human-merged artifact), stamped source="import"; type="user-directive" entries are FORCED to pending proposals (never active -- a bible cannot smuggle an active directive). Idempotent (re-import of the same bible adds nothing). Runs a freshness sweep after import so entries whose basis does not match this worktree are staled. Accepts every bible shape: a legacy bare JSON array and the v2/v3 {version, provenance:{commit, branch, entry_count}, entries} envelope. A v3 entry's source_file_hashes (repo-relative path -> hash, covering every cited file) is stored as its basis exactly -- local files are never re-hashed for it; an entry without a valid carried map (any v1/v2 entry) imports with no basis, so kb_export and kb_bible_commit do not re-publish it until it is re-verified. Entries with no source_files, or citing files absent from this worktree, are REJECTED (an entry with no checkable basis can never be staled, so nothing could falsify it) -- re-importing a legacy bible deliberately drops those. Returns {imported, skipped, linked, flagged, rejected, sweep:{checked, staled, unstaled}}. Pass skip_sweep: true to skip the post-import freshness sweep -- the sweep re-judges EVERY entry against the given worktree, which is right for a deliberate audit but wrong for a routine warm-the-KB import (it mass-stales entries merely because unrelated files moved on, which in turn empties the promotion candidates kb_list returns). `path` names only the bible file to read, never which KB is written. TRUST BOUNDARY: importing the repo-resolved bible is the git-reviewed trusted channel; an explicit --path bible is caller-asserted trust, equivalent in power to kb_promote. Directives are quarantined either way; activation stays CLI-only. Scope: always the calling session's own KB -- a member session uses its registered work folder, any other session the fleet server's working folder; there is no repo/path scope argument (the removed repo_path, repo and repo_remote_url keys fail with E-SCOPE-KEY-REMOVED). Fails with E-SELF-NO-WORKFOLDER, E-SELF-NOT-A-REPO or E-SELF-NO-REMOTE (each with a one-line remediation) when that folder cannot carry a KB identity (it must be a git repository with an origin remote).
```

### kb_resolve_contradiction

```text
Resolve a KB contradiction pair: {winnerId, loserId, evidence}. The SINGLE write path for reconcile resolutions (used by kb_reconcile_prefilter and the reconciler agent alike). Winner ends confidence=CONFIRMED with the evidence note appended and both flag fields cleared (flagged_for_review + contradiction_of); stale is cleared ONLY if the D2 un-stale predicate holds on the post-flag-clear row (so a downvoted or invalidated winner still stays retired -- it wins the contradiction, not its reputation). Loser ends superseded_at=now + stale=1 + flag cleared, never deleted. REFUSES (throws, writes nothing) when either id is missing, either entry is already superseded, the ids do not form a genuinely linked contradiction pair, or the pair involves an ACTIVE user-directive. Scope: always the calling session's own KB -- a member session uses its registered work folder, any other session the fleet server's working folder; there is no repo/path scope argument (the removed repo_path, repo and repo_remote_url keys fail with E-SCOPE-KEY-REMOVED). Fails with E-SELF-NO-WORKFOLDER, E-SELF-NOT-A-REPO or E-SELF-NO-REMOTE (each with a one-line remediation) when that folder cannot carry a KB identity (it must be a git repository with an origin remote).
```

### kb_reconcile_prefilter

```text
Mechanical hash-basis prefilter over all flagged contradiction pairs (including stale members -- see flaggedPairs liveness contract). Re-hashes both sides of each pair against the CURRENT worktree: exactly one side fully matching wins mechanically via kb_resolve_contradiction (evidence "hash-basis match on merged worktree"); both match, both mismatch, or an empty/missing basis on either side leaves the pair for the reconciler agent. Pairs involving an ACTIVE user-directive are never touched. Returns {pairs, resolved, left_for_agent, skipped_directive}. Run after kb_import + kb_freshness_sweep, before dispatching the reconciler agent. Scope: always the calling session's own KB -- a member session uses its registered work folder, any other session the fleet server's working folder; there is no repo/path scope argument (the removed repo_path, repo and repo_remote_url keys fail with E-SCOPE-KEY-REMOVED). Fails with E-SELF-NO-WORKFOLDER, E-SELF-NOT-A-REPO or E-SELF-NO-REMOTE (each with a one-line remediation) when that folder cannot carry a KB identity (it must be a git repository with an origin remote).
```

### kb_setup

```text
Set up KB: install git post-commit hook, write provider config, store remote credentials encrypted. Run once per repo. Scope: always the calling session's own KB -- a member session uses its registered work folder, any other session the fleet server's working folder; there is no repo/path scope argument (the removed repo_path, repo and repo_remote_url keys fail with E-SCOPE-KEY-REMOVED). Fails with E-SELF-NO-WORKFOLDER, E-SELF-NOT-A-REPO or E-SELF-NO-REMOTE (each with a one-line remediation) when that folder cannot carry a KB identity (it must be a git repository with an origin remote).
```

### kb_export

```text
Export CONFIRMED, non-superseded, non-stale KB entries to a canonical bible file (stable field set, deterministic id order, ASCII-safe). scope="project" (default): reads the project KB and ADDITIVELY merges into <repo>/.fleet/kb-canonical.json. Only entries whose cited source_files each have a recorded per-file hash that matches the file currently in the repo qualify (an empty or missing basis, or a missing cited file, excludes the entry). Entries already in the bible are never removed or rewritten (the existing bible entry wins on an id clash); only qualifying new ids are added, and when none qualify the file is left untouched and nothing is committed. exported is the entry count of the resulting bible. scope="global" is unchanged: it exports the full GLOBAL set with no basis filter. scope="global": reads the GLOBAL KB, writes <repo>/.fleet/kb-canonical-global.json (in practice the apra-fleet platform repo, committed there so the installer can distribute it to every project on the machine -- D8/F9). Run after kb_promote so the canonical set stays current. F6a: the tool itself auto-commits the bible file (pathspec-only, identity pm-kb) when the repo is a git repo and the content changed -- this is code, not agent discretion, so no manual git step is needed, and this applies to the global file too. Non-fatal on any git failure; push is not automatic. Writes the v3 format: {version:3, provenance:{commit, branch, entry_count}, entries:[...]}; each project entry it adds carries source_file_hashes, its stored per-file hash basis (repo-relative path -> hash; never re-hashed at write time). Refuses (throws, file untouched) to write a bible holding a duplicate id. provenance.branch is the target base branch (the branch the entries merge into) and provenance.commit the base commit the entries were verified against (a commit, not a timestamp, so re-exports stay diff-free when nothing changed): pass baseBranch and baseCommit to state them explicitly; when omitted they default to the export folder HEAD branch and commit. An export whose entry set is unchanged rewrites nothing. Auto-commit defaults to ON (USER DIRECTIVE 2026-08-11 -- an export left uncommitted is knowledge nobody else ever sees): set FLEET_DIR/knowledge/config.json { bible: { autoCommit: false } } to opt out. A malformed config disables it. Scope: always the calling session's own KB -- a member session uses its registered work folder, any other session the fleet server's working folder; there is no repo/path scope argument (the removed repo_path, repo and repo_remote_url keys fail with E-SCOPE-KEY-REMOVED). Fails with E-SELF-NO-WORKFOLDER, E-SELF-NOT-A-REPO or E-SELF-NO-REMOTE (each with a one-line remediation) when that folder cannot carry a KB identity (it must be a git repository with an origin remote).
```

### kb_stats

```text
Read-only KB health aggregation: totals by confidence/type, stale/flagged/superseded counts, retrieval hit_rate, promote_ratio, canonical-bible presence/drift, and optional per-symbol coverage. Never bumps use_count/last_accessed (kb_list pattern). Bible drift is visibility for the machine that owns the KB -- CI cannot see the local kb.sqlite, so there is no CI gate on it. Scope: always the calling session's own KB -- a member session uses its registered work folder, any other session the fleet server's working folder; there is no repo/path scope argument (the removed repo_path, repo and repo_remote_url keys fail with E-SCOPE-KEY-REMOVED). Fails with E-SELF-NO-WORKFOLDER, E-SELF-NOT-A-REPO or E-SELF-NO-REMOTE (each with a one-line remediation) when that folder cannot carry a KB identity (it must be a git repository with an origin remote).
```

### kb_feedback

```text
Downvote a KB entry that proved wrong in practice: { id, reason, role? }. Marks the entry stale=1 + flagged_for_review=1 and appends an ASCII feedback note "[feedback <ISO>] <validated-role>: <reason>" (CONTENT_CAP respected). NEVER deletes and NEVER touches confidence -- a downvoted CONFIRMED entry stays CONFIRMED-but-stale-flagged; the human resolves it in kb-review, this tool only flags it for that review. Exception: an ACTIVE user-directive is flagged for review but NOT staled (directives outrank agent experience -- the human decides); a pending directive proposal stales normally. Scope: always the calling session's own KB -- a member session uses its registered work folder, any other session the fleet server's working folder; there is no repo/path scope argument (the removed repo_path, repo and repo_remote_url keys fail with E-SCOPE-KEY-REMOVED). Fails with E-SELF-NO-WORKFOLDER, E-SELF-NOT-A-REPO or E-SELF-NO-REMOTE (each with a one-line remediation) when that folder cannot carry a KB identity (it must be a git repository with an origin remote).
```

### kb_bible_commit

```text
Commit one round of confirmed entries to the bible: { ids, baseBranch, baseCommit }. Merges exactly the given ids from this repository's KB into <repo>/.fleet/kb-canonical.json at ENTRY level -- every entry already in the file is kept, only the given ids are added or replaced, and an entry in the file but not in the KB is never dropped -- in kb_export's stable serialization (v3 envelope, id order, ASCII-safe; each merged entry carries its stored source_file_hashes basis). provenance.branch is baseBranch (the sprint's target base branch) and provenance.commit is baseCommit (the base commit the entries were verified against), never the working folder HEAD. Then makes a local commit scoped to that one path (identity pm-kb). It NEVER pushes. Re-running with the same ids after resetting to a newer HEAD re-merges at entry level, so a rejected push can be retried with no manual merge. Ids that are unknown, stale, superseded, or not CONFIRMED are SKIPPED (never an error) and reported in skipped with reason not_confirmed_or_unknown. A CONFIRMED id is admitted only if it passes the same basis rule kb_export (scope=project) applies: every cited source file has a recorded per-file hash that matches the file currently in the repo (an empty or missing basis, a cited file with no basis key, a missing or changed file, or a path that is not repo-relative excludes it); such an id is SKIPPED with reason basis_mismatch, logged, and any entry already in the bible for it is left unchanged. No ids, no mergeable ids, or an unchanged entry set: no write and no commit. Refuses (throws, file untouched) when the existing bible file is unreadable or holds a duplicate id, or when the local commit fails. Returns {path, merged, skipped, entry_count, committed}. Scope: always the calling session's own KB -- a member session uses its registered work folder, any other session the fleet server's working folder; there is no repo/path scope argument (the removed repo_path, repo and repo_remote_url keys fail with E-SCOPE-KEY-REMOVED). Fails with E-SELF-NO-WORKFOLDER, E-SELF-NOT-A-REPO or E-SELF-NO-REMOTE (each with a one-line remediation) when that folder cannot carry a KB identity (it must be a git repository with an origin remote).
```

### code_graph

```text
Trace the call graph for a symbol. Returns callers and callees across the codebase. Prefer this over Glob/Grep/file reads for structural questions (symbol lookup, call chains, impact) -- the answer is pre-indexed. Scope: always the calling session's own repo -- a member session uses its registered work folder, any other session the fleet server's working folder; there is no repo/path scope argument. Fails with E-SELF-NO-WORKFOLDER or E-SELF-NOT-A-REPO when that folder is missing or is not a git repository, E-CODE-INDEX-NOT-READY when it has no usable code index yet (a missing or interrupted index gets a build requested automatically -- retry shortly) or the index is still building, and E-CODE-INTEL-DISABLED when code intelligence is off (each with a one-line remediation).
```

### code_impact

```text
Find what is affected by changes to a symbol. Prefer this over Glob/Grep/file reads for structural questions (symbol lookup, call chains, impact) -- the answer is pre-indexed. Scope: always the calling session's own repo -- a member session uses its registered work folder, any other session the fleet server's working folder; there is no repo/path scope argument. Fails with E-SELF-NO-WORKFOLDER or E-SELF-NOT-A-REPO when that folder is missing or is not a git repository, E-CODE-INDEX-NOT-READY when it has no usable code index yet (a missing or interrupted index gets a build requested automatically -- retry shortly) or the index is still building, and E-CODE-INTEL-DISABLED when code intelligence is off (each with a one-line remediation).
```

### code_query

```text
Search the codebase for symbols, patterns, or concepts using natural language or code patterns. Prefer this over Glob/Grep/file reads for structural questions (symbol lookup, call chains, impact) -- the answer is pre-indexed. Scope: always the calling session's own repo -- a member session uses its registered work folder, any other session the fleet server's working folder; there is no repo/path scope argument. Fails with E-SELF-NO-WORKFOLDER or E-SELF-NOT-A-REPO when that folder is missing or is not a git repository, E-CODE-INDEX-NOT-READY when it has no usable code index yet (a missing or interrupted index gets a build requested automatically -- retry shortly) or the index is still building, and E-CODE-INTEL-DISABLED when code intelligence is off (each with a one-line remediation).
```

### code_context

```text
Get callers, callees, and execution flows for a symbol. Prefer this over Glob/Grep/file reads for structural questions (symbol lookup, call chains, impact) -- the answer is pre-indexed. Scope: always the calling session's own repo -- a member session uses its registered work folder, any other session the fleet server's working folder; there is no repo/path scope argument. Fails with E-SELF-NO-WORKFOLDER or E-SELF-NOT-A-REPO when that folder is missing or is not a git repository, E-CODE-INDEX-NOT-READY when it has no usable code index yet (a missing or interrupted index gets a build requested automatically -- retry shortly) or the index is still building, and E-CODE-INTEL-DISABLED when code intelligence is off (each with a one-line remediation).
```

### code_map

```text
Get the architectural map of a repository: module communities with their key symbols and files, ranked by size. Prefer this over directory listings or file reads when orienting in an unfamiliar codebase -- the answer is pre-indexed. Scope: always the calling session's own repo -- a member session uses its registered work folder, any other session the fleet server's working folder; there is no repo/path scope argument. Fails with E-SELF-NO-WORKFOLDER or E-SELF-NOT-A-REPO when that folder is missing or is not a git repository, E-CODE-INDEX-NOT-READY when it has no usable code index yet (a missing or interrupted index gets a build requested automatically -- retry shortly) or the index is still building, and E-CODE-INTEL-DISABLED when code intelligence is off (each with a one-line remediation).
```

### code_flow

```text
Find process flows (entry -> steps -> exit) matching a name or endpoints. Prefer this over manually tracing call chains across files -- the flows are pre-indexed. Scope: always the calling session's own repo -- a member session uses its registered work folder, any other session the fleet server's working folder; there is no repo/path scope argument. Fails with E-SELF-NO-WORKFOLDER or E-SELF-NOT-A-REPO when that folder is missing or is not a git repository, E-CODE-INDEX-NOT-READY when it has no usable code index yet (a missing or interrupted index gets a build requested automatically -- retry shortly) or the index is still building, and E-CODE-INTEL-DISABLED when code intelligence is off (each with a one-line remediation).
```

### code_tests

```text
Find the test files and test functions that exercise a symbol (transitive callers, depth 2). Use this to run targeted tests for the code you changed instead of the full suite. Prefer this over Grep for test discovery -- the call graph is pre-indexed. Scope: always the calling session's own repo -- a member session uses its registered work folder, any other session the fleet server's working folder; there is no repo/path scope argument. Fails with E-SELF-NO-WORKFOLDER or E-SELF-NOT-A-REPO when that folder is missing or is not a git repository, E-CODE-INDEX-NOT-READY when it has no usable code index yet (a missing or interrupted index gets a build requested automatically -- retry shortly) or the index is still building, and E-CODE-INTEL-DISABLED when code intelligence is off (each with a one-line remediation).
```

### code_reindex

```text
Rebuild the code index of the calling session's own repo (runs gitnexus analyze detached; its output is captured to <data>/code-index/<slug>/analyze.log). Returns after the first tick -- outcome "started" (lock held, process alive, output seen), "up-to-date", "starting" (running, no tick yet), "already-running", or "not-started" with a typed reason (npx-not-found, gitnexus-not-found, analyze-failed, spawn-failed, remote-member, provider-not-supported). Only the gitnexus provider is supported: provider none fails with E-CODE-INTEL-DISABLED, any other provider (e.g. codebase-memory, which manages its own index) gets not-started with reason provider-not-supported naming the provider. Poll code_status for completion. Scope: always the calling session's own repo -- a member session uses its registered work folder, any other session the fleet server's working folder; there is no repo/path scope argument. Fails with E-SELF-NO-WORKFOLDER or E-SELF-NOT-A-REPO when that folder is missing or is not a git repository, E-CODE-INDEX-NOT-READY when it has no usable code index yet (a missing or interrupted index gets a build requested automatically -- retry shortly) or the index is still building, and E-CODE-INTEL-DISABLED when code intelligence is off (each with a one-line remediation).
```

### code_status

```text
Report the code index state of the calling session's own repo: the last analyze run (phase, result indexed|up-to-date|incomplete|failed, last log line, log path), live readiness (ready|building|interrupted|missing; interrupted = marked incomplete with no analyze running), the indexed commit, and autoReindexPaused (a failed automatic run that paused automatic rebuilds until code_reindex). Only the gitnexus provider is supported: provider none fails with E-CODE-INTEL-DISABLED, any other provider gets {outcome: "not-started", reason: "provider-not-supported", provider, indexedCommit: null} instead of gitnexus readiness. Scope: always the calling session's own repo -- a member session uses its registered work folder, any other session the fleet server's working folder; there is no repo/path scope argument. Fails with E-SELF-NO-WORKFOLDER or E-SELF-NOT-A-REPO when that folder is missing or is not a git repository, E-CODE-INDEX-NOT-READY when it has no usable code index yet (a missing or interrupted index gets a build requested automatically -- retry shortly) or the index is still building, and E-CODE-INTEL-DISABLED when code intelligence is off (each with a one-line remediation).
```

