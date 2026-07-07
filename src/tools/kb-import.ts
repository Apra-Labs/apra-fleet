import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { getKbProviders } from '../services/knowledge/kb-providers.js';
import type { KBEntryInput, ContentType, Confidence } from '../services/knowledge/types.js';

// T2.1 (F4, D3 HARDENED): kb_import -- the trusted-channel write path that lets a
// warm local KB absorb a merged-in bible (.fleet/kb-canonical.json). The
// cold-seed in kb_session_prime is OUTPUT-ONLY and fires only under
// COLD_KB_MAX=3; it never writes the DB. This tool is that missing write path.
//
// Each bible entry routes through provider.capture() (the AUDN choke point) so
// dedupe/supersede/flag semantics apply, with an INTERNAL import mode (a second,
// non-deserializable capture() parameter -- R4) that (a) preserves the entry's
// bible confidence for NON-directive types (the SOLE clamp exemption -- the
// bible is a git-reviewed, human-merged artifact), stamping source='import';
// (b) forces type='user-directive' entries through the existing directive gate
// so they land as pending proposals, never active -- a bible cannot smuggle an
// active directive; and (c) suppresses provenance normalization so the tool's
// source='import' survives. After the loop it runs freshnessSweep() so imported
// entries whose basis does not match THIS worktree are staled immediately.
//
// TRUST BOUNDARY (LOW-1, honest statement): kb_import reads a caller-named local
// file. A local caller with tool access could hand-craft a bible and import it.
// This is equivalent in power to the already-MCP-exposed kb_promote surface
// (which walks any entry INFERRED->CONFIRMED one call at a time), so
// import-from-path adds bulk convenience, not a new privilege class. The
// "git-reviewed artifact" rationale only holds for the repo-resolved
// .fleet/kb-canonical.json; an explicit --path bible is CALLER-ASSERTED trust.
// The unforgeable tier remains user-directives, which are CLI-gated -- the
// directive gate quarantines them either way.

export const kbImportSchema = z.object({
  path: z.string().optional()
    .describe('Explicit path to a bible JSON file. When omitted, resolves to <repo>/.fleet/kb-canonical.json. TRUST NOTE: importing the repo-resolved .fleet/kb-canonical.json is the git-reviewed trusted channel; an explicit --path bible is caller-asserted trust (equivalent in power to kb_promote). Directives are quarantined to pending proposals either way.'),
  repo: z.string().optional()
    .describe('Repo root used to resolve <repo>/.fleet/kb-canonical.json when --path is omitted, and to anchor the post-import freshness sweep. Validated (must exist and be a directory) or the call fails; when omitted, falls back to the validated process working directory.'),
  scope: z.literal('project').optional()
    .describe('Only project scope is supported (imports into the project KB). Global bibles are a separate concern.'),
});

export type KbImportInput = z.infer<typeof kbImportSchema>;

// F4 (D3, KB d5193cb9): repo path resolution precedence, mirroring kb-export --
// (1) explicit repo, validated (must exist and be a directory) or refuse; (2)
// validated process working directory when repo is omitted (same check, not a
// blind default); (3) neither validates -> throw. kb_import is an explicit
// command, so it throws like kb_export rather than silently skipping.
function resolveRepoPath(explicit?: string): string {
  const candidate = explicit || process.cwd();
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
    throw new Error('kb_import: repo does not exist or is not a directory: ' + candidate);
  }
  return candidate;
}

const VALID_TYPES: readonly ContentType[] = ['context-cache', 'learning', 'knowledge', 'runbook', 'user-directive'];
const VALID_CONFIDENCE: readonly Confidence[] = ['CONFIRMED', 'INFERRED', 'UNVERIFIED'];

interface BibleEntry {
  id: string;
  type: ContentType;
  title: string;
  summary: string;
  symbols?: string[];
  source_files?: string[];
  confidence: Confidence;
  updated_at?: string;
}

// Validate a single parsed bible entry against the exported CanonicalEntry field
// set {id, type, title, summary, symbols, source_files, confidence, updated_at}
// (KB b9df569a -- NOTE: no content field). Malformed entries are tolerated and
// skipped individually rather than aborting the whole import.
function isValidBibleEntry(e: unknown): e is BibleEntry {
  if (!e || typeof e !== 'object') return false;
  const r = e as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id.length === 0) return false;
  if (typeof r.type !== 'string' || !(VALID_TYPES as readonly string[]).includes(r.type)) return false;
  if (typeof r.title !== 'string' || r.title.length === 0) return false;
  if (typeof r.summary !== 'string' || r.summary.length === 0) return false;
  if (typeof r.confidence !== 'string' || !(VALID_CONFIDENCE as readonly string[]).includes(r.confidence)) return false;
  if (r.symbols !== undefined && !Array.isArray(r.symbols)) return false;
  if (r.source_files !== undefined && !Array.isArray(r.source_files)) return false;
  return true;
}

// LOW-2: bible entries carry no content field, so synthesize content
// DETERMINISTICALLY from the summary. Determinism matters twice: (1) a re-import
// of the same bible produces byte-identical content so AUDN's content-equality
// 'none' path can dedupe an id-collision-with-identical-content case; (2) it
// keeps import a pure function of the bible file.
function synthesizeContent(entry: BibleEntry): string {
  return entry.summary;
}

export interface KbImportReport {
  imported: number;
  skipped: number;
  superseded: number;
  flagged: number;
  sweep: { checked: number; staled: number; unstaled: number };
}

export async function kbImport(input: KbImportInput): Promise<string> {
  const repoAnchor = resolveRepoPath(input.repo);
  const biblePath = input.path ?? path.join(repoAnchor, '.fleet', 'kb-canonical.json');

  // Validate the file resolves and parses to the bible array shape BEFORE
  // importing anything (reject otherwise -- non-zero exit at the CLI).
  if (!fs.existsSync(biblePath)) {
    throw new Error('kb_import: bible file not found: ' + biblePath);
  }
  const raw = fs.readFileSync(biblePath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('kb_import: bible file is not valid JSON: ' + biblePath);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('kb_import: bible file is not a JSON array of entries: ' + biblePath);
  }

  const providers = await getKbProviders();
  const provider = providers.project;

  let imported = 0;
  let skipped = 0;
  let superseded = 0;
  let flagged = 0;

  for (const candidate of parsed) {
    // Malformed entry -> tolerate and skip individually.
    if (!isValidBibleEntry(candidate)) {
      skipped++;
      continue;
    }
    const entry = candidate;

    // ORDER OF OPERATIONS (LOW-2): id-exists check FIRST, before capture()/AUDN.
    // This is what makes re-import EXACT even for symbol-less/file-less entries
    // AUDN can never dedupe.
    if (provider.hasEntry(entry.id)) {
      skipped++;
      continue;
    }

    const kbInput: KBEntryInput = {
      type: entry.type,
      title: entry.title,
      summary: entry.summary,
      content: synthesizeContent(entry),
      source_files: entry.source_files ?? [],
      symbols: entry.symbols ?? [],
      tags: [],
      content_hash: '',
      content_hash_type: 'sha256',
      flagged_for_review: false,
      // Bible entries carry no author; the trusted channel is the provenance.
      author: 'unknown',
      source: 'import',
      confidence: entry.confidence,
      scope: 'project',
    };

    // Route through the AUDN choke point with the INTERNAL import mode and the
    // preserved bible id. A user-directive is still forced through the directive
    // gate (pending proposal) INSIDE capture() -- import mode does not bypass it.
    const { audn_decision } = await provider.capture(kbInput, {
      importMode: true,
      preferredId: entry.id,
    });

    if (audn_decision === 'add') imported++;
    else if (audn_decision === 'none') skipped++;
    else if (audn_decision === 'update') superseded++;
    else if (audn_decision === 'flagged') flagged++;
  }

  // After the entry loop, run freshnessSweep() (T1.3) so imported entries whose
  // basis does not match THIS worktree stale immediately rather than serving
  // wrong-branch claims (D3).
  //
  // T3.1 (D4 fold-in, Phase 2 review MEDIUM yashr-d8b) sweep anchoring:
  // freshnessSweep() re-hashes each entry's stored basis via
  // computeFileHashBatch, which resolves RELATIVE paths against an explicit
  // root when given. A bible imported into THIS worktree carries repo-relative
  // basis paths, so the sweep anchors at the resolved repo -- previously via a
  // global process.chdir(repoAnchor)/process.chdir(prevCwd) pair straddling
  // the await (a process-wide mutation any other concurrent async work in this
  // process would also observe); now via freshnessSweep's own `root` parameter,
  // which threads the anchor straight into computeFileHashBatch's { cwd }
  // option with no global side effect at all. Behavior is unchanged (absolute
  // basis paths remain cwd-independent either way).
  const sweep = await provider.freshnessSweep(repoAnchor);

  const report: KbImportReport = { imported, skipped, superseded, flagged, sweep };
  return JSON.stringify(report);
}
