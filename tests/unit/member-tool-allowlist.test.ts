import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  REGISTERED_TOOL_NAMES,
  MEMBER_ALLOWED_TOOLS,
  MEMBER_BASE_TOOLS,
  MEMBER_CHANNEL_TOOLS,
  MEMBER_DENIED_TOOLS,
  MEMBER_MAINTAINER_TOOLS,
  MEMBER_NEVER_TOOLS,
  isMemberAllowedTool,
  isMemberMaintainerTool,
} from '../../src/services/member-tool-allowlist.js';

// Enumerate the registry's own registrations from source, so this test never
// relies on a hardcoded copy of the tool set.
function registeredFromSource(): string[] {
  const registryPath = path.resolve(__dirname, '../../src/services/tool-registry.ts');
  const content = fs.readFileSync(registryPath, 'utf8');
  return [...content.matchAll(/server\.tool\s*\(\s*'([^']+)'/g)].map(m => m[1]);
}

describe('member tool allowlist', () => {
  const registered = registeredFromSource();

  it('REGISTERED_TOOL_NAMES matches every server.tool registration in tool-registry.ts', () => {
    expect(registered.length).toBeGreaterThan(0);
    expect([...REGISTERED_TOOL_NAMES].sort()).toEqual([...registered].sort());
  });

  it('contains every registered code_* tool, the non-minting kb_* tools, and version, report_status and session_stats', () => {
    const code = registered.filter(t => t.startsWith('code_'));
    expect(code.length).toBeGreaterThan(0);
    for (const t of [...code, 'version', 'report_status', 'session_stats']) expect(MEMBER_ALLOWED_TOOLS).toContain(t);
    for (const t of ['kb_capture', 'kb_query', 'kb_list', 'kb_session_prime', 'kb_stats', 'kb_import', 'kb_bible_commit']) {
      expect(MEMBER_ALLOWED_TOOLS).toContain(t);
    }
  });

  it('never serves kb_setup or kb_export, and keeps kb_promote / kb_demote / kb_resolve_contradiction to the maintainer grant', () => {
    expect([...MEMBER_NEVER_TOOLS].sort()).toEqual(['kb_export', 'kb_setup']);
    expect([...MEMBER_MAINTAINER_TOOLS].sort()).toEqual(['kb_demote', 'kb_promote', 'kb_resolve_contradiction']);
    for (const t of [...MEMBER_NEVER_TOOLS, ...MEMBER_MAINTAINER_TOOLS]) {
      expect(MEMBER_ALLOWED_TOOLS).not.toContain(t);
      expect(isMemberAllowedTool(t)).toBe(false);
      // Client-side deny rules (claude, agy) deny them on every agent session.
      expect(MEMBER_DENIED_TOOLS).toContain(t);
    }
    for (const t of MEMBER_MAINTAINER_TOOLS) expect(isMemberMaintainerTool(t)).toBe(true);
    for (const t of MEMBER_NEVER_TOOLS) expect(isMemberMaintainerTool(t)).toBe(false);
  });

  it('classifies every registered kb_* tool exactly once: base, maintainer-only or never', () => {
    const kb = registered.filter(t => t.startsWith('kb_'));
    for (const t of kb) {
      const homes = [MEMBER_BASE_TOOLS, MEMBER_MAINTAINER_TOOLS, MEMBER_NEVER_TOOLS].filter(l => l.includes(t)).length;
      expect(homes, t).toBe(1);
    }
    for (const t of [...MEMBER_BASE_TOOLS, ...MEMBER_MAINTAINER_TOOLS, ...MEMBER_NEVER_TOOLS]) expect(registered).toContain(t);
  });

  it('excludes dispatch, file-transfer, member, credential, admin and shutdown tools', () => {
    const excluded = registered.filter(t =>
      ['execute_prompt', 'execute_command', 'stop_prompt', 'send_files', 'receive_files', 'shutdown_server'].includes(t)
      || /member/.test(t)
      || t.startsWith('credential_store_')
      || ['setup_git_app', 'setup_ssh_key', 'provision_llm_auth', 'provision_vcs_auth', 'revoke_vcs_auth',
        'vcs_credential_exec', 'compose_permissions', 'update_llm_cli', 'cloud_control', 'fleet_status',
        'send_message', 'send_email', 'dolt_push_mutex', 'child_id_allocator'].includes(t));
    for (const t of ['execute_prompt', 'execute_command', 'stop_prompt', 'send_files', 'receive_files',
      'register_member', 'remove_member', 'update_member', 'shutdown_server', 'credential_store_set']) {
      expect(excluded).toContain(t);
    }
    for (const t of excluded) expect(MEMBER_ALLOWED_TOOLS).not.toContain(t);
  });

  it('is exactly the registered tools in the explicit base list (no unregistered names)', () => {
    expect([...MEMBER_ALLOWED_TOOLS]).toEqual(registered.filter(isMemberAllowedTool).sort((a, b) =>
      REGISTERED_TOOL_NAMES.indexOf(a) - REGISTERED_TOOL_NAMES.indexOf(b)));
    for (const t of MEMBER_ALLOWED_TOOLS) expect(registered).toContain(t);
  });

  it('is explicit: an unlisted kb_/code_ name is not member-allowed', () => {
    expect(isMemberAllowedTool('kb_some_future_tool')).toBe(false);
    expect(isMemberAllowedTool('code_some_future_tool')).toBe(false);
    expect(isMemberAllowedTool('code_status')).toBe(true);
    expect(isMemberAllowedTool('session_stats')).toBe(true);
    expect(isMemberAllowedTool('execute_prompt')).toBe(false);
  });

  it('exports MEMBER_CHANNEL_TOOLS with respond_to_message, disjoint from the base allowlist', () => {
    expect(MEMBER_CHANNEL_TOOLS).toContain('respond_to_message');
    for (const t of MEMBER_CHANNEL_TOOLS) {
      expect(MEMBER_ALLOWED_TOOLS).not.toContain(t);
      expect(isMemberAllowedTool(t)).toBe(false);
    }
  });
});
