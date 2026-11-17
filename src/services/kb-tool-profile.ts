// KB tool profiles (GitHub #759): which kb_* tools a FULL (interactive,
// non-member) MCP session is served.
//
//   full      -- every kb_* tool (the default; also what an absent setting means).
//   developer -- the everyday set: DEVELOPER_KB_TOOLS below.
//   custom    -- an explicit list of registered kb_* tool names.
//
// The profile is install-wide (stored in FLEET_DIR/knowledge/config.json as
// tool_profile / tool_profile_tools, see src/services/knowledge/kb-config.ts)
// and is applied only to FULL sessions when they register their tools
// (src/services/tool-registry.ts). Member sessions -- including the engine's
// kb_maintainer session -- keep their own allowlists regardless of profile.
// Non-kb tools (code_* included) are never filtered.
//
// This is a usability control that trims the tool list, NOT a security
// boundary: a hidden tool is just not listed, and the profile can be changed
// back with `apra-fleet kb profile full`.

import { REGISTERED_TOOL_NAMES } from './member-tool-allowlist.js';

export type KbToolProfileName = 'full' | 'developer' | 'custom';

export const KB_TOOL_PROFILE_NAMES: readonly KbToolProfileName[] = Object.freeze(['full', 'developer', 'custom'] as const);

/** The resolved install-wide profile. `tools` is set only for custom. */
export type KbToolProfile =
  | { name: 'full' }
  | { name: 'developer' }
  | { name: 'custom'; tools: readonly string[] };

export const FULL_KB_TOOL_PROFILE: KbToolProfile = Object.freeze({ name: 'full' as const });

/** The kb_* tools the developer profile serves. */
export const DEVELOPER_KB_TOOLS: readonly string[] = Object.freeze([
  'kb_session_prime', 'kb_query', 'kb_context', 'kb_capture', 'kb_feedback',
]);

/** Every registered kb_* tool name (the only names a custom list may hold). */
export function registeredKbToolNames(): string[] {
  return REGISTERED_TOOL_NAMES.filter(isKbToolName);
}

export function isKbToolName(name: string): boolean {
  return name.startsWith('kb_');
}

/**
 * Validate a custom tool list: non-empty, and every entry a registered kb_*
 * tool name. Throws an Error naming the unknown entries and the valid ones.
 * Returns the list de-duplicated, in the caller's order.
 */
export function validateCustomKbTools(tools: readonly unknown[]): string[] {
  const valid = registeredKbToolNames();
  const names = tools.map(t => (typeof t === 'string' ? t.trim() : String(t))).filter(t => t.length > 0);
  if (names.length === 0) {
    throw new Error(`KB tool profile "custom" needs at least one kb_* tool name. Valid names: ${valid.join(', ')}`);
  }
  const unknown = names.filter(n => !valid.includes(n));
  if (unknown.length > 0) {
    throw new Error(
      `KB tool profile "custom" has unknown kb tool name(s): ${[...new Set(unknown)].join(', ')}. ` +
      `Valid names: ${valid.join(', ')}`,
    );
  }
  return [...new Set(names)];
}

/**
 * Build a profile from its name and (for custom) its list, validating both.
 * Throws a clear Error on an unknown profile name or an invalid custom list.
 */
export function makeKbToolProfile(name: unknown, tools?: readonly unknown[]): KbToolProfile {
  if (name === 'full') return FULL_KB_TOOL_PROFILE;
  if (name === 'developer') return { name: 'developer' };
  if (name === 'custom') {
    if (!Array.isArray(tools)) {
      throw new Error(`KB tool profile "custom" needs a tool list. Valid names: ${registeredKbToolNames().join(', ')}`);
    }
    return { name: 'custom', tools: validateCustomKbTools(tools) };
  }
  throw new Error(`Unknown KB tool profile ${JSON.stringify(name)}; expected one of: ${KB_TOOL_PROFILE_NAMES.join(', ')}`);
}

/**
 * True when `name` may be registered on a FULL session under `profile`.
 * Non-kb tools are always allowed.
 */
export function kbToolAllowedByProfile(name: string, profile: KbToolProfile): boolean {
  if (!isKbToolName(name)) return true;
  switch (profile.name) {
    case 'full': return true;
    case 'developer': return DEVELOPER_KB_TOOLS.includes(name);
    case 'custom': return profile.tools.includes(name);
  }
}

/** One-line human description, e.g. for the CLI. */
export function describeKbToolProfile(profile: KbToolProfile): string {
  switch (profile.name) {
    case 'full': return 'full (every kb_* tool)';
    case 'developer': return `developer (${DEVELOPER_KB_TOOLS.join(', ')})`;
    case 'custom': return `custom (${profile.tools.join(', ')})`;
  }
}
