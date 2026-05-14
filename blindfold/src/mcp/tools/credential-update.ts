import { z } from 'zod';
import { credentialUpdate } from '../../credential-store.js';
import { getLogger } from '../../config.js';

export const credentialUpdateSchema = z.object({
  name: z.string().min(1).describe('Name of the credential to update'),
  members: z.string().optional().describe('New member scope ("*" or comma-separated names)'),
  ttl_seconds: z.number().min(0).optional().describe('New TTL in seconds from now. Pass 0 to remove expiry.'),
  network_policy: z.enum(['allow', 'deny', 'confirm']).optional().describe('New network egress policy'),
});

export type CredentialUpdateInput = z.infer<typeof credentialUpdateSchema>;

export async function credentialUpdateHandler(input: CredentialUpdateInput): Promise<string> {
  if (input.members === undefined && input.ttl_seconds === undefined && input.network_policy === undefined) {
    return 'No fields to update — specify at least one of: members, ttl_seconds, network_policy.';
  }

  const updates: { members?: string; expiresAt?: number | null; network_policy?: 'allow' | 'confirm' | 'deny' } = {};
  if (input.members !== undefined) updates.members = input.members;
  if (input.ttl_seconds !== undefined) {
    updates.expiresAt = input.ttl_seconds === 0 ? null : Date.now() + input.ttl_seconds * 1000;
  }
  if (input.network_policy !== undefined) updates.network_policy = input.network_policy;

  const updated = credentialUpdate(input.name, updates);
  if (!updated) {
    return `Credential "${input.name}" not found.`;
  }
  getLogger().info('credential_update', `name=${input.name}`);

  const output: Record<string, unknown> = {
    members: updated.members,
    expiresAt: input.ttl_seconds === 0 ? null : updated.expiresAt,
    network_policy: updated.network_policy,
  };
  return `Credential "${input.name}" updated. ${JSON.stringify(output)}`;
}
