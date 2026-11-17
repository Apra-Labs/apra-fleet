// `apra-fleet kb profile [full | developer | custom <tool1,tool2,...>]`
//
// Shows or sets the install-wide KB tool profile (src/services/kb-tool-profile.ts)
// stored in the KB config. This verb exists because the developer profile hides
// kb_setup from interactive sessions: the CLI is always a way back to full.
// The profile applies to FULL (non-member) sessions only and takes effect when
// a session reconnects. It is a usability control, not a security boundary.

import { readKbToolProfileFromDisk, KB_CONFIG_PATH, KB_CONFIG_HAND_FIX, KbConfigUnreadableError } from '../services/knowledge/kb-config.js';
import { describeKbToolProfile, makeKbToolProfile, registeredKbToolNames, type KbToolProfile } from '../services/kb-tool-profile.js';
import { writeKbToolProfile } from '../tools/kb-setup.js';

export const KB_PROFILE_USAGE =
  'Usage: apra-fleet kb profile [full | developer | custom <tool1,tool2,...>]';

interface Io {
  log: (msg: string) => void;
  error: (msg: string) => void;
}

const defaultIo: Io = {
  log: (msg) => console.log(msg),
  error: (msg) => console.error(msg),
};

/**
 * Parse the arguments after `kb profile` into a profile to set, or null to
 * print the current one. Throws an Error with a usage-ready message on bad
 * input or an unknown tool name.
 */
export function parseKbProfileArgs(args: string[]): KbToolProfile | null {
  if (args.length === 0) return null;
  const [name, ...rest] = args;
  if (name === 'full' || name === 'developer') {
    if (rest.length > 0) throw new Error(`"${name}" takes no tool list`);
    return makeKbToolProfile(name);
  }
  if (name === 'custom') {
    const tools = rest.join(',').split(',').map(t => t.trim()).filter(t => t.length > 0);
    if (tools.length === 0) {
      throw new Error(`"custom" needs a comma-separated kb_* tool list. Valid names: ${registeredKbToolNames().join(', ')}`);
    }
    return makeKbToolProfile('custom', tools);
  }
  throw new Error(`unknown profile "${name}"`);
}

/** Run the verb; returns the process exit code. */
export function runKbProfile(args: string[], io: Io = defaultIo): number {
  if (args.includes('--help') || args.includes('-h')) {
    io.log(KB_PROFILE_USAGE);
    return 0;
  }
  let profile: KbToolProfile | null;
  try {
    profile = parseKbProfileArgs(args);
  } catch (err) {
    io.error(`Error: ${(err as Error).message}`);
    io.error(KB_PROFILE_USAGE);
    return 1;
  }
  if (profile === null) {
    try {
      io.log(`KB tool profile: ${describeKbToolProfile(readKbToolProfileFromDisk())}`);
      return 0;
    } catch (err) {
      io.error(`Error: ${(err as Error).message}`);
      io.error(err instanceof KbConfigUnreadableError ? KB_CONFIG_HAND_FIX : 'Fix it with: apra-fleet kb profile full');
      return 1;
    }
  }
  let steps: string[];
  try {
    ({ steps } = writeKbToolProfile(profile));
  } catch (err) {
    if (!(err instanceof KbConfigUnreadableError)) throw err;
    io.error(`Error: ${err.message}; nothing was written.`);
    io.error(KB_CONFIG_HAND_FIX);
    return 1;
  }
  for (const s of steps) io.log(s);
  io.log(`Config: ${KB_CONFIG_PATH}. Applies to interactive (non-member) sessions only; reconnect to see the change.`);
  return 0;
}
