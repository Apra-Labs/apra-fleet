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
  ref?: string;
  baseBranch?: string;
}

// Minimal argv parsing, mirroring parseKbCommitArgs: no external dependency,
// tolerant of flags in any order.
export function parseKbImportArgs(args: string[]): KbImportArgs {
  let repo: string | undefined;
  let filePath: string | undefined;
  let ref: string | undefined;
  let baseBranch: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo' && i + 1 < args.length) {
      repo = args[i + 1];
      i++;
    } else if (args[i] === '--path' && i + 1 < args.length) {
      filePath = args[i + 1];
      i++;
    } else if (args[i] === '--ref' && i + 1 < args.length) {
      ref = args[i + 1];
      i++;
    } else if (args[i] === '--base-branch' && i + 1 < args.length) {
      baseBranch = args[i + 1];
      i++;
    }
  }
  return { repo, path: filePath, ref, baseBranch };
}

// Structural type for the injected import function -- kept narrow (input in,
// JSON string out) so tests can pass either the real kbImport or a stub without
// importing the full tool module graph.
// The second argument is the explicit KB anchor (--repo); omitted, kbImport
// resolves the caller's own folder (this process's working directory).
export type KbImportFn = (input: { path?: string; ref?: string; base_branch?: string }, anchor?: { folder: string }) => Promise<string>;

export const KB_IMPORT_USAGE =
  'Usage: apra-fleet kb import [--repo <path>] [--path <file>] [--ref <ref>] [--base-branch <branch>]\n' +
  '  Absorb a merged knowledge bible into the local KB.\n' +
  '  --repo <path>  repo root; resolves <repo>/.fleet/kb-canonical.json when --path is omitted.\n' +
  '  --path <file>  explicit bible file. TRUST: the repo-resolved bible is the git-reviewed\n' +
  '                 trusted channel; an explicit --path bible is caller-asserted trust\n' +
  '                 (equivalent in power to kb_promote). Directives stay quarantined either way.\n' +
  '  --ref <ref>    read the bible as committed at this git ref (e.g. refs/remotes/origin/main).\n' +
  '  --base-branch <branch>\n' +
  '                 the base branch the merged bible belongs to (e.g. main). Withdrawn tombstones\n' +
  '                 are applied only when --ref is refs/remotes/<remote>/<branch> and the bible\n' +
  '                 provenance.branch equals that branch; without --base-branch the base is\n' +
  '                 refs/remotes/<remote>/HEAD, and when that is unset withdrawals are deferred.\n' +
  '                 Example: apra-fleet kb import --ref refs/remotes/origin/main --base-branch main';

export async function kbImportCmd(importFn: KbImportFn, args: string[]): Promise<number> {
  const { repo, path: filePath, ref, baseBranch } = parseKbImportArgs(args);
  try {
    const input: { path?: string; ref?: string; base_branch?: string } = { path: filePath };
    if (ref !== undefined) input.ref = ref;
    if (baseBranch !== undefined) input.base_branch = baseBranch;
    if (ref !== undefined || baseBranch !== undefined) {
      // Validation is the tool's own schema, never a copy of its rules.
      const { kbImportSchema } = await import('../tools/kb-import.js');
      const checked = kbImportSchema.pick({ ref: true, base_branch: true }).safeParse({ ref, base_branch: baseBranch });
      if (!checked.success) {
        const why = checked.error.issues
          .map(i => (i.path.length ? (i.path[0] === 'base_branch' ? '--base-branch' : '--ref') : 'input') + ': ' + i.message)
          .join('; ');
        throw new Error('invalid argument (' + why + ')');
      }
    }
    const raw = await importFn(input, repo ? { folder: repo } : undefined);
    const r = JSON.parse(raw) as KbImportReport;
    console.log(
      'Imported ' + r.imported + ', skipped ' + r.skipped +
      ', linked ' + r.linked + ', flagged ' + r.flagged + '.'
    );
    console.log(
      'Freshness sweep: checked ' + r.sweep.checked +
      ', staled ' + r.sweep.staled + ', unstaled ' + r.sweep.unstaled + '.'
    );
    const w = r.withdrawals;
    if (w) {
      if (w.sent > 0 || w.withdrawn.length > 0 || w.repromoted.length > 0 || w.already.length > 0) {
        console.log(
          'Withdrawals: withdrawn ' + w.withdrawn.length + ', repromoted ' + w.repromoted.length +
          ', already ' + w.already.length + ', not found ' + w.not_found.length + '.'
        );
      }
      if (w.deferred.length > 0) {
        console.log('Withdrawals deferred (' + w.deferred.length + '): ' + w.deferred.join(', '));
      }
      if (w.warning) console.log('Warning: ' + w.warning);
    }
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
