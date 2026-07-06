import { z } from 'zod';
import { getKBService } from '../services/knowledge/kb-service.js';
import type { KBEntryInput, CaptureSource } from '../services/knowledge/types.js';

export const kbHarvestSchema = z.object({
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

export async function kbHarvest(input: KbHarvestInput): Promise<string> {
  if (!input.session_transcript) {
    return JSON.stringify({ entries_captured: 0, entries_updated: 0, entries_skipped: 0 });
  }

  const service = getKBService();
  const provider = service.getProvider();
  await provider.init();

  const learnings = extractLearnings(input.session_transcript);
  let entries_captured = 0;
  let entries_updated = 0;
  let entries_skipped = 0;

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

    const { audn_decision } = await provider.capture(entryInput);
    if (audn_decision === 'add' || audn_decision === 'flagged') {
      entries_captured++;
    } else if (audn_decision === 'update') {
      entries_updated++;
    } else {
      entries_skipped++;
    }
  }

  return JSON.stringify({ entries_captured, entries_updated, entries_skipped });
}
