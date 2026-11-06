// Builds the vector inputs of one KB entry (design D2a, vector half).
//
// One entry becomes several vectors, so a query matching any one facet of it
// finds it (the store scores an entry by its best vector):
//
//   title_summary  title + summary (always one)
//   cue            one per recall cue
//   chunk          the content split into chunks of about 200-250 tokens (for a
//                  512-token model) on paragraph / section breaks, with about
//                  30 tokens of overlap, each starting with the entry title
//   error          one per error signature long enough to carry meaning:
//                  at least ERROR_MIN_WORDS words OR ERROR_MIN_CHARS characters.
//                  "ENOENT" or "timeout" alone matches everything and nothing.
//   tried          a "Tried (failed)" labelled section of the content, cut out
//                  of the normal chunks and kept as its own labelled chunk, so a
//                  search for the failed approach returns the entry together
//                  with its warning.
//
// Chunk size scales with the model's token limit: the target is
// CHUNK_FRACTION of the limit and the overlap OVERLAP_FRACTION, so a long-window
// model gets bigger chunks. Tokens are estimated as characters / 4 (no
// tokenizer on this path; the embedder truncates at the real limit anyway, and
// the target leaves more than half the window free).
//
// Every input is embedded with a one-line header in front (embedText): the
// entry's module or component plus its trigger type, e.g.
// "[src/services/knowledge] trigger: bug-fix".

import { createHash } from 'node:crypto';
import type { VectorKind } from './vector-store.js';

/** Bumped when the inputs this module builds change (forces a vector rebuild). */
export const KB_CHUNKER_VERSION = 1;

export const ERROR_MIN_WORDS = 3;
export const ERROR_MIN_CHARS = 20;
/** Chunk target as a fraction of the model token limit (512 -> ~230 tokens). */
export const CHUNK_FRACTION = 0.45;
/** Overlap as a fraction of the model token limit (512 -> ~31 tokens). */
export const OVERLAP_FRACTION = 0.06;
const CHARS_PER_TOKEN = 4;
const MIN_CHUNK_TOKENS = 32;
const MIN_OVERLAP_TOKENS = 4;

export const TRIED_LABEL = 'Tried (failed)';

/** The entry fields the chunker reads. */
export interface ChunkableEntry {
  title: string;
  summary: string;
  content?: string | null;
  recall_cues?: string[];
  error_signatures?: string[];
  module?: string | null;
  source_files?: string[];
  symbols?: string[];
  trigger?: string | null;
  type?: string;
}

export interface VectorInput {
  kind: VectorKind;
  ordinal: number;
  /** The input without the header (chunks start with the title). */
  text: string;
  /** What is actually embedded: header line + text. */
  embedText: string;
  /** sha256 of embedText. */
  textHash: string;
}

export interface ChunkSizing {
  targetTokens: number;
  overlapTokens: number;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Chunk target and overlap for a model token limit. */
export function chunkSizing(tokenLimit: number): ChunkSizing {
  const limit = Number.isFinite(tokenLimit) && tokenLimit > 0 ? tokenLimit : 512;
  return {
    targetTokens: Math.max(MIN_CHUNK_TOKENS, Math.floor(limit * CHUNK_FRACTION)),
    overlapTokens: Math.max(MIN_OVERLAP_TOKENS, Math.round(limit * OVERLAP_FRACTION)),
  };
}

/** True when an error signature is long enough to embed on its own. */
export function errorSignatureQualifies(sig: string): boolean {
  const s = sig.trim();
  if (s.length >= ERROR_MIN_CHARS) return true;
  return s.split(/\s+/).filter(Boolean).length >= ERROR_MIN_WORDS;
}

/** The one-line header prepended before embedding: module or component plus trigger type. */
export function entryHeader(e: ChunkableEntry): string {
  const component = (e.module && e.module.trim())
    || (e.source_files?.[0] ? componentOfFile(e.source_files[0]) : '')
    || e.symbols?.[0]
    || 'general';
  const trigger = (e.trigger && e.trigger.trim()) || e.type || 'none';
  return `[${component}] trigger: ${trigger}`;
}

function componentOfFile(file: string): string {
  const norm = file.replace(/\\/g, '/');
  const slash = norm.lastIndexOf('/');
  return slash > 0 ? norm.slice(0, slash) : norm;
}

// -- content sections -------------------------------------------------------

const HEADING_RE = /^\s{0,3}#{1,6}\s+\S/;
const TRIED_RE = /^\s{0,3}(?:#{1,6}\s*)?(?:[-*]\s+)?(?:\*\*|__)?\s*tried\s*\(\s*failed\s*\)\s*(?:\*\*|__)?\s*:?\s*(?:\*\*|__)?/i;
/** A line that opens another labelled section ("Fix:", "**Root cause:**"). */
const LABEL_RE = /^\s{0,3}(?:[-*]\s+)?(?:\*\*|__)?[A-Z][A-Za-z0-9 ()/-]{0,30}(?:\*\*|__)?:(?:\*\*|__)?(?:\s|$)/;

/**
 * Split content into the Tried (failed) sections and the rest. A Tried
 * section starts at a line labelled "Tried (failed)" (heading, bold label or
 * plain "Tried (failed):") and runs until the next heading or the next line
 * that opens another "Label:" section.
 */
export function splitTriedSections(content: string): { rest: string; tried: string[] } {
  const lines = content.split(/\r?\n/);
  const rest: string[] = [];
  const tried: string[] = [];
  let current: string[] | null = null;
  const flush = () => {
    if (current) {
      const body = current.join('\n').trim();
      if (body) tried.push(body);
    }
    current = null;
  };
  for (const line of lines) {
    const t = TRIED_RE.exec(line);
    if (t) {
      flush();
      current = [];
      const after = line.slice(t[0].length).trim();
      if (after) current.push(after);
      continue;
    }
    if (current && (HEADING_RE.test(line) || LABEL_RE.test(line))) {
      flush();
    }
    if (current) current.push(line);
    else rest.push(line);
  }
  flush();
  return { rest: rest.join('\n'), tried };
}

/** Paragraphs (blank-line separated; a heading also starts a new one). */
function paragraphs(text: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  const push = () => {
    const p = cur.join('\n').trim();
    if (p) out.push(p);
    cur = [];
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') { push(); continue; }
    if (HEADING_RE.test(line)) push();
    cur.push(line);
  }
  push();
  return out;
}

/** The last ~maxChars of text, starting at a word boundary. */
function tail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(text.length - maxChars);
  const sp = cut.search(/\s/);
  return (sp >= 0 ? cut.slice(sp) : cut).trim();
}

/** Split one over-long piece into word-aligned windows of at most targetChars. */
function windows(text: string, targetChars: number, overlapChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur: string[] = [];
  let len = 0;
  for (const w of words) {
    if (len > 0 && len + 1 + w.length > targetChars) {
      const piece = cur.join(' ');
      out.push(piece);
      const carry = tail(piece, overlapChars);
      cur = carry ? carry.split(/\s+/) : [];
      len = carry.length;
    }
    cur.push(w);
    len += (len > 0 ? 1 : 0) + w.length;
  }
  if (cur.length) out.push(cur.join(' '));
  return out;
}

/**
 * Pack text into chunks of about sizing.targetTokens on paragraph breaks,
 * each (after the first) starting with about sizing.overlapTokens of the
 * previous chunk's tail. Bodies only: the caller prefixes the title.
 */
export function chunkText(text: string, sizing: ChunkSizing): string[] {
  const targetChars = sizing.targetTokens * CHARS_PER_TOKEN;
  const overlapChars = sizing.overlapTokens * CHARS_PER_TOKEN;
  const pieces: string[] = [];
  for (const p of paragraphs(text)) {
    if (p.length > targetChars) pieces.push(...windows(p, targetChars, overlapChars));
    else pieces.push(p);
  }
  const chunks: string[] = [];
  let cur = '';
  let curHasNew = false;
  for (const piece of pieces) {
    const joined = cur ? cur + '\n\n' + piece : piece;
    if (cur && curHasNew && joined.length > targetChars) {
      chunks.push(cur);
      const carry = tail(cur, overlapChars);
      cur = carry ? carry + '\n\n' + piece : piece;
    } else {
      cur = joined;
    }
    curHasNew = true;
  }
  if (cur && curHasNew) chunks.push(cur);
  return chunks;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Every vector input of an entry, in a stable order. `tokenLimit` is the
 * active model profile's token limit (drives chunk size).
 */
export function buildVectorInputs(entry: ChunkableEntry, tokenLimit: number): VectorInput[] {
  const sizing = chunkSizing(tokenLimit);
  const header = entryHeader(entry);
  const title = (entry.title ?? '').trim();
  const summary = (entry.summary ?? '').trim();
  const raw: { kind: VectorKind; text: string }[] = [];

  raw.push({ kind: 'title_summary', text: summary ? `${title}\n${summary}` : title });

  for (const cue of entry.recall_cues ?? []) {
    const c = typeof cue === 'string' ? cue.trim() : '';
    if (c) raw.push({ kind: 'cue', text: c });
  }

  const content = (entry.content ?? '').trim();
  if (content && content !== summary) {
    const { rest, tried } = splitTriedSections(content);
    for (const body of chunkText(rest, sizing)) raw.push({ kind: 'chunk', text: `${title}\n${body}` });
    for (const t of tried) {
      for (const body of chunkText(t, sizing)) raw.push({ kind: 'tried', text: `${title}\n${TRIED_LABEL}: ${body}` });
    }
  }

  for (const sig of entry.error_signatures ?? []) {
    if (typeof sig === 'string' && errorSignatureQualifies(sig)) raw.push({ kind: 'error', text: sig.trim() });
  }

  const ordinals = new Map<VectorKind, number>();
  return raw.map(({ kind, text }) => {
    const ordinal = ordinals.get(kind) ?? 0;
    ordinals.set(kind, ordinal + 1);
    const embedText = `${header}\n${text}`;
    return { kind, ordinal, text, embedText, textHash: sha256(embedText) };
  });
}

/** One hash over all inputs: equal hashes mean nothing to re-embed. */
export function inputsHash(inputs: VectorInput[]): string {
  return sha256(inputs.map(i => `${i.kind}:${i.ordinal}:${i.textHash}`).join('\n'));
}
