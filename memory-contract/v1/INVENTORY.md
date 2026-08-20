# memory-contract/v1 -- Contract Surface Inventory

Status: authoritative inventory of the memory/code-intelligence contract surface
as it exists in this repository. This document is the ARBITER OF THE TOOL COUNT
for the v1 contract work: downstream schema generation, binding generation and
round-trip fixtures cite the number stated here rather than re-deriving it.

Tree inventoried: branch `u1_contract_v1_skeleton`, HEAD `3a19a9d9`.

## 1. Verified tool count

**23 tools: 16 `kb_*` + 7 `code_*`.**

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
   records every registration. Result: 57 tools registered in total, of which 16
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

### 2.1 kb_* tools (16)

| # | Tool | Request schema | Request fields | Response (observed) |
|---|------|----------------|----------------|---------------------|
| 1 | `kb_capture` | `kbCaptureSchema` (`src/tools/kb-capture.ts`) | repo_remote_url, repo_path, type, title, summary, content, source_files, symbols, module, tags, source_file, role, confidence, scope, supersedes | `text(JSON): {id, audn_decision, confidence_clamped}` |
| 2 | `kb_invalidate` | `kbInvalidateSchema` (`src/tools/kb-invalidate.ts`) | repo_remote_url, repo_path, files | `text(JSON): {invalidated, files}` |
| 3 | `kb_context` | `kbContextSchema` (`src/tools/kb-context.ts`) | repo_remote_url, repo_path, files | `text(JSON): {fresh, stale, missing}` |
| 4 | `kb_session_prime` | `kbSessionPrimeSchema` (`src/tools/kb-session-prime.ts`) | repo_remote_url, session_files, hint_symbols, hint_modules, repo_path | `text(JSON): PrimedContext {session_warm, stale_files, top_entries, fresh_summaries, recommended_code_calls, token_estimate}` |
| 5 | `kb_query` | `kbQuerySchema` (`src/tools/kb-query.ts`) | repo_remote_url, repo_path, query, type, tag, limit, include_stale, flagged_only, expand_related | TWO shapes -- default: `text(JSON): {l1_results, l2_expanded, related_claims?}`; with `flagged_only` true: `text(JSON): {flagged_entries, total, note}` |
| 6 | `kb_list` | `kbListSchema` (`src/tools/kb-list.ts`) | repo_remote_url, repo_path, confidence, type, module, symbol, tag, limit | `text(JSON): {results, total}` |
| 7 | `kb_harvest` | `kbHarvestSchema` (`src/tools/kb-harvest.ts`) | repo_remote_url, repo_path, session_transcript, session_id | `text(JSON): {entries_captured, entries_updated, entries_skipped, entries_rejected}` |
| 8 | `kb_promote` | `kbPromoteSchema` (`src/tools/kb-promote.ts`) | repo_remote_url, repo_path, id, reason | `text(JSON): {id, previous_confidence, new_confidence}` |
| 9 | `kb_freshness_sweep` | `kbFreshnessSweepSchema` (`src/tools/kb-freshness-sweep.ts`) | repo_remote_url, repo_path | `text(JSON): {checked, staled, unstaled}` |
| 10 | `kb_import` | `kbImportSchema` (`src/tools/kb-import.ts`) | repo_remote_url, path, repo, repo_path, scope, skip_sweep | `text(JSON): KbImportReport {imported, skipped, linked, flagged, rejected, sweep:{checked, staled, unstaled}}` |
| 11 | `kb_resolve_contradiction` | `kbResolveContradictionSchema` (`src/tools/kb-resolve-contradiction.ts`) | repo_remote_url, repo_path, winnerId, loserId, evidence | `text(JSON): {winnerId, loserId}` |
| 12 | `kb_reconcile_prefilter` | `kbReconcilePrefilterSchema` (`src/tools/kb-reconcile-prefilter.ts`) | repo_remote_url, repo_path | `text(JSON): {pairs, resolved[], left_for_agent[], skipped_directive}` |
| 13 | `kb_setup` | `kbSetupSchema` (`src/tools/kb-setup.ts`) | repo_path, provider, remote, token | `text(JSON): {success, steps}` |
| 14 | `kb_export` | `kbExportSchema` (`src/tools/kb-export.ts`) | repo_remote_url, repo_path, scope | `text(JSON): {exported, path, scope, committed}` |
| 15 | `kb_stats` | `kbStatsSchema` (`src/tools/kb-stats.ts`) | repo_remote_url, repo, repo_path, symbols | `text(JSON): ProviderStats spread plus bible` -- `{supported?, reason?, totals, stale, flagged, superseded, retrieval, promote_ratio, coverage?, bible}` |
| 16 | `kb_feedback` | `kbFeedbackSchema` (`src/tools/kb-feedback.ts`) | repo_remote_url, repo_path, id, reason, role | `text(JSON): {id, stale, flagged_for_review, confidence}` |

Scope-field note: 15 of the 16 `kb_*` request schemas spread the shared
`kbScopeFields` (`src/services/knowledge/kb-scope-input.ts`), which is where
`repo_path` and `repo_remote_url` come from. `kb_setup` is the sole exclusion and
it is by design: its `repo_path` only locates a `.git` directory for hook
installation, and it writes a single global config rather than resolving a project
KB. A generated binding must therefore not assume `kb_setup` carries scope
semantics merely because it has a `repo_path` field.

`kb_import` additionally accepts `repo` as an alias for `repo_path` (`repo` wins),
and `kb_stats` accepts both names as well -- an alias pair a generated schema must
preserve, because zod strips an unknown key silently rather than erroring.

### 2.2 code_* tools (7)

| # | Tool | Request schema | Request fields | Response (observed) |
|---|------|----------------|----------------|---------------------|
| 17 | `code_graph` | `codeGraphSchema` (`src/tools/code-intelligence.ts`) | symbol, repo | `text(JSON): opaque` (provider payload) |
| 18 | `code_impact` | `codeImpactSchema` (`src/tools/code-intelligence.ts`) | target, direction, file_path, repo | `text(JSON): opaque` (provider payload) |
| 19 | `code_query` | `codeQuerySchema` (`src/tools/code-intelligence.ts`) | query, repo | `text(JSON): opaque` (provider payload) |
| 20 | `code_context` | `codeContextSchema` (`src/tools/code-intelligence.ts`) | name, repo, repo_remote_url | `text(JSON): opaque` (provider payload, KB-enriched by `enrichContextWithKb`) |
| 21 | `code_map` | `codeMapSchema` (`src/tools/code-intelligence.ts`) | repo, top | `text(JSON): opaque` (provider payload) |
| 22 | `code_flow` | `codeFlowSchema` (`src/tools/code-intelligence.ts`) | from, to, name, repo | `text(JSON): opaque` (provider payload) |
| 23 | `code_tests` | `codeTestsSchema` (`src/tools/code-intelligence.ts`) | symbol, repo | `text(JSON): opaque` (provider payload) |

`code_context` is the only `code_*` tool that takes `repo_remote_url`, because it
is the only one that touches the KB.

Registration descriptions for all 23 tools are reproduced verbatim in Appendix A.

## 3. Decision rule: responses that are not schema-shaped

Observed facts about the response side of this surface:

- Every one of the 23 tools is registered through the shared `wrapTool` helper in
  `src/services/tool-registry.ts`, which converts the handler return value into
  MCP `content: [{type: 'text', text}]` blocks.
- NO tool in this surface declares a response zod schema. The registration call
  is given a name, a description and a REQUEST shape only.
- NO tool in this surface returns `structuredContent`. `wrapTool` forwards
  `structuredContent` only when the handler returns `{text, structuredContent}`;
  all 23 handlers return a bare `string`, so the channel is unused here. (In the
  wider 57-tool server, `execute_command` is the tool that uses it.)
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
  observable in this repo (all 16 `kb_*` tools). The generated response schema is
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

### 4.2 Provider members reached by tools but NOT declared on MemoryProvider (6 methods + 1 property)

These are `SqliteProvider` members (`src/services/knowledge/sqlite-provider.ts`)
that registered tools call directly. They are part of the real contract surface
even though the interface does not declare them -- a generated binding typed only
against `MemoryProvider` would not cover them.

| # | Member | Signature | Tools routing through it | Effect | Idempotent |
|---|--------|-----------|--------------------------|--------|------------|
| X-1 | `list` | `list(opts: {confidence?, type?, module?, symbol?, tag?, limit?}): Promise<KBEntry[]>` | `kb_list`, `kb_stats` (bible drift comparison) | read, no telemetry bump | yes |
| X-2 | `feedback` | `feedback(id, reason, author): Promise<KBEntry>` | `kb_feedback` | mutate-trust (sets `stale` plus `flagged_for_review`, appends note; never deletes, never touches confidence) | no (each call appends another note) |
| X-3 | `freshnessSweep` | `freshnessSweep(root?): Promise<{checked, staled, unstaled}>` | `kb_freshness_sweep`, `kb_import` (post-import unless `skip_sweep`) | mutate-trust (bidirectional stale/unstale) | yes for a fixed worktree |
| X-4 | `resolveContradiction` | `resolveContradiction(winnerId, loserId, evidence): Promise<{winnerId, loserId}>` | `kb_resolve_contradiction`, and internally from `reconcilePrefilter` | mutate-trust (winner to CONFIRMED with flags cleared; loser superseded plus stale) | NO -- a second call REFUSES, because the loser is now superseded |
| X-5 | `reconcilePrefilter` | `reconcilePrefilter(): Promise<{pairs, resolved[], left_for_agent[], skipped_directive}>` | `kb_reconcile_prefilter` | mutate-trust (writes only via `resolveContradiction`) | yes in effect (resolved pairs are no longer flagged) |
| X-6 | `hasEntry` | `hasEntry(id: string): boolean` -- SYNCHRONOUS, the only non-Promise member on this list | `kb_import` | read | yes |
| X-7 | `repoPath` | property, not a method | read by `kb_freshness_sweep` to anchor the sweep root | read | n/a |

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

`NullProvider` returns an MCP-content-shaped object -- a `content` array holding a
single text block reading "Code intelligence is disabled for this member (method:
X)." -- which the registry then JSON-stringifies into a text block. A disabled
member therefore yields a nested content object inside the text, not an error.
That is a shape a v1 response schema must tolerate; it is covered by the
permissive `code_*` body from section 3.

## 5. Error and refusal paths

Provisional names are assigned here so downstream schema and binding work has a
stable vocabulary. Grouping is by mechanism, because several of these paths do not
throw at all and a throw-site scan cannot find them.

### 5.1 Non-throwing paths (silent transformation or decision-coded outcome)

| Provisional name | Where | Mechanism | Observable signal |
|------------------|-------|-----------|-------------------|
| `E-CLAMP` | `src/tools/kb-capture.ts` (UX copy) and `SqliteProvider.capture` (enforcement copy) | an incoming `CONFIRMED` on a non-directive type is DOWNGRADED to `INFERRED`, with a bracketed note appended to content | `confidence_clamped: true` in the `kb_capture` response, plus the content note. NOT an error |
| `E-DIRECTIVE-QUARANTINE` | `SqliteProvider.capture` directive gate | a `user-directive` capture is forced to a PENDING PROPOSAL: confidence to `UNVERIFIED`, `flagged_for_review` set, `directive:pending` tag added, scope forced to `project` | the stored entry differs from the requested one; activation is CLI-only. NOT an error |
| `E-CONTRADICTION-FLAGGED` | `makeAudnDecision`, `src/services/knowledge/audn.ts` | symbol overlap PLUS a contradiction signal (keyword hit or opposite polarity); cross-type allowed, file overlap not required | `audn_decision: flagged` in the capture response, and a `contradiction_of` link. NOT an error |
| `E-SUPERSEDE-CONSENT-MISSING` | `makeAudnDecision` explicit-supersede branch | a `supersedes` request takes effect ONLY if AUDN independently matches that candidate under the dedup gates (same type, symbol overlap, file overlap, target not an ACTIVE user-directive). Otherwise the request silently falls through to the ordinary paths | the named target is NOT retired and `audn_decision` is whatever the fallthrough decided. NO error is raised -- the most easily missed refusal in the surface |
| `E-DEDUP-NONE` | `makeAudnDecision` | exact content equality, or a same-topic match with no contradiction signal | `audn_decision: none` -- the capture is skipped, not failed |
| `E-ACTIVE-DIRECTIVE-SUPERSEDE-GUARD` | `makeAudnDecision` | an ACTIVE (CONFIRMED) user-directive candidate can never be superseded or updated by any `capture()` path; the loop skips past it | the candidate degrades to `flagged` (if a contradiction signal was present) or is skipped. NOT an error |
| `E-CODE-INTEL-DISABLED` | `NullProvider`, `src/tools/code-intelligence.ts` | code intelligence disabled for the member | a text payload naming the disabled method. NOT an error |
| `E-STATS-UNSUPPORTED` | `ProviderStats.supported === false` (HTTP provider, per design D4) | a provider that cannot compute stats returns a documented not-supported result rather than throwing | `{supported: false, reason}` in the `kb_stats` response |
| `E-BIBLE-READ-DEGRADED` | `src/tools/kb-stats.ts` | any failure reading or comparing the canonical bible is swallowed | the response falls back to the absent/drift-zero bible shape. `kb_stats` never throws over the bible file |
| `E-RELATED-CLAIMS-DEGRADED` | `src/tools/kb-query.ts` | `relatedClaims` throws | caught; `related_claims` becomes `[]` and the query result still returns |

### 5.2 Throwing paths (refusals)

| Provisional name | Where | Trigger |
|------------------|-------|---------|
| `E-NO-BASIS` | `SqliteProvider.assertCheckableBasis`, raising `KbCaptureRejected('no_source_files')` | an entry cites zero source files. Exempt: `user-directive`, which is not a claim about code. Rationale: the freshness sweep builds its work set only from entries with a parsed basis, so a basis-less entry is structurally unfalsifiable |
| `E-BASIS-MISSING-FILES` | `SqliteProvider.assertCheckableBasis`, raising `KbCaptureRejected('missing_source_files')` | cited source files do not resolve in this worktree. NO exemption for harvest-sourced entries or for import mode |
| `E-PROVIDER-UNINITIALIZED` | `SqliteProvider.getDb` | any method called before `init()` |
| `E-ENTRY-NOT-FOUND` | `promote`, `feedback` | the id has no row |
| `E-PROMOTE-SUPERSEDED` | `promote` | the target entry is already superseded |
| `E-PROMOTE-REFUSED-DIRECTIVE` | `promote` guard block | promotion of a `user-directive` entry; activation is CLI-only |
| `E-RESOLVE-MISSING-ENTRY` | `resolveContradiction` | either id does not exist. Writes NOTHING |
| `E-RESOLVE-ALREADY-SUPERSEDED` | `resolveContradiction` | either entry is already superseded. Writes NOTHING |
| `E-RESOLVE-NOT-A-PAIR` | `resolveContradiction` | the ids do not form a genuinely linked contradiction pair. Writes NOTHING |
| `E-RESOLVE-DIRECTIVE-PAIR` | `resolveContradiction` | the pair involves an ACTIVE user-directive; directives are never auto-resolved. Writes NOTHING |
| `E-DIRECTIVE-NOT-FOUND` | `approveDirective`, `rejectDirective` | the id has no row (CLI-only surface) |
| `E-DIRECTIVE-WRONG-TYPE` | `approveDirective`, `rejectDirective` | the entry is not a `user-directive` (CLI-only surface) |
| `E-DIRECTIVE-ALREADY-DECIDED` | `approveDirective`, `rejectDirective` | already active, or already rejected (CLI-only surface) |
| `E-PATH-TRAVERSAL` | `src/services/knowledge/path-validation.ts` | an absolute path, or a parent-directory traversal, in a file list |
| `E-QUERY-NO-SELECTOR` | `src/tools/kb-query.ts` | none of `query`, `tag`, `flagged_only` was supplied |
| `E-REPO-PATH-INVALID` | `src/tools/kb-export.ts`, `src/tools/kb-import.ts` | an explicitly supplied repo path does not exist or is not a directory. Both refuse rather than silently falling back to the server cwd |
| `E-BIBLE-NOT-FOUND` | `src/tools/kb-import.ts` | the resolved bible file does not exist |
| `E-BIBLE-NOT-JSON` | `src/tools/kb-import.ts` | the bible file is not valid JSON |
| `E-BIBLE-WRONG-SHAPE` | `src/tools/kb-import.ts` | the bible parses but is neither an entry array nor the v2 envelope |

### 5.3 Import-time entry rejection (counted, not thrown)

| Provisional name | Where | Mechanism |
|------------------|-------|-----------|
| `E-IMPORT-ENTRY-REJECTED` | `src/tools/kb-import.ts`, surfaced as `KbImportReport.rejected` | a single bible entry that fails `E-NO-BASIS` or `E-BASIS-MISSING-FILES` is counted in `rejected` and skipped; the import as a whole still succeeds. Per-entry validation failures (`isBibleEntry`: bad id, type, title, summary or confidence; non-array `symbols`/`source_files`) are likewise counted, not thrown |

### 5.4 Author/role validation

`validateAuthor` exists in BOTH `src/tools/kb-capture.ts` and
`src/tools/kb-feedback.ts` (duplicated, not shared). It never throws: an
unrecognised `role` degrades to the literal `unknown`. Provisional name
`E-ROLE-UNKNOWN-DEGRADED`.

## 6. Downstream notes

- The tool count to propagate is **23** (16 `kb_*`, 7 `code_*`). Anything citing
  24 is citing the unverified plan number.
- A generated binding typed against `MemoryProvider` alone is INCOMPLETE: the six
  methods plus one property in section 4.2 are tool-reachable but undeclared.
- Response-schema generation must handle three irregularities: `kb_query`'s
  two-shape union with an absent-vs-null `related_claims`, `kb_stats`'s
  spread-plus-optionals, and the seven permissive `code_*` bodies.

## Appendix A -- registration descriptions (verbatim)

Each block is the description string passed to the tool registration call in
`src/services/tool-registry.ts`, captured from the runtime registration dump so it
is byte-exact. No entry is blank.

### kb_capture

```text
Capture a learning, fact, or file summary into the knowledge bank. Confidence is capped at INFERRED: any CONFIRMED passed here is downgraded to INFERRED (result carries confidence_clamped:true). CONFIRMED is minted ONLY via kb_promote. Returns {id, audn_decision, confidence_clamped}. audn_decision: add=new entry, none=duplicate skipped, update=same-topic predecessor linked (refines; both entries stay live), flagged=contradiction flagged for review. Pass supersedes:<id> to retire that entry instead (only takes effect if AUDN independently matched it).
```

### kb_invalidate

```text
Mark context-cache entries stale for the given file paths. Call after modifying files to ensure the KB reflects the current state.
```

### kb_context

```text
Check freshness of files against the knowledge bank. Returns {fresh, stale, missing} -- fresh files can be skipped, stale/missing files must be re-read.
```

### kb_session_prime

```text
Prime a session with KB context. Returns session_warm status, stale files needing re-read, top KB entries, and recommended GitNexus calls.
```

### kb_query

```text
Two-level knowledge bank search. L1: FTS5 on title+summary (up to 20 results). L2: full content for top 5 hits (max 800 tokens each). Excludes stale/superseded by default. Optional tag filter (exact match) ANDs alongside other filters without touching FTS/OR-join logic, and may be used alone (no query) to list all entries carrying the tag. Pass flagged_only: true to list all contradiction-flagged entry pairs for resolution. Pass expand_related: true to also receive related_claims -- entries joined to the top hits by a refines or contradiction_of edge. Those record the KB own judgements about its contents (there is a newer framing of this; something disputes this) and cannot be reached by a text match. shares_file/shares_symbol edges are deliberately not traversed, since FTS over those same fields already surfaces them. Default false, in which case related_claims is absent and the result shape is unchanged.
```

### kb_list

```text
List KB entries by confidence/type/module/symbol/tag -- audit the CONFIRMED set (or any tier) without touching FTS ranking or use_count telemetry. Excludes superseded/stale entries. Returns {results, total} with each entry as {id, type, confidence, title, summary, symbols, source_files}.
```

### kb_harvest

```text
Scan a session transcript for learnings and capture them into the KB. Returns {entries_captured, entries_updated, entries_skipped}. Extracted entries are UNVERIFIED and author=harvest, source=harvest.
```

### kb_promote

```text
Upgrade KB entry confidence: UNVERIFIED -> INFERRED -> CONFIRMED. Appends promotion note to content as evidence trail. CONFIRMED entries are no-op.
```

### kb_freshness_sweep

```text
Bounded full-KB bidirectional freshness sweep: re-hash every entry that has a stored per-file basis against the CURRENT worktree, mark mismatches stale, and revive stale entries whose full basis matches again (superseded, feedback-downvoted, and invalidated entries stay retired). This is the branch-switch revival surface kb_session_prime cannot be (prime excludes stale entries). Returns {checked, staled, unstaled}.
```

### kb_import

```text
Import a merged bible (.fleet/kb-canonical.json) into the warm local KB -- the post-merge write path (the prime-time cold-seed is output-only). Reads the repo-resolved bible, or an explicit --path file. Each entry routes through the AUDN choke point (duplicate -> skipped, refinement -> linked, contradiction -> flagged); non-directive entries KEEP their bible confidence (the bible is a git-reviewed, human-merged artifact), stamped source="import"; type="user-directive" entries are FORCED to pending proposals (never active -- a bible cannot smuggle an active directive). Idempotent (re-import of the same bible adds nothing). Runs a freshness sweep after import so entries whose basis does not match this worktree are staled. Accepts BOTH bible shapes: a legacy bare JSON array and the v2 {version, provenance:{commit, branch, entry_count}, entries} envelope. Entries with no source_files, or citing files absent from this worktree, are REJECTED (an entry with no checkable basis can never be staled, so nothing could falsify it) -- re-importing a legacy bible deliberately drops those. Returns {imported, skipped, linked, flagged, rejected, sweep:{checked, staled, unstaled}}. Pass skip_sweep: true to skip the post-import freshness sweep -- the sweep re-judges EVERY entry against the given worktree, which is right for a deliberate audit but wrong for a routine warm-the-KB import (it mass-stales entries merely because unrelated files moved on, which in turn empties the promotion candidates kb_list returns). Accepts `repo_path` as an alias for `repo`, matching every other kb_* tool (the apra-fleet-src input-name trap: zod strips an unknown key silently, so the mismatched name resolved against the server cwd instead of erroring). TRUST BOUNDARY: importing the repo-resolved bible is the git-reviewed trusted channel; an explicit --path bible is caller-asserted trust, equivalent in power to kb_promote. Directives are quarantined either way; activation stays CLI-only.
```

### kb_resolve_contradiction

```text
Resolve a KB contradiction pair: {winnerId, loserId, evidence}. The SINGLE write path for reconcile resolutions (used by kb_reconcile_prefilter and the reconciler agent alike). Winner ends confidence=CONFIRMED with the evidence note appended and both flag fields cleared (flagged_for_review + contradiction_of); stale is cleared ONLY if the D2 un-stale predicate holds on the post-flag-clear row (so a downvoted or invalidated winner still stays retired -- it wins the contradiction, not its reputation). Loser ends superseded_at=now + stale=1 + flag cleared, never deleted. REFUSES (throws, writes nothing) when either id is missing, either entry is already superseded, the ids do not form a genuinely linked contradiction pair, or the pair involves an ACTIVE user-directive.
```

### kb_reconcile_prefilter

```text
Mechanical hash-basis prefilter over all flagged contradiction pairs (including stale members -- see flaggedPairs liveness contract). Re-hashes both sides of each pair against the CURRENT worktree: exactly one side fully matching wins mechanically via kb_resolve_contradiction (evidence "hash-basis match on merged worktree"); both match, both mismatch, or an empty/missing basis on either side leaves the pair for the reconciler agent. Pairs involving an ACTIVE user-directive are never touched. Returns {pairs, resolved, left_for_agent, skipped_directive}. Run after kb_import + kb_freshness_sweep, before dispatching the reconciler agent.
```

### kb_setup

```text
Set up KB: install git post-commit hook, write provider config, store remote credentials encrypted. Run once per repo.
```

### kb_export

```text
Export all CONFIRMED, non-superseded, non-stale KB entries to a canonical bible file (stable field set, deterministic id order, ASCII-safe). scope="project" (default): reads the project KB, writes <repo>/.fleet/kb-canonical.json. scope="global": reads the GLOBAL KB, writes <repo>/.fleet/kb-canonical-global.json (in practice the apra-fleet platform repo, committed there so the installer can distribute it to every project on the machine -- D8/F9). Run after kb_promote so the canonical set stays current. F6a: the tool itself auto-commits the bible file (pathspec-only, identity pm-kb) when the repo is a git repo and the content changed -- this is code, not agent discretion, so no manual git step is needed, and this applies to the global file too. Non-fatal on any git failure; push is not automatic. Writes the v2 format: {version:2, provenance:{commit, branch, entry_count}, entries:[...]}, recording the commit the entries were verified against (a commit, not a timestamp, so re-exports stay diff-free when nothing changed). An export whose entry set is unchanged rewrites nothing. Auto-commit defaults to ON (USER DIRECTIVE 2026-08-11 -- an export left uncommitted is knowledge nobody else ever sees): set FLEET_DIR/knowledge/config.json { bible: { autoCommit: false } } to opt out. A malformed config disables it.
```

### kb_stats

```text
Read-only KB health aggregation: totals by confidence/type, stale/flagged/superseded counts, retrieval hit_rate, promote_ratio, canonical-bible presence/drift, and optional per-symbol coverage. Never bumps use_count/last_accessed (kb_list pattern). Bible drift is visibility for the machine that owns the KB -- CI cannot see the local kb.sqlite, so there is no CI gate on it.
```

### kb_feedback

```text
Downvote a KB entry that proved wrong in practice: { id, reason, role? }. Marks the entry stale=1 + flagged_for_review=1 and appends an ASCII feedback note "[feedback <ISO>] <validated-role>: <reason>" (CONTENT_CAP respected). NEVER deletes and NEVER touches confidence -- a downvoted CONFIRMED entry stays CONFIRMED-but-stale-flagged; the human resolves it in kb-review, this tool only flags it for that review. Exception: an ACTIVE user-directive is flagged for review but NOT staled (directives outrank agent experience -- the human decides); a pending directive proposal stales normally.
```

### code_graph

```text
Trace the call graph for a symbol. Returns callers and callees across the codebase. Prefer this over Glob/Grep/file reads for structural questions (symbol lookup, call chains, impact) -- the answer is pre-indexed.
```

### code_impact

```text
Find what is affected by changes to a symbol. Prefer this over Glob/Grep/file reads for structural questions (symbol lookup, call chains, impact) -- the answer is pre-indexed.
```

### code_query

```text
Search the codebase for symbols, patterns, or concepts using natural language or code patterns. Prefer this over Glob/Grep/file reads for structural questions (symbol lookup, call chains, impact) -- the answer is pre-indexed.
```

### code_context

```text
Get callers, callees, and execution flows for a symbol. Prefer this over Glob/Grep/file reads for structural questions (symbol lookup, call chains, impact) -- the answer is pre-indexed.
```

### code_map

```text
Get the architectural map of a repository: module communities with their key symbols and files, ranked by size. Prefer this over directory listings or file reads when orienting in an unfamiliar codebase -- the answer is pre-indexed.
```

### code_flow

```text
Find process flows (entry -> steps -> exit) matching a name or endpoints. Prefer this over manually tracing call chains across files -- the flows are pre-indexed.
```

### code_tests

```text
Find the test files and test functions that exercise a symbol (transitive callers, depth 2). Use this to run targeted tests for the code you changed instead of the full suite. Prefer this over Grep for test discovery -- the call graph is pre-indexed.
```

