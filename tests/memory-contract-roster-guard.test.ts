// my-beads-db-27m.39: EXPECTED_TOOL_COUNT in generate-contract.mjs only fires
// when a dist/tools export DISAPPEARS -- a NEW kb_*/code_* tool registered in
// src/services/tool-registry.ts is silently absent from the generator roster,
// emits no schema pair, and produces no diff for a regenerate-and-diff drift
// guard (my-beads-db-27m.10) to catch, because there is nothing on disk to
// diff against.
//
// This test closes that gap with a THREE-WAY set-equality check, with no
// hand-copied fourth list:
//   1. registered tool names, enumerated from the REAL registerAllTools()
//      (the same fake-McpServer technique already proven in
//      tests/code-intelligence-registry-wiring.test.ts), filtered to the
//      kb_*/code_* prefixes this contract covers;
//   2. the generator roster, imported directly from
//      memory-contract/v1/generate-contract.mjs's exported KB_MODULES/
//      CODE_EXPORTS -- the actual data the generator runs on, not a copy;
//   3. the emitted schemas/ file pairs on disk.
//
// Lives under the repo's top-level tests/ (not memory-contract/v1/tests/)
// because vitest.config.ts only discovers tests/**/*.test.ts and
// packages/*/tests/**/*.test.ts -- already the established reason for every
// other memory-contract test at this path.
import { readdirSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

import { registerAllTools } from '../src/services/tool-registry.js';
import { KB_MODULES, CODE_EXPORTS, SCHEMAS_DIR } from '../memory-contract/v1/generate-contract.mjs';

type ToolHandler = (input: unknown, extra?: unknown) => Promise<unknown>;

/**
 * Minimal stand-in for McpServer -- records every tool name registerAllTools()
 * actually calls server.tool() with. No handler is ever invoked, so this is
 * safe to run with no other mocking (same technique as
 * tests/code-intelligence-registry-wiring.test.ts).
 */
async function registeredToolNames(): Promise<Set<string>> {
  const names = new Set<string>();
  const fakeServer = {
    tool: (name: string, _description: string, _schema: Record<string, unknown>, _handler: ToolHandler) => {
      names.add(name);
    },
    server: { sendLoggingMessage: async () => {} },
  };
  await registerAllTools(fakeServer as never);
  return names;
}

function kbAndCodeToolNames(allNames: Set<string>): Set<string> {
  return new Set([...allNames].filter((n) => n.startsWith('kb_') || n.startsWith('code_')));
}

function generatorRosterNames(): Set<string> {
  return new Set([...KB_MODULES.map(([tool]) => tool), ...CODE_EXPORTS.map(([tool]) => tool)]);
}

function emittedSchemaToolNames(): Set<string> {
  const files = readdirSync(SCHEMAS_DIR).filter((f) => f.endsWith('.json'));
  const requestFiles = files.filter((f) => f.endsWith('.request.json'));
  const responseFiles = files.filter((f) => f.endsWith('.response.json'));
  const requestTools = new Set(requestFiles.map((f) => f.slice(0, -'.request.json'.length)));
  const responseTools = new Set(responseFiles.map((f) => f.slice(0, -'.response.json'.length)));
  // Every tool must have BOTH files, not just one -- assert that here rather
  // than silently unioning, so a tool missing its response (or request) half
  // fails loudly instead of appearing complete.
  expect([...requestTools].sort()).toEqual([...responseTools].sort());
  return requestTools;
}

describe('generator roster matches the registered kb_*/code_* tool surface (my-beads-db-27m.39)', () => {
  it('registered kb_*/code_* tools == generator roster (KB_MODULES + CODE_EXPORTS)', async () => {
    const registered = kbAndCodeToolNames(await registeredToolNames());
    const roster = generatorRosterNames();

    expect([...registered].sort()).toEqual([...roster].sort());
  });

  it('registered kb_*/code_* tools == emitted schemas/ request+response pairs', async () => {
    const registered = kbAndCodeToolNames(await registeredToolNames());
    const emitted = emittedSchemaToolNames();

    expect([...registered].sort()).toEqual([...emitted].sort());
  });

  it('generator roster == emitted schemas/ request+response pairs', () => {
    const roster = generatorRosterNames();
    const emitted = emittedSchemaToolNames();

    expect([...roster].sort()).toEqual([...emitted].sort());
  });

  it('baseline: 16 kb_* + 7 code_* = 23 registered tools, 46 emitted schema documents', async () => {
    const registered = kbAndCodeToolNames(await registeredToolNames());
    const kbCount = [...registered].filter((n) => n.startsWith('kb_')).length;
    const codeCount = [...registered].filter((n) => n.startsWith('code_')).length;

    // Asserted against the REAL enumeration above, not hardcoded independent
    // of it -- if the real count ever differs, this whole test file already
    // fails on the set-equality assertions above before this baseline check
    // is even reached for a wrong reason; this check exists to name the
    // number INVENTORY.md section 1 arbitrates, not to gate on it blindly.
    expect(kbCount).toBe(16);
    expect(codeCount).toBe(7);
    expect(registered.size).toBe(23);

    const emittedFiles = readdirSync(SCHEMAS_DIR).filter((f) => f.endsWith('.json'));
    expect(emittedFiles.length).toBe(46);
  });
});
