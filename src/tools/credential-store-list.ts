import { z } from 'zod';
import { credentialList } from '../services/credential-store.js';

export const credentialStoreListSchema = z.object({});

function formatRemaining(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m remaining`;
  if (m > 0) return `${m}m ${s}s remaining`;
  return `${s}s remaining`;
}

export async function credentialStoreList(): Promise<string> {
  const entries = credentialList();
  const display = entries.map(e => ({
    name: e.name,
    scope: e.scope,
    network_policy: e.network_policy,
    created_at: e.created_at,
    members: e.allowedMembers === '*' ? '*' : e.allowedMembers.join(', '),
    expiry: e.expiresAt ? formatRemaining(e.expiresAt) : 'none',
  }));
  return JSON.stringify(display, null, 2);
}
