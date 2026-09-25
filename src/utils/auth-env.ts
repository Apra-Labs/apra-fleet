import type { Agent } from '../types.js';
import type { RemoteOS } from './platform.js';
import { buildEnvPrefix } from './env-prefix.js';

/**
 * Build a platform-correct inline export prefix for all stored auth env vars.
 * Returns empty string if the agent has no stored env vars.
 *
 * Thin back-compat wrapper over buildEnvPrefix (src/utils/env-prefix.ts,
 * F14) with the member.env map excluded -- kept exported with its original
 * two-argument signature so the call sites and tests that only ever cared
 * about auth credentials do not have to change.
 *
 * Note the deliberate consequence of NOT taking a `shell`: a gitbash Windows
 * member reached through THIS entry point still gets the PowerShell form,
 * exactly as it did before F14. Callers that want shell-correct output for a
 * gitbash member must call buildEnvPrefix directly and pass
 * getAgentShell(agent) -- which is what every dispatch site now does.
 */
export function buildAuthEnvPrefix(agent: Agent, os: RemoteOS): string {
  return buildEnvPrefix(agent, { os, include: { auth: true, member: false } });
}
