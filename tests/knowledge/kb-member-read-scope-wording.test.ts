// Pins the MEMBER read-scope wording of the four KB read tools so it cannot
// silently drift back to "an explicit INFERRED/UNVERIFIED read ... returns
// only entries tagged member:<caller uuid>" (which omitted the checkout bible
// for a mixed request). Checks both the registered description (the real
// text passed to server.tool()) and the generated memory-contract binding.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';

import { registerAllTools } from '../../src/services/tool-registry.js';
import { BINDINGS_MCP_DIR } from '../../memory-contract/v1/generate-contract.mjs';

const TOOLS = ['kb_query', 'kb_list', 'kb_context', 'kb_session_prime'] as const;

const registered = new Map<string, string>();

beforeAll(async () => {
  const fakeServer = {
    tool: (name: string, description: string) => {
      registered.set(name, description);
    },
    server: { sendLoggingMessage: async () => {} },
  };
  await registerAllTools(fakeServer as never);
});

function bindingDescription(tool: string): string {
  const raw = readFileSync(path.join(BINDINGS_MCP_DIR, `${tool}.json`), 'utf-8');
  return (JSON.parse(raw) as { description: string }).description;
}

const sources: Array<[string, (tool: string) => string]> = [
  ['registered description', (t) => registered.get(t) ?? ''],
  ['memory-contract binding', bindingDescription],
];

describe.each(sources)('MEMBER read-scope wording in the %s', (_label, describe_) => {
  it.each(TOOLS)('%s states the bible/own-captures split, merged for a mixed request', (tool) => {
    const d = describe_(tool);
    expect(d).toContain('MEMBER session');
    expect(d).toContain('CONFIRMED is read from the member checkout bible');
    expect(d).toContain("INFERRED/UNVERIFIED only from the member's own captures");
    expect(d).toContain('member:<caller uuid>');
    expect(d).toContain('merged for a mixed request');
  });

  it.each(TOOLS)('%s no longer carries the old per-repo-DB-only member-scope sentence', (tool) => {
    const d = describe_(tool);
    expect(d).not.toMatch(/an explicit INFERRED\/UNVERIFIED (read|list) comes from the per-repo DB/);
    expect(d).not.toContain('returns only entries tagged member:<caller uuid>');
    expect(d).not.toContain('own-tagged entries only');
  });
});
