// kb (self) resolution: the pre-redesign scope keys are REMOVED, and a caller
// still passing one is refused with a typed error -- never silently re-scoped.
//
// Every kb_* call operates on the calling session's own KB (a member session's
// registered work folder, otherwise the server's working folder --
// src/services/knowledge/kb-self.ts). repo_path, repo and repo_remote_url are
// still DECLARED on every kb_* schema (KB_REMOVED_SCOPE_KEYS_SHAPE) only so the
// MCP layer does not strip them before the wrapper can refuse them with
// E-SCOPE-KEY-REMOVED. This enumerates the tools ACTUALLY registered by
// registerAllTools() rather than a hand-kept list, so a new kb_* tool that
// forgets the removed-key markers, or a scope key that becomes live again,
// fails here.
import { describe, it, expect } from 'vitest';
import { registerAllTools } from '../../src/services/tool-registry.js';
import {
  KB_REMOVED_SCOPE_KEYS, KB_REMOVED_SCOPE_KEYS_SHAPE, KB_REMOVED_SCOPE_KEY_REPLACEMENTS,
} from '../../src/services/knowledge/kb-removed-scope-keys.js';

type Handler = (input: unknown, extra?: unknown) => Promise<unknown>;

async function registeredKbTools(): Promise<Map<string, { shape: Record<string, unknown>; handler: Handler }>> {
  const tools = new Map<string, { shape: Record<string, unknown>; handler: Handler }>();
  const fakeServer = {
    tool: (name: string, _description: string, shape: Record<string, unknown>, handler: Handler) => {
      if (name.startsWith('kb_')) tools.set(name, { shape, handler });
    },
    server: { sendLoggingMessage: async () => {} },
  };
  await registerAllTools(fakeServer as never);
  return tools;
}

// Tool families: every kb_* tool belongs to exactly one, and every family is
// exercised with every removed key.
const FAMILIES: Record<string, string[]> = {
  read: ['kb_query', 'kb_list', 'kb_context', 'kb_session_prime', 'kb_stats'],
  write: ['kb_capture', 'kb_feedback', 'kb_promote', 'kb_invalidate', 'kb_harvest'],
  bible: ['kb_export', 'kb_import', 'kb_bible_commit'],
  maintenance: ['kb_freshness_sweep', 'kb_reconcile_prefilter', 'kb_resolve_contradiction', 'kb_setup'],
};

describe('kb_* tool input schemas carry the removed scope keys only as refusal markers', () => {
  it('the families partition exactly the registered kb_* tools', async () => {
    const tools = await registeredKbTools();
    expect(tools.size).toBe(17);
    expect(Object.values(FAMILIES).flat().sort()).toEqual([...tools.keys()].sort());
  });

  it('every kb_* tool declares repo, repo_path and repo_remote_url as the shared REMOVED markers, nothing else', async () => {
    const tools = await registeredKbTools();
    const offenders: string[] = [];
    for (const [tool, { shape }] of tools) {
      for (const key of KB_REMOVED_SCOPE_KEYS) {
        if (shape[key] !== KB_REMOVED_SCOPE_KEYS_SHAPE[key]) offenders.push(`${tool}.${key}`);
      }
    }
    expect(offenders).toEqual([]);
    for (const key of KB_REMOVED_SCOPE_KEYS) {
      expect((KB_REMOVED_SCOPE_KEYS_SHAPE[key] as { description?: string }).description).toMatch(/^REMOVED -- .*E-SCOPE-KEY-REMOVED/);
    }
  });

  it('kb_import keeps its explicit bible file path input', async () => {
    const tools = await registeredKbTools();
    expect(Object.keys(tools.get('kb_import')?.shape ?? {})).toContain('path');
  });
});

for (const [family, members] of Object.entries(FAMILIES)) {
  describe(`${family} family: a removed scope key fails with E-SCOPE-KEY-REMOVED naming it and its replacement`, () => {
    it.each(members.flatMap(tool => KB_REMOVED_SCOPE_KEYS.map(key => [tool, key] as const)))(
      '%s with %s',
      async (tool, key) => {
        const tools = await registeredKbTools();
        const { handler } = tools.get(tool)!;
        const err = await handler({ [key]: '/some/other/repo' }).then(() => null, (e: unknown) => e as Error);
        expect(err, `${tool} accepted ${key}`).toBeInstanceOf(Error);
        expect((err as Error & { code?: string }).code).toBe('E-SCOPE-KEY-REMOVED');
        expect(err!.message).toMatch(/^E-SCOPE-KEY-REMOVED: /);
        expect(err!.message).toContain(`${tool} no longer accepts '${key}'`);
        expect(err!.message).toContain(`Remediation: ${key}: ${KB_REMOVED_SCOPE_KEY_REPLACEMENTS[key]}`);
      },
    );
  });
}

describe('removed scope keys: edge cases', () => {
  it('names every removed key present in one call', async () => {
    const { handler } = (await registeredKbTools()).get('kb_query')!;
    const err = await handler({ query: 'x', repo_path: '/a', repo_remote_url: 'https://example.test/a.git' })
      .then(() => null, (e: unknown) => e as Error);
    expect(err!.message).toContain("kb_query no longer accepts 'repo_path', 'repo_remote_url'");
  });

  it('refuses even an empty-string value (the caller meant to scope the call)', async () => {
    const { handler } = (await registeredKbTools()).get('kb_list')!;
    const err = await handler({ repo: '' }).then(() => null, (e: unknown) => e as Error);
    expect((err as Error & { code?: string }).code).toBe('E-SCOPE-KEY-REMOVED');
  });
});
