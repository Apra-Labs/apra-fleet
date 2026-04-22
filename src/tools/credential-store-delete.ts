import { z } from 'zod';
import { credentialDelete } from '../services/credential-store.js';

export const credentialStoreDeleteSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_]{1,64}$/).describe('Name of the credential to delete'),
});

export type CredentialStoreDeleteInput = z.infer<typeof credentialStoreDeleteSchema>;

export async function credentialStoreDelete(input: CredentialStoreDeleteInput): Promise<string> {
  const deleted = credentialDelete(input.name);
  return deleted
    ? `✅ Credential "${input.name}" deleted.`
    : `❌ Credential "${input.name}" not found.`;
}
