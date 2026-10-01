// kb (self) resolution: no kb_* tool declares a scope parameter.
//
// Every kb_* call operates on the calling session's own KB (a member session's
// registered work folder, otherwise the server's working folder --
// src/services/knowledge/kb-self.ts). This enumerates the tools ACTUALLY
// registered by registerAllTools() rather than a hand-kept list, so a new kb_*
// tool, or a scope field re-added to an existing one, fails here.
import { describe, it, expect } from 'vitest';
import { registerAllTools } from '../../src/services/tool-registry.js';

const SCOPE_FIELDS = ['repo', 'repo_path', 'repo_remote_url'];

async function registeredKbShapes(): Promise<Map<string, Record<string, unknown>>> {
  const shapes = new Map<string, Record<string, unknown>>();
  const fakeServer = {
    tool: (name: string, _description: string, shape: Record<string, unknown>) => {
      if (name.startsWith('kb_')) shapes.set(name, shape);
    },
    server: { sendLoggingMessage: async () => {} },
  };
  await registerAllTools(fakeServer as never);
  return shapes;
}

describe('kb_* tool input schemas declare no scope parameter', () => {
  it('enumerates every registered kb_* tool and finds no repo, repo_path or repo_remote_url', async () => {
    const shapes = await registeredKbShapes();
    expect(shapes.size).toBe(17);
    const offenders: string[] = [];
    for (const [tool, shape] of shapes) {
      for (const field of SCOPE_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(shape, field)) offenders.push(`${tool}.${field}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('kb_import keeps its explicit bible file path input', async () => {
    const shapes = await registeredKbShapes();
    expect(Object.keys(shapes.get('kb_import') ?? {})).toContain('path');
  });
});
