/**
 * Remote agent provisioning must resolve tool-conditional blocks exactly as the
 * local install does. Uses the REAL canonical agent assets (no loadAgentAssets mock).
 */
import { describe, it, expect } from 'vitest';
import type { LlmProvider } from '../src/types.js';
import { loadCanonicalAgentSet } from '../src/services/agent-provisioner.js';
import { loadAgentAssets } from '../src/cli/install.js';
import { transformAgentForClaude } from '../src/cli/agent-transform.js';

const ALL_PROVIDERS: LlmProvider[] = ['claude', 'codex', 'copilot', 'agy', 'opencode', 'none'];
const MARKER_RE = /<!--\s*(if-tool|else-tool|end-tool):/;

describe('loadCanonicalAgentSet -- tool-conditional markers', () => {
  it('source assets actually carry markers (guards against a vacuous pass)', () => {
    expect(loadAgentAssets().some(a => MARKER_RE.test(a.content))).toBe(true);
  });

  for (const provider of ALL_PROVIDERS) {
    it(`${provider}: no if-tool/else-tool/end-tool marker survives`, () => {
      const offenders = loadCanonicalAgentSet(provider)
        .filter(f => MARKER_RE.test(f.content))
        .map(f => f.relPath);
      expect(offenders).toEqual([]);
    });
  }

  // Local install writes transformAgentForClaude(raw) for every provider except
  // opencode/agy; remote normalizes CRLF -> LF first, so compare on LF input.
  for (const provider of ['claude', 'codex', 'copilot'] as LlmProvider[]) {
    it(`${provider}: remote output equals the local install output byte-for-byte`, () => {
      const local = new Map(
        loadAgentAssets().map(a => [
          a.relPath,
          transformAgentForClaude(a.content.replace(/\r\n/g, '\n'), a.relPath),
        ])
      );
      for (const f of loadCanonicalAgentSet(provider)) {
        expect(f.content, f.relPath).toBe(local.get(f.relPath));
      }
    });
  }

  // kb-reconciler.md is the role prompt that still carries the ToolSearch
  // if-tool/else-tool branches (the other roles use the kb_* tools directly).
  it('claude: kb-reconciler.md keeps the ToolSearch branch and drops the else branch', () => {
    const src = loadAgentAssets().find(a => a.relPath === 'kb-reconciler.md');
    expect(src?.content, 'premise: the source carries both branches').toMatch(/<!-- else-tool: ToolSearch -->/);
    const rec = loadCanonicalAgentSet('claude').find(f => f.relPath === 'kb-reconciler.md');
    expect(rec).toBeDefined();
    expect(rec!.content).toContain('Run ToolSearch with query');
    expect(rec!.content).not.toContain('No tool-discovery step is needed on this provider');
  });
});
