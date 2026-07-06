import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { getKbProviders } from '../services/knowledge/kb-providers.js';

// T3.4 (F8b, D8): export half of the shareable, diffable team bible. Writes
// all CONFIRMED, non-superseded, non-stale project entries to
// <repo>/.fleet/kb-canonical.json. Registered as a real MCP tool (not just an
// exported helper) so the KB Agent -- which is MCP-only, it has no shell/git
// access -- can invoke it directly after kb_promote. The PM commits the
// resulting file; this tool only writes it to disk.
export const kbExportSchema = z.object({
  repo_path: z.string().optional()
    .describe('Path to the repo root to write .fleet/kb-canonical.json into (default: current directory)'),
});

export type KbExportInput = z.infer<typeof kbExportSchema>;

interface CanonicalEntry {
  id: string;
  type: string;
  title: string;
  summary: string;
  symbols: string[];
  source_files: string[];
  confidence: string;
  updated_at: string;
}

// ASCII-safe stringify: JSON.stringify already escapes the JSON-mandatory
// characters (quotes, control chars) but leaves ordinary non-ASCII text
// (e.g. an em-dash or accented letter that made it into a captured title or
// summary) as literal UTF-8 bytes. This file is committed under the repo's
// ASCII-only convention, so every UTF-16 code unit above the printable ASCII
// range gets re-escaped as a four-hex-digit unicode escape, one code unit at
// a time via charCodeAt/toString(16). Deliberately avoids putting a literal
// unicode-escape sequence in THIS source file's own text (it must stay
// ASCII too) and avoids template literals -- the pre-commit hook's
// backtick-n/t/r scan false-positives on template-literal escape sequences,
// the same gotcha T2.3's promote() fix worked around.
function asciiSafeStringify(value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  const maxAsciiCode = 127;
  const escapePrefix = String.fromCharCode(92) + 'u'; // backslash + 'u', built at runtime
  let out = '';
  for (let i = 0; i < json.length; i++) {
    const code = json.charCodeAt(i);
    if (code > maxAsciiCode) {
      let hex = code.toString(16);
      while (hex.length < 4) hex = '0' + hex;
      out += escapePrefix + hex;
    } else {
      out += json.charAt(i);
    }
  }
  return out;
}

export async function kbExport(input: KbExportInput): Promise<string> {
  const repoPath = input.repo_path || process.cwd();
  if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
    throw new Error('kb_export: repo_path does not exist or is not a directory: ' + repoPath);
  }

  const providers = await getKbProviders();
  const entries = await providers.project.list({ confidence: 'CONFIRMED' });

  // Deterministic ordering by id so re-exports produce meaningful diffs.
  const canonical: CanonicalEntry[] = entries
    .map(e => ({
      id: e.id,
      type: e.type,
      title: e.title,
      summary: e.summary,
      symbols: e.symbols,
      source_files: e.source_files,
      confidence: e.confidence,
      updated_at: e.promoted_at || e.created_at,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const fleetDir = path.join(repoPath, '.fleet');
  if (!fs.existsSync(fleetDir)) {
    fs.mkdirSync(fleetDir, { recursive: true });
  }
  const outPath = path.join(fleetDir, 'kb-canonical.json');
  fs.writeFileSync(outPath, asciiSafeStringify(canonical) + '\n', 'utf-8');

  return JSON.stringify({ exported: canonical.length, path: outPath });
}
