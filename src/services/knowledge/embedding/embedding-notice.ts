// One-line, operator-facing description of an embedding model state that needs
// attention: what state it is in, why, and the command that fixes it. Used by
// fleet_status (compact line + JSON fields) and kb_session_prime (one warning).
// Healthy states (idle, loading, ready) have no notice. kb_session_prime skips
// the deliberate off state.

import type { EmbedderState } from './embedder.js';

export interface EmbeddingNotice {
  state: 'downloading' | 'failed' | 'off';
  reason: string;
  fix: string;
  /** The single line: state, reason and fix. */
  line: string;
}

const KEYWORD_NOTE = 'keyword and anchor search serve meanwhile';

export function embeddingNotice(e: EmbedderState | undefined): EmbeddingNotice | null {
  if (!e) return null;
  switch (e.state) {
    case 'downloading': {
      const reason = `downloading the ${e.modelId} model (about 23 MB for the default); ${KEYWORD_NOTE}`;
      const fix = 'wait for it; on an offline machine run apra-fleet kb model import <folder>, or run apra-fleet kb embedding none to turn semantic search off';
      return { state: 'downloading', reason, fix, line: `semantic search starting: ${reason} -- ${fix}` };
    }
    case 'failed': {
      const reason = e.reason;
      const fix = 'run apra-fleet kb model import <folder> (offline install) or apra-fleet kb embedding none (turn semantic search off)';
      return { state: 'failed', reason, fix, line: `semantic search off: ${reason.startsWith('load failed') ? 'model failed to load' : 'model download failed'}: ${reason} -- ${fix}; ${KEYWORD_NOTE}` };
    }
    case 'disabled': {
      // A deliberate setting, not a fault: state it and how to change it,
      // without urging anyone to undo it.
      const reason = 'embedding.model is none';
      const fix = 'set in the KB config; apra-fleet kb embedding <model name> (or kb_setup embedding_model) changes it';
      return { state: 'off', reason, fix, line: `semantic search off: ${reason}, keyword and anchor search only -- ${fix}` };
    }
    default:
      return null;
  }
}
