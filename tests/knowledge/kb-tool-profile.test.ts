import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FLEET_DIR } from '../../src/paths.js';
import { readKbToolProfileFromDisk } from '../../src/services/knowledge/kb-config.js';
import {
  DEVELOPER_KB_TOOLS,
  kbToolAllowedByProfile,
  makeKbToolProfile,
  registeredKbToolNames,
} from '../../src/services/kb-tool-profile.js';
import { registerAllTools } from '../../src/services/tool-registry.js';
import { memberToolScope } from '../../src/services/tool-scope.js';
import {
  REGISTERED_TOOL_NAMES,
  MEMBER_ALLOWED_TOOLS,
  MEMBER_MAINTAINER_TOOLS,
} from '../../src/services/member-tool-allowlist.js';

// Unit coverage for the KB tool profile (GitHub #759): the reader, the
// validator, and the FULL-session filter in registerAllTools, driven through
// the real registry with a recording fake server. The end-to-end MCP-client
// view lives in tests/kb-tool-profile-e2e.test.ts.

const KB_CONFIG_DIR = path.join(FLEET_DIR, 'knowledge');
const KB_CONFIG_PATH = path.join(KB_CONFIG_DIR, 'config.json');

function writeConfig(config: Record<string, unknown>): void {
  fs.mkdirSync(KB_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(KB_CONFIG_PATH, JSON.stringify(config, null, 2));
}

async function registeredNames(scope?: Parameters<typeof registerAllTools>[1]): Promise<string[]> {
  const names: string[] = [];
  const fakeServer = {
    tool: (name: string) => { names.push(name); },
    registerTool: (name: string) => { names.push(name); },
  };
  await registerAllTools(fakeServer as never, scope);
  return names;
}

let saved: string | null = null;
beforeEach(() => {
  saved = fs.existsSync(KB_CONFIG_PATH) ? fs.readFileSync(KB_CONFIG_PATH, 'utf-8') : null;
  fs.rmSync(KB_CONFIG_PATH, { force: true });
});
afterEach(() => {
  if (saved === null) fs.rmSync(KB_CONFIG_PATH, { force: true });
  else fs.writeFileSync(KB_CONFIG_PATH, saved);
});

describe('readKbToolProfileFromDisk', () => {
  it('is full when the config file is absent', () => {
    expect(readKbToolProfileFromDisk()).toEqual({ name: 'full' });
  });

  it('is full when tool_profile is absent, without touching provider keys', () => {
    writeConfig({ provider: 'http', token_encrypted: 'corrupt' });
    expect(readKbToolProfileFromDisk()).toEqual({ name: 'full' });
  });

  it('reads developer', () => {
    writeConfig({ provider: 'sqlite', tool_profile: 'developer' });
    expect(readKbToolProfileFromDisk()).toEqual({ name: 'developer' });
  });

  it('reads a valid custom list', () => {
    writeConfig({ tool_profile: 'custom', tool_profile_tools: ['kb_query', 'kb_setup'] });
    expect(readKbToolProfileFromDisk()).toEqual({ name: 'custom', tools: ['kb_query', 'kb_setup'] });
  });

  it('throws naming the unknown custom names and the valid ones', () => {
    writeConfig({ tool_profile: 'custom', tool_profile_tools: ['kb_query', 'kb_nope', 'code_query'] });
    expect(() => readKbToolProfileFromDisk()).toThrow(/unknown kb tool name\(s\): kb_nope, code_query\. Valid names: kb_capture/);
  });

  it('throws on an unknown profile name', () => {
    writeConfig({ tool_profile: 'minimal' });
    expect(() => readKbToolProfileFromDisk()).toThrow(/Unknown KB tool profile "minimal"/);
  });
});

describe('makeKbToolProfile / kbToolAllowedByProfile', () => {
  it('developer allows exactly the five developer kb tools and every non-kb tool', () => {
    const p = makeKbToolProfile('developer');
    expect([...DEVELOPER_KB_TOOLS].sort()).toEqual(['kb_capture', 'kb_context', 'kb_feedback', 'kb_query', 'kb_session_prime']);
    expect(registeredKbToolNames().filter(n => kbToolAllowedByProfile(n, p)).sort()).toEqual([...DEVELOPER_KB_TOOLS].sort());
    expect(kbToolAllowedByProfile('code_query', p)).toBe(true);
    expect(kbToolAllowedByProfile('execute_prompt', p)).toBe(true);
  });

  it('custom requires a non-empty list', () => {
    expect(() => makeKbToolProfile('custom', [])).toThrow(/at least one kb_\* tool name/);
    expect(() => makeKbToolProfile('custom')).toThrow(/needs a tool list/);
  });
});

describe('registerAllTools under a KB tool profile', () => {
  it('full or absent: a FULL session registers every tool (same list either way)', async () => {
    const absent = await registeredNames();
    writeConfig({ tool_profile: 'full' });
    const full = await registeredNames();
    expect(full).toEqual(absent);
    expect([...absent].sort()).toEqual([...REGISTERED_TOOL_NAMES].sort());
  });

  it('developer: a FULL session registers the five developer kb tools plus every non-kb tool', async () => {
    writeConfig({ tool_profile: 'developer' });
    const names = await registeredNames();
    const expected = REGISTERED_TOOL_NAMES.filter(n => !n.startsWith('kb_') || DEVELOPER_KB_TOOLS.includes(n));
    expect([...names].sort()).toEqual([...expected].sort());
  });

  it('custom: a FULL session registers exactly the listed kb tools', async () => {
    writeConfig({ tool_profile: 'custom', tool_profile_tools: ['kb_query', 'kb_setup'] });
    const names = await registeredNames();
    expect(names.filter(n => n.startsWith('kb_')).sort()).toEqual(['kb_query', 'kb_setup']);
  });

  it('an invalid profile on disk falls back to full rather than breaking the session', async () => {
    writeConfig({ tool_profile: 'custom', tool_profile_tools: ['kb_nope'] });
    const names = await registeredNames();
    expect([...names].sort()).toEqual([...REGISTERED_TOOL_NAMES].sort());
  });

  it('member sessions ignore the profile', async () => {
    const plainBefore = await registeredNames(memberToolScope('m-1', false));
    const maintBefore = await registeredNames(memberToolScope('m-1', false, true, true));
    writeConfig({ tool_profile: 'developer' });
    expect(await registeredNames(memberToolScope('m-1', false))).toEqual(plainBefore);
    expect(await registeredNames(memberToolScope('m-1', false, true, true))).toEqual(maintBefore);
    expect([...plainBefore].sort()).toEqual([...MEMBER_ALLOWED_TOOLS].sort());
    for (const t of MEMBER_MAINTAINER_TOOLS) expect(maintBefore).toContain(t);
  });
});
