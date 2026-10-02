import { z } from 'zod';
import { KB_REMOVED_SCOPE_KEYS_SHAPE } from '../services/knowledge/kb-removed-scope-keys.js';
import fs from 'node:fs';
import path from 'node:path';
import { getKbProviders } from '../services/knowledge/kb-providers.js';
import { resolveKbAnchor, type KbAnchor } from '../services/knowledge/kb-self.js';
import { readBibleEntries, importBibleEntries } from '../services/knowledge/bible-import.js';
import { requireSqliteProject } from '../services/knowledge/require-sqlite-project.js';

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
    .describe('Explicit path to a bible JSON file (e.g. <worktree>/.fleet/kb-canonical.json). This is a file path, not a scope selector: the KB written is always the calling session\'s own (a member session -> its work folder; otherwise the server folder). When omitted, resolves to <own folder>/.fleet/kb-canonical.json. TRUST NOTE: importing the repo-resolved .fleet/kb-canonical.json is the git-reviewed trusted channel; an explicit --path bible is caller-asserted trust (equivalent in power to kb_promote). Directives are quarantined to pending proposals either way.'),
  scope: z.literal('project').optional()
    .describe('Only project scope is supported (imports into the project KB). Global bibles are a separate concern.'),
  // KB audit 2026-08-12, found by a LIVE sprint rather than by review. The
  // sprint engine imports the bible per member at sprint start; the sweep that
  // follows re-judged the WHOLE KB against that worktree and staled 16 of 17
  // CONFIRMED entries, purely because the repo had moved on since capture.
  // Three observed consequences in one run: retrieval degraded to a single
  // matchable entry, kb_export tried to write 9 over a 17-entry bible, and
  // kb_list (which filters stale=0) handed the reviewer an EMPTY promotion
  // candidate list -- reintroducing apra-fleet-0ef, "kb_promote can never
  // fire", by a side door. Opt-out, defaulting to today's behaviour.
  skip_sweep: z.boolean().optional()
    .describe('Skip the post-import freshness sweep. The sweep re-judges EVERY entry in the KB against this worktree, which is right for a deliberate audit but wrong for a routine import: an import performed to warm the KB should not mass-stale it because unrelated files have changed since capture. prime() still runs its own bounded freshness check on the entries it actually returns, so skipping this does not surface stale claims. Default false (sweep runs, unchanged).'),
  // Removed pre-redesign scope keys: declared only so a caller still passing one
  // is refused with E-SCOPE-KEY-REMOVED instead of silently re-scoped.
  ...KB_REMOVED_SCOPE_KEYS_SHAPE,
});

export type KbImportInput = z.infer<typeof kbImportSchema>;

// The KB anchor is the calling session's own folder (kb-self.ts). kb_import
// reads the bible and sweeps against that folder on THIS host, so an anchor
// naming a folder on another host refuses rather than silently skipping.
function requireLocalFolder(folder: string): string {
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    throw new Error('kb_import: repo folder does not exist or is not a directory on this host: ' + folder);
  }
  return folder;
}

export interface KbImportReport {
  imported: number;
  skipped: number;
  linked: number;
  flagged: number;
  /**
   * Bible entries refused by the Phase 1 capture basis check -- no source_files,
   * or source_files absent from this worktree. Import is NOT exempt: an
   * unfalsifiable entry must not enter through any path, including a legacy
   * bible, so re-importing an old bible deliberately drops those entries.
   */
  rejected: number;
  sweep: { checked: number; staled: number; unstaled: number };
}

export async function kbImport(input: KbImportInput, anchor?: KbAnchor): Promise<string> {
  const resolved = resolveKbAnchor(anchor);
  const repoAnchor = requireLocalFolder(resolved.folder);
  const biblePath = input.path ?? path.join(repoAnchor, '.fleet', 'kb-canonical.json');

  // Validate the file resolves and parses to the bible array shape BEFORE
  // importing anything (reject otherwise -- non-zero exit at the CLI).
  if (!fs.existsSync(biblePath)) {
    throw new Error('kb_import: bible file not found: ' + biblePath);
  }
  // Parsing (both on-disk shapes) is shared with the member bible view
  // (services/knowledge/bible-import.ts); a malformed file throws KbBibleError.
  const bibleEntries = readBibleEntries(biblePath, 'kb_import');

  // repoAnchor (resolved above) selects the KB, so an import 'for' repo B can
  // never land in whichever repo the server process happens to sit in.
  const providers = await getKbProviders(repoAnchor, resolved.remoteUrl);
  const provider = requireSqliteProject(providers.project, 'kb_import');

  // Same entry loop the member bible view uses: import mode (bible confidence
  // preserved, directives quarantined), id-exists skip first, per-entry
  // isolation of capture basis rejections.
  const { imported, skipped, linked, flagged, rejected } = await importBibleEntries(provider, bibleEntries);

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
  // skip_sweep (audit 2026-08-12): report the same shape with zeroes rather
  // than omitting the field, so every existing caller reading report.sweep
  // keeps working.
  const sweep = input.skip_sweep
    ? { checked: 0, staled: 0, unstaled: 0 }
    : await provider.freshnessSweep(repoAnchor);

  const report: KbImportReport = { imported, skipped, linked, flagged, rejected, sweep };
  return JSON.stringify(report);
}
