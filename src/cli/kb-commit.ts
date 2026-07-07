// T3.7b (PM-added, closes yashr-8wy + Phase 2 LOW-1 dangling reference
// f68e41ae): `apra-fleet kb commit [--repo <path>] [--global]`.
//
// kb_export (T2.3/F6a) already auto-commits the canonical bible whenever its
// content changed, so a human never NEEDS to run this manually in the normal
// flow. But the amended-D5 fleet_status bible-drift anomaly message
// (src/tools/check-status.ts) tells the operator to "run apra-fleet kb
// commit" when drift is nonzero (auto-commit may have failed, or the KB was
// updated outside the normal promote-then-export flow) -- until this task,
// that command did not exist (kb-directives.ts only implements
// directives/approve-directive/reject-directive/add-directive). This IS that
// manual/recovery path: a thin wrapper that just re-runs kbExport (which
// already owns every commit/no-commit decision -- content-gated, pathspec-
// only, non-fatal on git failure) against the resolved repo and scope, then
// prints the export + commit result. No new git logic lives here.

export interface KbCommitArgs {
  repo?: string;
  global: boolean;
}

// Minimal argv parsing, mirroring parseSymbols in kb-directives.ts: no
// external arg-parsing dependency, tolerant of flags in any order.
export function parseKbCommitArgs(args: string[]): KbCommitArgs {
  let repo: string | undefined;
  let global = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo' && i + 1 < args.length) {
      repo = args[i + 1];
      i++;
    } else if (args[i] === '--global') {
      global = true;
    }
  }
  return { repo, global };
}

// Structural type for the injected export function -- kept narrow (input in,
// JSON string out) so tests can pass either the real kbExport or a stub
// without importing the full tool module graph.
export type KbExportFn = (input: { repo_path?: string; scope?: 'project' | 'global' }) => Promise<string>;

export async function kbCommitCmd(exportFn: KbExportFn, args: string[]): Promise<number> {
  const { repo, global } = parseKbCommitArgs(args);
  try {
    const raw = await exportFn({ repo_path: repo, scope: global ? 'global' : 'project' });
    const result = JSON.parse(raw) as { exported: number; path: string; scope: string; committed: boolean };
    console.log('Exported ' + result.exported + ' entries to ' + result.path + ' (scope=' + result.scope + ').');
    console.log(
      result.committed
        ? 'Committed (pm-kb identity).'
        : 'Not committed (no change, auto-commit disabled, or not a git repo).'
    );
    return 0;
  } catch (err) {
    console.error('Error: ' + (err instanceof Error ? err.message : String(err)));
    return 1;
  }
}

// -- top-level dispatch (resolves the real kb_export tool) --

export async function runKbCommit(args: string[]): Promise<number> {
  const { kbExport } = await import('../tools/kb-export.js');
  return kbCommitCmd(kbExport, args);
}
