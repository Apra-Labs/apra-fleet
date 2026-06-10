export type ContentType = 'context-cache' | 'learning' | 'knowledge' | 'runbook';

export type Confidence = 'CONFIRMED' | 'INFERRED' | 'UNVERIFIED';

export type CaptureSource = 'doer' | 'reviewer' | 'user_interrupt' | 'kb_agent_harvest';

export type AudnDecision = 'add' | 'update' | 'flagged' | 'none';

export interface GitNexusCall {
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
  author: string;
  source: CaptureSource;
  confidence: Confidence;
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

export interface PrimedContext {
  learnings: KBEntry[];
  fresh_summaries: FileContextResult[];
  stale_files: string[];
  recommended_gitnexus_calls: GitNexusCall[];
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
}

export interface MemoryProvider {
  init(): Promise<void>;
  capture(input: KBEntryInput): Promise<{ id: string; audn_decision: AudnDecision }>;
  query(opts: QueryOptions): Promise<KBResult>;
  context(files: string[]): Promise<FileContextResult[]>;
  invalidate(files: string[]): Promise<{ invalidated: number }>;
  prime(task: string, hint_files?: string[], hint_symbols?: string[]): Promise<PrimedContext>;
  promote(id: string, reason?: string): Promise<{ id: string; confidence_before: Confidence; confidence_after: Confidence }>;
  sync(opts?: SyncOptions): Promise<SyncResult>;
}
