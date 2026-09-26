import { z } from 'zod';
import { getKbProviders } from '../services/knowledge/kb-providers.js';
import { kbScopeFields } from '../services/knowledge/kb-scope-input.js';
import { KbCaptureRejected } from '../services/knowledge/types.js';
import type { KBEntryInput, CaptureSource, AudnDecision } from '../services/knowledge/types.js';

export const kbHarvestSchema = z.object({
  ...kbScopeFields,
  repo_path: z.string().optional()
    .describe('Path to the repo root this call is about. Selects WHICH project KB is read/written. When omitted, falls back to the calling process cwd, which is only correct for single-repo CLI use -- server-handled tool calls must pass it explicitly.'),
  session_transcript: z.string().optional()
    .describe('Full session transcript text to scan for learnings'),
  session_id: z.string().optional()
    .describe('Session ID for attribution'),
});

export type KbHarvestInput = z.infer<typeof kbHarvestSchema>;

interface ExtractedLearning {
  title: string;
  summary: string;
  content: string;
  source_files: string[];
  symbols: string[];
}

const LEARNING_PATTERNS = [
  /(?:^|\n)\s*(?:I found that|Note:|Warning:|Bug:|Gotcha:|This means)\s*[:\-]?\s*(.+?)(?:\n\n|\n(?=[A-Z])|$)/gis,
  /(?:^|\n)\s*(?:The (?:issue|problem|fix|solution|root cause) (?:is|was))\s*[:\-]?\s*(.+?)(?:\n\n|\n(?=[A-Z])|$)/gis,
  /(?:^|\n)\s*(?:Important:|Key insight:|Lesson learned:|TIL:)\s*(.+?)(?:\n\n|\n(?=[A-Z])|$)/gis,
];

const FILE_PATH_RE = /(?:^|\s)((?:src|lib|tests?|docs?)\/[\w./-]+\.\w+)/g;
const SYMBOL_RE = /`(\w{2,}(?:\.\w+)?(?:\(\))?)`/g;

function extractFilePaths(text: string): string[] {
  const matches = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(FILE_PATH_RE.source, FILE_PATH_RE.flags);
  while ((m = re.exec(text)) !== null) {
    matches.add(m[1]);
  }
  return [...matches];
}

function extractSymbols(text: string): string[] {
  const matches = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(SYMBOL_RE.source, SYMBOL_RE.flags);
  while ((m = re.exec(text)) !== null) {
    const sym = m[1].replace(/\(\)$/, '');
    if (sym.length >= 2 && !/^(the|and|for|not|but|was|are|has|had|can|will|this|that|with|from)$/i.test(sym)) {
      matches.add(sym);
    }
  }
  return [...matches];
}

function extractLearnings(transcript: string): ExtractedLearning[] {
  const results: ExtractedLearning[] = [];
  const seen = new Set<string>();

  for (const pattern of LEARNING_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(transcript)) !== null) {
      const raw = match[1].trim();
      if (raw.length < 20 || seen.has(raw)) continue;
      seen.add(raw);

      const title = raw.length > 80 ? raw.slice(0, 77) + '...' : raw;
      const summary = raw.length > 200 ? raw.slice(0, 200) + '...' : raw;
      const source_files = extractFilePaths(raw);
      const symbols = extractSymbols(raw);

      results.push({
        title,
        summary,
        content: raw,
        source_files,
        symbols,
      });
    }
  }

  return results;
}

// T3.2 (F7, revised D7): kb_harvest is auto-dispatched fire-and-forget by
// src/tools/execute-prompt.ts after every successful execute_prompt, which
// passes the full session transcript -- the one thing the agent whose
// session just ended does not itself have reliable access to. That autowire
// is the ONLY path that produces entries; do not remove it (see
// tests/knowledge/kb-harvest-autowire.test.ts). Calling this tool manually
// with no session_transcript (the "call kb_harvest yourself at session end"
// pattern once documented in the role prompts) is a no-op -- see the early
// return below -- and that instruction has been removed from agents/doer.md,
// agents/reviewer.md, etc. (they now note kb_harvest is an automatic
// backstop, not something they need to call). This is a separate, low-trust,
// regex-extracted path from a role's own kb_capture/kb_captures flow: every
// entry captured here is forced to
// confidence='UNVERIFIED' (never CONFIRMED, covered by the D1 clamp) with
// author='harvest', source='harvest' so it is distinguishable in queries.
export async function kbHarvest(input: KbHarvestInput): Promise<string> {
  if (!input.session_transcript) {
    return JSON.stringify({ entries_captured: 0, entries_updated: 0, entries_skipped: 0, entries_rejected: 0 });
  }

  const providers = await getKbProviders(input.repo_path, input.repo_remote_url);
  const provider = providers.project;

  const learnings = extractLearnings(input.session_transcript);
  let entries_captured = 0;
  let entries_updated = 0;
  let entries_skipped = 0;
  let entries_rejected = 0;

  // D5 + revised D7 (T2.3): harvested entries are UNVERIFIED, regex-extracted,
  // low-trust captures from the execute_prompt autowire -- distinct provenance
  // from real KB-Agent captures (author='kb-agent', source='session'/'review').
  const source: CaptureSource = 'harvest';

  for (const learning of learnings) {
    const entryInput: KBEntryInput = {
      type: 'learning',
      title: learning.title,
      summary: learning.summary,
      content: learning.content,
      source_files: learning.source_files,
      symbols: learning.symbols,
      tags: input.session_id ? [`session:${input.session_id}`] : [],
      content_hash: '',
      content_hash_type: 'sha256',
      flagged_for_review: false,
      author: 'harvest',
      source,
      confidence: 'UNVERIFIED',
    };

    // KB-TRUST PHASE 1: capture now fails closed on an uncheckable basis, and
    // harvest is the highest-volume writer -- its regex extraction frequently
    // yields no file paths at all. Isolate each capture so one rejected entry
    // is counted and the loop continues; an unhandled throw here would abort
    // the remaining entries and die silently, because auto-harvest is
    // dispatched fire-and-forget with a bare .catch() in execute-prompt.ts.
    let audn_decision: AudnDecision;
    try {
      ({ audn_decision } = await provider.capture(entryInput));
    } catch (err) {
      if (err instanceof KbCaptureRejected) {
        entries_rejected++;
        continue;
      }
      throw err;
    }

    if (audn_decision === 'add' || audn_decision === 'flagged') {
      entries_captured++;
    } else if (audn_decision === 'update') {
      entries_updated++;
    } else {
      entries_skipped++;
    }
  }

  return JSON.stringify({ entries_captured, entries_updated, entries_skipped, entries_rejected });
}
