// D6 (T3.1): 'user-directive' is the highest-trust entry type -- a standing
// instruction/correction the user gave during a sprint. It is captured at
// confidence='CONFIRMED' (the SOLE exemption from the D1 clamp, stamped by the
// kb-capture tool layer), is NEVER auto-decayed, and can only be superseded by
// another user-directive. Retrieval needs NO special ranking code: because it
// stores confidence='CONFIRMED', every existing confidence-aware ranking path
// treats it as CONFIRMED-equivalent automatically (D6 semantic 4).
export type ContentType = 'context-cache' | 'learning' | 'knowledge' | 'runbook' | 'user-directive';

export type Confidence = 'CONFIRMED' | 'INFERRED' | 'UNVERIFIED';

// D5 (T2.3): canonical provenance enums. These are stamped ONLY by the tool
// layer (kb-capture / kb-promote handlers) -- callers cannot pass a free
// string into either field via the tool schemas (the zod schemas were
// tightened accordingly). 'harvest' is ADDED to Author beyond D5's literal
// list per the revised D7: harvest-sourced entries need a distinct author
// from real KB-Agent captures (feedback.md LOW finding 6). This deviation
// from D5's literal enum is recorded in progress.json notes for T2.3.
export type Author = 'doer' | 'reviewer' | 'planner' | 'plan-reviewer' | 'kb-agent' | 'harvest' | 'pm' | 'user';
// T2.1 (F4, D3): 'import' is ADDED for the kb_import trusted-channel write path
// -- entries absorbed from a git-reviewed, human-merged .fleet/kb-canonical.json
// bible are stamped source='import' so provenance shows the channel. It is
// STAMPED ONLY when the internal import mode is engaged (SqliteProvider.capture's
// second, non-deserializable parameter); a caller-supplied 'import' (or
// 'promotion') arriving via a deserialized route body is normalized away
// (MEDIUM-4). See SqliteProvider.capture.
export type CaptureSource = 'session' | 'review' | 'harvest' | 'promotion' | 'import' | 'user-directive' | 'unknown';

export type AudnDecision = 'add' | 'update' | 'flagged' | 'none';

export interface CodeIntelCall {
  tool: string;
  args: Record<string, string>;
}

export interface KBEntry {
  id: string;
  type: ContentType;
  title: string;
  summary: string;
  content: string;
  source_files: string[];
  symbols: string[];
  module?: string;
  tags: string[];
  content_hash: string;
  content_hash_type: 'git' | 'sha256';
  stale: boolean;
  flagged_for_review: boolean;
  contradiction_of?: string;
  // Tolerant reads (D5, no migration): existing rows carry legacy free-string
  // author values and legacy source values ('doer', 'reviewer',
  // 'user_interrupt', 'kb_agent_harvest'). New WRITES from the tool layer are
  // enum-only (Author | 'unknown' for author, CaptureSource for source), but
  // the read-side type stays loose so rowToEntry never lies about historical
  // data that is intentionally NOT migrated.
  author: string;
  source: CaptureSource | string;
  confidence: Confidence;
  scope?: 'project' | 'global';
  created_at: string;
  superseded_at?: string;
  promoted_at?: string;
  use_count: number;
  last_accessed?: string;
}

export type KBEntryInput = Omit<KBEntry, 'id' | 'stale' | 'created_at' | 'superseded_at' | 'use_count' | 'last_accessed'>;

// T2.1 (F4, D3, R4): internal-only options for SqliteProvider.capture(). This is
// a SECOND parameter of capture() -- deliberately NOT a field of KBEntryInput --
// so it is structurally unreachable from every deserialized route: the HTTP
// /api/kb/capture route does capture(JSON.parse(body)) with exactly one argument
// and the kb_capture MCP handler builds the input from zod-parsed fields and
// calls capture({...}) with one argument. Only in-process callers (kb_import)
// can set it. importMode grants the SOLE clamp exemption (bible confidence is
// preserved for non-directive types) and suppresses provenance normalization so
// source='import' survives; preferredId lets kb_import preserve a bible entry's
// id on the pure 'add' path (exact re-import idempotency).
export interface CaptureOpts {
  importMode?: boolean;
  preferredId?: string;
}

export interface QueryOptions {
  // Free text from a caller (kb_query). Tokenized + OR-joined inside query().
  // NEVER pass a pre-built FTS expression here -- query() would re-tokenize it
  // and turn '"a" OR "b"' into '"a" OR "OR" OR "b"'. Use fts_terms instead.
  query?: string;
  // INTERNAL ONLY. Callers that already hold discrete terms (prime) pass them
  // here so sanitization happens exactly once and AND-within-term semantics
  // survive for qualified names (Parser.parsePower -> '"Parser" "parsePower"').
  // Structurally unreachable from kbQuerySchema and the HTTP /api/kb/query
  // route -- both build QueryOptions field-by-field from zod-parsed input.
  // Do NOT add this to either surface.
  fts_terms?: string[];
  type?: ContentType;
  symbols?: string[];
  source_files?: string[];
  tags?: string[];
  // T-tag-filter: exact-match filter on a single tag value, applied as a WHERE
  // clause (json_each over the tags column) alongside existing filters --
  // NOT an FTS term, so it composes with `query` and does not disturb the
  // FTS/OR-join logic. Same pattern as kb_list's `symbol` filter.
  tag?: string;
  include_stale?: boolean;
  include_superseded?: boolean;
  flagged_only?: boolean;
  l1_only?: boolean;
  limit?: number;
  ids?: string[];
}

export interface KBResult {
  results: KBEntry[];
  total: number;
  l1_only: boolean;
}

export interface FileContextResult {
  file: string;
  status: 'fresh' | 'stale' | 'missing';
  reason?: string;
  summary?: string;
  content_hash?: string;
  entry_id?: string;
}

export interface PrimeOptions {
  session_files?: string[];
  hint_symbols?: string[];
  hint_modules?: string[];
  decay_after_days?: number;
}

export interface PrimedContext {
  session_warm: boolean;
  stale_files: string[];
  top_entries: KBEntry[];
  fresh_summaries: FileContextResult[];
  recommended_code_calls: CodeIntelCall[];
  token_estimate: number;
}

export interface StalenessResult {
  stale: boolean;
  reason?: string;
  currentHash?: string;
}

// T2.1 (F5, D4): kb_stats read-only aggregation shapes. totals/stale/flagged/
// superseded are raw table-wide counts (no liveness filter) -- they exist to
// show the full volume alongside the "live" subset used by retrieval.hit_rate
// and coverage (resolution 6: hit_rate = entries_retrieved / total LIVE
// entries, where live = superseded_at IS NULL AND stale = 0). promote_ratio
// and hit_rate are null (not 0/NaN) when their denominator is zero (no
// CONFIRMED entries / no live entries yet) -- an empty KB reports null, not a
// misleading 0.
export interface KbTotals {
  by_confidence: Record<Confidence, number>;
  by_type: Record<ContentType, number>;
  total: number;
}

export interface KbRetrievalStats {
  entries_retrieved: number;
  total_uses: number;
  hit_rate: number | null;
}

export interface KbCoverage {
  fraction: number;
  symbols: Record<string, boolean>;
}

export interface ProviderStats {
  // Present (false) only on a provider that cannot compute stats at all (D4:
  // HttpKbProvider returns a documented not-supported result rather than
  // throwing). Absent/true on SqliteProvider's real computation.
  supported?: boolean;
  reason?: string;
  totals: KbTotals;
  stale: number;
  flagged: number;
  superseded: number;
  retrieval: KbRetrievalStats;
  promote_ratio: number | null;
  coverage?: KbCoverage;
}

export interface SyncOptions {
  direction?: 'push' | 'pull' | 'both';
  peer?: string;
}

export interface SyncResult {
  synced: boolean;
  reason?: string;
}

export interface ProviderConfig {
  provider: 'sqlite' | 'http';
  url?: string;
  dbPath?: string;
}

export interface MemoryProvider {
  init(): Promise<void>;
  capture(input: KBEntryInput): Promise<{ id: string; audn_decision: AudnDecision }>;
  query(opts: QueryOptions): Promise<KBResult>;
  context(files: string[]): Promise<FileContextResult[]>;
  invalidate(files: string[]): Promise<{ invalidated: number }>;
  getLinked(id: string): Promise<KBEntry[]>;
  prime(opts: PrimeOptions): Promise<PrimedContext>;
  promote(id: string, reason?: string): Promise<{ id: string; confidence_before: Confidence; confidence_after: Confidence }>;
  sync(opts?: SyncOptions): Promise<SyncResult>;
  // T2.1 (F5, D4): dedicated no-bump aggregation read (kb_list pattern -- never
  // touches use_count/last_accessed). Part of the interface (not just
  // SqliteProvider, unlike list()) because D4 binds HttpKbProvider to a
  // documented not-supported result rather than an absent method.
  stats(opts?: { symbols?: string[] }): Promise<ProviderStats>;
}
