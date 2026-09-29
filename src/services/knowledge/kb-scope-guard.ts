// Server-side repo-scope guard for kb_* MCP tools.
//
// The fleet server is ONE long-lived process serving every project a user
// works on, launched from an arbitrary directory (a detached launch sits in
// C:\Windows\System32). A kb_* call that names no repo used to fall back to
// the server's process.cwd() to pick a project KB -- silently reading or
// writing an unrelated project's KB (or the empty `default` scope). This guard
// refuses such calls instead of guessing.
//
// It is applied ONLY where kb_* tools are registered on the MCP server
// (src/services/tool-registry.ts), which is the single entry point for
// server-handled kb_* calls. CLI entry points (`apra-fleet kb invalidate` from
// the post-commit hook, `kb commit`, `kb import`, `kb-server`, the directive
// commands) call the tool functions / getKbProviders directly, run in the
// user's own shell, and keep resolving the repo from their cwd.
//
// kb_setup is deliberately NOT guarded: its repo_path only locates a .git dir
// for hook installation and carries no project-KB scope (memory-contract/v1
// spec.md section 4.1).

export const KB_SCOPE_REQUIRED_REASON = 'repo_scope_required';
export const KB_SCOPE_REQUIRED_CODE = 'E-REPO-SCOPE-REQUIRED';

// Tools whose own implementation resolves a LOCAL filesystem repo path (bible
// read/write, drift, cold-seed). repo_remote_url alone cannot tell them which
// directory to use, so they need repo_path (or its `repo` alias).
//
// Exported so every copy of this set (tests/knowledge/kb-scope-guard.test.ts,
// packages/apra-fleet-se/test/runner-kb-priming.test.mjs) can assert against
// this one source of truth instead of drifting literals -- see apra-fleet-b4g.39.
export const NEEDS_LOCAL_REPO_PATH: ReadonlySet<string> = new Set([
  'kb_export',
  'kb_import',
  'kb_stats',
  'kb_session_prime',
]);

export interface KbScopeRefusal {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: { isError: true; reason: string; code: string; tool: string };
  isError: true;
}

function present(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Return a structured MCP error result when a server-handled kb_* call names
 * no repo scope, or null when the call may proceed. Pure: never touches the
 * filesystem or a KB database.
 */
export function kbScopeRefusal(toolName: string, input: unknown): KbScopeRefusal | null {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const hasPath = present(i.repo_path) || present(i.repo);
  if (hasPath) return null;
  const acceptsRemote = !NEEDS_LOCAL_REPO_PATH.has(toolName);
  if (acceptsRemote && present(i.repo_remote_url)) return null;

  const how = acceptsRemote
    ? 'pass repo_path (the root of the repo this call is about), or repo_remote_url (its origin URL) when the repo lives on a remote member'
    : 'pass repo_path (the root of the local repo checkout this call is about)';
  const text = `${toolName}: repo scope required -- ${how}. The fleet server serves every project and never guesses one from its own working directory.`;
  return {
    content: [{ type: 'text', text }],
    structuredContent: { isError: true, reason: KB_SCOPE_REQUIRED_REASON, code: KB_SCOPE_REQUIRED_CODE, tool: toolName },
    isError: true,
  };
}
