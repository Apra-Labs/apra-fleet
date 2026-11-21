import os from 'node:os';
import type { Agent } from '../types.js';
import { getAllAgents } from './registry.js';

// The host+user an authorized_keys file belongs to. Host names are
// case-insensitive; a local member (and a loopback host) is this machine, and
// a local member with no recorded username runs as the current OS user.
export function authorizedKeysOwner(a: Agent): { host: string; user: string } {
  const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);
  let host = (a.host ?? '').trim().toLowerCase();
  if (a.agentType === 'local' || host === '' || LOOPBACK.has(host)) host = 'localhost';
  let user = (a.username ?? '').trim();
  if (!user && a.agentType === 'local') {
    try { user = os.userInfo().username; } catch { /* keep empty */ }
  }
  return { host, user };
}

// Another registered member that runs as the same user on the same host
// (keyed on authorizedKeysOwner only, so loopback/local hosts compare equal).
// The LLM login files, shell-profile auth exports and a LEGACY (global,
// per-OS-user) git credential helper live in that user's home and are shared
// by every such member: removing them would break that member, so the caller
// must leave them in place. A per-member helper (VcsCredentialRecord.
// memberScoped) is that member's own and is not shared.
export function memberSharingHostUser(agent: Agent): Agent | undefined {
  const mine = authorizedKeysOwner(agent);
  if (!mine.user) return undefined;
  return getAllAgents().find(a => {
    if (a.id === agent.id) return false;
    const theirs = authorizedKeysOwner(a);
    return theirs.host === mine.host && theirs.user === mine.user;
  });
}
