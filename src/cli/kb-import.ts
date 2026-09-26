// T2.2 (F4, D3): `apra-fleet kb import [--repo <path>] [--path <file>]` -- the
// post-merge, human-facing entry point for absorbing a merged bible into the
// warm local KB. Thin wrapper over the SAME kbImport implementation the MCP
// tool uses (no logic duplication): it parses argv, calls kbImport, prints the
// {imported, skipped, linked, flagged} + sweep report in plain ASCII, and
// exits non-zero on a resolution failure (missing bible / invalid repo).
//
// TRUST BOUNDARY (LOW-1): importing the repo-resolved .fleet/kb-canonical.json
// is the git-reviewed trusted channel; an explicit --path bible is
// caller-asserted trust (equivalent in power to kb_promote). Directives are
// quarantined to pending proposals either way.

import type { KbImportReport } from '../tools/kb-import.js';

export interface KbImportArgs {
  repo?: string;
  path?: string;
}

// Minimal argv parsing, mirroring parseKbCommitArgs: no external dependency,
// tolerant of flags in any order.
export function parseKbImportArgs(args: string[]): KbImportArgs {
  let repo: string | undefined;
  let filePath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo' && i + 1 < args.length) {
      repo = args[i + 1];
      i++;
    } else if (args[i] === '--path' && i + 1 < args.length) {
      filePath = args[i + 1];
      i++;
    }
  }
  return { repo, path: filePath };
}

// Structural type for the injected import function -- kept narrow (input in,
// JSON string out) so tests can pass either the real kbImport or a stub without
// importing the full tool module graph.
export type KbImportFn = (input: { repo?: string; path?: string }) => Promise<string>;

export const KB_IMPORT_USAGE =
  'Usage: apra-fleet kb import [--repo <path>] [--path <file>]\n' +
  '  Absorb a merged knowledge bible into the local KB.\n' +
  '  --repo <path>  repo root; resolves <repo>/.fleet/kb-canonical.json when --path is omitted.\n' +
  '  --path <file>  explicit bible file. TRUST: the repo-resolved bible is the git-reviewed\n' +
  '                 trusted channel; an explicit --path bible is caller-asserted trust\n' +
  '                 (equivalent in power to kb_promote). Directives stay quarantined either way.';

export async function kbImportCmd(importFn: KbImportFn, args: string[]): Promise<number> {
  const { repo, path: filePath } = parseKbImportArgs(args);
  try {
    const raw = await importFn({ repo, path: filePath });
    const r = JSON.parse(raw) as KbImportReport;
    console.log(
      'Imported ' + r.imported + ', skipped ' + r.skipped +
      ', linked ' + r.linked + ', flagged ' + r.flagged + '.'
    );
    console.log(
      'Freshness sweep: checked ' + r.sweep.checked +
      ', staled ' + r.sweep.staled + ', unstaled ' + r.sweep.unstaled + '.'
    );
    return 0;
  } catch (err) {
    console.error('Error: ' + (err instanceof Error ? err.message : String(err)));
    return 1;
  }
}

// -- top-level dispatch (resolves the real kb_import tool) --

export async function runKbImport(args: string[]): Promise<number> {
  const { kbImport } = await import('../tools/kb-import.js');
  return kbImportCmd(kbImport, args);
}
