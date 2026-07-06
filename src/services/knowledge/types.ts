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
export type CaptureSource = 'session' | 'review' | 'harvest' | 'promotion' | 'user-directive' | 'unknown';

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

export interface QueryOptions {
  query?: string;
  type?: ContentType;
  symbols?: string[];
  source_files?: string[];
  tags?: string[];
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
}
