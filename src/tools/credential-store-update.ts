import { z } from 'zod';
import { credentialResolve, credentialUpdate } from '../services/credential-store.js';

export const credentialStoreUpdateSchema = z.object({
  name: z.string().min(1).describe('Name of the credential to update'),
  members: z.string().optional().describe('New member scope ("*" or comma-separated friendly names)'),
  ttl_seconds: z.number().min(0).optional().describe('New TTL in seconds from now. Pass 0 to remove expiry.'),
  network_policy: z.enum(['allow', 'deny', 'confirm']).optional().describe('New network egress policy'),
});

export type CredentialStoreUpdateInput = z.infer<typeof credentialStoreUpdateSchema>;

export async function credentialStoreUpdate(input: CredentialStoreUpdateInput): Promise<string> {
  if (input.members === undefined && input.ttl_seconds === undefined && input.network_policy === undefined) {
    return '❌ No fields to update — specify at least one of: members, ttl_seconds, network_policy.';
  }

  const existing = credentialResolve(input.name);
  if (!existing) {
    return `❌ Credential "${input.name}" not found.`;
  }

  const updates: { members?: string; expiresAt?: number | null; network_policy?: 'allow' | 'confirm' | 'deny' } = {};
  if (input.members !== undefined) updates.members = input.members;
  if (input.ttl_seconds !== undefined) {
    updates.expiresAt = input.ttl_seconds === 0 ? null : Date.now() + input.ttl_seconds * 1000;
  }
  if (input.network_policy !== undefined) updates.network_policy = input.network_policy;

  const updated = credentialUpdate(input.name, updates);
  if (!updated) {
    return `❌ Credential "${input.name}" not found.`;
  }

  const output: Record<string, unknown> = {
    members: updated.members,
    expiresAt: input.ttl_seconds === 0 ? null : updated.expiresAt,
    network_policy: updated.network_policy,
  };
  return `✅ Credential "${input.name}" updated. ${JSON.stringify(output)}`;
}
