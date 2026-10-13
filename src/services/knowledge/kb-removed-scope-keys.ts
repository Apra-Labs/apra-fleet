// Removed kb_* scope keys: repo_path, repo, repo_remote_url.
//
// Before the KB redesign every kb_* tool took repo_path and repo_remote_url
// (kb_stats and kb_import also took repo) to say which repository's KB a call
// was about. The redesign removed them: a kb_* call now always acts on the
// CALLING SESSION's own KB (kb-self.ts). An MCP server built from a zod raw
// shape strips undeclared keys before the handler runs, so an existing caller
// still passing one would have been silently re-pointed at a different KB.
//
// So the keys stay DECLARED on every kb_* input schema (KB_REMOVED_SCOPE_KEYS_
// SHAPE, described as removed) purely so they reach the tool wrapper, and the
// wrapper refuses any call carrying one (assertNoRemovedKbScopeKeys) with a
// typed E-SCOPE-KEY-REMOVED error naming the key and what replaces it. The
// call is refused before any KB is resolved or opened, so nothing changes.

import { z } from 'zod';

export type KbRemovedScopeKey = 'repo_path' | 'repo' | 'repo_remote_url';

/** What replaces each removed key, phrased as the caller's fix. */
export const KB_REMOVED_SCOPE_KEY_REPLACEMENTS: Readonly<Record<KbRemovedScopeKey, string>> = Object.freeze({
  repo_path:
    "nothing -- drop it: every kb_* call acts on the calling session's own KB (a member session's registered work folder; a FULL session's fleet server working folder). To act on another repository, call from a member session registered on that folder.",
  repo:
    "nothing -- drop it: same as repo_path, the KB (and kb_stats' bible drift check) is the calling session's own repository. kb_import names a bible file with path, which is unchanged.",
  repo_remote_url:
    "nothing -- drop it: a remote member's KB identity is its registered origin remote (record it with update_member git_repos) and is resolved from the calling member session.",
});

export const KB_REMOVED_SCOPE_KEYS = Object.keys(KB_REMOVED_SCOPE_KEY_REPLACEMENTS) as KbRemovedScopeKey[];

const removedDescription = 'REMOVED -- do not pass. A call carrying it fails with E-SCOPE-KEY-REMOVED; the KB is always the calling session\'s own.';

/**
 * Spread into every kb_* input schema (last, after the tool's own keys) so a
 * removed key reaches the wrapper instead of being stripped by the MCP layer.
 * Typed `unknown` on purpose: any value, even a well-formed path, is refused.
 */
export const KB_REMOVED_SCOPE_KEYS_SHAPE = {
  repo_path: z.unknown().optional().describe(removedDescription),
  repo: z.unknown().optional().describe(removedDescription),
  repo_remote_url: z.unknown().optional().describe(removedDescription),
};

export class KbScopeKeyRemovedError extends Error {
  readonly code = 'E-SCOPE-KEY-REMOVED' as const;
  readonly keys: KbRemovedScopeKey[];
  constructor(tool: string, keys: KbRemovedScopeKey[]) {
    const named = keys.map(k => `'${k}'`).join(', ');
    const fixes = keys.map(k => `${k}: ${KB_REMOVED_SCOPE_KEY_REPLACEMENTS[k]}`).join(' ');
    super(
      `E-SCOPE-KEY-REMOVED: ${tool} no longer accepts ${named} (removed in the KB redesign); the call was not run and no KB was changed. ` +
        `Remediation: ${fixes}`,
    );
    this.name = 'KbScopeKeyRemovedError';
    this.keys = keys;
  }
}

/**
 * Refuse a kb_* call that carries any removed scope key. A key that is present
 * with value undefined is treated as absent (some clients serialise optional
 * fields that way); any other value -- including null or '' -- is refused,
 * because the caller evidently meant to scope the call.
 */
export function assertNoRemovedKbScopeKeys(tool: string, input: unknown): void {
  if (!input || typeof input !== 'object') return;
  const present = KB_REMOVED_SCOPE_KEYS.filter(k => (input as Record<string, unknown>)[k] !== undefined);
  if (present.length > 0) throw new KbScopeKeyRemovedError(tool, present);
}
