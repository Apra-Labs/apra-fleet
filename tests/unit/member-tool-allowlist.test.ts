import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  REGISTERED_TOOL_NAMES,
  MEMBER_ALLOWED_TOOLS,
  MEMBER_CHANNEL_TOOLS,
  isMemberAllowedTool,
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

  it('contains every registered kb_* and code_* tool plus version and report_status', () => {
    const kbCode = registered.filter(t => t.startsWith('kb_') || t.startsWith('code_'));
    expect(kbCode.length).toBeGreaterThan(0);
    for (const t of [...kbCode, 'version', 'report_status']) {
      expect(MEMBER_ALLOWED_TOOLS).toContain(t);
    }
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

  it('is exactly the registered tools that the rule allows (no unregistered names)', () => {
    expect([...MEMBER_ALLOWED_TOOLS]).toEqual(registered.filter(isMemberAllowedTool).sort((a, b) =>
      REGISTERED_TOOL_NAMES.indexOf(a) - REGISTERED_TOOL_NAMES.indexOf(b)));
    for (const t of MEMBER_ALLOWED_TOOLS) expect(registered).toContain(t);
  });

  it('allows not-yet-registered kb_/code_ tools and session_stats by rule', () => {
    expect(isMemberAllowedTool('code_reindex')).toBe(true);
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
